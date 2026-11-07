import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClient,
  createMockTransport,
  createHostHandler,
  createRemoteClient,
  UniCloudError,
} from '../dist/index.js';

const SPACE = { provider: 'alipay', spaceId: 'env-test', spaceAppId: 'APP', accessKey: 'AK', secretKey: 'SK' };

function setup(handlerResponse = () => ({ status: 200, data: { list: ['a'] }, headers: { 'x-trace-id': 't-1' } })) {
  const transport = createMockTransport(handlerResponse);
  const client = createClient({ space: SPACE, appId: '__UNI__TEST', deviceId: 'D', osName: 'windows', retries: 0, transport });
  const handle = createHostHandler(client, {
    objects: { music: ['search', 'getLyric'] },
    functions: ['hello'],
    storage: { tempFileURL: true, upload: { pathPrefixes: ['user-upload/'], maxBytes: 1024 } },
  });
  // 模拟 IPC：结构化克隆（与 Electron ipcRenderer.invoke 相同语义）
  const remote = createRemoteClient(async (call) => structuredClone(await handle(structuredClone(call))));
  return { transport, handle, remote };
}

test('远程客户端写法与 createClient 一致，请求由宿主签名发出', async () => {
  const { transport, remote } = setup();
  const music = remote.importObject('music');
  assert.equal(music.then, undefined);
  assert.deepEqual(await music.search('晴天'), { list: ['a'] });
  const sent = transport.requests[0];
  assert.match(sent.headers.Authorization, /^HMAC-SHA256 Credential=AK/);
  assert.deepEqual(JSON.parse(sent.body).params, ['晴天']);
});

test('白名单外的对象或方法被拒绝，且不发出任何请求', async () => {
  const { transport, remote } = setup();
  await assert.rejects(() => remote.importObject('music').deleteAll(), (e) => e.errCode === 'BRIDGE_NOT_ALLOWED');
  await assert.rejects(() => remote.importObject('admin').search(), (e) => e.errCode === 'BRIDGE_NOT_ALLOWED');
  await assert.rejects(() => remote.callFunction('other'), (e) => e.errCode === 'BRIDGE_NOT_ALLOWED');
  assert.equal(transport.requests.length, 0);
});

test('私有方法、非法名字、原型链键都会被拒绝', async () => {
  const { transport, handle } = setup();
  for (const call of [
    { kind: 'object', object: 'music', method: '_before', args: [] },
    { kind: 'object', object: 'music', method: 'constructor', args: [] },
    { kind: 'object', object: '__proto__', method: 'search', args: [] },
    { kind: 'object', object: 'music', method: 'search', args: 'not-array' },
    { kind: 'function', name: 'hello', data: [1, 2] },
    { kind: 'raw', url: 'https://evil.example', stringToSign: 'x' },
    null,
    'string',
  ]) {
    const response = await handle(call);
    assert.equal(response.ok, false, JSON.stringify(call));
  }
  assert.equal(transport.requests.length, 0);
});

test('超大参数被拒绝', async () => {
  const { transport, handle } = setup();
  const response = await handle({ kind: 'object', object: 'music', method: 'search', args: ['x'.repeat(300 * 1024)] });
  assert.equal(response.ok, false);
  assert.equal(response.error.errCode, 'BRIDGE_PAYLOAD_TOO_LARGE');
  assert.equal(transport.requests.length, 0);
});

test('业务错误码与 requestId 能穿过 IPC 还原为 UniCloudError', async () => {
  const { remote } = setup(() => ({
    status: 200,
    data: { errCode: 'NEED_LOGIN', errMsg: '请先登录' },
    headers: { 'x-trace-id': 'trace-9' },
  }));
  await assert.rejects(
    () => remote.importObject('music').getLyric('1'),
    (error) => {
      assert.ok(error instanceof UniCloudError);
      assert.equal(error.errCode, 'NEED_LOGIN');
      assert.equal(error.requestId, 'trace-9');
      return true;
    },
  );
});

test('宿主内部异常不向前端泄露细节', async () => {
  const { handle } = setup(() => {
    throw new Error('C:\\secret\\path leaked SK=abc');
  });
  const response = await handle({ kind: 'function', name: 'hello' });
  assert.equal(response.ok, false);
  assert.equal(response.error.errCode, 'HOST_ERROR');
  assert.ok(!JSON.stringify(response).includes('secret'));
});

test('callFunction 走白名单并返回结果', async () => {
  const { transport, remote } = setup();
  assert.deepEqual(await remote.callFunction('hello', { a: 1 }), { list: ['a'] });
  assert.equal(JSON.parse(transport.requests[0].body).a, 1);
});

test('存储：默认关闭；上传只允许白名单前缀与大小', async () => {
  const transport = createMockTransport(() => ({ status: 200, headers: {}, data: { success: true, data: { file_id: 'user-upload/a.png', upload_url: 'https://oss.example', form_data: [] } } }));
  const uploads = [];
  const client = createClient({
    space: SPACE, appId: '__UNI__TEST', retries: 0, transport,
    uploader: { async upload(i) { uploads.push(i); return { status: 204 }; } },
  });
  const closed = createHostHandler(client, { objects: {} });
  assert.equal((await closed({ kind: 'storage', op: 'getTempFileURL', fileList: ['a'] })).error.errCode, 'BRIDGE_NOT_ALLOWED');
  assert.equal((await closed({ kind: 'storage', op: 'uploadFile', cloudPath: 'user-upload/a.png', file: new Uint8Array(1) })).error.errCode, 'BRIDGE_NOT_ALLOWED');

  const handle = createHostHandler(client, { storage: { upload: { pathPrefixes: ['user-upload/'], maxBytes: 4 } } });
  const remote = createRemoteClient(async (call) => structuredClone(await handle(structuredClone(call))));
  assert.deepEqual(await remote.uploadFile({ cloudPath: 'user-upload/a.png', file: new Uint8Array([1, 2]) }), { fileID: 'user-upload/a.png' });
  assert.equal(uploads.length, 1);

  for (const [call, code] of [
    [{ cloudPath: 'covers/a.png', file: new Uint8Array(1) }, 'BRIDGE_NOT_ALLOWED'],
    [{ cloudPath: 'user-upload/../covers/a.png', file: new Uint8Array(1) }, 'BRIDGE_INVALID_CALL'],
    [{ cloudPath: 'user-upload/a.png', file: new Uint8Array(5) }, 'BRIDGE_PAYLOAD_TOO_LARGE'],
    [{ cloudPath: 'user-upload/a.png', file: 'not-bytes' }, 'BRIDGE_INVALID_CALL'],
  ]) {
    await assert.rejects(() => remote.uploadFile(call), (e) => e.errCode === code, JSON.stringify(call.cloudPath));
  }
  assert.equal(uploads.length, 1);
});

test('errSubject 能穿过 IPC', async () => {
  const { remote } = setup(() => ({ status: 200, data: { errCode: 'uni-id-token-expired', errMsg: 'expired', errSubject: 'uni-id' }, headers: {} }));
  await assert.rejects(() => remote.importObject('music').search('x'), (e) => e.errSubject === 'uni-id');
});

test('uni-id 登录经宿主桥：宿主保存 token，前端拿不到；session 状态与退出登录', async () => {
  const transport = createMockTransport(() => ({
    status: 200,
    headers: {},
    data: {
      errCode: 0,
      uid: 'u1',
      token: 'LEGACY-TOKEN',
      newToken: { token: 'TOKEN-1', tokenExpired: 4102444800000 },
      userInfo: { nickname: 'n', uniIdToken: 'X' },
      uploadFileOptions: { formData: { token: 'QINIU-UPLOAD-TOKEN' } },
    },
  }));
  const client = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 0, transport });
  const handle = createHostHandler(client, { objects: { 'uni-id-co': ['login'] } });
  const remote = createRemoteClient(async (call) => structuredClone(await handle(structuredClone(call))));

  const res = await remote.importObject('uni-id-co').login({ username: 'a', password: 'b' });
  assert.equal(res.uid, 'u1');
  assert.equal(res.token, undefined);
  assert.equal(res.newToken, undefined);
  assert.equal(res.userInfo.uniIdToken, undefined);
  assert.equal(res.uploadFileOptions.formData.token, 'QINIU-UPLOAD-TOKEN', '业务字段 formData.token 不受影响');
  assert.equal((await client.getTokenInfo()).token, 'TOKEN-1', '宿主已保存 token');

  assert.deepEqual(await remote.getSession(), { loggedIn: true, tokenExpired: 4102444800000, deviceId: null });
  await remote.logout();
  assert.equal((await remote.getSession()).loggedIn, false);
  assert.equal(await client.getTokenInfo(), null);
});

test('exposeTokens: true 时原样返回（仅在明确需要时使用）', async () => {
  const transport = createMockTransport(() => ({ status: 200, headers: {}, data: { errCode: 0, newToken: { token: 'T', tokenExpired: 1 } } }));
  const client = createClient({ space: SPACE, appId: '__UNI__TEST', retries: 0, transport });
  const handle = createHostHandler(client, { objects: { 'uni-id-co': ['login'] }, exposeTokens: true });
  const res = await handle({ kind: 'object', object: 'uni-id-co', method: 'login', args: [] });
  assert.equal(res.result.newToken.token, 'T');
});
