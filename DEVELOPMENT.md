# unicloud-sdk 开发文档

> 面向桌面应用的 uniCloud 客户端 SDK · 标准用法与二次开发指南
> 版本 0.1.0 · 适用平台 Windows / macOS / Linux · 运行环境 Node ≥ 20 或带 WebCrypto 的 WebView

---

## 0. 阅读指引

| 你是 | 直接看 |
|---|---|
| 第一次接入，想先跑通一次调用 | §2 环境 → §3 快速开始 |
| 要写业务代码，需要查参数和返回值 | §4 配置参考 → §5 API 参考 → §6 云端写法 |
| 要做分发的桌面程序，关心密钥安全 | §7 运行模式（推荐宿主代理模式） |
| 要排查报错 / 做联调 | §10 调试与排障 → §11 测试 |
| 要改 SDK 本身 / 加服务商支持 | §9 扩展点 → §12 SDK 自身开发 |
| 要评估能不能用 | §1 能力边界 → §13 已知限制 |

配套速查见 [README.md](README.md)，本文是完整版。

---

## 1. SDK 是什么，不是什么

`unicloud-sdk` 在桌面进程中复刻 uniCloud **客户端网关协议**：构造与官方客户端 SDK 一致的报文与签名，直接调用云对象 / 云函数。云端看到的是一次标准的客户端调用（`source = client`），而不是云函数 URL 化 / HTTP 访问服务。

```ts
const cloud = createClient({ space: { ... }, appId: '__UNI__YOUR_APP' })
const notes = cloud.importObject<NotesApi>('notes')
const list = await notes.list({ page: 1 })
```

**它不依赖** uni-app Runtime、WebView 桥、Android 运行时、模拟器或任何原生插件；**运行时零 npm 依赖**，编译产物为 ESM + `.d.ts`。

### 1.1 能力边界

| 能力 | 支持 |
|---|---|
| `importObject()` 直调云对象、`callFunction()` 直调云函数 | ✅ |
| 上报 `appId / deviceId / osName / uniPlatform`，云端 `getClientInfo()` 可读 | ✅ |
| uni-id token、请求钩子、超时、重试、错误规范化 | ✅ |
| 支付宝云服务空间 | ✅ 报文与签名已按官方客户端 SDK 逐字节对照 |
| 阿里云 / 腾讯云服务空间 | ⚠️ 实验实现，未做真实联调 |
| 宿主进程代理签名（密钥不进 WebView） | ✅ |
| uniCloud SecureNetwork（`secretType`、客户端强制校验、双向加密） | ❌ 不支持，也不模拟 |
| 云存储上传、clientDB、SSEChannel | ❌ 未实现，SDK 聚焦云对象 / 云函数调用 |

### 1.2 术语澄清

客户端 SDK 底层本来就是 HTTPS POST。所谓「不走 HTTP 云访问」指的是**不走 URL 化路由**——区别在入口、报文结构和身份模型，不在传输协议：URL 化调用的 `source` 是 `http`，且官方明确该场景跳过客户端校验；客户端协议的 `source` 是 `client`，并携带 `clientInfo`。

SecureNetwork 官方仅面向 App 与微信小程序，桌面端无法合法取得该身份。本 SDK 不伪造 `secretType`、不盗用设备密钥、不绕过服务端校验。桌面端的身份校验应放在云端应用层，见 §8。

---

## 2. 环境与安装

### 2.1 运行环境

- **Node / Electron 主进程**：Node ≥ 20（内置 `fetch`、WebCrypto）
- **Tauri / Electron 渲染进程**：需 `crypto.subtle` 与 `fetch`；若运行时缺少 WebCrypto，通过 `crypto` 选项注入自定义实现
- 语言：TypeScript 5.6 构建，纯 ESM（`"type": "module"`），无 CJS 入口

### 2.2 安装

```bash
# 方式一：本地路径依赖
npm install @yungot/unicloud-sdk

# 方式二：打包后安装
cd path/to/unicloud-sdk && npm pack
npm install ./yungot-unicloud-sdk-0.5.0.tgz

# 方式三：直接复制 dist/ 到项目内
```

发布包包含 `dist/`、`cloud/`（云端模板）、`examples/`、文档与 LICENSE（`package.json` 的 `files` 字段），运行时依赖数为 0。

### 2.3 构建与自检（SDK 源码工程）

```bash
npm install       # 唯一开发依赖：typescript
npm run build     # tsc -p tsconfig.json → dist/*.js + *.d.ts
npm run typecheck # 只做类型检查
npm test          # 构建 + node --test test/*.test.mjs
```

### 2.4 目录

```
src/
  client.ts              客户端主体：importObject Proxy、重试、宿主代理、上下文
  config.ts              服务空间配置合并、环境变量、默认网关域名
  identity.ts            clientInfo 构造、设备 ID 解析与持久化
  crypto.ts              WebCrypto / Node crypto 后端、本地签名器
  transport.ts           默认 fetch 传输层、mock 传输层
  errors.ts              UniCloudError / TransportError
  types.ts               全部公开类型
  providers/alipay.ts    支付宝云协议与 HMAC 签名（已对照验证）
  providers/aliyun.ts    阿里云协议（实验）
  index.ts               公开导出入口
examples/                 最小可运行示例
test/                     单元测试 + 签名黄金对照
DEVELOPMENT.md            本文
README.md                 速查
```

---

## 3. 快速开始

### 3.1 准备凭据

从 uniCloud 服务空间的客户端配置取得：`spaceId`、`spaceAppId`、`accessKey`、`secretKey`（支付宝云）。开发期用环境变量，不要写进源码或提交到版本库。

```bash
# .env.local 或 shell 环境变量
UNICLOUD_PROVIDER=alipay
UNICLOUD_SPACE_ID=env-xxxxxxxx
UNICLOUD_SPACE_APP_ID=<space-app-id>
UNICLOUD_ACCESS_KEY=<access-key>
UNICLOUD_SECRET_KEY=<secret-key>
```

### 3.2 最小示例（Node 脚本 / 命令行工具）

```js
import { createClient, isUniCloudError } from '@yungot/unicloud-sdk'

const cloud = createClient({
  space: {
    provider: 'alipay',
    spaceId: process.env.UNICLOUD_SPACE_ID,
    spaceAppId: process.env.UNICLOUD_SPACE_APP_ID,
    accessKey: process.env.UNICLOUD_ACCESS_KEY,
    secretKey: process.env.UNICLOUD_SECRET_KEY,
  },
  appId: '__UNI__YOUR_APP',
  osName: 'windows',
  hooks: {
    onRequest: (req) => console.log('→', req.url, req.headers['x-to-function-name']),
  },
})

console.log(cloud.describe()) // 脱敏连接信息，安全可打印

try {
  const greeter = cloud.importObject('greeter')
  const reply = await greeter.hello('desktop')
  console.log(reply)
} catch (error) {
  if (isUniCloudError(error)) console.error(error.toJSON())
  else throw error
}
```

也可完全依赖环境变量构造 `space`：

```js
import { createClient, spaceFromEnv } from '@yungot/unicloud-sdk'

const cloud = createClient({ space: spaceFromEnv(), appId: '__UNI__YOUR_APP' })
```

### 3.3 云端对照（最小云对象）

```js
// uniCloud-alipay/cloudfunctions/greeter/index.obj.js
module.exports = {
  async hello(name) {
    return { message: `hello, ${name}`, source: this.getClientInfo().source }
  },
}
```

返回 `source: 'client'` 即说明请求走的是客户端网关协议，而非 URL 化路由。

---

## 4. 配置参考

`createClient(options)` 只接受一个对象，其中 `space` 与 `appId` 必填。

### 4.1 `space`：服务空间

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `provider` | `'alipay' \| 'aliyun'` | `'alipay'` | 服务商，决定协议适配器 |
| `spaceId` | `string` | 必填 | 服务空间 ID |
| `spaceAppId` | `string` | — | 支付宝云空间 AppId |
| `accessKey` | `string` | — | 支付宝云 AccessKey（非密，参与 `Credential`） |
| `secretKey` | `string` | — | 支付宝云签名密钥（**敏感**） |
| `clientSecret` | `string` | — | 阿里云客户端密钥（**敏感**） |
| `accessToken` | `string` | — | 阿里云匿名访问 token，由宿主预先获取 |
| `endpoint` | `string` | 由 `spaceId` 推导 | 覆盖网关域名（自定义域名 / 代理） |

默认网关：

| provider | endpoint |
|---|---|
| `alipay` | `https://${spaceId}.api-hz.cloudbasefunction.cn` |
| `aliyun` | `https://api.bspapp.com`；`spaceId` 以 `mp-` 开头时为 `https://api.next.bspapp.com` |

配置合并优先级：**显式传入 > 环境变量 > 默认值**（`resolveSpace()`）。环境变量名：

| 变量 | 对应字段 |
|---|---|
| `UNICLOUD_PROVIDER` | `provider` |
| `UNICLOUD_SPACE_ID` | `spaceId` |
| `UNICLOUD_SPACE_APP_ID` | `spaceAppId` |
| `UNICLOUD_ACCESS_KEY` | `accessKey` |
| `UNICLOUD_SECRET_KEY` | `secretKey` |
| `UNICLOUD_CLIENT_SECRET` | `clientSecret` |
| `UNICLOUD_ENDPOINT` | `endpoint` |
| `UNICLOUD_DEVICE_ID` | 设备 ID（由身份模块读取，见 §8.3） |

缺少必填项时构造即抛错：`spaceId is required` / `alipay space requires: spaceAppId, accessKey, secretKey` / `aliyun space requires: clientSecret`。**宿主代理模式或自定义 `signer` 下会跳过密钥校验**，因为密钥不在当前进程。

### 4.2 身份与网络

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appId` | `string` | 必填 | DCloud AppId，云端 `getClientInfo().appId` |
| `deviceId` | `string` | 自动生成 | 稳定设备 ID，显式传入优先 |
| `deviceIdStore` | `DeviceIdStore` | 内存存储 | 设备 ID 持久化实现 |
| `osName` | `string` | 自动探测 | `windows` / `macos` / `linux` 等 |
| `uniPlatform` | `string` | `'web'` | 上报的平台标识 |
| `locale` | `string` | `'zh-Hans'` | 语言 |
| `appVersion` / `appVersionCode` | `string` | `'1.0.0'` / `'100'` | 版本信息 |
| `userAgent` | `string` | `unicloud-sdk/1.0 (<os>)` | UA |
| `extraClientInfo` | `Record<string, unknown>` | — | 附加身份字段，会合并进 `clientInfo` |
| `uniIdToken` | `string` | — | uni-id 登录态，随每次请求上行 |
| `timeout` | `number` | `15000` | 单次请求超时（ms） |
| `retries` | `number` | `1` | 网络错误 / 5xx 重试次数 |

> `extraClientInfo` 的展开顺序在内置字段之后，**同名字段会覆盖内置值**；除非有意，不要使用 `appId`、`osName`、`deviceId` 等键名。

### 4.3 扩展点与钩子

| 字段 | 类型 | 说明 |
|---|---|---|
| `crypto` | `CryptoBackend` | 替换哈希 / HMAC 实现 |
| `transport` | `Transport` | 替换 HTTP 发送实现 |
| `signer` | `Signer` | 替换签名器；提供后跳过密钥校验 |
| `hostDispatcher` | `HostDispatcher` | 启用宿主代理模式，见 §7.2 |
| `hooks` | `Hooks` | `onRequest` / `onResponse` / `onError` |
| `now` | `() => number` | 注入时钟，便于测试 |
| `uuid` | `() => string` | 注入随机源，便于测试 |

```ts
interface Hooks {
  onRequest?: (request: OutboundRequest, ctx: RequestContext) => void | Promise<void>
  onResponse?: (result: InvocationResult, ctx: RequestContext) => void | Promise<void>
  onError?: (error: unknown, ctx: RequestContext) => void | Promise<void>
}
```

钩子在签名之后、发送之前触发；`onError` 覆盖构造报文、发送、解析全过程的异常。

---

## 5. API 参考

### 5.1 `createClient(options): UniCloudDesktopClient`

创建客户端。构造是同步的，但设备 ID 解析是异步的——首次调用会等待初始化完成（`getClientInfo()` 也是 async）。同一 client 可复用整个应用生命周期；不同服务空间创建多个实例即可。

### 5.2 `importObject<T>(name, options?): T`

返回类型化 Proxy，把任意方法调用转成一次云对象请求。

```ts
interface NotesApi {
  list(query: { page: number; keyword?: string }): Promise<{ items: unknown[] }>
  remove(id: string): Promise<{ ok: boolean }>
}

const notes = cloud.importObject<NotesApi>('notes')
const { items } = await notes.list({ page: 1 })
```

请求体为 `{ method, params, clientInfo }`，`params` 是实参数组。

- `options.defaults` 会展开进请求体，适合附带客户端版本等固定字段；**不要用 `method` / `params` 作键名**，会覆盖调用本身。
- 保留字 `then` / `catch` / `toJSON` / `toString` / `inspect` / `constructor` / `valueOf` 返回 `undefined`，避免 `await` 把 Proxy 误判为 Promise。云对象方法不要取这些名字。
- 方法返回值是解析后的结果（见 §5.3 说明）。

### 5.3 `callFunction<T>({ name, data? }): Promise<InvocationResult<T>>`

调用云函数；`data` 展开进请求体，SDK 注入 `clientInfo`，有登录态时注入顶层 `uniIdToken`。

```ts
const { result, requestId, raw } = await cloud.callFunction<{ ok: boolean }>({
  name: 'health-check',
  data: { verbose: true },
})
```

| 返回字段 | 说明 |
|---|---|
| `result` | 解析后的业务结果 |
| `requestId` | 取自 `x-trace-id` / `x-request-id` / `request-id` 响应头，或响应体 `requestId` |
| `raw` | 原始 `{ status, data, headers }`，用于排查 |

> **返回值结构**：适配器把 2xx 响应体作为 `result` 返回（响应体带非零 `errCode` 时抛 `UniCloudError`）。若网关对云对象返回值做了额外包装，请按实际结构取值；首次联调建议用 `hooks.onResponse` 打印一次确认。

### 5.4 身份与登录态

```ts
await cloud.getClientInfo()                       // 当前上报的 clientInfo 副本
await cloud.patchClientInfo({ clientBuild: '2026.11' }) // 追加 / 覆盖字段
cloud.setUniIdToken(token)                      // 设置或更新；传 undefined 清除
cloud.describe()                                // 脱敏连接信息，可安全写入日志
```

`describe()` 输出：`{ provider, spaceId, endpoint, appId, hasSecret, hostMode }`。**若前端日志里出现 `hasSecret: true`，说明密钥被打进了前端包**，应改用 §7.2。

`clientInfo` 字段为大写与小写双份（`PLATFORM` / `uniPlatform`、`OS` / `osName`、`APPID` / `appId`、`DEVICEID` / `deviceId`、`LOCALE` / `locale`），另含 `appVersion`、`appVersionCode`、`appLanguage`、`ua` 与自定义字段。大写字段供云函数 context 读取，小写字段供云对象 `getClientInfo()` 读取。

### 5.5 宿主代理相关

```ts
const prepared = await cloud.prepare(target, payload)
// → { request: OutboundRequest, material: SignatureMaterial, ctx: RequestContext }

const parsed = cloud.parseResponse<T>(raw) // 解析宿主返回的原始响应
```

`prepare()` 返回未签名请求与待签材料，见 §7.2。手动调用时若需要登录态，请在 `payload` 中显式放入 `uniIdToken`（`callFunction()` 会自动注入，`prepare()` 不会）。

### 5.6 错误类型

```ts
import { UniCloudError, TransportError, isUniCloudError } from '@yungot/unicloud-sdk'
```

| 类型 | 触发 | 字段 |
|---|---|---|
| `UniCloudError` | 网关返回非零 `errCode` | `errCode` / `errMsg` / `requestId` / `status?` / `toJSON()` |
| `TransportError` | 超时、断网、非 2xx HTTP（`errCode = 'TRANSPORT_ERROR'`） | 同上 |

`isUniCloudError(value)` 是类型守卫。两者都继承 `Error`。

```ts
try {
  await notes.remove('id-1')
} catch (error) {
  if (isUniCloudError(error)) {
    console.error(error.errCode, error.errMsg, error.requestId)
  } else {
    throw error // 编程错误 / 配置错误
  }
}
```

### 5.7 工具导出

| 类别 | 导出 |
|---|---|
| 配置 | `resolveSpace` / `spaceFromEnv` / `defaultEndpoint` |
| 身份 | `buildClientInfo` / `resolveDeviceId` / `uuid` / `createMemoryDeviceIdStore` / `createLocalStorageDeviceIdStore` |
| 密码学 | `LocalSigner` / `resolveCrypto` / `createWebCryptoBackend` / `lazyCrypto` |
| 传输 | `FetchTransport` / `createFetchTransport` / `createMockTransport` / `normalizeHeaders` |
| 适配器 | `AlipayAdapter` / `AliyunAdapter` |
| 类 / 工厂 | `UniCloudDesktopClient` / `createClient` |

公开类型见 `src/types.ts`，全部从包根导出（`SpaceConfig`、`ClientInfo`、`DeviceIdStore`、`CryptoBackend`、`SignatureMaterial`、`Signer`、`OutboundRequest`、`RawResponse`、`Transport`、`InvocationResult`、`RequestContext`、`ProviderAdapter`、`Hooks`、`DesktopClientOptions`、`CallFunctionOptions`、`ImportObjectOptions`、`CloudObjectMethods`、`ExtendedClientOptions`、`HostDispatcher`）。

---

## 6. 云端标准写法

### 6.1 云对象

```js
// uniCloud-alipay/cloudfunctions/notes/index.obj.js
module.exports = {
  async _before() {
    const info = this.getClientInfo()
    if (info.source !== 'client') throw new Error('client sdk required')
    if (info.appId !== '__UNI__YOUR_APP') throw new Error('unknown app')
  },

  async list(query) {
    // params 是数组，方法参数按位置展开
    return { items: await db.collection('notes').limit(query.pageSize ?? 20).get() }
  },

  async remove(id) {
    return { ok: true }
  },
}
```

方法名与参数由 SDK 的 `{ method, params }` 映射，和 uni-app 客户端写法一致。

### 6.2 云函数

```js
// uniCloud-alipay/cloudfunctions/health-check/index.js
exports.main = async (event) => {
  return { ok: true, appId: event.clientInfo?.appId, os: event.clientInfo?.osName }
}
```

`data` 的字段平铺在 `event` 上，`clientInfo` 作为整体字段；`uniIdToken` 为请求体顶层字段。

### 6.3 返回值与错误码

- 正常返回：任意可序列化对象，SDK 解析为 `result`。
- 业务错误：返回带非零 `errCode` / `errMsg` 的对象，SDK 抛 `UniCloudError`。
- 网关错误、HTTP 非 2xx：抛 `TransportError`。

---

## 7. 运行模式

### 7.1 本地签名模式（默认）

密钥在当前 JS 进程内，SDK 完成「构造 → 签名 → 发送 → 解析」全流程。适用于 Node 工具、本地脚本、可信环境中的 CLI，以及把 client 建在 Electron 主进程的场景。

```ts
const cloud = createClient({ space: { /* 含 secretKey */ }, appId: '__UNI__YOUR_APP' })
```

调用链：

```mermaid
flowchart LR
  A[业务代码 importObject] --> B[构造报文 + clientInfo]
  B --> C[计算 canonical / stringToSign]
  C --> D[LocalSigner HMAC]
  D --> E[FetchTransport HTTPS POST]
  E --> F[parse → result / UniCloudError]
```

> 桌面程序会被解包，前端 bundle 里的 `secretKey` 属于可提取信息。分发型应用请用宿主代理模式。

### 7.2 宿主代理模式（已弃用）

> ⚠️ v0.2.0 起弃用。`hostDispatcher` 接收完整请求与 `stringToSign`，宿主若照单签名，前端即可借宿主对任意内容签名（签名 Oracle）。新代码请使用 README §3.2 的宿主桥：`createHostHandler`（宿主，带白名单）+ `createRemoteClient`（前端）。以下内容仅为兼容保留。

`hostDispatcher` 把签名与发送交给原生主进程 / 主进程，WebView 只持有非密配置：

```ts
import { invoke } from '@tauri-apps/api/core'
import { createClient } from '@yungot/unicloud-sdk'

export const cloud = createClient({
  space: {
    provider: 'alipay',
    spaceId: 'env-xxxxxxxx',
    spaceAppId: 'SP-APP-ID',
    accessKey: 'AK-...',        // accessKey 非密；secretKey 不出现在此处
  },
  appId: '__UNI__YOUR_APP',
  osName: 'windows',
  hostDispatcher: (input) => invoke('unicloud_request', { payload: input }),
})

export const notes = cloud.importObject<NotesApi>('notes')
```

`hostDispatcher` 收到：

```ts
{
  request:  { url, method: 'POST', headers, body },  // 未签名，无 Authorization
  material: { kind: 'alipay', timestamp, stringToSign, credential, signedHeaders }
          | { kind: 'aliyun', payload },
  ctx:      { space, clientInfo, uniIdToken?, timestamp, requestId },
}
```

宿主侧职责只有三步：

1. 用 `secretKey` 对 `material.stringToSign` 做 HMAC-SHA256，得到十六进制签名；
2. 组装 `Authorization: HMAC-SHA256 Credential=<credential>, SignedHeaders=<signedHeaders 以 ; 连接>, Signature=<签名>`，加入 `request.headers`；
3. POST `request.url`，把响应转成 `{ status, data, headers }` 返回。SDK 用 `adapter.parse()` 完成错误规范化。

```js
// Electron 主进程（伪代码，省略 IPC 与密钥读取）
ipcMain.handle('unicloud_request', async (_e, payload) => {
  const { request, material } = payload
  const signature = createHmac('sha256', await readSecret())
    .update(material.stringToSign).digest('hex')
  const headers = {
    ...request.headers,
    Authorization: `HMAC-SHA256 Credential=${material.credential}, ` +
      `SignedHeaders=${material.signedHeaders.join(';')}, Signature=${signature}`,
  }
  const response = await fetch(request.url, { method: 'POST', headers, body: request.body })
  return { status: response.status, data: await response.json(), headers: {} }
})
```

Rust 参考实现会对前端传入的任意内容签名，已从公开仓库移除。此模式下 `describe().hostMode === true`、`hasSecret === false`。

### 7.3 自定义签名器 / 传输层

只需替换签名环节（例如交给系统凭据服务）时注入 `signer`；只需替换发送环节（例如走代理或 Tauri HTTP 插件、规避 WebView CORS）时注入 `transport`：

```ts
const cloud = createClient({
  space: { provider: 'alipay', spaceId: 'env-xxxxxxxx', spaceAppId: 'SP', accessKey: 'AK' },
  appId: '__UNI__YOUR_APP',
  signer: {
    async sign(material) {
      if (material.kind !== 'alipay') throw new Error('unsupported')
      const hex = await nativeSign(material.stringToSign) // 宿主实现
      return `HMAC-SHA256 Credential=${material.credential}, ` +
        `SignedHeaders=${material.signedHeaders.join(';')}, Signature=${hex}`
    },
  },
  transport: {
    async send(request) {
      const res = await nativeFetch(request)
      return { status: res.status, data: res.data, headers: res.headers }
    },
  },
})
```

注意：只有 `hostDispatcher` 或 `signer` 会跳过密钥必填校验，单独注入 `transport` 时仍需提供完整凭据。且**只有 `hostDispatcher` 会让 `describe().hostMode` 为 true**；自定义 `signer` 仍需自行保证密钥不进前端 bundle。

---

## 8. 身份、鉴权与设备 ID

### 8.1 云端校验建议（三层）

```js
async _before() {
  const info = this.getClientInfo()

  // 1) 由网关给出，客户端无法伪造：拒绝 URL 化调用
  if (info.source !== 'client') throw new Error('client sdk required')

  // 2) 业务白名单：AppId / 平台
  if (info.appId !== '__UNI__YOUR_APP') throw new Error('unknown app')
  if (!['windows', 'macos', 'linux'].includes(info.osName)) throw new Error('desktop only')

  // 3) 真正的鉴权：uni-id token + 应用层 HMAC（时间戳 + nonce 防重放）
}
```

`clientInfo` 是客户端上报的字段，**只用于业务识别，不能单独当作安全凭据**；`uniPlatform` 默认为 `web`，桌面平台请用 `osName` 区分。若服务空间开启了「客户端强制校验」，Web / 桌面平台会被全局拒绝，需关闭该开关或配置自定义规则——这是官方设计，本 SDK 不提供绕过。

### 8.2 登录态

```ts
cloud.setUniIdToken(await login())       // 之后每次请求自动携带
cloud.setUniIdToken(undefined)           // 退出登录
```

token 作为请求体顶层 `uniIdToken` 上行；云端按使用的 uni-id 版本读取，首次联调请打印一次请求体确认。

### 8.3 设备 ID 持久化

默认使用内存存储，进程退出即变。桌面程序应注入持久化实现：

```ts
import { createClient, spaceFromEnv } from '@yungot/unicloud-sdk'
import type { DeviceIdStore } from '@yungot/unicloud-sdk'

const store: DeviceIdStore = {
  get: () => readConfig('deviceId'),       // 配置文件 / 注册表 / 系统凭据库
  set: (id) => writeConfig('deviceId', id),
}

const cloud = createClient({
  space: spaceFromEnv(),
  appId: '__UNI__YOUR_APP',
  deviceIdStore: store,
})
```

WebView 场景可直接用内置的 `createLocalStorageDeviceIdStore('myapp.deviceId')`（默认键 `unicloud.deviceId`）。解析顺序：`deviceId` 显式值 → `UNICLOUD_DEVICE_ID` → `deviceIdStore.get()` → 生成 `desktop-<uuid>` 并 `set()`。设备 ID 可用于风控与统计，不是认证凭据。

---

## 9. 扩展点一览

| 接口 | 方法 | 用途 |
|---|---|---|
| `CryptoBackend` | `sha256Hex` / `hmacSha256Hex` | 替换哈希实现（硬件加密模块、专用运行时） |
| `Signer` | `sign(material)` | 把签名放到宿主进程或凭据服务 |
| `Transport` | `send(request) → RawResponse` | 替换 HTTP 栈、加代理、统一日志 |
| `DeviceIdStore` | `get` / `set` | 设备 ID 持久化 |
| `Hooks` | `onRequest` / `onResponse` / `onError` | 日志、埋点、指标 |
| `ProviderAdapter` | `build` / `sign` / `parse` | 协议适配器（内置 `alipay` / `aliyun`） |

扩展日志示例：

```ts
hooks: {
  onRequest: (req, ctx) => logger.debug('cloud →', ctx.requestId, req.headers['x-to-function-name']),
  onResponse: (res, ctx) => logger.debug('cloud ←', ctx.requestId, res.requestId),
  onError: (err, ctx) => logger.warn('cloud !', ctx.requestId, err),
}
```

> 当前 `createClient()` 按 `space.provider` 在 `src/client.ts` 内选择内置适配器，未提供 adapter 注入项。要支持新的服务商，需实现 `ProviderAdapter` 并在该选择分支注册（或直接用适配器类自行组装请求），见 §12.2。

---

## 10. 调试与排障

### 10.1 标准排查顺序

1. `console.log(cloud.describe())` —— 确认 provider / endpoint / `hasSecret` / `hostMode`。
2. 挂 `hooks.onRequest` 打印 URL、`x-to-function-name` 与 body，确认入口与参数。
3. 挂 `hooks.onResponse` 打印 `result` 结构，确认返回值是否需要解包。
4. 捕获 `isUniCloudError(error)` 并打印 `error.toJSON()`，带 `requestId` 便于云端查日志。

### 10.2 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `spaceId is required` / `alipay space requires: ...` | 缺配置或环境变量未加载；确认 `spaceFromEnv()` 的进程环境 |
| HTTP 401 / 403 或签名错误 | `secretKey` / `accessKey` / `spaceAppId` 不匹配；确认客户端机器时钟（签名使用 `Date.now()` 毫秒时间戳） |
| 提示 `functionName is empty` 之类网关错误 | 入口不对：确认 `endpoint` 是服务空间网关，不是云函数 URL 化地址 |
| WebView 中 `fetch` 失败 / CORS | 用宿主 `transport` 或 `hostDispatcher` 从原生侧发请求 |
| `fetch` 超时 / `AbortError` | 调大 `timeout`；默认重试只覆盖网络错误与 5xx |
| 云对象方法返回 `undefined` | 方法名撞上保留字；或把 Proxy 当值做了序列化 |
| 业务错误未抛出 | v0.3.0 起与官方一致：`callFunction` 不因业务 `errCode` 抛错（读 `result.errCode`），`importObject` 才会抛；字符串 `'0'` / 空串视为成功 |
| 设备 ID 每次启动都变 | 未注入 `deviceIdStore`（默认内存存储） |
| 前端日志里 `hasSecret: true` | 密钥进了前端包，改用宿主代理模式 |
| 云端一律拒绝、`source` 异常 | 服务空间可能开启「客户端强制校验」，见 §8.1 |

### 10.3 重试语义

`retries` 默认 1，但**只对声明幂等的调用生效**：`callFunction({ name, data, idempotent: true })`，或 `importObject(name, { idempotentMethods: ['search'] })`。幂等调用在**网络异常**与 **HTTP 5xx** 时重试，退避 `200ms × 2^attempt`；4xx 与业务 `errCode` 不重试。

非幂等调用（写库、计数、下单等）一律只发送一次：超时或 5xx 时请求可能已在云端执行，自动重发会造成重复执行。（v0.2.0 起的行为；v0.1.0 会对所有调用重试。）

---

## 11. 测试

SDK 自带 57 项单元测试（`node --test`），含与官方客户端 SDK 的签名黄金对照：

```bash
npm test
```

在业务项目里 mock 云端，用 `createMockTransport` 即可，无需真实服务空间：

```js
import { createClient, createMockTransport } from '@yungot/unicloud-sdk'

const transport = createMockTransport((request) => ({
  status: 200,
  data: { items: [{ id: '1' }] },
  headers: { 'x-trace-id': 'test-1' },
}))

const cloud = createClient({
  space: { provider: 'alipay', spaceId: 'env-test', spaceAppId: 'APP', accessKey: 'AK', secretKey: 'SK' },
  appId: '__UNI__TEST',
  deviceId: 'DEV-1',
  now: () => 1700000000000,
  uuid: () => 'req-1',
  retries: 0,
  transport,
})

const notes = cloud.importObject('notes')
const res = await notes.list({ page: 1 })
console.log(res, transport.requests[0].body) // 可断言报文结构
```

`now` / `uuid` 注入后可完全确定报文，适合做快照测试。宿主代理模式可用 `hostDispatcher` 返回 mock 的 `RawResponse`，断言 `material` 内容。

---

## 12. SDK 自身开发

### 12.1 代码约定

- 纯 ESM、TypeScript `strict`，模块相对导入带 `.js` 后缀（`moduleResolution: Bundler`）。
- 公开类型集中在 `src/types.ts`，从 `src/index.ts` 统一导出；新增公开 API 必须同时更新导出与文档。
- 避免静态 `import 'node:crypto'`（`crypto.ts` 用变量做动态导入，保证浏览器打包器可解析）。
- 不引入运行时依赖；构建产物只写 `dist/`（已 gitignore）。

### 12.2 新增服务商适配器

1. 在 `src/types.ts` 的 `ProviderName` 增加取值，必要时扩展 `SpaceConfig` 与 `SignatureMaterial`。
2. 在 `src/providers/` 实现 `ProviderAdapter` 的 `build()` / `sign()` / `parse()`：
   - `build()` 产出 `OutboundRequest`（`url` / `method` / `headers` / `body` 字符串）；
   - `sign()` 通过传入的 `signer` 完成签名，`prepare()` 依赖它捕获材料，因此**不要绕过 signer 直接算签名**；
   - `parse()` 负责 2xx 解析、非零 `errCode` 抛 `UniCloudError`、非 2xx 抛 `TransportError`，返回 `{ result, requestId, raw }`。
3. 在 `src/config.ts` 补默认 endpoint 与必填项校验，在 `src/client.ts` 的适配器选择分支注册。
4. 补 `test/`：报文结构、签名材料、错误解析、宿主代理模式各一组。

### 12.3 构建与发布

```bash
npm run typecheck
npm test
npm pack --dry-run      # 确认 files 字段：dist/ + cloud/ + examples/ + 文档
npm version patch
npm publish             # 或把 .tgz 分发给使用方
```

发布前检查：`dist/index.d.ts` 含全部公开类型、`describe()` 不泄露密钥、示例中的凭据均为占位符。

---

## 13. 已知限制与验证状态

**已验证**

- 支付宝云请求 URL、header、body 结构与官方客户端 SDK 生成的报文一致；
- HMAC-SHA256 签名与官方客户端 SDK **逐字节一致**（`test/golden.test.mjs`）；
- 57 项单测通过：参数传递、错误语义、uni-id 续期、云存储黄金对照、幂等重试、宿主桥、设备身份端到端、配置校验、平台识别、脱敏等；
- 纯 Node 环境可运行，无 uni-app / 浏览器 / Android 依赖。

**未验证 / 使用方需补做**

- 接入真实服务空间后的端到端往返（首次联调请用 `greeter.hello()` 一类只读方法，确认 `source === 'client'` 与响应体结构）；
- `AliyunAdapter` 为按协议实现的实验代码，未做真实联调；匿名 token 需宿主预先获取；
- 云存储上传、clientDB、SSEChannel 等能力未实现。

**明确不支持**：SecureNetwork 相关能力（`secretType`、客户端强制校验、双向加密），以及任何形式的客户端身份伪造。

---

## 附录 A：支付宝云报文格式

```
POST https://${spaceId}.api-hz.cloudbasefunction.cn/functions/invokeFunction

headers:
  x-to-function-name    : <云对象 / 云函数名>
  x-from-app-id         : <spaceAppId>
  x-from-env-id         : <spaceId>
  x-to-env-id           : <spaceId>
  x-from-instance-id    : <毫秒时间戳>
  x-from-function-name  : <同 x-to-function-name>
  x-client-timestamp    : <毫秒时间戳>
  x-alipay-source       : client
  x-request-id / x-alipay-callid / x-trace-id : <uuid>
  Content-Type          : application/json
  Authorization         : HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...

body (云对象): { "method": "<方法名>", "params": [...], "clientInfo": {...} }
body (云函数): { ...data, "clientInfo": {...}, "uniIdToken"?: "..." }

canonical     = "POST\n" + path + "\n" + query + "\n"
              + 已签名头的 "key:value\n" 行 + "\n"
              + 已签名头名（排序、; 连接） + "\n"
              + sha256(body) + "\n"
stringToSign  = "HMAC-SHA256\n" + timestamp + "\n" + sha256(canonical) + "\n"
Signature     = hex( HMAC-SHA256(stringToSign, secretKey) )
```

已签名头（按字典序）：`x-client-timestamp`、`x-from-app-id`、`x-from-env-id`、`x-from-function-name`、`x-from-instance-id`、`x-to-env-id`、`x-to-function-name`。

## 附录 B：环境变量速查

```
UNICLOUD_PROVIDER=alipay
UNICLOUD_SPACE_ID=env-xxxxxxxx
UNICLOUD_SPACE_APP_ID=
UNICLOUD_ACCESS_KEY=
UNICLOUD_SECRET_KEY=
UNICLOUD_CLIENT_SECRET=   # 仅阿里云空间
UNICLOUD_ENDPOINT=        # 可选，覆盖网关域名
UNICLOUD_DEVICE_ID=       # 可选，固定设备 ID
```

`UNICLOUD_APP_ID` 不是 SDK 读取的变量；`appId` 需显式传给 `createClient()`（示例脚本可能自行读取该变量）。

## 附录 C：许可

MIT。协议格式与签名算法参照 DCloud `@dcloudio/uni-cloud`（Apache-2.0）实现，用于与自有服务空间互操作；本 SDK 不是 DCloud 官方产品。
