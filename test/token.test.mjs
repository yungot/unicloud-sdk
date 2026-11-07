import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createMockTransport, createMemoryTokenStore } from '../dist/index.js';

const SPACE = { provider: 'alipay', spaceId: 'env-test', spaceAppId: 'APP', accessKey: 'AK', secretKey: 'SK' };

test('云端下发 newToken 时自动保存、回调，并在下一次请求中上行（与官方一致）', async () => {
  let n = 0;
  const transport = createMockTransport(() => {
    n += 1;
    return n === 1
      ? { status: 200, headers: {}, data: { errCode: 0, list: [], newToken: { token: 'T2', tokenExpired: 1800000000000 } } }
      : { status: 200, headers: {}, data: { errCode: 0 } };
  });
  const refreshed = [];
  const store = createMemoryTokenStore();
  const cloud = createClient({
    space: SPACE, appId: '__UNI__TEST', retries: 0, transport, tokenStore: store,
    uniIdToken: 'T1', onTokenRefresh: (info) => refreshed.push(info),
  });
  const music = cloud.importObject('music');
  await music.search('a');
  assert.equal(JSON.parse(transport.requests[0].body).uniIdToken, 'T1');
  assert.deepEqual(refreshed, [{ token: 'T2', tokenExpired: 1800000000000 }]);
  assert.deepEqual(await cloud.getTokenInfo(), { token: 'T2', tokenExpired: 1800000000000 });

  await music.search('b');
  assert.equal(JSON.parse(transport.requests[1].body).uniIdToken, 'T2');
});

test('调用方显式传入的 uniIdToken 不被覆盖（与官方一致）', async () => {
  const transport = createMockTransport(() => ({ status: 200, headers: {}, data: {} }));
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 0, transport, uniIdToken: 'STORED' });
  await cloud.callFunction({ name: 'f', data: { uniIdToken: 'EXPLICIT' } });
  assert.equal(JSON.parse(transport.requests[0].body).uniIdToken, 'EXPLICIT');
});

test('setUniIdToken(undefined) 退出登录，之后请求不再携带 token', async () => {
  const transport = createMockTransport(() => ({ status: 200, headers: {}, data: {} }));
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 0, transport, uniIdToken: 'T1' });
  await cloud.setUniIdToken(undefined);
  await cloud.callFunction({ name: 'f' });
  assert.equal(JSON.parse(transport.requests[0].body).uniIdToken, undefined);
  assert.equal(await cloud.getTokenInfo(), null);
});

test('isTokenExpired 按 tokenExpired 本地判断', async () => {
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', now: () => 2000, transport: createMockTransport(() => ({ status: 200, headers: {}, data: {} })) });
  assert.equal(await cloud.isTokenExpired(), true);
  await cloud.setUniIdToken('T', 1000);
  assert.equal(await cloud.isTokenExpired(), true);
  await cloud.setUniIdToken('T', 3000);
  assert.equal(await cloud.isTokenExpired(), false);
});

test('不完整的 newToken 被忽略', async () => {
  const transport = createMockTransport(() => ({ status: 200, headers: {}, data: { newToken: { token: 'X' } } }));
  const cloud = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 0, transport, uniIdToken: 'T1' });
  await cloud.callFunction({ name: 'f' });
  assert.equal((await cloud.getTokenInfo()).token, 'T1');
});
