# Changelog

## 未发布

### 文档
- 补充真实 Electron 应用验证记录：在 Windows Electron 桌面应用中完整使用 SDK 0.5.0，宿主桥、设备身份、safeStorage、登录态携带、`protectCloudObject`、打包安装版均在真实环境跑通，SDK 代码无需改动。README「验证状态」、§8 与 `docs/VERIFICATION.md` 同步更新。
- 「待真实环境验证」清单调整：移除「真实 Electron 中运行宿主桥、safeStorage」；明确列出 uni-id、设备吊销、内置存储、macOS / Linux / Web。

> 以上只改文档，代码与 0.5.0 相同。

## 0.5.0 首次公开发布 — 2026-11-07

- 包名 `@yungot/unicloud-sdk`（仓库 `yungot/unicloud-sdk`），MIT 许可。
- 签名黄金对照测试改用虚构服务空间 `env-golden`（由官方运行时重新生成）。
- 新增 `docs/VERIFICATION.md`（验证记录摘要）、`SECURITY.md`。
- 移除已弃用且不安全的 Tauri Rust 参考实现（`integrations/`）。

以下为公开前的开发记录。


## 0.5.0 — 2026-11-07（阶段 S4-1：uni-id 兼容，离线）

### 新增
- 宿主桥隐藏登录凭据：`HostPolicy.exposeTokens`（默认 false）。uni-id 登录结果中的 `token / tokenExpired / newToken / uniIdToken`（顶层）及嵌套的 `newToken / uniIdToken` 在返回给前端前删除；业务字段（如七牛上传参数 `formData.token`）不受影响。
- 宿主桥会话操作：`RemoteClient.getSession()`（登录状态、过期时间、设备 ID，不含 token）、`logout()`。
- 云端公共模块 `createUniIdResolver(uniIdCommon)`；`ucd-device-co` 与业务示例改用它。
- `examples/electron-token-store.mjs`：系统加密保存 uni-id 登录态，系统加密不可用时只保存在内存。
- README：§0、开头示例改为官方 todo 示例；§3 重写 Electron（宿主桥）与 Tauri 说明；新增 §5.2「与 uni-id 配合」，标注未实测。

> 以上 uni-id 相关能力已离线测试（62/62），尚未在真实服务空间验证。


## 0.4.0 — 2026-11-07（阶段 S3：设备身份与云端门禁）

### 新增
- 设备身份：`DeviceKey` 接口、`createSoftwareDeviceKey`（P-256，运行期不可导出）、`KeyVault`（宿主负责加密保存）、`createMemoryKeyVault`。
- 请求证明：开启 `options.device` 后，每个请求在 `clientInfo.devicePoP` 中附带对「设备 + 云对象 + 方法 + 参数 + 登录 token + 时间 + nonce」的签名。
- 自动处理：`DEVICE_NOT_ENROLLED` / `DEVICE_NOT_BOUND` 自动登记后重试；`DEVICE_PROOF_EXPIRED` 按 `serverTime` 校准后重试；登记响应同时校准时钟。
- `enrollDevice()`、`getDeviceId()`。
- 云端模板（`cloud/`）：公共模块 `ucd-device-auth`（登记、校验、重放拦截、吊销、用户绑定、内存与 uniCloud 数据库存储）、云对象 `ucd-device-co`、业务接入示例、数据库 schema 与唯一索引。
- `examples/electron-device-vault.mjs`：用 Electron safeStorage（DPAPI / Keychain）保存设备私钥，系统加密不可用时拒绝明文保存。
- `tools/s3-live-check.mjs` 与临时测试对象 `s3-guard-probe`。
- 云端命名统一使用 `ucd-` 前缀（`uni-` 为 DCloud 保留前缀，数据表无法创建）；SDK 默认登记云对象为 `ucd-device-co`。
- README 新增「我们做到了什么」：与官方 uni-app 内置 SDK 的能力与安全层级对比。


## 0.3.0 — 2026-11-06（阶段 S1：补齐调用能力）

### 新增
- 云存储（支付宝云）：`uploadFile`、`getTempFileURL`，报文与官方 `@dcloudio/uni-cloud` 逐字节一致（黄金对照）；`deleteFile` 明确抛 `UNSUPPORTED`（官方支付宝云客户端同样不支持）。
- `uploadWithOptions`：按云对象下发的上传参数直传（扩展存储 / 七牛），客户端不持有存储密钥；模板 `examples/cloud/file-co.js`。
- 可替换的 `FileUploader`（默认 fetch + FormData）。
- uni-id 登录态：`TokenStore`（内存 / localStorage）、`newToken` 自动保存、`onTokenRefresh`、`getTokenInfo`、`isTokenExpired`。
- 宿主桥支持存储：`storage.tempFileURL`、`storage.upload.pathPrefixes / maxBytes`，默认关闭；`errSubject` 可穿过 IPC。
- `UniCloudError` 增加 `errSubject`、`detail`。
- `tools/capture-official-golden.mjs`：用本机官方 SDK 离线生成黄金报文。
- `signAlipayRequest` 导出，`OutboundRequest` 支持 GET。

### 变更（行为变化，与官方对齐）
- `callFunction` 不再因云函数返回的业务 `errCode` 抛异常（官方行为）；`importObject` 方法在非零 `errCode` 时抛 `UniCloudError`。
- 调用方在 data 中显式传入的 `uniIdToken` 不再被覆盖（官方行为）。
- `setUniIdToken` 改为异步（返回 Promise）。
- HTTP ≥ 400 的 `TransportError` 带上网关 message 与 `trace_id`；响应无 trace 头时 requestId 回退为本次请求 ID。
- `getTempFileURL` 拒绝其他服务空间的 fileID（官方只警告）。


## 0.2.0 — 2026-11-06（阶段 S0：工程整顿）

### 新增
- 宿主桥 `createHostHandler` / `createRemoteClient`（`src/bridge.ts`）：渲染进程只能提交「对象名 + 方法名 + 参数」，宿主按白名单执行；拒绝 `_` 开头私有方法、非法名字、原型链键、超大参数；错误码与 requestId 跨 IPC 还原，内部异常不外泄。
- `CallFunctionOptions.idempotent`、`ImportObjectOptions.idempotentMethods`。
- `detectOsName` 导出；新增 iOS / Android UA 识别。
- `package.json` 增加 `engines.node >= 20`。

### 变更（行为变化）
- **重试只作用于声明幂等的调用。** 0.1.0 会对所有调用在网络错误 / 5xx 时重发，写操作可能在云端被重复执行；0.2.0 起非幂等调用只发送一次。

### 修复
- `importObject` 的 `defaults` 可覆盖 `method` / `params`，现已改为不可覆盖。
- iOS 的 UA 含 "like Mac OS X"，此前会被识别为 `macos`。
- 单测依赖运行环境操作系统（非 Windows 下 1 项失败），现已固定 `osName`。

### 弃用
- `hostDispatcher`：宿主会对前端传入的任意 `stringToSign` 签名（签名 Oracle）。保留兼容，新代码请用宿主桥。

### 未改动
- 支付宝云签名算法与报文格式（黄金对照测试不变）。
