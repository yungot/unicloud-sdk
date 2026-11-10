# 云端部署：设备身份门禁

本目录是配合 SDK `options.device` 的云端代码模板，复制到你的 uni-app 工程（关联服务空间的那个）里部署。

> 命名统一使用 `ucd-` 前缀（uniCloud Desktop，设备身份模块）。`uni-` 前缀是 DCloud 官方保留的，数据表不能使用，云对象和公共模块也应避免与官方插件冲突。

```
cloud/
├── common/ucd-device-auth/          公共模块：登记、校验、吊销（只依赖 Node 内置 crypto）
├── cloudfunctions/
│   ├── ucd-device-co/               云对象：设备登记（beginEnroll / completeEnroll）、我的设备、吊销
│   ├── todo-guarded-example/        业务云对象接入示例
│   └── s3-guard-probe/              S3 临时测试对象（验证完删除）
└── database/                        3 个集合的 schema 与索引
```

## 部署步骤（HBuilderX）

1. **公共模块**：把 `common/ucd-device-auth` 复制到 `uniCloud-alipay/cloudfunctions/common/ucd-device-auth`，右键 → 上传公共模块。
2. **数据库**：把 `database/*.json` 复制到 `uniCloud-alipay/database/`，右键 `database` → 上传所有 DB Schema 及扩展校验函数。
   - 集合：`ucd-device-keys`、`ucd-device-enrolls`、`ucd-device-nonces`，权限全部为 false（只允许云端访问）。
   - 索引文件 `*.index.json` 若未自动生效，请在控制台为 `ucd-device-nonces.nonceKey`、`ucd-device-keys.kid`、`ucd-device-enrolls.enrollId` 手动建**唯一索引**。没有唯一索引时模块有兜底（插入后计数），但唯一索引更可靠也更快。
3. **云对象 ucd-device-co**：复制到 `cloudfunctions/ucd-device-co`，右键 →「管理公共模块或扩展库依赖」勾选 `ucd-device-auth`（如使用 uni-id，同时勾选 `uni-id-common`），上传部署。
4. **业务云对象**：参照 `todo-guarded-example` 用 `protectCloudObject` 包装导出的方法，同样添加 `ucd-device-auth` 依赖。
   **不要在 `_before` 里抛错**：支付宝云会把 `_before` 抛出的错误变成 HTTP 500「用户函数代码语法或逻辑异常」，客户端拿不到 errCode，SDK 也就无法自动登记 / 校准时钟。

## 错误码

| errCode | 含义 | SDK 行为 |
|---|---|---|
| `DEVICE_NOT_ENROLLED` | 设备未登记 | 自动登记后重试一次 |
| `DEVICE_NOT_BOUND` | 已登录，但设备是游客期登记的 | 自动重新登记（绑定账号）后重试一次 |
| `DEVICE_PROOF_EXPIRED` | 本机时间偏差超过 ±120 秒 | 按返回的 `serverTime` 校准后重试一次 |
| `DEVICE_PROOF_MISSING` / `MALFORMED` / `INVALID` | 没有证明 / 格式错误 / 签名不对 | 抛出 |
| `DEVICE_PROOF_REPLAYED` | 同一请求重放 | 抛出 |
| `DEVICE_REVOKED` | 设备已被停用 | 抛出（需用户处理） |
| `DEVICE_USER_MISMATCH` | 设备绑定的是其他账号 | 抛出 |

以上自动重试都发生在业务代码执行之前（被 `_before` 拒绝），不会造成重复执行。

## 性能

- 读方法（`readMethods`）：每次请求 1 次设备查询（实例内缓存 30 秒，实际多数命中缓存），无写入。
- 写方法：额外 1 次 nonce 写入 + 1 次计数（有唯一索引时计数可删）。
- 过期的 nonce / 登记记录按 1% 概率顺带清理；访问量大时可改为定时触发器清理。
