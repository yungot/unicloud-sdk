import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createMockTransport, uploadWithOptions, normalizeCloudPath, UniCloudError } from '../dist/index.js';

/**
 * 黄金对照：以下请求由本机 HBuilderX 官方 @dcloudio/uni-cloud（3.0.0-alpha-5020720260921001）
 * 在 mock uni.request / uni.uploadFile 下离线生成，未发往云端。
 * 配置：spaceId=env-golden, spaceAppId=SPACE-APP, AK-EXAMPLE / SK-EXAMPLE, Date.now()=1700000000000
 */
const GOLDEN = {
  upload: {
    requestId: '2468adf1-358a-4ce0-b579-be02468bdf13',
    url: 'https://env-golden.api-hz.cloudbasefunction.cn/music/cover.png?post_url',
    method: 'GET',
    authorization:
      'HMAC-SHA256 Credential=AK-EXAMPLE, SignedHeaders=x-client-timestamp;x-data-api-type;x-expire-timestamp;x-from-app-id;x-from-env-id;x-from-function-name;x-from-instance-id;x-to-env-id, Signature=9119acebacab9e5d302a0e07acc0d725b4a4096b7557a66596f3e08fafe511a4',
  },
  tempUrl: {
    requestId: '68ace135-79ce-4024-b9bd-f1468acf1357',
    url: 'https://env-golden.api-hz.cloudbasefunction.cn/?download_url',
    method: 'POST',
    body: '{"file_list":[{"file_id":"music/cover.png","expire":600}]}',
    authorization:
      'HMAC-SHA256 Credential=AK-EXAMPLE, SignedHeaders=x-client-timestamp;x-data-api-type;x-expire-timestamp;x-from-app-id;x-from-env-id;x-from-function-name;x-from-instance-id;x-to-env-id, Signature=427b87ebcb3697c60cbb0925baa5b0b5f666eefc80f194bb0b5cad409902ccde',
  },
};

const SPACE = { provider: 'alipay', spaceId: 'env-golden', spaceAppId: 'SPACE-APP', accessKey: 'AK-EXAMPLE', secretKey: 'SK-EXAMPLE' };

function makeClient(responses, ids) {
  const queue = [...responses];
  const transport = createMockTransport(() => queue.shift());
  const uploads = [];
  const uploader = { async upload(input) { uploads.push(input); return { status: 204 }; } };
  const idQueue = [...ids];
  const cloud = createClient({
    space: SPACE, appId: '__UNI__DESKTOP', deviceId: 'D', osName: 'windows',
    now: () => 1700000000000, uuid: () => idQueue.shift(), retries: 0, transport, uploader,
  });
  return { cloud, transport, uploads };
}

test('uploadFile：获取上传地址的请求与官方逐字节一致，并按下发表单直传', async () => {
  const { cloud, transport, uploads } = makeClient(
    [{ status: 200, headers: {}, data: { success: true, data: { file_id: 'music/cover.png', upload_url: 'https://oss.example/upload', form_data: [{ key: 'policy', value: 'P' }, { key: 'signature', value: 'S' }] } } }],
    [GOLDEN.upload.requestId],
  );
  const file = new Uint8Array([1, 2, 3]);
  const result = await cloud.uploadFile({ cloudPath: 'music/cover.png', file, contentType: 'image/png' });
  assert.deepEqual(result, { fileID: 'music/cover.png' });

  const req = transport.requests[0];
  assert.equal(req.url, GOLDEN.upload.url);
  assert.equal(req.method, 'GET');
  assert.equal(req.body, undefined);
  assert.equal(req.headers.Authorization, GOLDEN.upload.authorization);
  assert.equal(req.headers['x-expire-timestamp'], '1700000060000');
  assert.equal(req.headers['x-alipay-cloud-mode'], 'oss');

  assert.equal(uploads[0].url, 'https://oss.example/upload');
  assert.equal(uploads[0].fieldName, 'file');
  assert.deepEqual(uploads[0].formData, { policy: 'P', signature: 'S' });
  assert.equal(uploads[0].fileName, 'cover.png');
  assert.equal(uploads[0].file, file);
});

test('getTempFileURL：请求与官方逐字节一致，fileID 规范为 cloud:// 形式', async () => {
  const { cloud, transport } = makeClient(
    [{ status: 200, headers: {}, data: { success: true, data: { file_list: [{ file_id: 'music/cover.png', download_url: 'https://cdn.example/cover.png?sig=1' }] } } }],
    [GOLDEN.tempUrl.requestId],
  );
  const result = await cloud.getTempFileURL({ fileList: ['cloud://env-golden/music/cover.png'] });
  assert.deepEqual(result, { fileList: [{ fileID: 'cloud://env-golden/music/cover.png', tempFileURL: 'https://cdn.example/cover.png?sig=1' }] });

  const req = transport.requests[0];
  assert.equal(req.url, GOLDEN.tempUrl.url);
  assert.equal(req.method, 'POST');
  assert.equal(req.body, GOLDEN.tempUrl.body);
  assert.equal(req.headers.Authorization, GOLDEN.tempUrl.authorization);
});

test('存储网关返回 success:false 时抛 UniCloudError', async () => {
  const { cloud } = makeClient([{ status: 200, headers: {}, data: { success: false, errCode: 'NO_PERMISSION', errMsg: 'denied' } }], ['r']);
  await assert.rejects(() => cloud.getTempFileURL({ fileList: ['a.png'] }), (e) => e.errCode === 'NO_PERMISSION');
});

test('getTempFileURL 参数校验：空数组、超过 50 个、其他空间的 fileID', async () => {
  const { cloud, transport } = makeClient([], []);
  await assert.rejects(() => cloud.getTempFileURL({ fileList: [] }), (e) => e.errCode === 'INVALID_PARAM');
  await assert.rejects(() => cloud.getTempFileURL({ fileList: Array(51).fill('a.png') }), (e) => e.errCode === 'INVALID_PARAM');
  await assert.rejects(() => cloud.getTempFileURL({ fileList: ['cloud://env-other/a.png'] }), (e) => e.errCode === 'INVALID_PARAM');
  assert.equal(transport.requests.length, 0);
});

test('cloudPath 校验：拒绝空、协议、.. 段、空段和不允许的字符', () => {
  assert.equal(normalizeCloudPath('/music/封面.png'), 'music/封面.png');
  for (const bad of ['', '   ', 'http://x/a.png', 'a/../b.png', 'a//b.png', 'a b.png', 'a?b.png', 'a#b', 42]) {
    assert.throws(() => normalizeCloudPath(bad), UniCloudError, String(bad));
  }
});

test('deleteFile 在客户端明确不支持（与官方支付宝云一致）', async () => {
  const { cloud } = makeClient([], []);
  await assert.rejects(() => cloud.deleteFile({ fileList: ['a.png'] }), (e) => e.errCode === 'UNSUPPORTED');
});

test('uploadWithOptions：按云对象下发的参数直传（扩展存储）', async () => {
  const calls = [];
  const uploader = { async upload(input) { calls.push(input); return { status: 200 }; } };
  await uploadWithOptions(
    { uploadFileOptions: { url: 'https://upload.qiniup.com', name: 'file', formData: { token: 'T', key: 'k/1.mp3' } }, file: new Uint8Array([9]), fileName: '1.mp3' },
    uploader,
  );
  assert.deepEqual(calls[0].formData, { token: 'T', key: 'k/1.mp3' });
  assert.equal(calls[0].fieldName, 'file');

  await assert.rejects(
    () => uploadWithOptions({ uploadFileOptions: { url: 'http://insecure', name: 'file' }, file: new Uint8Array(1) }, uploader),
    (e) => e.errCode === 'INVALID_PARAM',
  );
  const failing = { async upload() { return { status: 403 }; } };
  await assert.rejects(
    () => uploadWithOptions({ uploadFileOptions: { url: 'https://u', name: 'file' }, file: new Uint8Array(1) }, failing),
    (e) => e.errCode === 'UPLOAD_FAILED',
  );
});
