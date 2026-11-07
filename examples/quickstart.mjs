/**
 * 真实联调脚本：验证桌面 SDK 是否走通 uniCloud 客户端网关。
 *
 * 用法（PowerShell）：
 *   $env:UNICLOUD_SPACE_ID="env-xxxxxxxx"
 *   $env:UNICLOUD_SPACE_APP_ID="..."
 *   $env:UNICLOUD_ACCESS_KEY="..."
 *   $env:UNICLOUD_SECRET_KEY="..."
 *   node examples/quickstart.mjs
 *
 * 成功标志：返回 source === 'client'，且 requestId 由云端生成。
 * 若云端开启了「客户端强制校验」，Web/桌面平台会被拒绝，需先调整该开关。
 */
import { createClient, isUniCloudError } from '../dist/index.js';

const cloud = createClient({
  space: {
    provider: 'alipay',
    spaceId: process.env.UNICLOUD_SPACE_ID ?? '',
    spaceAppId: process.env.UNICLOUD_SPACE_APP_ID,
    accessKey: process.env.UNICLOUD_ACCESS_KEY,
    secretKey: process.env.UNICLOUD_SECRET_KEY,
  },
  appId: process.env.UNICLOUD_APP_ID ?? '__UNI__DESKTOP',
  osName: 'windows',
  uniPlatform: 'web',
  hooks: {
    onRequest: (request) => console.log('→', request.url, request.headers['x-to-function-name']),
  },
});

console.log('连接信息：', cloud.describe());

try {
  const secure = cloud.importObject('secure-test');
  const info = await secure.diagnose();
  console.log('\n诊断结果：', JSON.stringify(info, null, 2));

  if (info?.source === 'client') {
    console.log('\n✅ 已走客户端 SDK 网关协议（source=client），不是 URL 化 HTTP。');
  } else {
    console.log('\n⚠️ 未得到 source=client，请检查凭据、网关路径与云端配置。');
  }
} catch (error) {
  if (isUniCloudError(error)) {
    console.error('\n云端错误：', error.toJSON());
  } else {
    console.error('\n请求失败：', error);
  }
  process.exitCode = 1;
}
