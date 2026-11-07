/**
 * 用本机 HBuilderX 自带的官方 @dcloudio/uni-cloud 离线生成黄金对照报文（不联网）。
 *
 * 用法（PowerShell）：
 *   $env:UNI_PLATFORM="web"; $env:UNI_CLOUD_PROVIDER="[]"
 *   node tools/capture-official-golden.mjs "C:\Program Files\HBuilderX\plugins\uniapp-cli-vite\node_modules\@dcloudio\uni-cloud\dist\uni-cloud.es.js"
 *
 * 原理：把官方 ES 模块复制到临时目录、去掉两个构建期 import，用 mock 的 uni.request / uni.uploadFile 捕获报文。
 * 固定 Date.now 与 Math.random，保证输出可复现；结果用于 test/storage.test.mjs 与 test/golden.test.mjs。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const source = process.argv[2];
if (!source) {
  console.error('usage: node tools/capture-official-golden.mjs <path-to-uni-cloud.es.js>');
  process.exit(1);
}
const code = readFileSync(source, 'utf8').replace(
  'import{UTS as e}from"@dcloudio/uni-shared";import t from"@/pages.json";',
  'const e={};const t={pages:[]};',
);
const dir = mkdtempSync(path.join(tmpdir(), 'unicloud-golden-'));
const target = path.join(dir, 'official.mjs');
writeFileSync(target, code);

const captured = [];
let rnd = 0;
Math.random = () => ((rnd = (rnd + 0.137) % 1), rnd);
Date.now = () => 1700000000000;
const store = {};
let next = {};
globalThis.getCurrentPages = () => [{}];
globalThis.uni = {
  request(o) { captured.push({ kind: 'request', url: o.url, method: o.method, header: o.header, data: o.data }); setTimeout(() => o.complete({ statusCode: 200, header: {}, data: next }), 0); },
  uploadFile(o) { captured.push({ kind: 'upload', url: o.url, name: o.name, formData: o.formData }); setTimeout(() => o.success({ statusCode: 204 }), 0); return {}; },
  getStorageSync: (k) => store[k] ?? '', setStorageSync: (k, v) => { store[k] = v; }, removeStorageSync: (k) => { delete store[k]; },
  getSystemInfoSync: () => ({ appId: '__UNI__DESKTOP', deviceId: 'WIN-DEVICE-001', osName: 'windows', uniPlatform: 'web' }),
  getLocale: () => 'zh-Hans',
};

const { uniCloud } = await import(pathToFileURL(target).href);
const space = uniCloud.init({ provider: 'alipay', spaceId: 'env-golden', spaceAppId: 'SPACE-APP', accessKey: 'AK-EXAMPLE', secretKey: 'SK-EXAMPLE' });

next = { success: true, data: { file_id: 'music/cover.png', upload_url: 'https://oss.example/upload', form_data: [{ key: 'policy', value: 'P' }, { key: 'signature', value: 'S' }] } };
await space.uploadFile({ filePath: '/tmp/cover.png', cloudPath: 'music/cover.png' });
next = { success: true, data: { file_list: [{ file_id: 'music/cover.png', download_url: 'https://cdn.example/cover.png?sig=1' }] } };
await space.getTempFileURL({ fileList: ['cloud://env-golden/music/cover.png'] });

console.log(JSON.stringify(captured, null, 2));
