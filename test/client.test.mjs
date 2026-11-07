import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createMockTransport, UniCloudError, TransportError } from '../dist/index.js';

const SPACE = {
  provider: 'alipay',
  spaceId: 'env-test',
  spaceAppId: 'APP',
  accessKey: 'AK',
  secretKey: 'SK',
};

function make(options = {}) {
  const transport = createMockTransport(() => ({ status: 200, data: { list: [1, 2] }, headers: {} }));
  const cloud = createClient({
    space: SPACE,
    appId: '__UNI__TEST',
    deviceId: 'DEV-1',
    osName: 'windows',
    now: () => 1700000000000,
    uuid: () => 'req-1',
    retries: 0,
    transport,
    ...options,
  });
  return { cloud, transport };
}

test('callFunction 传递 data 并注入 clientInfo', async () => {
  const { cloud, transport } = make();
  const response = await cloud.callFunction({ name: 'hello', data: { a: 1 } });
  assert.deepEqual(response.result, { list: [1, 2] });

  const body = JSON.parse(transport.requests[0].body);
  assert.equal(body.a, 1);
  assert.equal(body.clientInfo.APPID, '__UNI__TEST');
  assert.equal(body.clientInfo.DEVICEID, 'DEV-1');
  assert.equal(body.clientInfo.OS, 'windows');
  assert.equal(transport.requests[0].headers['x-to-function-name'], 'hello');
});

test('importObject 把方法名与参数转成云对象调用', async () => {
  const { cloud, transport } = make();
  const api = cloud.importObject('music');
  assert.equal(typeof api.search, 'function');
  assert.equal(api.then, undefined);

  await api.search('晴天', 2);
  const body = JSON.parse(transport.requests[0].body);
  assert.equal(body.method, 'search');
  assert.deepEqual(body.params, ['晴天', 2]);
});

test('uniIdToken 会随请求上行，且可更新', async () => {
  const { cloud, transport } = make({ uniIdToken: 'token-a' });
  await cloud.callFunction({ name: 'hello' });
  assert.equal(JSON.parse(transport.requests[0].body).uniIdToken, 'token-a');

  await cloud.setUniIdToken('token-b');
  await cloud.callFunction({ name: 'hello' });
  assert.equal(JSON.parse(transport.requests[1].body).uniIdToken, 'token-b');
});

test('与官方一致：callFunction 不因业务 errCode 抛错，importObject 会抛', async () => {
  const transport = createMockTransport(() => ({
    status: 200,
    data: { errCode: 'INVALID_TOKEN', errMsg: 'token 无效', errSubject: 'uni-id', extra: 1 },
    headers: { 'x-trace-id': 'trace-err' },
  }));
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 0, transport });

  const plain = await cloud.callFunction({ name: 'hello' });
  assert.equal(plain.result.errCode, 'INVALID_TOKEN');
  assert.equal(plain.requestId, 'trace-err');

  await assert.rejects(
    () => cloud.importObject('user').getInfo(),
    (error) => {
      assert.ok(error instanceof UniCloudError);
      assert.equal(error.errCode, 'INVALID_TOKEN');
      assert.equal(error.errSubject, 'uni-id');
      assert.equal(error.requestId, 'trace-err');
      assert.equal(error.detail.extra, 1);
      return true;
    },
  );
});

test('HTTP 4xx 抛 TransportError 并带上网关信息与 requestId', async () => {
  const transport = createMockTransport(() => ({ status: 403, data: { message: 'signature mismatch', trace_id: 't-403' }, headers: {} }));
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 0, transport });
  await assert.rejects(
    () => cloud.callFunction({ name: 'hello' }),
    (error) => {
      assert.ok(error instanceof TransportError);
      assert.match(error.errMsg, /signature mismatch/);
      assert.equal(error.requestId, 't-403');
      return true;
    },
  );
});

test('响应没有 trace 头时 requestId 回退为本次请求 ID', async () => {
  const { cloud } = make();
  const response = await cloud.callFunction({ name: 'hello' });
  assert.equal(response.requestId, 'req-1');
});

test('网关 5xx 按配置重试', async () => {
  let calls = 0;
  const transport = {
    async send() {
      calls += 1;
      if (calls === 1) return { status: 502, data: {}, headers: {} };
      return { status: 200, data: { ok: true }, headers: {} };
    },
  };
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 1, transport });
  const result = await cloud.callFunction({ name: 'hello', idempotent: true });
  assert.equal(calls, 2);
  assert.deepEqual(result.result, { ok: true });
});

test('非幂等调用遇到 5xx 不自动重试，避免云端重复执行', async () => {
  let calls = 0;
  const transport = {
    async send() {
      calls += 1;
      return { status: 502, data: {}, headers: {} };
    },
  };
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 3, transport });
  await assert.rejects(() => cloud.callFunction({ name: 'hello' }), TransportError);
  assert.equal(calls, 1);
});

test('非幂等调用遇到网络错误不自动重试', async () => {
  let calls = 0;
  const transport = {
    async send() {
      calls += 1;
      throw new Error('socket hang up');
    },
  };
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 3, transport });
  await assert.rejects(() => cloud.importObject('music').addFavorite('t1'), /socket hang up/);
  assert.equal(calls, 1);
});

test('importObject 的 idempotentMethods 只让指定方法重试', async () => {
  let calls = 0;
  const transport = {
    async send() {
      calls += 1;
      if (calls === 1) return { status: 503, data: {}, headers: {} };
      return { status: 200, data: { list: [] }, headers: {} };
    },
  };
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 1, transport });
  const music = cloud.importObject('music', { idempotentMethods: ['search'] });
  await music.search('晴天');
  assert.equal(calls, 2);
});

test('importObject 的 defaults 不能覆盖 method / params', async () => {
  const { cloud, transport } = make();
  const api = cloud.importObject('music', { defaults: { method: 'deleteAll', params: ['x'], ver: '1.2' } });
  await api.search('晴天');
  const body = JSON.parse(transport.requests[0].body);
  assert.equal(body.method, 'search');
  assert.deepEqual(body.params, ['晴天']);
  assert.equal(body.ver, '1.2');
});

test('网关持续 5xx 抛出 TransportError', async () => {
  const transport = createMockTransport(() => ({ status: 500, data: {}, headers: {} }));
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 0, transport });
  await assert.rejects(() => cloud.callFunction({ name: 'hello' }), TransportError);
});

test('宿主代理模式：不要求 secretKey，且输出签名材料', async () => {
  let captured;
  const cloud = createClient({
    space: { provider: 'alipay', spaceId: 'env-test', spaceAppId: 'APP', accessKey: 'AK' },
    appId: '__UNI__TEST',
    retries: 0,
    now: () => 1700000000000,
    uuid: () => 'req-1',
    hostDispatcher: async (input) => {
      captured = input;
      return { status: 200, data: { ok: 'from-host' }, headers: { 'x-trace-id': 'host-1' } };
    },
  });

  const result = await cloud.importObject('music').ping();
  assert.deepEqual(result, { ok: 'from-host' });
  assert.equal(captured.material.kind, 'alipay');
  assert.match(captured.material.stringToSign, /^HMAC-SHA256\n/);
  assert.equal(captured.material.credential, 'AK');
  assert.equal(captured.request.headers.Authorization, undefined);
  assert.equal(captured.ctx.requestId, 'req-1');
  assert.equal(cloud.describe().hasSecret, false);
});

test('describe 不泄露密钥', () => {
  const { cloud } = make();
  const info = JSON.stringify(cloud.describe());
  assert.ok(!info.includes('SK'));
  assert.equal(cloud.describe().hostMode, false);
});

test('patchClientInfo 追加自定义字段', async () => {
  const { cloud, transport } = make();
  await cloud.patchClientInfo({ clientBuild: '2026.11.05' });
  await cloud.callFunction({ name: 'hello' });
  assert.equal(JSON.parse(transport.requests[0].body).clientInfo.clientBuild, '2026.11.05');
});
