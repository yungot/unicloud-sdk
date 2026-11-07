import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createMockTransport } from '../dist/index.js';

/**
 * 黄金对照：这些值来自本机 HBuilderX 官方 `@dcloudio/uni-cloud` 客户端运行时
 * 在相同配置下真实生成的请求报文（未发往云端，仅用 mock uni.request 捕获）。
 * 若本协议层与之逐字节一致，说明签名与报文格式没有偏差。
 */
const OFFICIAL = {
  url: 'https://env-golden.api-hz.cloudbasefunction.cn/functions/invokeFunction',
  method: 'POST',
  authorization:
    'HMAC-SHA256 Credential=AK-EXAMPLE, ' +
    'SignedHeaders=x-client-timestamp;x-from-app-id;x-from-env-id;x-from-function-name;x-from-instance-id;x-to-env-id;x-to-function-name, ' +
    'Signature=768f96c96d80d89bda90bd21c596d838ee5f7a109dd9db8d34c7e0d87d176531',
  body: {
    method: 'search',
    params: ['晴天'],
    clientInfo: {
      PLATFORM: 'web',
      OS: 'windows',
      APPID: '__UNI__DESKTOP',
      DEVICEID: 'WIN-DEVICE-001',
      deviceId: 'WIN-DEVICE-001',
      osName: 'windows',
      uniPlatform: 'web',
      appId: '__UNI__DESKTOP',
      appVersion: '1.0.0',
      appVersionCode: '100',
      appLanguage: 'zh-Hans',
      ua: 'Desktop/1.0',
      locale: 'zh-Hans',
      LOCALE: 'zh-Hans',
    },
  },
};

function makeClient(transport) {
  return createClient({
    space: {
      provider: 'alipay',
      spaceId: 'env-golden',
      spaceAppId: 'SP-APP-ID',
      accessKey: 'AK-EXAMPLE',
      secretKey: 'SK-EXAMPLE',
    },
    appId: '__UNI__DESKTOP',
    deviceId: 'WIN-DEVICE-001',
    osName: 'windows',
    uniPlatform: 'web',
    locale: 'zh-Hans',
    appVersion: '1.0.0',
    appVersionCode: '100',
    userAgent: 'Desktop/1.0',
    now: () => 1793876781338,
    uuid: () => 'e12053af-4813-4c37-bafc-3684c724ed29',
    retries: 0,
    transport,
  });
}

test('云对象请求的 URL、报文与官方 SDK 一致', async () => {
  const transport = createMockTransport(() => ({
    status: 200,
    data: { ok: true },
    headers: { 'x-trace-id': 'trace-1' },
  }));
  const cloud = makeClient(transport);
  const music = cloud.importObject('music');

  const result = await music.search('晴天');
  assert.deepEqual(result, { ok: true });

  const request = transport.requests[0];
  assert.equal(request.url, OFFICIAL.url);
  assert.equal(request.method, OFFICIAL.method);
  assert.deepEqual(JSON.parse(request.body), OFFICIAL.body);
});

test('HMAC-SHA256 签名与官方 SDK 逐字节一致', async () => {
  const transport = createMockTransport(() => ({ status: 200, data: {}, headers: {} }));
  await makeClient(transport).importObject('music').search('晴天');

  const headers = transport.requests[0].headers;
  assert.equal(headers.Authorization, OFFICIAL.authorization);
  assert.equal(headers['x-alipay-source'], 'client');
  assert.equal(headers['x-to-function-name'], 'music');
  assert.equal(headers['x-from-env-id'], 'env-golden');
  assert.equal(headers['x-client-timestamp'], '1793876781338');
});
