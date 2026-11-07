import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createClient,
  createMockTransport,
  createSoftwareDeviceKey,
  createMemoryKeyVault,
  canonicalJson,
  jwkThumbprint,
  UniCloudError,
} from '../dist/index.js';
import { lazyCrypto } from '../dist/crypto.js';

const require = createRequire(import.meta.url);
const server = require('../cloud/common/ucd-device-auth/index.js');

const SPACE = { provider: 'alipay', spaceId: 'env-test', spaceAppId: 'APP', accessKey: 'AK', secretKey: 'SK' };
const TOKENS = { 'T-u1': 'u1', 'T-u2': 'u2' };

/** 模拟 uniCloud：把 SDK 请求路由到云端模块，复刻云对象 _before 的行为 */
function createCloud({ now = () => Date.now(), readMethods = [], requireLogin = [] } = {}) {
  const store = server.createMemoryStore();
  const auth = server.createDeviceAuth({ store, now, cacheMs: 0 });
  const log = [];
  const transport = createMockTransport(async (req) => {
    const target = req.headers['x-to-function-name'];
    const body = JSON.parse(req.body);
    log.push({ target, body });
    const uid = body.uniIdToken ? TOKENS[body.uniIdToken] ?? null : null;
    const ok = (data) => ({ status: 200, headers: {}, data });
    try {
      if (target === 'ucd-device-co') {
        if (body.method === 'beginEnroll') return ok({ errCode: 0, ...(await auth.beginEnroll(body.params[0], { uid })) });
        if (body.method === 'completeEnroll') return ok({ errCode: 0, ...(await auth.completeEnroll(body.params[0], { uid })) });
      }
      if (target === 'music') {
        if (requireLogin.includes(body.method) && !uid) return ok({ errCode: 'NEED_LOGIN', errMsg: 'login' });
        const device = await auth.verify(
          { target, method: body.method, params: body.params, clientInfo: body.clientInfo, uniIdToken: body.uniIdToken },
          { replay: readMethods.includes(body.method) ? 'window' : 'nonce', uid },
        );
        return ok({ errCode: 0, method: body.method, deviceId: device.deviceId, uid: device.uid });
      }
      if (target === 'plain-fn') {
        const { clientInfo, uniIdToken, ...params } = body;
        const device = await auth.verify({ target, method: '', params, clientInfo, uniIdToken }, { uid });
        return ok({ errCode: 0, deviceId: device.deviceId });
      }
      return ok({ errCode: 'NOT_FOUND' });
    } catch (error) {
      if (!error.errCode) throw error;
      return ok({ errCode: error.errCode, errMsg: error.errMsg, ...(error.serverTime ? { serverTime: error.serverTime } : {}) });
    }
  });
  return { transport, auth, store, log };
}

function makeDeviceClient(transport, extra = {}) {
  const vault = extra.vault ?? createMemoryKeyVault();
  const key = createSoftwareDeviceKey({ vault, crypto: lazyCrypto });
  const cloud = createClient({
    space: SPACE, appId: '__UNI__TEST', osName: 'windows', retries: 0, transport,
    device: { key, deviceName: 'Test PC' },
    ...extra.client,
  });
  return { cloud, key, vault };
}

test('首次调用自动登记设备，之后每个请求都带有效的设备证明', async () => {
  const { transport, log } = createCloud();
  const { cloud, key } = makeDeviceClient(transport);
  const music = cloud.importObject('music');

  const first = await music.search('晴天');
  assert.equal(first.deviceId, await key.getKeyId());
  // search → NOT_ENROLLED → beginEnroll → completeEnroll → search
  assert.deepEqual(log.map((l) => `${l.target}.${l.body.method}`), ['music.search', 'ucd-device-co.beginEnroll', 'ucd-device-co.completeEnroll', 'music.search']);
  assert.equal(log[1].body.clientInfo.devicePoP, undefined, '登记接口不附带证明');

  await music.search('七里香');
  assert.equal(log.length, 5, '已登记设备不再重复登记');
  const pop = log[4].body.clientInfo.devicePoP;
  assert.equal(pop.v, 1);
  assert.equal(pop.kid, await key.getKeyId());
  assert.match(pop.sig, /^[A-Za-z0-9_-]{86}$/);
});

test('参数被篡改、换对象、换方法、换 token 时签名失效', async () => {
  const { transport, auth, log } = createCloud();
  const { cloud } = makeDeviceClient(transport, { client: { uniIdToken: 'T-u1' } });
  await cloud.enrollDevice();
  await cloud.importObject('music').search('a');
  const sent = log.at(-1).body;
  const base = { target: 'music', method: 'search', params: sent.params, clientInfo: sent.clientInfo, uniIdToken: sent.uniIdToken };
  const cases = [
    { ...base, params: ['b'] },
    { ...base, target: 'other' },
    { ...base, method: 'deleteAll' },
    { ...base, uniIdToken: 'T-u2' },
  ];
  for (const req of cases) {
    await assert.rejects(() => auth.verify(req, { replay: 'window' }), (e) => e.errCode === 'DEVICE_PROOF_INVALID');
  }
});

test('同一请求重放被拒绝；只读方法按时间窗策略放行', async () => {
  const { transport, auth, log } = createCloud({ readMethods: ['search'] });
  const { cloud } = makeDeviceClient(transport);
  await cloud.enrollDevice();
  await cloud.importObject('music').addFavorite('s1');
  const sent = log.at(-1).body;
  const req = { target: 'music', method: 'addFavorite', params: sent.params, clientInfo: sent.clientInfo };
  await assert.rejects(() => auth.verify(req), (e) => e.errCode === 'DEVICE_PROOF_REPLAYED');
  // 读接口策略：时间窗内可重复（以性能换取一次数据库写；不得用于写操作）
  await auth.verify(req, { replay: 'window' });
});

test('本机时钟偏差：登记时自动校准；登记后时钟再漂移，云端返回 serverTime 后校准并重试', async () => {
  const { transport, log } = createCloud();
  let skew = 10 * 60 * 1000;
  const { cloud } = makeDeviceClient(transport, { client: { now: () => Date.now() + skew } });

  await cloud.enrollDevice();
  let before = log.length;
  assert.equal((await cloud.importObject('music').search('x')).errCode, 0);
  assert.equal(log.length - before, 1, '登记响应的 serverTime 已校准时钟');

  skew += 15 * 60 * 1000; // 运行中本机时间又被改动
  before = log.length;
  assert.equal((await cloud.importObject('music').search('y')).errCode, 0);
  assert.equal(log.length - before, 2, '过期一次 + 校准后重试一次');
  assert.ok(Math.abs(log.at(-1).body.clientInfo.devicePoP.ts - Date.now()) < 5000);
});

test('设备被吊销后请求被拒绝（不自动重新登记）', async () => {
  const { transport, auth } = createCloud();
  const { cloud, key } = makeDeviceClient(transport, { client: { uniIdToken: 'T-u1' } });
  await cloud.enrollDevice();
  await auth.revokeDevice(await key.getKeyId(), { uid: 'u1' });
  await assert.rejects(() => cloud.importObject('music').search('x'), (e) => e instanceof UniCloudError && e.errCode === 'DEVICE_REVOKED');
  await assert.rejects(() => cloud.enrollDevice(), (e) => e.errCode === 'DEVICE_REVOKED');
});

test('游客设备登录后自动绑定账号；绑定后不能被其他账号使用', async () => {
  const { transport, store, log } = createCloud();
  const { cloud, key } = makeDeviceClient(transport);
  await cloud.importObject('music').search('guest');
  assert.equal((await store.getDevice(await key.getKeyId())).uid, null);

  await cloud.setUniIdToken('T-u1');
  const res = await cloud.importObject('music').search('logged-in');
  assert.equal(res.uid, 'u1');
  assert.ok(log.some((l) => l.body.method === 'completeEnroll' && l.body.uniIdToken === 'T-u1'), '登录后重新登记完成绑定');

  await cloud.setUniIdToken('T-u2');
  await assert.rejects(() => cloud.importObject('music').search('other user'), (e) => e.errCode === 'DEVICE_USER_MISMATCH');
});

test('登记挑战一次性、会过期、必须由对应私钥签名', async () => {
  let t = 1_000_000;
  const store = server.createMemoryStore();
  const auth = server.createDeviceAuth({ store, now: () => t });
  const key = createSoftwareDeviceKey({ vault: createMemoryKeyVault(), crypto: lazyCrypto });
  const other = createSoftwareDeviceKey({ vault: createMemoryKeyVault(), crypto: lazyCrypto });
  const text = (b) => ['UCDE1', b.enrollId, b.kid, b.challenge].join('\n');

  const b1 = await auth.beginEnroll({ publicJwk: await key.getPublicJwk() });
  await assert.rejects(async () => auth.completeEnroll({ enrollId: b1.enrollId, signature: await other.signText(text(b1)) }), (e) => e.errCode === 'DEVICE_PROOF_INVALID');
  await assert.rejects(async () => auth.completeEnroll({ enrollId: b1.enrollId, signature: await key.signText(text(b1)) }), (e) => e.errCode === 'DEVICE_ENROLL_INVALID', '失败后挑战已作废');

  const b2 = await auth.beginEnroll({ publicJwk: await key.getPublicJwk() });
  t += 10 * 60 * 1000;
  await assert.rejects(async () => auth.completeEnroll({ enrollId: b2.enrollId, signature: await key.signText(text(b2)) }), (e) => e.errCode === 'DEVICE_ENROLL_EXPIRED');

  await assert.rejects(() => auth.beginEnroll({ publicJwk: { kty: 'EC', crv: 'P-256', x: 'short', y: 'short' } }), (e) => e.errCode === 'DEVICE_ENROLL_INVALID');
});

test('格式错误或缺失的证明被拒绝', async () => {
  const auth = server.createDeviceAuth({ store: server.createMemoryStore() });
  await assert.rejects(() => auth.verify({ target: 'm', method: 'a', params: [], clientInfo: {} }), (e) => e.errCode === 'DEVICE_PROOF_MISSING');
  for (const pop of [{ v: 2 }, { v: 1, kid: 'x', ts: Date.now(), nonce: 'n', sig: 's' }, { v: 1, kid: 'a'.repeat(43), ts: 'now', nonce: 'b'.repeat(22), sig: 's' }]) {
    await assert.rejects(() => auth.verify({ target: 'm', method: 'a', params: [], clientInfo: { devicePoP: pop } }), (e) => e.errCode === 'DEVICE_PROOF_MALFORMED');
  }
});

test('普通云函数（callFunction）同样受设备证明保护', async () => {
  const { transport } = createCloud();
  const { cloud, key } = makeDeviceClient(transport);
  await cloud.enrollDevice();
  const res = await cloud.callFunction({ name: 'plain-fn', data: { a: 1, nested: { z: 1, b: [1, '二'] } } });
  assert.equal(res.result.errCode, 0);
  assert.equal(res.result.deviceId, await key.getKeyId());
});

test('设备密钥持久化：同一 vault 重启后 kid 不变；reset 后生成新身份', async () => {
  const vault = createMemoryKeyVault();
  const k1 = createSoftwareDeviceKey({ vault, crypto: lazyCrypto });
  const id1 = await k1.getKeyId();
  const k2 = createSoftwareDeviceKey({ vault, crypto: lazyCrypto });
  assert.equal(await k2.getKeyId(), id1);
  await k2.reset();
  const k3 = createSoftwareDeviceKey({ vault, crypto: lazyCrypto });
  assert.notEqual(await k3.getKeyId(), id1);
});

test('SDK 与云端模块的 canonicalJson、JWK 指纹完全一致', async () => {
  const samples = [
    null, 0, -1.5, 1e21, 'a"b\\c', '中文🎵', [1, undefined, null, { b: 2, a: 1 }],
    { z: 1, a: { y: [3, 2, 1], x: undefined }, 'é': true, '': '' }, [], {},
  ];
  for (const s of samples) assert.equal(canonicalJson(s), server.canonicalJson(s), JSON.stringify(s));
  const key = createSoftwareDeviceKey({ vault: createMemoryKeyVault(), crypto: lazyCrypto });
  const jwk = await key.getPublicJwk();
  assert.equal(await jwkThumbprint(lazyCrypto, jwk), server.thumbprint(jwk));
  assert.equal(await key.getKeyId(), server.thumbprint(jwk));
});

test('未配置设备身份时不附带证明，行为与之前一致', async () => {
  const transport = createMockTransport(() => ({ status: 200, headers: {}, data: { errCode: 0 } }));
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 0, transport });
  await cloud.importObject('music').search('x');
  assert.equal(JSON.parse(transport.requests[0].body).clientInfo.devicePoP, undefined);
  assert.equal(await cloud.getDeviceId(), null);
});

test('protectCloudObject：校验失败以普通结果返回 errCode（不抛错，避免支付宝云 HTTP 500）', async () => {
  const store = server.createMemoryStore();
  const auth = server.createDeviceAuth({ store });
  const obj = server.protectCloudObject(
    {
      diag() { return { errCode: 0, public: true }; },
      ping(x) { return { errCode: 0, echo: x, deviceId: this.device.deviceId, uid: this.uid }; },
      async fail() { throw new Error('boom'); },
      _private() { return 'internal'; },
    },
    {
      auth, object: 'probe', publicMethods: ['diag'],
      resolveUid: async (ctx) => {
        const token = ctx.getUniIdToken();
        if (token === 'BAD') throw { errCode: 'uni-id-check-token-failed', errMsg: 'bad token' };
        return token ? 'u1' : null;
      },
    },
  );
  const ctx = (method, params, clientInfo = {}, token) => ({
    getMethodName: () => method, getParams: () => params, getClientInfo: () => clientInfo, getUniIdToken: () => token,
  });

  assert.deepEqual(await obj.diag.call(ctx('diag', [])), { errCode: 0, public: true });
  assert.equal(obj._private.call(null), 'internal');
  assert.equal((await obj.ping.call(ctx('ping', ['x']), 'x')).errCode, 'DEVICE_PROOF_MISSING');
  assert.equal((await obj.ping.call(ctx('ping', ['x'], {}, 'BAD'), 'x')).errCode, 'uni-id-check-token-failed');

  // 用真实 SDK 生成证明后调用
  const key = createSoftwareDeviceKey({ vault: createMemoryKeyVault(), crypto: lazyCrypto });
  const b = await auth.beginEnroll({ publicJwk: await key.getPublicJwk() });
  await auth.completeEnroll({ enrollId: b.enrollId, signature: await key.signText(['UCDE1', b.enrollId, b.kid, b.challenge].join('\n')) });
  const transport = createMockTransport(async (req) => {
    const body = JSON.parse(req.body);
    const result = await obj[body.method].call(ctx(body.method, body.params, body.clientInfo, body.uniIdToken), ...body.params);
    return { status: 200, headers: {}, data: result };
  });
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 0, transport, device: { key } });
  const res = await cloud.importObject('probe').ping('hi');
  assert.equal(res.echo, 'hi');
  assert.equal(res.deviceId, await key.getKeyId());
  await assert.rejects(() => cloud.importObject('probe').fail(), /boom/, '非 errCode 的异常照常抛出');
});

test('uniCloud 存储：支付宝云的重复插入错误（-409）被识别为重放', async () => {
  assert.equal(server.isDuplicateError({ errCode: -409, errMsg: 'document is already exists' }), true);
  assert.equal(server.isDuplicateError(new Error('E11000 duplicate key error')), true);
  assert.equal(server.isDuplicateError({ errCode: -1, errMsg: 'network' }), false);

  const added = new Set();
  const fakeDb = {
    command: { lt: (v) => ({ $lt: v }) },
    collection: () => ({
      add: async (doc) => {
        if (added.has(doc.nonceKey)) throw { errCode: -409, errMsg: 'document is already exists' };
        added.add(doc.nonceKey);
        return { id: '1' };
      },
      where: () => ({ count: async () => ({ total: 1 }) }),
    }),
  };
  const store = server.createUniCloudStore(fakeDb);
  assert.equal(await store.useNonce('k', 'n1', 0), true);
  assert.equal(await store.useNonce('k', 'n1', 0), false);
});

test('createUniIdResolver：无 token 为游客，token 无效返回错误码，有效返回 uid', async () => {
  const fakeUniId = {
    createInstance: () => ({
      checkToken: async (t) => (t === 'GOOD' ? { errCode: 0, uid: 'u9' } : { errCode: 'uni-id-check-token-failed', errMsg: 'bad' }),
    }),
  };
  const resolve = server.createUniIdResolver(fakeUniId);
  const ctx = (token) => ({ getUniIdToken: () => token, getClientInfo: () => ({}) });
  assert.equal(await resolve(ctx(undefined)), null);
  assert.equal(await resolve(ctx('GOOD')), 'u9');
  await assert.rejects(() => resolve(ctx('BAD')), (e) => e.errCode === 'uni-id-check-token-failed');
  await assert.rejects(() => server.createUniIdResolver(null)(ctx('GOOD')), (e) => e.errCode === 'UNI_ID_UNAVAILABLE');
});
