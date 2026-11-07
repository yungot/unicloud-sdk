import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultEndpoint, resolveSpace, spaceFromEnv } from '../dist/index.js';

test('支付宝云端点由 spaceId 推导', () => {
  assert.equal(defaultEndpoint('alipay', 'env-abc'), 'https://env-abc.api-hz.cloudbasefunction.cn');
});

test('阿里云端点区分新旧空间', () => {
  assert.equal(defaultEndpoint('aliyun', 'mp-abc'), 'https://api.next.bspapp.com');
  assert.equal(defaultEndpoint('aliyun', 'env-abc'), 'https://api.bspapp.com');
});

test('环境变量可构造空间配置', () => {
  const config = spaceFromEnv({
    UNICLOUD_PROVIDER: 'alipay',
    UNICLOUD_SPACE_ID: 'env-from-env',
    UNICLOUD_SPACE_APP_ID: 'APP',
    UNICLOUD_ACCESS_KEY: 'AK',
    UNICLOUD_SECRET_KEY: 'SK',
  });
  assert.equal(config.spaceId, 'env-from-env');
  assert.equal(config.secretKey, 'SK');
});

test('缺少必填凭据时明确报错', () => {
  assert.throws(
    () => resolveSpace({ spaceId: 'env-x' }, {}),
    /alipay space requires/,
  );
  assert.throws(() => resolveSpace({ spaceId: '' }, {}), /spaceId is required/);
});

test('宿主签名模式允许省略密钥', () => {
  const resolved = resolveSpace(
    { provider: 'alipay', spaceId: 'env-x', spaceAppId: 'APP', accessKey: 'AK' },
    {},
    { skipSecretCheck: true },
  );
  assert.equal(resolved.endpoint, 'https://env-x.api-hz.cloudbasefunction.cn');
  assert.equal(resolved.secretKey, undefined);
});

test('显式 endpoint 优先', () => {
  const resolved = resolveSpace(
    {
      provider: 'alipay',
      spaceId: 'env-x',
      spaceAppId: 'APP',
      accessKey: 'AK',
      secretKey: 'SK',
      endpoint: 'https://my-domain.example',
    },
    {},
  );
  assert.equal(resolved.endpoint, 'https://my-domain.example');
});
