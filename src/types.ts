/** 支持的云服务商。支付宝云为已验证实现，阿里云为实验实现。 */
export type ProviderName = 'alipay' | 'aliyun';

/** 服务空间连接参数。凭据应由宿主注入，不要硬编码进前端 bundle。 */
export interface SpaceConfig {
  provider?: ProviderName;
  /** 服务空间 ID，如 env-xxxxxxxx */
  spaceId: string;
  /** 支付宝云：空间 AppId */
  spaceAppId?: string;
  /** 支付宝云：AccessKey */
  accessKey?: string;
  /** 支付宝云：SecretKey（签名密钥） */
  secretKey?: string;
  /** 阿里云：客户端密钥 */
  clientSecret?: string;
  /** 覆盖网关域名，默认由 spaceId 推导 */
  endpoint?: string;
  /** 阿里云：匿名访问 token（可选，由宿主预先获取） */
  accessToken?: string;
}

/** 内部使用的已补全配置 */
export interface ResolvedSpaceConfig extends SpaceConfig {
  provider: ProviderName;
  endpoint: string;
}

/** 上报给云对象的客户端身份信息。大写字段兼容 uniCloud 的 context 读取。 */
export interface ClientInfo {
  PLATFORM: string;
  OS: string;
  APPID: string;
  DEVICEID: string;
  deviceId: string;
  osName: string;
  uniPlatform: string;
  appId: string;
  appVersion: string;
  appVersionCode: string;
  appLanguage: string;
  ua: string;
  locale: string;
  LOCALE: string;
  [key: string]: unknown;
}

/** 设备 ID 持久化接口。桌面程序应注入自己的实现（Tauri store / 配置文件 / 注册表）。 */
export interface DeviceIdStore {
  get(): string | null | Promise<string | null>;
  set(id: string): void | Promise<void>;
}

/** 密码学后端。默认自动选择 WebCrypto 或 Node crypto。 */
export interface CryptoBackend {
  sha256Hex(input: string): Promise<string>;
  hmacSha256Hex(input: string, secret: string): Promise<string>;
}

/**
 * 待签名材料。
 * - alipay：stringToSign 为 HMAC 输入，返回完整 Authorization 头值
 * - aliyun：payload 为待签名串，返回 x-serverless-sign 头值
 */
export type SignatureMaterial =
  | {
      kind: 'alipay';
      timestamp: string;
      stringToSign: string;
      credential: string;
      signedHeaders: string[];
    }
  | { kind: 'aliyun'; payload: string };

/** 签名器。可实现为宿主进程代理，使密钥永不进入 WebView。 */
export interface Signer {
  sign(material: SignatureMaterial): Promise<string> | string;
}

/** 已构造、可直接发送的 HTTP 请求 */
export interface OutboundRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** GET 请求无 body */
  body?: string;
}

/** 传输层原始响应 */
export interface RawResponse {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

/** 传输层。可实现为 Tauri invoke / Electron net / 代理转发。 */
export interface Transport {
  send(request: OutboundRequest): Promise<RawResponse>;
}

/** 一次调用的结果 */
export interface InvocationResult<T = unknown> {
  result: T;
  requestId: string;
  raw: RawResponse;
}

/** 请求上下文，每次调用生成一份 */
export interface RequestContext {
  space: ResolvedSpaceConfig;
  clientInfo: ClientInfo;
  uniIdToken?: string;
  timestamp: string;
  requestId: string;
}

/** 云服务商协议适配器 */
export interface ProviderAdapter {
  /** 构造未签名请求 */
  build(target: string, payload: Record<string, unknown>, ctx: RequestContext): Promise<OutboundRequest>;
  /** 计算签名材料并通过 signer 完成签名 */
  sign(request: OutboundRequest, ctx: RequestContext, signer: Signer): Promise<OutboundRequest>;
  /** 解析网关响应 */
  parse(raw: RawResponse): InvocationResult;
}

/** 设备身份（S3） */
export interface DeviceAuthOptions {
  /** 设备密钥，见 createSoftwareDeviceKey */
  key: import('./device.js').DeviceKey;
  /** 负责设备登记的云对象名，默认 ucd-device-co */
  enrollObject?: string;
  /** 云端返回 DEVICE_NOT_ENROLLED 时自动登记并重试一次，默认 true */
  autoEnroll?: boolean;
  /** 登记时上报的设备名（便于用户在设备列表里辨认） */
  deviceName?: string;
}

/** uni-id 登录态 */
export interface TokenInfo {
  token: string;
  /** 过期时间戳（毫秒），由 uni-id 返回 */
  tokenExpired?: number;
}

/**
 * 登录态持久化接口。桌面程序建议在主进程用 Electron safeStorage 加密后写文件实现；
 * 默认是内存存储，进程退出即丢失。
 */
export interface TokenStore {
  get(): TokenInfo | null | Promise<TokenInfo | null>;
  set(info: TokenInfo): void | Promise<void>;
  clear(): void | Promise<void>;
}

/** 文件内容：Blob（含 File）、ArrayBuffer 或 Uint8Array */
export type FileBody = Blob | ArrayBuffer | Uint8Array;

/** 上传到对象存储（表单直传）。默认用 fetch + FormData 实现，可替换为带进度的实现。 */
export interface FileUploader {
  upload(input: {
    url: string;
    /** 存储服务下发的表单字段，必须原样提交 */
    formData: Record<string, string>;
    /** 文件字段名，支付宝云为 'file' */
    fieldName: string;
    file: FileBody;
    fileName: string;
    contentType?: string;
    onUploadProgress?: (progress: { loaded: number; total: number }) => void;
  }): Promise<{ status: number }>;
}

export interface UploadFileOptions {
  /** 云端路径，如 avatar/u1.png。建议只用 ASCII 字符 */
  cloudPath: string;
  file: FileBody;
  /** 表单中的文件名，默认取 cloudPath 最后一段 */
  fileName?: string;
  contentType?: string;
  onUploadProgress?: (progress: { loaded: number; total: number }) => void;
}

export interface UploadFileResult {
  fileID: string;
}

export interface GetTempFileURLOptions {
  /** fileID 列表，最多 50 个 */
  fileList: string[];
}

export interface TempFileURLResult {
  fileList: Array<{ fileID: string; tempFileURL: string }>;
}

/** 拦截器 */
export interface Hooks {
  onRequest?: (request: OutboundRequest, ctx: RequestContext) => void | Promise<void>;
  onResponse?: (result: InvocationResult, ctx: RequestContext) => void | Promise<void>;
  onError?: (error: unknown, ctx: RequestContext) => void | Promise<void>;
}

/** 客户端配置 */
export interface DesktopClientOptions {
  space: SpaceConfig;
  /** DCloud AppId，如 __UNI__XXXXXXX */
  appId: string;
  /** 稳定设备 ID。不传则由 deviceIdStore 提供或自动生成 */
  deviceId?: string;
  deviceIdStore?: DeviceIdStore;
  osName?: string;
  uniPlatform?: string;
  locale?: string;
  appVersion?: string;
  appVersionCode?: string;
  userAgent?: string;
  /** 附加到 clientInfo 的自定义字段（云端可在 _before 中校验） */
  extraClientInfo?: Record<string, unknown>;
  /** 初始 uni-id 登录态 token（会写入 tokenStore） */
  uniIdToken?: string;
  /** 登录态持久化，默认内存存储 */
  tokenStore?: TokenStore;
  /** 云端下发新 token（uni-id 自动续期）后回调 */
  onTokenRefresh?: (info: TokenInfo) => void | Promise<void>;
  /** 云存储表单直传实现，默认 fetch + FormData */
  uploader?: FileUploader;
  /** 设备身份：开启后每个请求自动附带设备签名证明 */
  device?: DeviceAuthOptions;
  /** 请求超时毫秒，默认 15000 */
  timeout?: number;
  /** 幂等调用在网络错误 / 5xx 时的重试次数，默认 1；非幂等调用永不自动重试 */
  retries?: number;
  crypto?: CryptoBackend;
  transport?: Transport;
  signer?: Signer;
  hooks?: Hooks;
  /** 注入时钟与随机源，便于测试 */
  now?: () => number;
  uuid?: () => string;
}

/** callFunction 参数 */
export interface CallFunctionOptions {
  name: string;
  data?: Record<string, unknown>;
  /**
   * 声明本次调用幂等（重复执行无副作用，如查询）。
   * 只有幂等调用才会在网络错误 / 5xx 时按 `retries` 自动重试，默认 false。
   */
  idempotent?: boolean;
}

/** 云对象导入选项 */
export interface ImportObjectOptions {
  /** 附加到每次方法的固定参数（如客户端版本号）。不能覆盖 method / params。 */
  defaults?: Record<string, unknown>;
  /** 幂等方法名单（如 search、getLyric），只有这些方法会自动重试 */
  idempotentMethods?: string[];
}

/** 任意云对象的调用签名 */
export type CloudObjectMethods = Record<string, (...args: any[]) => Promise<any>>;
