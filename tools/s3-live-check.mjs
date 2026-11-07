/**
 * S3 真实环境验证：设备登记、设备证明、一次性 nonce、重放拦截。
 *
 * 前置：已部署 公共模块 ucd-device-auth、云对象 ucd-device-co、s3-guard-probe，
 *       已创建集合 ucd-device-keys / ucd-device-enrolls / ucd-device-nonces。
 *
 *   npm run build
 *   node --env-file=.env.local tools/s3-live-check.mjs
 *
 * 结果写入 reports/S3-live-result.json（已脱敏，不入库）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createClient, createSoftwareDeviceKey, createMemoryKeyVault } from '../dist/index.js';

const env = process.env;
const required = ['UNICLOUD_SPACE_ID', 'UNICLOUD_SPACE_APP_ID', 'UNICLOUD_ACCESS_KEY', 'UNICLOUD_SECRET_KEY', 'UNICLOUD_APP_ID'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`缺少环境变量：${missing.join(', ')}`);
  process.exit(2);
}
const space = {
  provider: 'alipay',
  spaceId: env.UNICLOUD_SPACE_ID,
  spaceAppId: env.UNICLOUD_SPACE_APP_ID,
  accessKey: env.UNICLOUD_ACCESS_KEY,
  secretKey: env.UNICLOUD_SECRET_KEY,
};

const vault = createMemoryKeyVault(); // 每次运行都是一台「新设备」
const calls = [];
let lastSigned = null;
function makeClient() {
  return createClient({
    space,
    appId: env.UNICLOUD_APP_ID,
    osName: 'windows',
    deviceId: 'S3-LIVE-CHECK',
    retries: 0,
    timeout: 20_000,
    device: { key: createSoftwareDeviceKey({ vault }), deviceName: 'S3 live check' },
    hooks: {
      onRequest: (req) => {
        const body = JSON.parse(req.body ?? '{}');
        calls.push(`${req.headers['x-to-function-name']}.${body.method ?? ''}`);
        lastSigned = req;
      },
    },
  });
}

const results = [];
async function step(name, fn) {
  const started = Date.now();
  const callStart = calls.length;
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, ms: Date.now() - started, calls: calls.slice(callStart), detail });
    console.log(`✔ ${name} (${Date.now() - started} ms) ${calls.slice(callStart).join(' → ')}`);
  } catch (error) {
    const info = {
      errCode: error?.errCode ?? 'ERROR',
      errMsg: String(error?.errMsg ?? error?.message ?? error).slice(0, 300),
      requestId: error?.requestId,
      status: error?.status,
    };
    results.push({ step: name, ok: false, ms: Date.now() - started, calls: calls.slice(callStart), error: info });
    console.log(`✘ ${name}: ${info.errCode} ${info.errMsg}${info.requestId ? ` (requestId ${info.requestId})` : ''}`);
  }
}

const cloud = makeClient();
const probe = cloud.importObject('s3-guard-probe');

await step('1. 诊断：devicePoP 与参数能到达云端', async () => {
  const d = await probe.diag('a', 1);
  if (!d.hasDevicePoP || !d.paramsIsArray || !d.paramsEqualsArgs) throw Object.assign(new Error(JSON.stringify(d)), { errCode: 'DIAG_FAILED' });
  return d;
});

await step('2. 新设备首次调用：自动登记后成功', async () => {
  const r = await probe.ping('hello');
  if (r.deviceId !== (await cloud.getDeviceId())) throw new Error('deviceId mismatch');
  return { deviceIdPrefix: r.deviceId.slice(0, 8) };
});

let replayRequest = null;
await step('3. 写方法（一次性 nonce，走数据库）', async () => {
  const r = await probe.write('w1');
  replayRequest = lastSigned;
  return { echo: r.echo };
});

await step('4. 原样重放第 3 步的请求：应被拒绝', async () => {
  const res = await fetch(replayRequest.url, { method: 'POST', headers: replayRequest.headers, body: replayRequest.body });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  if (data.errCode === 'DEVICE_PROOF_REPLAYED') return { status: res.status, blockedBy: 'ucd-device-auth', errCode: data.errCode };
  if (res.status >= 400) return { status: res.status, blockedBy: 'gateway', detail: JSON.stringify(data).slice(0, 120) };
  throw Object.assign(new Error(`HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`), { errCode: 'REPLAY_NOT_BLOCKED' });
});

await step('5. 同一设备重启（新 client 实例）：不重复登记', async () => {
  const again = makeClient();
  await again.importObject('s3-guard-probe').ping('restart');
  return {};
});

await step('6. 错误码能否回到客户端（_before 抛出带 errCode 的错误）', async () => {
  const stranger = createClient({ space, appId: env.UNICLOUD_APP_ID, osName: 'windows', retries: 0 });
  try {
    await stranger.importObject('s3-guard-probe').ping('no-device');
  } catch (error) {
    if (error.errCode === 'DEVICE_PROOF_MISSING') return { errCode: error.errCode, via: 'result' };
    throw Object.assign(new Error(`收到 ${error.errCode} / HTTP ${error.status ?? '-'}：${error.errMsg}`), { errCode: 'ERROR_SHAPE' });
  }
  throw Object.assign(new Error('未携带设备证明的请求被放行了'), { errCode: 'NOT_BLOCKED' });
});

const summary = {
  sdkVersion: '0.4.0',
  node: process.version,
  time: new Date().toISOString(),
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
mkdirSync('reports', { recursive: true });
writeFileSync('reports/S3-live-result.json', JSON.stringify(summary, null, 2));
console.log(`\n通过 ${summary.passed}，失败 ${summary.failed}。结果已写入 reports/S3-live-result.json`);
process.exit(summary.failed ? 1 : 0);
