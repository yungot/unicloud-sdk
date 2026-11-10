# 验证记录

本项目的每个能力都区分「离线验证」和「真实环境验证」。真实环境验证在一个支付宝云服务空间中进行（「客户端校验」关闭），使用 Node 20+ 在 Windows 上运行 `tools/` 下的脚本。以下为脱敏摘要。

## 离线验证

| 内容 | 方法 |
|---|---|
| 云函数 / 云对象调用报文与签名 | 与官方 `@dcloudio/uni-cloud` 运行时离线生成的报文逐字节对照（`test/golden.test.mjs`） |
| 云存储报文与签名 | 同上（`test/storage.test.mjs`），由 `tools/capture-official-golden.mjs` 生成 |
| 错误语义、uni-id 登录态 | 与官方运行时行为对照 |
| 设备身份 | SDK 与云端模块 `ucd-device-auth` 端到端测试：登记、篡改、重放、时钟漂移、吊销、账号绑定 |
| 宿主桥 | 白名单、私有方法、超大参数、凭据隐藏、IPC 结构化克隆 |

`npm test`：62 项全部通过。

## 真实环境验证

| 阶段 | 脚本 | 结果 |
|---|---|---|
| 云对象直调 | `tools/s2-live-check.mjs` | ✅ 云端 `getClientInfo()`：`source=client`、`osName=windows`；requestId 链路一致 |
| 扩展存储（七牛） | `tools/s2-live-check.mjs --ext` | ✅ 云对象下发参数 → 直传 → 下载比对一致 → 删除，5/5 |
| 设备身份 | `tools/s3-live-check.mjs` | ✅ 自动登记、写方法一次性 nonce、原样重放被拒、同设备不重复登记、错误码回传，6/6 |

真实环境中发现并已修复的平台差异：

1. 支付宝云上，云对象 `_before` 抛出的错误会变成 HTTP 500，errCode 丢失 → 提供 `protectCloudObject`，在方法内部校验并以普通结果返回错误码。
2. `uni-` 前缀为 DCloud 保留，数据表无法创建 → 云端命名统一为 `ucd-`。
3. 支付宝云数据库重复插入返回 `{ errCode: -409 }` → 识别为重放。
4. 扩展存储需为云对象添加 `uni-cloud-ext-storage` 扩展库依赖。

## 真实 Electron 应用验证（2026-11-10）

在一个 Windows Electron 桌面应用中（Electron 37，从 GitHub 安装 SDK 0.5.0）完整使用本 SDK 调用支付宝云服务空间，并用 electron-builder 打包成安装版运行。期间 SDK 代码无需任何改动。

| 能力 | 用法 | 结果 |
|---|---|---|
| 主进程 `createClient` + `importObject` | 多个业务云对象、数十个方法 | ✅ |
| 宿主桥 `createHostHandler` | 渲染进程只能提交「对象名 + 方法名 + 参数」，按白名单执行；开发版与正式版可登记不同的白名单 | ✅ |
| 幂等重试 `idempotentMethods` | 只读方法声明为幂等，网络抖动时自动重试；写方法只发一次 | ✅ |
| 设备身份 `createSoftwareDeviceKey` + 自定义 `KeyVault` | 设备私钥用 Electron `safeStorage`（DPAPI）加密保存，首次启动自动登记 | ✅ |
| 云端门禁 `protectCloudObject` | 所有业务云对象都用它；方法内通过 `this.device.deviceId` 实现按设备授权 | ✅ |
| 防重放 | 把同一请求原样再发一次，返回 `DEVICE_PROOF_REPLAYED` | ✅ |
| 登录态 `setUniIdToken` + 自定义 `TokenStore` | 应用自建登录的会话 token 交给 SDK 保存（`safeStorage` 加密），每次请求自动携带，云端 `this.getUniIdToken()` 取到；重启后免登录，退出时清除 | ✅（未用 uni-id，见下） |
| 自定义传输 `createFetchTransport` | 使用 Electron `net.fetch`（走系统代理） | ✅ |
| 打包后运行 | electron-builder（NSIS）安装版，SDK 打进主进程代码 | ✅ |

该应用没有接入 uni-id（`ucd-device-co` 的 `resolveUid` 按预留方式返回 `null`），所以下列 uni-id 相关能力仍未实测。

## 尚未在真实环境验证

- 内置存储上传与临时链接（离线已与官方逐字节一致）；中文 cloudPath
- uni-id：`uni-id-co` 登录经宿主桥、`newToken` 续期、`createUniIdResolver` 解析 uid、设备绑定账号
- 设备吊销
- macOS / Linux / Web 平台
- 阿里云服务空间（`AliyunAdapter` 为实验实现）

## 自己运行

```bash
cp .env.example .env.local      # 填入服务空间客户端配置
npm run build
node --env-file=.env.local tools/s2-live-check.mjs          # 云对象直调
node --env-file=.env.local tools/s2-live-check.mjs --ext    # 扩展存储（需部署 examples/cloud/s2-ext-probe）
node --env-file=.env.local tools/s3-live-check.mjs          # 设备身份（需部署 cloud/ 下的模块与 s3-guard-probe）
```

测试用的临时云对象（`s2-ext-probe`、`s3-guard-probe`）没有登录校验，验证后请从服务空间删除。
