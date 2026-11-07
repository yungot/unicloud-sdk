/**
 * S2 真实环境验证（在你本机运行；需要联网和服务空间客户端凭据）。
 *
 * 凭据只从环境变量读取，脚本不会打印 secretKey、Authorization 或 token。
 *
 * 用法（PowerShell，项目根目录）：
 *   npm run build
 *   node --env-file=.env.local tools/s2-live-check.mjs              # 只测云对象调用（1 次请求）
 *   node --env-file=.env.local tools/s2-live-check.mjs --ext        # 再测扩展存储（需先部署 s2-ext-probe）
 *   node --env-file=.env.local tools/s2-live-check.mjs --builtin    # 再测内置存储（会在 s2-test/ 下留 2 个小文件）
 *
 * 结果同时写入 reports/S2-live-result.json（已脱敏）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createClient, uploadWithOptions } from '../dist/index.js';

const args = new Set(process.argv.slice(2));
const env = process.env;
const required = ['UNICLOUD_SPACE_ID', 'UNICLOUD_SPACE_APP_ID', 'UNICLOUD_ACCESS_KEY', 'UNICLOUD_SECRET_KEY', 'UNICLOUD_APP_ID'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`缺少环境变量：${missing.join(', ')}（请写在 .env.local，并用 --env-file=.env.local 运行）`);
  process.exit(2);
}

const SENSITIVE = /^(?!secretType$).*(token|secret|authorization|signature|policy|credential|accesskey)/i;
function redact(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return value.split('?')[0] + (value.includes('?') ? '?[query-redacted]' : '');
  return value;
}

const requests = [];
const cloud = createClient({
  space: {
    provider: 'alipay',
    spaceId: env.UNICLOUD_SPACE_ID,
    spaceAppId: env.UNICLOUD_SPACE_APP_ID,
    accessKey: env.UNICLOUD_ACCESS_KEY,
    secretKey: env.UNICLOUD_SECRET_KEY,
  },
  appId: env.UNICLOUD_APP_ID,
  osName: 'windows',
  deviceId: 'S2-LIVE-CHECK',
  retries: 0,
  timeout: 20_000,
  hooks: {
    onRequest: (req, ctx) => requests.push({ method: req.method, url: req.url.split('?')[0], requestId: ctx.requestId }),
  },
});

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, ms: Date.now() - started, detail: redact(detail) });
    console.log(`✔ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    const info = {
      errCode: error?.errCode ?? error?.code ?? 'ERROR',
      errMsg: String(error?.errMsg ?? error?.message ?? error).slice(0, 300),
      errSubject: error?.errSubject,
      requestId: error?.requestId,
      status: error?.status,
    };
    results.push({ step: name, ok: false, ms: Date.now() - started, error: info });
    console.log(`✘ ${name}: ${info.errCode} ${info.errMsg}${info.requestId ? ` (requestId ${info.requestId})` : ''}`);
  }
}

async function fetchText(url) {
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
}

// 1. 云对象调用（客户端网关，不经 URL 化）
await step('importObject win-http-probe.probe()', async () => {
  return await cloud.importObject('win-http-probe').probe();
});

// 2. 扩展存储：云对象下发参数 → 直传 → 下载校验 → 清理
if (args.has('--ext')) {
  const probe = cloud.importObject('s2-ext-probe');
  const content = `s2-ext ${new Date().toISOString()}`;
  let opts;
  await step('ext: getUploadOptions', async () => {
    opts = await probe.getUploadOptions();
    return { cloudPath: opts.cloudPath, fileID: opts.fileID, uploadUrl: opts.uploadFileOptions?.url, fieldName: opts.uploadFileOptions?.name };
  });
  if (opts) {
    let uploaded = false;
    await step('ext: uploadWithOptions', async () => {
      const r = await uploadWithOptions({ uploadFileOptions: opts.uploadFileOptions, file: new TextEncoder().encode(content), fileName: 's2.txt', contentType: 'text/plain' });
      uploaded = true;
      return r;
    });
    if (uploaded) {
      await step('ext: getTempURL + 下载内容一致', async () => {
        const res = await probe.getTempURL({ fileID: opts.fileID });
        const url = res.fileList?.[0]?.tempFileURL;
        const got = await fetchText(url);
        if (got.text !== content) throw Object.assign(new Error(`内容不一致：HTTP ${got.status}`), { errCode: 'CONTENT_MISMATCH' });
        return { status: got.status, matched: true };
      });
      await step('ext: remove（清理测试文件）', async () => probe.remove({ fileID: opts.fileID }));
    }
  }
}

// 3. 内置存储：ASCII 路径 + 中文路径各一次
if (args.has('--builtin')) {
  for (const [label, name] of [['ASCII', `sdk-${Date.now()}.txt`], ['中文', `中文-${Date.now()}.txt`]]) {
    const content = `s2-builtin ${label} ${new Date().toISOString()}`;
    let fileID;
    await step(`builtin(${label}): uploadFile`, async () => {
      ({ fileID } = await cloud.uploadFile({ cloudPath: `s2-test/${name}`, file: new TextEncoder().encode(content), contentType: 'text/plain' }));
      return { fileID };
    });
    if (fileID) {
      await step(`builtin(${label}): getTempFileURL + 下载内容一致`, async () => {
        const { fileList } = await cloud.getTempFileURL({ fileList: [fileID] });
        const got = await fetchText(fileList[0].tempFileURL);
        if (got.text !== content) throw Object.assign(new Error(`内容不一致：HTTP ${got.status}`), { errCode: 'CONTENT_MISMATCH' });
        return { status: got.status, matched: true };
      });
    }
  }
}

const summary = {
  sdkVersion: '0.3.0',
  node: process.version,
  time: new Date().toISOString(),
  spaceId: env.UNICLOUD_SPACE_ID,
  appId: env.UNICLOUD_APP_ID,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
  requests,
};
mkdirSync('reports', { recursive: true });
writeFileSync('reports/S2-live-result.json', JSON.stringify(summary, null, 2));
console.log(`\n通过 ${summary.passed}，失败 ${summary.failed}。脱敏结果已写入 reports/S2-live-result.json`);
process.exit(summary.failed ? 1 : 0);
