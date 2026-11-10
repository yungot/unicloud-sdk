# unicloud-sdk

> 本项目独立实现 uniCloud 客户端协议，与 DCloud 无隶属或背书关系；uniCloud、uni-app、uni-id 为 DCloud 的产品与商标。

> 轻量的 uniCloud 客户端 SDK，适用于**桌面应用**（Windows / macOS / Linux）、**Web 网页**和 **Node.js**。
> 零运行时依赖 · 无需 HBuilderX 编译 · TypeScript 类型完整 · 桌面端额外提供宿主隔离与设备级请求签名。

让任何 JavaScript / TypeScript 项目像 uni-app 一样直接调用云对象：

```ts
const uniCloud = createClient({ /* 服务空间配置，见 §3 */ })

const todo = uniCloud.importObject('todo') //第一步导入云对象
const res = await todo.add('title demo', 'content demo') //导入云对象后就可以直接调用该对象的方法了
```

底层走 **uniCloud 客户端网关协议**（`source = client`），不是云函数 URL 化 / HTTP 访问服务，也不是自己拼一套 REST 接口。

> 完整配置说明、API 参考、运行模式、排障与二次开发指南见 [DEVELOPMENT.md](DEVELOPMENT.md)，本文为速查。

---

## 0. 我们做到了什么

用 HBuilderX 开发的 uni-app 项目，无论发布成 Web 还是安卓，都能直接 `uniCloud.importObject()` 调用云对象——因为 HBuilderX 编译时把官方客户端库 `@dcloudio/uni-cloud` 和服务空间配置一起打包进去了。**不经过 HBuilderX 编译的项目**（Electron 桌面程序、Vite/Vue/React 网页、Node 脚本）原来拿不到这套库，只能把云函数 URL 化后用 HTTP 调用。

本 SDK 重新实现了**同一套客户端协议**，让任何 JS/TS 项目都能像 uni-app 一样直接调用云对象：

```ts
const todo = uniCloud.importObject('todo') //第一步导入云对象
const res = await todo.add('title demo', 'content demo') //导入云对象后就可以直接调用该对象的方法了
```

写法与 uni-app 官方示例完全相同，不需要 URL 化。

### 与官方 uni-app 内置 SDK 对比

| 能力 | 官方（HBuilderX 编译的 uni-app） | 本 SDK | 说明 |
|---|---|---|---|
| 客户端网关协议 | ✅ | ✅ 相同 | 签名与官方逐字节一致（离线黄金对照 + 真实环境验证） |
| 云对象 `importObject` / 云函数 `callFunction` | ✅ | ✅ | 错误语义与官方一致 |
| 云存储 | ✅ | ✅ | 内置存储上传 / 临时链接；扩展存储（七牛）云端下发参数直传 |
| uni-id 登录态与自动续期 | ✅ | ✅ | 兼容 uni-id，不封装其业务接口；桌面端 token 只在主进程（§5.2，未实测） |
| 服务空间配置 | 编译时自动注入 | 配置 / 环境变量 | 桌面端凭据只放主进程 |
| 设备身份与请求签名 | — | ✅ | 每台设备一把私钥，每个请求带设备证明（§6） |
| 宿主隔离（页面拿不到密钥） | — | ✅ | 宿主桥：渲染进程只能调用白名单方法 |
| 安全网络（SecureNetwork） | ✅ 仅 Android / iOS / 微信小程序 | ❌ | DCloud 未开放桌面与 Web |
| clientDB（前端直接查库） | ✅ | ❌ 有意不做 | 桌面 / Web 密钥可被提取，读写统一放进云对象更可控 |
| 现成 UI（登录页、选择并上传文件） | ✅ | ❌ | 桌面端自行实现界面 |

### 安全层级对比

| 层级 | 方式 | 客户端身份 | 能防住什么 |
|:-:|---|---|---|
| 1 | 云函数 URL 化 + HTTP | 无签名 | 只靠你自己写的校验 |
| 2 | 官方 H5 ≈ 本 SDK 在浏览器 | 网关签名，密钥在页面 JS 里 | 随手构造的请求 |
| 3 | 本 SDK 在桌面端 + 宿主桥 | 密钥只在主进程 | 页面脚本 / XSS 盗用签名 |
| 4 | **本 SDK 在桌面端 + 宿主桥 + 设备身份**（在第 3 层之上叠加，推荐） | 每台设备独立私钥（系统加密保存） | 脚本直接调接口、重放、盗用 token；可逐台吊销 |
| 5 | 官方 App + 安全网络 | 平台背书的应用身份 | 以上全部 + 证明「是正版程序」 |

各层是逐层叠加的关系：第 4 层 = 第 3 层（宿主桥）+ 设备身份。第 2～4 层的空间客户端密钥都能从安装包中提取（没开安全网络的官方 App 也一样），所以**真正的安全边界在云端**：每个云对象都要校验设备证明和登录态（用 `protectCloudObject`，见 §6）。第 4 层与第 5 层的差别在于桌面端没有平台为「正版程序」背书，需要靠账号绑定与风控弥补。

### 验证状态

| 阶段 | 内容 | 结果 |
|---|---|---|
| S0 | 工程整顿、宿主桥、幂等重试 | ✅ |
| S1 | 云存储、uni-id 续期、官方错误语义（官方运行时离线黄金对照） | ✅ |
| S2 | **真实服务空间**：Windows 直调云对象、扩展存储上传下载 | ✅ 5/5 |
| S3 | **真实服务空间**：设备自动登记、请求签名、重放拦截、错误码回传 | ✅ 6/6 |
| S4 | uni-id 兼容（宿主桥隐藏 token、登录态持久化、云端 uid 解析） | ✅ 离线 62/62 · 未实测 |
| 实战 | **真实项目**：迷笛音乐（Electron 桌面播放器）全部在线功能，含宿主桥、设备身份、safeStorage、登录态携带、打包安装版 | ✅ 无需改动 SDK |

---

## 1. 定位与边界

| 能力 | 支持 |
|---|---|
| `importObject()` 直调云对象、`callFunction()` 直调云函数 | ✅ 真实环境已验证 |
| 上报客户端身份 `appId / deviceId / osName / uniPlatform`，云端 `getClientInfo()` 可读 | ✅ |
| uni-id 登录态与自动续期、拦截器、超时、幂等重试、错误规范化 | ✅ |
| 云存储：内置存储上传 / 临时链接，扩展存储直传 | ✅ |
| 设备身份：设备密钥、登记、请求签名、防重放、吊销 | ✅ |
| 支付宝云服务空间（如 `env-xxx.api-hz.cloudbasefunction.cn`） | ✅ 已按官方 SDK 逐字节验证 |
| 阿里云 / 腾讯云空间 | ⚠️ 实验实现，未做真实联调 |
| **uniCloud SecureNetwork**（`secretType=both`、客户端强制校验、双向加密） | ❌ **不支持，也不打算模拟** |

最后一条很重要：DCloud 官方安全网络只支持 App 与微信小程序，Web ✗，且 App 端加密全部依赖 `plus` 原生插件、配置由云打包注入。桌面端无法合法取得该身份。本 SDK **不伪造 `secretType`、不盗用设备密钥、不绕过服务端校验**。

替代方案是我们自己的设备身份（见 §6）：设备私钥 + 每个请求的设备证明，在云端 `_before` 统一校验。使用本 SDK 的服务空间需**关闭「客户端校验」**（或用自定义规则排除桌面端使用的云对象）。

> 术语澄清：客户端 SDK 底层本来就是 HTTPS POST。「不走 HTTP 云访问」准确说是**不走 URL 化路由**——区别在于入口、报文和身份模型，而不在传输协议。

---

## 2. 安装

在你的项目（如 Electron 工程）中安装：

```bash
# 方式一：从 npm 安装（发布到 npm 后可用）
npm install @yungot/unicloud-sdk

# 方式二：直接从 GitHub 安装（安装时自动编译）
npm install github:yungot/unicloud-sdk
```

代码里统一这样引入：

```ts
import { createClient } from '@yungot/unicloud-sdk'
```

`@yungot/unicloud-sdk` 是包名：`@yungot` 是作者的命名空间，`unicloud-sdk` 是包本身的名字。用命名空间可以避免与他人的包重名，也表明这不是 DCloud 官方包。

要求：Node ≥ 20（Electron 主进程即满足），或任意带 WebCrypto 的 WebView。运行时**没有任何 npm 依赖**。

### 从源码构建

```bash
git clone https://github.com/yungot/unicloud-sdk.git
cd unicloud-sdk
npm install          # 只有 typescript 一个开发依赖
npm run build        # 输出 dist/*.js + *.d.ts
npm test             # 62 项单测，含与官方 SDK 的调用与云存储签名黄金对照
```

---

## 3. 快速开始

### 3.1 本地脚本 / Node 工具

```js
import { createClient } from '@yungot/unicloud-sdk'

const cloud = createClient({
  space: {
    provider: 'alipay',
    spaceId: 'env-xxxxxxxx',
    spaceAppId: process.env.UNICLOUD_SPACE_APP_ID,
    accessKey: process.env.UNICLOUD_ACCESS_KEY,
    secretKey: process.env.UNICLOUD_SECRET_KEY,
  },
  appId: '__UNI__YOUR_APP',
  osName: 'windows',
})

const greeter = cloud.importObject('greeter')
console.log(await greeter.hello('desktop'))
```

凭据也能全部走环境变量：`UNICLOUD_PROVIDER / UNICLOUD_SPACE_ID / UNICLOUD_SPACE_APP_ID / UNICLOUD_ACCESS_KEY / UNICLOUD_SECRET_KEY / UNICLOUD_ENDPOINT / UNICLOUD_DEVICE_ID`。

### 3.2 Electron 桌面程序（推荐写法：宿主桥）

Electron 程序分两部分：**主进程**（Node 环境，看不到界面）和**渲染进程**（显示界面的网页）。网页里的代码最容易被注入脚本或被调试工具查看，所以：

- 服务空间凭据、登录 token、设备私钥**只放在主进程**；
- 网页通过「宿主桥」请主进程代为调用，而且只能调用主进程**白名单**里的云对象方法。

网页里的写法和 uni-app 一样，区别只是 `uniCloud` 的来源：

```ts
// 主进程：持有凭据，按白名单代为调用
import { createClient, createHostHandler } from '@yungot/unicloud-sdk'
const uniCloud = createClient({ /* 凭据只在这里 */ })
const handle = createHostHandler(uniCloud, {
  objects: { todo: ['add', 'list'] },        // 网页能调用的方法
  idempotent: { todo: ['list'] },            // 只读方法，网络波动时可自动重试
})
ipcMain.handle('cloud:call', (_e, call) => handle(call))

// preload：只暴露一个通道
contextBridge.exposeInMainWorld('cloud', { call: (c) => ipcRenderer.invoke('cloud:call', c) })

// 渲染进程（网页）：写法与 uni-app 相同
import { createRemoteClient } from '@yungot/unicloud-sdk'
const uniCloud = createRemoteClient((c) => window.cloud.call(c))
const todo = uniCloud.importObject('todo')
const res = await todo.add('title demo', 'content demo')
```

宿主桥会拒绝：白名单外的对象和方法、`_` 开头的私有方法、非法名字、超大参数。错误码和 requestId 会原样传回网页；主进程内部的异常细节不会外泄；uni-id 登录返回的 token 由主进程保存，不会交给网页（§5.2）。完整示例见 [`examples/electron-main.mjs`](examples/electron-main.mjs)。

### 3.3 Tauri 等其他桌面框架

**能用，但安全等级不同。** 关键看框架的后台是不是 JavaScript：

| 框架 | 后台语言 | 能否使用本 SDK | 安全等级（§0） |
|---|---|---|---|
| Electron | Node.js | ✅ 完整支持：主进程持有凭据 + 宿主桥 + 设备身份 | 第 4 层 |
| NW.js 等 Node 系框架 | Node.js | ✅ 同 Electron 方式 | 第 4 层 |
| Tauri、Wails（Go）、Flutter、Qt 等 | 非 JavaScript | ✅ 可以在界面（WebView）里直接运行 SDK | 第 2 层，与官方 H5 相同：密钥在网页里 |

非 JS 后台的框架里，SDK 只能跑在网页那一侧，调用云对象、云存储、uni-id 都正常，缺的只是「把凭据藏进后台」这一层隔离。注意两点：

- WebView 访问云端可能受跨域限制：在 uniCloud 控制台「跨域配置」里加入框架的页面来源（如 Tauri 的 `tauri://localhost` / `http://tauri.localhost`），或通过 `transport` 选项改用框架自带的 HTTP 能力（如 Tauri 的 http 插件）。
- 早期提供的 `hostDispatcher`（网页构造请求、后台负责签名）**已弃用**：后台会对网页传来的任意内容签名，等于把签名能力交给了网页。说明保留在 DEVELOPMENT.md §7.2，Rust 参考实现因不安全已移除。

要在这些框架里也达到第 4 层，有两种做法（目前未实现，有需要时再做）：
1. 附带一个 Node 小进程（sidecar）运行本 SDK，界面通过它调用——与 Electron 方式相同；
2. 用后台语言（如 Rust）实现宿主桥：只接收「对象名 + 方法名 + 参数」，自行构造并签名请求。协议已完整记录在 §7 和黄金测试中。

---

## 4. 配置说明

| 字段 | 说明 |
|---|---|
| `space.provider` | `alipay`（默认）或 `aliyun`（实验） |
| `space.spaceId` | 服务空间 ID |
| `space.spaceAppId` / `accessKey` / `secretKey` | 支付宝云客户端凭据，由 HBuilderX 关联服务空间时注入，**不要入库/入 git** |
| `space.clientSecret` | 阿里云版客户端密钥 |
| `space.endpoint` | 覆盖网关域名（自定义域名 / 代理） |
| `appId` | DCloud AppId，云端 `getClientInfo().appId` 会读到 |
| `deviceId` / `deviceIdStore` | 稳定设备 ID；不传则自动生成，建议用 Tauri store / 配置文件持久化 |
| `extraClientInfo` | 附加身份字段，云端可用于业务校验（**不是**安全凭据） |
| `uniIdToken` | uni-id 登录态，会随每次请求上行 |
| `timeout` / `retries` | 默认 15s / 1 次。**只有声明幂等的调用才重试**（`callFunction({ idempotent: true })` 或 `importObject(name, { idempotentMethods })`），写操作永不自动重发 |
| `crypto` / `transport` / `signer` | 可替换的底层实现 |
| `hostDispatcher` | 已弃用（见 §3.3 与 DEVELOPMENT.md §7.2）；新代码用宿主桥 §3.2 |
| `hooks` | `onRequest` / `onResponse` / `onError` |

凭据来源建议：开发期环境变量；分发版由 Rust 主进程从系统凭据库或加密配置读取。**不要把长期主密钥打进前端 bundle。**

---

## 5. API

| 方法 | 说明 |
|---|---|
| `createClient(options)` | 创建客户端 |
| `cloud.importObject<T>(name, options?)` | 返回类型化 Proxy，调用任意方法 |
| `cloud.callFunction({ name, data })` | 调云函数，返回 `{ result, requestId, raw }` |
| `cloud.prepare(target, payload)` | 返回 `{ request, material, ctx }`，供宿主签名 |
| `cloud.parseResponse(raw)` | 解析宿主返回的原始响应 |
| `cloud.getClientInfo()` / `patchClientInfo()` | 读取 / 追加身份字段 |
| `cloud.setUniIdToken(token)` | 设置登录态 |
| `cloud.describe()` | 脱敏连接信息，用于日志 |
| `UniCloudError` / `TransportError` | 规范化错误，带 `errCode / errMsg / requestId` |

工具导出：`resolveSpace` / `spaceFromEnv` / `defaultEndpoint`、`buildClientInfo` / `createLocalStorageDeviceIdStore`、`FetchTransport` / `createMockTransport`、`LocalSigner` / `createWebCryptoBackend`、`AlipayAdapter` / `AliyunAdapter`。

---

## 5.1 云存储与登录态

```ts
// 内置存储（支付宝云）：与官方 uniCloud.uploadFile / getTempFileURL 报文逐字节一致
const { fileID } = await cloud.uploadFile({ cloudPath: 'user-upload/u1/a.png', file: bytes, contentType: 'image/png' })
const { fileList } = await cloud.getTempFileURL({ fileList: [fileID] })

// 扩展存储（七牛等）或任何「云端下发上传参数」的场景：客户端不持有存储密钥
import { uploadWithOptions } from '@yungot/unicloud-sdk'
const opts = await cloud.importObject('file-co').getAvatarUploadOptions({ ext: 'png' })
await uploadWithOptions({ uploadFileOptions: opts.uploadFileOptions, file: bytes, fileName: 'a.png' })
```

| 能力 | 支付宝云内置存储 | 扩展存储 |
|---|---|---|
| 上传 | `cloud.uploadFile` | 云对象 `getUploadFileOptions` + `uploadWithOptions`（模板见 `examples/cloud/file-co.js`） |
| 临时链接 | `cloud.getTempFileURL`（有效期 600 秒） | 在云对象里调用 `getTempFileURL` |
| 删除 | 客户端不支持，在云对象里删 | 在云对象里删 |
| 权限 | **云端无法限制前端写入路径**（官方文档原文：支付宝云不支持控制前端访问云储存的权限） | 由云对象决定路径和权限 |

**安全建议**：用户上传一律走「云对象下发上传参数」模式；内置存储直传只在宿主桥里开放给固定前缀（`storage.upload.pathPrefixes`）。

**登录态（uni-id）**：与官方一致，云对象返回 `newToken` 时 SDK 自动保存并在后续请求中上行，触发 `onTokenRefresh`。默认内存存储；桌面端请实现 `tokenStore`（主进程用 Electron `safeStorage` 加密后写文件），Web 端可用 `createLocalStorageTokenStore()`（键名与官方 H5 相同）。

| 方法 | 说明 |
|---|---|
| `setUniIdToken(token, tokenExpired?)` | 登录后写入；传 `undefined` 即退出登录 |
| `getTokenInfo()` / `isTokenExpired()` | 读取 / 本地判断是否过期 |

**错误语义（与官方一致，v0.3.0 起）**：`callFunction` 只在网络错误或 HTTP ≥ 400 时抛异常，云函数返回的非零 `errCode` 原样放在 `result` 里；`importObject` 的方法在返回非零 `errCode` 时抛 `UniCloudError`（含 `errSubject`、`requestId`、`detail`）。

## 5.2 与 uni-id 配合

> ⚠️ 本节能力已完成代码与离线测试，**尚未在真实服务空间验证**（需要服务空间已配置 uni-id）。

uni-id 是 DCloud 官方的用户体系（注册、登录、token、角色权限），本 SDK **不封装** uni-id 的业务接口，只保证兼容：

| 层 | 负责 | 回答的问题 |
|---|---|---|
| uni-id | 账号、登录、token、权限 | 这个人是谁 |
| 设备身份（§6） | 设备私钥、请求签名 | 这个请求来自哪台已登记的电脑 |

**已支持**

| 能力 | 说明 | 状态 |
|---|---|---|
| 自动携带 token、`newToken` 自动保存、`onTokenRefresh` | 与官方行为一致 | ✅ 离线 · 未实测 |
| 登录态持久化 | `tokenStore`；桌面端示例 `examples/electron-token-store.mjs`（系统加密保存，重启免登录） | ✅ 离线 · 未实测 |
| 宿主桥隐藏 token | 网页调用 `uni-id-co.login` 时，主进程保存 token，返回给网页前删除 `token / newToken / uniIdToken`（`exposeTokens` 默认 false） | ✅ 离线 · 未实测 |
| 网页查询登录状态、退出登录 | `getSession()` / `logout()`，不涉及 token | ✅ 离线 · 未实测 |
| 云端解析 uid | 公共模块 `createUniIdResolver(require('uni-id-common'))` | ✅ 离线 · 未实测 |
| 设备绑定账号 | 游客期登记的设备，登录后首次调用自动绑定；已绑定设备不能被其他账号使用 | ✅ 离线 · 未实测 |

**流程**

```
游客：设备自动登记（未绑定账号）→ 浏览、试听
登录：网页 → 宿主桥 → uni-id-co.login → 主进程保存 token
      下一次调用 → 云端返回 DEVICE_NOT_BOUND → SDK 自动重新登记，设备绑定到该用户
退出：uniCloud.logout() → 主进程清除 token（设备记录保留）
丢失电脑：在其他设备上调用 ucd-device-co.revokeMyDevice 吊销
```

`uni-id-co` 是官方云对象，升级插件时会被覆盖，不建议改它的代码加设备门禁；登录接口的防护使用 uni-id 自带的密码错误次数限制、验证码等配置。

## 6. 设备身份与云端门禁

关闭「客户端校验」后，持有客户端密钥即可调用空间内所有云对象，因此每个云对象都应在 `_before` 里校验**设备证明**。

**客户端（Electron 主进程）**

```ts
import { createClient, createSoftwareDeviceKey } from '@yungot/unicloud-sdk'
import { createSafeStorageVault } from './electron-device-vault.mjs'   // 见 examples/

const cloud = createClient({
  /* space、appId ... */
  device: {
    key: createSoftwareDeviceKey({ vault: createSafeStorageVault(), assurance: 'os-protected' }),
    deviceName: os.hostname(),
  },
})
await cloud.importObject('music').search('晴天')   // 自动附带设备证明；首次自动登记
```

**云端**（模板在 `cloud/` 目录，部署步骤见 `cloud/README.md`）

```js
const { createDeviceAuth, createUniCloudStore, protectCloudObject } = require('ucd-device-auth')
const auth = createDeviceAuth({ store: createUniCloudStore(uniCloud.database()) })

module.exports = protectCloudObject({
  async search(keyword) { /* this.device、this.uid 可用 */ },
  async addFavorite(songId) { /* ... */ },
}, {
  auth,
  object: 'music',                       // 与客户端 importObject 的名字一致
  readMethods: ['search'],               // 只读高频方法：只校验时间窗
  requireUserMethods: ['addFavorite'],   // 必须登录的方法
  resolveUid,                            // 用 uni-id-common 校验 token，返回 uid
})
```

> 不要在 `_before` 里抛错做校验：支付宝云会把 `_before` 抛出的错误变成 HTTP 500，客户端拿不到 errCode（S3 实测）。`protectCloudObject` 在方法内部校验，失败时以普通结果返回错误码。

| 机制 | 作用 |
|---|---|
| 设备私钥（P-256），系统加密保存 | 私钥不出本机；拷贝到其他电脑或其他系统账户无法使用 |
| 登记：挑战-签名 | 证明设备真的持有私钥；已登录时绑定到 uni-id 用户 |
| 每个请求的设备证明 | 绑定设备、云对象、方法、参数内容、登录 token、时间、一次性 nonce |
| 写方法一次性 nonce | 同一请求重放被拒绝 |
| 时间窗 ±120 秒 | 本机时钟不准时，SDK 按云端 `serverTime` 自动校准并重试 |
| 吊销 | 用户可在设备列表停用丢失的电脑；默认缓存 30 秒内生效 |
| 账号绑定 | 游客期登记的设备登录后自动绑定；已绑定的设备不能被其他账号使用 |

限制：设备证明能证明「这是某台已登记的设备」，不能证明「这是正版程序」；能接触到本机用户会话的恶意软件也能调用主进程。这类风险需要配合账号、新设备审批、限流与异常检测处理（后续阶段）。

---

## 7. 协议实现说明

支付宝云适配器复刻官方 `@dcloudio/uni-cloud` 的 `Kt()`：

```
POST https://${spaceId}.api-hz.cloudbasefunction.cn/functions/invokeFunction

headers: x-from-app-id / x-from-env-id / x-to-env-id / x-from-instance-id /
         x-from-function-name / x-to-function-name / x-client-timestamp /
         x-alipay-source: client / x-request-id / x-alipay-callid / x-trace-id

body:    { <业务参数>, clientInfo: {...}, uniIdToken?: '...' }

canonical = POST \n path \n query \n signedHeaderLines \n signedHeaders \n sha256(body) \n
stringToSign = `HMAC-SHA256\n${timestamp}\n${sha256(canonical)}\n`
Authorization = HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...
```

云对象方法会被转成 `body = { method, params, clientInfo }`；普通云函数则是 `{ ...data, clientInfo }`。

---

## 8. 验证状态（务必读）

**已验证**

- 请求 URL、header、body 与官方客户端 SDK 逐字节一致：云函数调用（`test/golden.test.mjs`）、云存储（`test/storage.test.mjs`，由 `tools/capture-official-golden.mjs` 用本机官方运行时离线生成）
- **真实服务空间**（S2）：Windows 直调云对象，云端 `source=client`；扩展存储上传、下载、删除全流程（[docs/VERIFICATION.md](docs/VERIFICATION.md)）
- 62 项单元测试：错误语义、uni-id 续期、云存储、幂等重试、宿主桥、设备身份端到端（SDK ↔ 云端模块）等

- **真实服务空间**（S3）：设备自动登记、请求签名、一次性 nonce 与重放拦截、错误码回传（[docs/VERIFICATION.md](docs/VERIFICATION.md)）
- **真实项目**（迷笛音乐，Windows Electron 桌面播放器，2026-11-10）：真实 Electron 中运行宿主桥、白名单、幂等重试；safeStorage 保存设备私钥与登录态；自定义登录 token 经 `setUniIdToken` 持久化并自动携带；`protectCloudObject` 守护全部业务云对象；electron-builder 安装版正常运行。开发全程未改动 SDK（详见 [docs/VERIFICATION.md](docs/VERIFICATION.md)）

**待真实环境验证**

- 内置存储真实上传（项目使用扩展存储，未测）；中文 cloudPath
- uni-id 相关（§5.2）：`uni-id-co` 登录经宿主桥、`newToken` 续期、云端 uid 解析、设备绑定账号
- 设备吊销
- macOS / Linux / Web 平台

**未实现 / 实验**

- `AliyunAdapter` 为按源码实现的实验代码，未联调。
- clientDB、SSEChannel 暂未实现。

**明确不支持**：`secretType` 相关能力、SecureNetwork 双向加密。

---

## 8.1 平台支持与预留

SDK 核心只依赖标准 `fetch` 与 WebCrypto（Node 20+ / Electron / 现代浏览器 / WebView 均具备），本身与平台无关。各平台差异集中在两处可替换接口：**宿主桥**（凭据放哪）和**设备密钥**（`DeviceKey` / `KeyVault`，设备私钥存哪）。

| 平台 | 调用能力 | 凭据位置 | 设备密钥 | 状态 |
|---|---|---|---|---|
| Windows（Electron） | ✓ | 主进程 + 宿主桥 | 软件密钥 + safeStorage（DPAPI）已实现；TPM 规划中 | **当前主目标**，已在真实项目中使用 |
| macOS（Electron） | ✓ | 同上 | safeStorage（Keychain） | **同方案支持**，发布需 Apple 签名与公证；未在 Mac 实机测试 |
| Linux（Electron） | ✓ | 同上 | safeStorage（libsecret） | 顺带支持，未测试 |
| Web（浏览器） | ✓（需在控制台「跨域配置」加域名） | 浏览器内，可被提取（与官方 H5 相同） | WebCrypto 不可导出密钥 + IndexedDB | 预留，未测试 |
| iOS | 协议层可用（React Native / Capacitor 等 JS 运行时） | 由宿主决定 | Keychain / Secure Enclave（需原生插件） | 预留，未测试 |

uni-app 原生 App（Android / iOS）应继续使用官方 uniCloud SDK 与安全网络；本 SDK 面向**非 uni-app** 的客户端。新增平台时只需实现宿主桥的 `invoke` 和设备密钥提供者，不改核心协议层。

## 9. 目录

```
src/                    SDK 源码（TS，零运行时依赖）
  client.ts             客户端主逻辑、importObject Proxy、幂等重试、宿主代理（已弃用）
  bridge.ts             宿主桥：createHostHandler（宿主白名单）/ createRemoteClient（前端）
  storage.ts            云存储：内置存储直传、uploadWithOptions、路径校验
  token.ts              uni-id 登录态存储
  device.ts             设备身份：设备密钥、证明构造
  providers/alipay.ts   支付宝云协议 + 签名（已验证）
  providers/aliyun.ts   阿里云协议（实验）
  config.ts / identity.ts / crypto.ts / transport.ts / errors.ts / types.ts
examples/               Node 快速开始、Electron 主进程与设备密钥保存、cloud/ 云对象模板
test/                   62 项单测（含官方 SDK 黄金对照）
tools/                  官方黄金报文生成；S2 / S3 真实环境验证脚本
cloud/                  云端部署模板：公共模块 ucd-device-auth、云对象 ucd-device-co、数据库 schema
docs/                   验证记录（VERIFICATION.md）
```

## 10. 许可

MIT（见 [LICENSE](LICENSE)）。协议格式与签名算法参照 DCloud `@dcloudio/uni-cloud`（Apache-2.0）实现，用于与自有服务空间互操作。
