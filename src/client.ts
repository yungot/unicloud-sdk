import { LocalSigner, lazyCrypto } from './crypto.js';
import { defaultEndpoint, resolveSpace } from './config.js';
import { TransportError, UniCloudError } from './errors.js';
import { buildClientInfo, resolveDeviceId, uuid as defaultUuid } from './identity.js';
import {
  ALIPAY_STORAGE_SIGNED_HEADERS,
  AlipayAdapter,
  buildAlipayStorageRequest,
  isRecord,
  isSuccessCode,
  signAlipayRequest,
} from './providers/alipay.js';
import { AliyunAdapter } from './providers/aliyun.js';
import {
  MAX_TEMP_URL_BATCH,
  createFetchUploader,
  fileIdToPath,
  normalizeCloudPath,
  parseStorageResponse,
  pathToFileId,
} from './storage.js';
import { createMemoryTokenStore } from './token.js';
import {
  DEVICE_ERRORS,
  PROOF_VERSION,
  buildEnrollText,
  buildProofText,
  randomNonce,
  type DeviceProof,
} from './device.js';
import { FetchTransport } from './transport.js';
import type {
  CallFunctionOptions,
  ClientInfo,
  CloudObjectMethods,
  CryptoBackend,
  DesktopClientOptions,
  DeviceAuthOptions,
  FileUploader,
  GetTempFileURLOptions,
  Hooks,
  ImportObjectOptions,
  InvocationResult,
  OutboundRequest,
  ProviderAdapter,
  RawResponse,
  RequestContext,
  ResolvedSpaceConfig,
  SignatureMaterial,
  Signer,
  TempFileURLResult,
  TokenInfo,
  TokenStore,
  Transport,
  UploadFileOptions,
  UploadFileResult,
} from './types.js';

/**
 * 宿主进程分发器：SDK 只构造请求与签名材料，由 Rust / 主进程完成签名与发送。
 *
 * @deprecated 宿主会对 WebView 传来的任意 stringToSign 签名，等于把签名能力暴露给前端
 * （签名 Oracle）。新代码请改用 `createHostHandler` + `createRemoteClient`（见 bridge.ts）：
 * 前端只能提交「对象名 + 方法名 + 参数」，请求由宿主自己构造和签名。
 */
export type HostDispatcher = (input: {
  request: OutboundRequest;
  material: SignatureMaterial;
  ctx: RequestContext;
}) => Promise<RawResponse>;

export interface ExtendedClientOptions extends DesktopClientOptions {
  /** @deprecated 见 HostDispatcher */
  hostDispatcher?: HostDispatcher;
}

const RESERVED = new Set(['then', 'catch', 'toJSON', 'toString', 'inspect', 'constructor', 'valueOf']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 通用桌面 uniCloud 客户端。
 *
 * 与 uni-app 写法一致，但不依赖 uni-app Runtime / WebView 桥 / Android：
 *   const cloud = createClient({...})
 *   const todo = cloud.importObject('todo')
 *   await todo.add('title demo', 'content demo')
 */
export class UniCloudDesktopClient {
  readonly space: ResolvedSpaceConfig;

  private readonly options: ExtendedClientOptions;
  private readonly crypto: CryptoBackend;
  private readonly adapter: ProviderAdapter;
  private readonly signer: Signer;
  private readonly transport: Transport;
  private readonly uploader: FileUploader;
  private readonly tokenStore: TokenStore;
  private readonly hooks: Hooks;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly retries: number;
  private readonly ready: Promise<void>;
  private readonly device?: Required<Omit<DeviceAuthOptions, 'deviceName'>> & { deviceName?: string };
  /** 本机时钟与云端的偏差（毫秒），由云端 serverTime 校准，只用于设备证明的时间戳 */
  private clockOffset = 0;
  private enrolling: Promise<{ deviceId: string }> | null = null;
  private clientInfo!: ClientInfo;

  constructor(options: ExtendedClientOptions) {
    this.options = options;
    this.space = resolveSpace(options.space, undefined, {
      skipSecretCheck: Boolean(options.hostDispatcher || options.signer),
    });
    this.crypto = options.crypto ?? lazyCrypto;
    this.adapter =
      this.space.provider === 'alipay'
        ? new AlipayAdapter(this.crypto)
        : new AliyunAdapter(this.crypto);
    this.signer =
      options.signer ??
      new LocalSigner(this.crypto, {
        accessKey: this.space.accessKey,
        secretKey: this.space.secretKey,
        clientSecret: this.space.clientSecret,
      });
    const timeout = options.timeout ?? 15_000;
    this.transport = options.transport ?? new FetchTransport({ timeout });
    this.uploader = options.uploader ?? createFetchUploader();
    this.tokenStore = options.tokenStore ?? createMemoryTokenStore();
    this.hooks = options.hooks ?? {};
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? defaultUuid;
    this.retries = Math.max(0, options.retries ?? 1);
    if (options.device) {
      this.device = {
        key: options.device.key,
        enrollObject: options.device.enrollObject ?? 'ucd-device-co',
        autoEnroll: options.device.autoEnroll ?? true,
        ...(options.device.deviceName ? { deviceName: options.device.deviceName } : {}),
      };
    }
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    const deviceId = await resolveDeviceId(this.options);
    this.clientInfo = buildClientInfo(this.options, deviceId);
    if (this.options.uniIdToken) await this.tokenStore.set({ token: this.options.uniIdToken });
  }

  /** 当前上报的客户端身份（云端 getClientInfo() 可读取） */
  async getClientInfo(): Promise<ClientInfo> {
    await this.ready;
    return { ...this.clientInfo };
  }

  /** 追加自定义身份字段，不会被云端当作可信凭据，仅用于业务校验 */
  async patchClientInfo(patch: Record<string, unknown>): Promise<void> {
    await this.ready;
    this.clientInfo = { ...this.clientInfo, ...patch };
  }

  // ---------------------------------------------------------------- 登录态

  /** 设置（登录后）或清除（传 undefined，等同 logout）uni-id token */
  async setUniIdToken(token: string | undefined, tokenExpired?: number): Promise<void> {
    await this.ready;
    if (token) await this.tokenStore.set({ token, ...(tokenExpired ? { tokenExpired } : {}) });
    else await this.tokenStore.clear();
  }

  /** 读取当前登录态 */
  async getTokenInfo(): Promise<TokenInfo | null> {
    await this.ready;
    return (await this.tokenStore.get()) ?? null;
  }

  /** 本地判断 token 是否已过期（无过期时间时返回 false，以云端校验为准） */
  async isTokenExpired(): Promise<boolean> {
    const info = await this.getTokenInfo();
    if (!info?.token) return true;
    return typeof info.tokenExpired === 'number' && info.tokenExpired <= this.now();
  }

  /** 脱敏后的连接信息，便于日志排查 */
  describe(): Record<string, unknown> {
    return {
      provider: this.space.provider,
      spaceId: this.space.spaceId,
      endpoint: this.space.endpoint,
      appId: this.options.appId,
      hasSecret: Boolean(this.space.secretKey || this.space.clientSecret),
      hostMode: Boolean(this.options.hostDispatcher),
    };
  }

  // ---------------------------------------------------------------- 云函数 / 云对象

  /**
   * 调用云函数。与官方一致：云函数返回值原样放在 result 中，
   * 即使带非零 errCode 也不抛异常（网络错误 / HTTP ≥ 400 才抛）。
   */
  async callFunction<T = unknown>(options: CallFunctionOptions): Promise<InvocationResult<T>> {
    const params: Record<string, unknown> = { ...(options.data ?? {}) };
    delete params.clientInfo;
    delete params.uniIdToken;
    return this.invokeWithDevice<T>(options, '', params);
  }

  /**
   * 导入云对象。返回 Proxy，方法调用会被转成一次客户端协议请求。
   * 与官方一致：返回值带非零 errCode 时抛 UniCloudError（含 errSubject、detail、requestId）。
   */
  importObject<T extends CloudObjectMethods>(name: string, options: ImportObjectOptions = {}): T {
    const invoke = async (method: string, args: unknown[]): Promise<unknown> => {
      // defaults 先展开，method / params 后写，保证固定参数无法覆盖方法名与实参
      const data: Record<string, unknown> = { ...(options.defaults ?? {}), method, params: args };
      const idempotent = options.idempotentMethods?.includes(method) ?? false;
      const response = await this.invokeWithDevice<unknown>({ name, data, idempotent }, method, args);
      const result = response.result;
      if (isRecord(result) && !isSuccessCode(result.errCode)) {
        throw new UniCloudError({
          errCode: result.errCode as string | number,
          errMsg: typeof result.errMsg === 'string' ? result.errMsg : 'uniCloud error',
          requestId: response.requestId,
          ...(typeof result.errSubject === 'string' ? { errSubject: result.errSubject } : {}),
          detail: result,
        });
      }
      return result;
    };
    return new Proxy({} as T, {
      get: (_target, prop) => {
        if (typeof prop !== 'string' || RESERVED.has(prop)) return undefined;
        return (...args: unknown[]) => invoke(prop, args);
      },
      has: (_target, prop) => typeof prop === 'string' && !RESERVED.has(prop),
    });
  }

  // ---------------------------------------------------------------- 设备身份

  /** 本设备的 ID（公钥指纹）；未配置设备身份时返回 null */
  async getDeviceId(): Promise<string | null> {
    return this.device ? this.device.key.getKeyId() : null;
  }

  /**
   * 向云端登记本设备（挑战-签名）。已登录时设备会绑定到当前 uni-id 用户。
   * 一般不需要手动调用：云端返回 DEVICE_NOT_ENROLLED 时会自动登记。
   * 用户登录后可再调用一次，把匿名设备绑定到账号。
   */
  async enrollDevice(): Promise<{ deviceId: string }> {
    const device = this.device;
    if (!device) {
      throw new UniCloudError({ errCode: 'DEVICE_NOT_CONFIGURED', errMsg: '未配置设备身份（options.device）' });
    }
    if (!this.enrolling) {
      this.enrolling = (async () => {
        await this.ready;
        const co = this.importObject<{
          beginEnroll(input: unknown): Promise<Record<string, unknown>>;
          completeEnroll(input: unknown): Promise<Record<string, unknown>>;
        }>(device.enrollObject);
        const kid = await device.key.getKeyId();
        const begin = await co.beginEnroll({
          publicJwk: await device.key.getPublicJwk(),
          platform: this.clientInfo.osName,
          assurance: device.key.assurance,
          ...(device.deviceName ? { deviceName: device.deviceName } : {}),
        });
        this.syncClock(begin.serverTime);
        const enrollId = String(begin.enrollId ?? '');
        const challenge = String(begin.challenge ?? '');
        if (!enrollId || !challenge || begin.kid !== kid) {
          throw new UniCloudError({ errCode: 'DEVICE_ENROLL_FAILED', errMsg: '登记响应不合法' });
        }
        const signature = await device.key.signText(buildEnrollText({ enrollId, kid, challenge }));
        const done = await co.completeEnroll({ enrollId, signature });
        return { deviceId: String(done.deviceId ?? kid) };
      })().finally(() => {
        this.enrolling = null;
      });
    }
    return this.enrolling;
  }

  private syncClock(serverTime: unknown): void {
    if (typeof serverTime === 'number' && Number.isFinite(serverTime)) this.clockOffset = serverTime - this.now();
  }

  /**
   * 发送请求；设备证明被云端以「过期」或「未登记」拒绝时（业务尚未执行），
   * 校准时钟或自动登记后重试一次。
   */
  private async invokeWithDevice<T>(
    options: CallFunctionOptions,
    method: string,
    params: unknown,
  ): Promise<InvocationResult<T>> {
    const response = await this.sendOnce<T>(options, method, params);
    const device = this.device;
    if (!device || options.name === device.enrollObject) return response;
    const result = response.result;
    if (!isRecord(result)) return response;
    if (result.errCode === DEVICE_ERRORS.EXPIRED && typeof result.serverTime === 'number') {
      this.syncClock(result.serverTime);
      return this.sendOnce<T>(options, method, params);
    }
    // 未登记，或游客期登记的设备在登录后尚未绑定账号：登记（绑定）后重试
    if ((result.errCode === DEVICE_ERRORS.NOT_ENROLLED || result.errCode === DEVICE_ERRORS.NOT_BOUND) && device.autoEnroll) {
      await this.enrollDevice();
      return this.sendOnce<T>(options, method, params);
    }
    return response;
  }

  private async sendOnce<T>(
    options: CallFunctionOptions,
    method: string,
    params: unknown,
  ): Promise<InvocationResult<T>> {
    const ctx = await this.makeContext();
    const payload: Record<string, unknown> = { ...(options.data ?? {}) };
    if (!payload.uniIdToken && ctx.uniIdToken) payload.uniIdToken = ctx.uniIdToken;
    payload.clientInfo = await this.clientInfoFor(options.name, method, params, payload.uniIdToken);

    try {
      let raw: RawResponse;
      if (this.options.hostDispatcher) {
        const prepared = await this.prepare(options.name, payload, ctx);
        await this.hooks.onRequest?.(prepared.request, ctx);
        raw = await this.options.hostDispatcher(prepared);
      } else {
        const base = await this.adapter.build(options.name, payload, ctx);
        const signed = await this.adapter.sign(base, ctx, this.signer);
        await this.hooks.onRequest?.(signed, ctx);
        raw = await this.sendWithRetry(signed, options.idempotent === true);
      }
      const parsed = this.adapter.parse(raw) as InvocationResult<T>;
      if (!parsed.requestId) parsed.requestId = ctx.requestId;
      await this.captureNewToken(parsed.result);
      await this.hooks.onResponse?.(parsed, ctx);
      return parsed;
    } catch (error) {
      await this.hooks.onError?.(error, ctx);
      throw error;
    }
  }

  /** 每次请求生成新的设备证明（新 nonce、新时间戳），放进 clientInfo.devicePoP */
  private async clientInfoFor(
    target: string,
    method: string,
    params: unknown,
    uniIdToken: unknown,
  ): Promise<ClientInfo> {
    const device = this.device;
    if (!device || target === device.enrollObject) return this.clientInfo;
    const kid = await device.key.getKeyId();
    const ts = this.now() + this.clockOffset;
    const nonce = randomNonce();
    const text = await buildProofText(this.crypto, {
      kid,
      target,
      method,
      ts,
      nonce,
      params,
      ...(typeof uniIdToken === 'string' ? { uniIdToken } : {}),
    });
    const devicePoP: DeviceProof = { v: PROOF_VERSION, kid, ts, nonce, sig: await device.key.signText(text) };
    return { ...this.clientInfo, devicePoP };
  }

  // ---------------------------------------------------------------- 云存储

  /** 上传文件到云存储（支付宝云）。返回的 fileID 可用于 getTempFileURL。 */
  async uploadFile(options: UploadFileOptions): Promise<UploadFileResult> {
    const cloudPath = normalizeCloudPath(options.cloudPath);
    const ctx = await this.storageContext();
    const target = await this.storageRequest(`/${cloudPath}?post_url`, 'GET', undefined, ctx);
    const uploadUrl = target.upload_url;
    const fileId = target.file_id;
    if (typeof uploadUrl !== 'string' || typeof fileId !== 'string') {
      throw new UniCloudError({ errCode: 'UPLOAD_FAILED', errMsg: '存储网关未返回上传地址', requestId: ctx.requestId });
    }
    const formData: Record<string, string> = {};
    if (Array.isArray(target.form_data)) {
      for (const item of target.form_data) {
        if (isRecord(item) && typeof item.key === 'string') formData[item.key] = String(item.value ?? '');
      }
    }
    const { status } = await this.uploader.upload({
      url: uploadUrl,
      formData,
      fieldName: 'file',
      file: options.file,
      fileName: options.fileName ?? cloudPath.split('/').pop() ?? 'file',
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.onUploadProgress ? { onUploadProgress: options.onUploadProgress } : {}),
    });
    if (status >= 400) {
      throw new UniCloudError({ errCode: 'UPLOAD_FAILED', errMsg: `文件上传失败（HTTP ${status}）`, requestId: ctx.requestId, status });
    }
    return { fileID: fileId };
  }

  /** 批量获取临时下载链接（每次最多 50 个，有效期由云端决定，支付宝云为 600 秒） */
  async getTempFileURL(options: GetTempFileURLOptions): Promise<TempFileURLResult> {
    const { fileList } = options;
    if (!Array.isArray(fileList) || fileList.length === 0) {
      throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'fileList不能为空数组' });
    }
    if (fileList.length > MAX_TEMP_URL_BATCH) {
      throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'fileList数组长度不能超过50' });
    }
    const file_list = fileList.map((fileID) => {
      if (typeof fileID !== 'string' || !fileID.trim()) {
        throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'fileList的元素必须是非空的字符串' });
      }
      return { file_id: fileIdToPath(fileID, this.space.spaceId), expire: 600 };
    });
    const ctx = await this.storageContext();
    const data = await this.storageRequest('/?download_url', 'POST', { file_list }, ctx);
    const list = Array.isArray(data.file_list) ? data.file_list : [];
    return {
      fileList: list.filter(isRecord).map((item) => ({
        fileID: pathToFileId(String(item.file_id ?? ''), this.space.spaceId),
        tempFileURL: String(item.download_url ?? ''),
      })),
    };
  }

  /** 支付宝云客户端协议不支持删除文件：请在云对象中调用 uniCloud.deleteFile，并在那里做权限校验 */
  async deleteFile(_options: { fileList: string[] }): Promise<never> {
    throw new UniCloudError({
      errCode: 'UNSUPPORTED',
      errMsg: '客户端不支持删除云存储文件，请在云对象中调用 uniCloud.deleteFile',
    });
  }

  private async storageContext(): Promise<RequestContext> {
    if (this.space.provider !== 'alipay') {
      throw new UniCloudError({ errCode: 'UNSUPPORTED', errMsg: '云存储目前只支持支付宝云服务空间' });
    }
    if (this.options.hostDispatcher) {
      throw new UniCloudError({ errCode: 'UNSUPPORTED', errMsg: 'hostDispatcher 模式不支持云存储，请改用宿主桥' });
    }
    return this.makeContext();
  }

  private async storageRequest(
    pathWithQuery: string,
    method: 'GET' | 'POST',
    data: unknown,
    ctx: RequestContext,
  ): Promise<Record<string, unknown>> {
    // 与官方一致：存储请求固定走 spaceId 推导的默认网关
    const endpoint = defaultEndpoint('alipay', this.space.spaceId);
    const { request, path, query } = buildAlipayStorageRequest(endpoint, pathWithQuery, method, data, ctx);
    const signed = await signAlipayRequest(
      request,
      {
        path,
        query,
        signedHeaders: [...ALIPAY_STORAGE_SIGNED_HEADERS],
        timestamp: ctx.timestamp,
        accessKey: this.space.accessKey ?? '',
      },
      this.crypto,
      this.signer,
    );
    try {
      await this.hooks.onRequest?.(signed, ctx);
      // 获取上传地址与临时链接都没有副作用，可按 retries 重试
      const raw = await this.sendWithRetry(signed, true);
      return parseStorageResponse(raw, raw.headers['x-trace-id'] ?? ctx.requestId);
    } catch (error) {
      await this.hooks.onError?.(error, ctx);
      throw error;
    }
  }

  // ---------------------------------------------------------------- 宿主代理（已弃用）

  /**
   * 构造未签名请求 + 签名材料，供宿主进程代理签名与发送。
   * @deprecated 见 HostDispatcher
   */
  async prepare(
    target: string,
    payload: Record<string, unknown>,
    ctx?: RequestContext,
  ): Promise<{ request: OutboundRequest; material: SignatureMaterial; ctx: RequestContext }> {
    const context = ctx ?? (await this.makeContext());
    const body = { ...payload };
    if (!('clientInfo' in body)) body.clientInfo = this.clientInfo;
    const request = await this.adapter.build(target, body, context);
    const captured: { material?: SignatureMaterial } = {};
    await this.adapter.sign(request, context, {
      sign: (value: SignatureMaterial) => {
        captured.material = value;
        return '';
      },
    });
    if (!captured.material) throw new Error('provider did not produce signature material');
    return { request, material: captured.material, ctx: context };
  }

  /** 解析宿主进程返回的原始响应 */
  parseResponse<T = unknown>(raw: RawResponse): InvocationResult<T> {
    return this.adapter.parse(raw) as InvocationResult<T>;
  }

  // ---------------------------------------------------------------- 内部

  /** uni-id 自动续期：云端返回 newToken 时保存（与官方 importObject 行为一致） */
  private async captureNewToken(result: unknown): Promise<void> {
    if (!isRecord(result) || !isRecord(result.newToken)) return;
    const { token, tokenExpired } = result.newToken;
    if (typeof token !== 'string' || !token || typeof tokenExpired !== 'number') return;
    const info: TokenInfo = { token, tokenExpired };
    await this.tokenStore.set(info);
    await this.options.onTokenRefresh?.(info);
  }

  private async makeContext(): Promise<RequestContext> {
    await this.ready;
    const tokenInfo = await this.tokenStore.get();
    return {
      space: this.space,
      clientInfo: this.clientInfo,
      ...(tokenInfo?.token ? { uniIdToken: tokenInfo.token } : {}),
      timestamp: String(this.now()),
      requestId: this.uuid(),
    };
  }

  /**
   * 只有调用方声明幂等时才重试。
   * 非幂等调用（写库、计数、下单等）在超时或 5xx 时请求可能已经在云端执行，
   * 自动重发会导致重复执行，因此一律只发一次，由业务层决定是否重试。
   */
  private async sendWithRetry(request: OutboundRequest, idempotent: boolean): Promise<RawResponse> {
    const maxRetries = idempotent ? this.retries : 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const raw = await this.transport.send(request);
        if (raw.status >= 500 && attempt < maxRetries) {
          lastError = new TransportError(`gateway returned HTTP ${raw.status}`, raw.status);
          await sleep(200 * 2 ** attempt);
          continue;
        }
        return raw;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await sleep(200 * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new TransportError('request failed');
  }
}

export function createClient(options: ExtendedClientOptions): UniCloudDesktopClient {
  return new UniCloudDesktopClient(options);
}
