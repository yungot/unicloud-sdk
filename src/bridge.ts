/**
 * 宿主桥（Host Bridge）：替代 hostDispatcher 的推荐方案。
 *
 *   渲染进程 / WebView                     主进程 / 宿主（持有凭据）
 *   createRemoteClient(invoke)             createHostHandler(client, policy)
 *     .importObject('music').search(kw)      ├─ 校验对象名、方法名是否在白名单
 *        │                                   ├─ 校验参数形状与大小
 *        └── { kind, object, method, args } ─┼─► client.importObject(...)[method](...)
 *                                            └─ 返回 { ok, result } / { ok:false, error }
 *
 * 安全要点：
 * - 前端永远拿不到 secretKey，也无法让宿主对任意字符串签名（没有签名 Oracle）。
 * - 宿主只执行白名单内的「对象.方法」，以 `_` 开头的私有方法一律拒绝。
 * - 响应用信封返回而不是抛异常，避免 Electron IPC 丢失 errCode / requestId。
 */
import type { UniCloudDesktopClient } from './client.js';
import { UniCloudError, isUniCloudError } from './errors.js';
import { normalizeCloudPath } from './storage.js';
import type { CloudObjectMethods, TempFileURLResult, UploadFileResult } from './types.js';

/** 前端可以提交给宿主的调用描述（只有语义，没有 URL、请求头或签名材料） */
export type BridgeCall =
  | { kind: 'object'; object: string; method: string; args?: unknown[] }
  | { kind: 'function'; name: string; data?: Record<string, unknown> }
  | { kind: 'session'; op: 'status' | 'logout' }
  | { kind: 'storage'; op: 'getTempFileURL'; fileList: string[] }
  | {
      kind: 'storage';
      op: 'uploadFile';
      cloudPath: string;
      /** IPC 结构化克隆可传 ArrayBuffer / Uint8Array */
      file: ArrayBuffer | Uint8Array;
      fileName?: string;
      contentType?: string;
    };

export interface BridgeErrorPayload {
  errCode: string | number;
  errMsg: string;
  errSubject?: string;
  requestId?: string;
}

/** 宿主返回给前端的信封 */
export type BridgeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: BridgeErrorPayload };

export interface HostPolicy {
  /**
   * 云对象白名单：对象名 → 允许的方法名列表。
   * 例：{ music: ['search', 'getPlayUrl', 'getLyric'] }
   */
  objects?: Record<string, readonly string[]>;
  /** 允许直接调用的云函数名 */
  functions?: readonly string[];
  /** 幂等方法（会按 client 的 retries 重试），键同 objects */
  idempotent?: Record<string, readonly string[]>;
  /** 单次调用参数序列化后的最大字节数，默认 256 KiB */
  maxPayloadBytes?: number;
  /**
   * 内置云存储。默认全部关闭。
   * 注意：支付宝云不支持在云端控制前端存储权限，持有客户端密钥即可写任意路径，
   * 因此直传只允许落在 pathPrefixes 下；更安全的做法是由云对象下发上传参数（uploadWithOptions）。
   */
  storage?: {
    tempFileURL?: boolean;
    upload?: { pathPrefixes: readonly string[]; maxBytes?: number };
  };
  /**
   * 是否把登录凭据返回给前端，默认 false。
   * uni-id 登录（如 uni-id-co.login）的结果里带有 token：宿主会自动保存它，
   * 返回给前端前删除 token / newToken / uniIdToken 字段，前端永远拿不到凭据。
   */
  exposeTokens?: boolean;
}

/** 前端可见的登录状态（不含 token） */
export interface SessionStatus {
  loggedIn: boolean;
  tokenExpired: number | null;
  deviceId: string | null;
}

/** uni-id 凭据字段：顶层这些全删；嵌套层只删 newToken / uniIdToken（避免误删七牛上传参数里的 formData.token） */
const TOP_LEVEL_TOKEN_FIELDS = new Set(['token', 'tokenExpired', 'newToken', 'uniIdToken']);
const NESTED_TOKEN_FIELDS = new Set(['newToken', 'uniIdToken']);

function redactTokens(value: unknown, depth = 0): unknown {
  if (depth > 3 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactTokens(item, depth + 1));
  const fields = depth === 0 ? TOP_LEVEL_TOKEN_FIELDS : NESTED_TOKEN_FIELDS;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (fields.has(key)) continue;
    out[key] = redactTokens(item, depth + 1);
  }
  return out;
}

const OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const METHOD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DEFAULT_MAX_PAYLOAD = 256 * 1024;
const DEFAULT_MAX_UPLOAD = 20 * 1024 * 1024;

function reject(errCode: string, errMsg: string): BridgeResponse {
  return { ok: false, error: { errCode, errMsg } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function payloadSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
  } catch {
    return Number.POSITIVE_INFINITY; // 循环引用、BigInt 等不可序列化的输入
  }
}

function toErrorPayload(error: unknown): BridgeErrorPayload {
  if (isUniCloudError(error)) {
    return {
      errCode: error.errCode,
      errMsg: error.errMsg,
      requestId: error.requestId,
      ...(error.errSubject ? { errSubject: error.errSubject } : {}),
    };
  }
  // 非预期异常不把堆栈或内部信息透给前端
  return { errCode: 'HOST_ERROR', errMsg: 'host failed to complete the call' };
}

/**
 * 在宿主（Electron 主进程 / Node）创建调用处理器。
 * 返回的函数永不抛异常，适合直接挂到 ipcMain.handle。
 */
export function createHostHandler(
  client: UniCloudDesktopClient,
  policy: HostPolicy,
): (call: unknown) => Promise<BridgeResponse> {
  const objects = policy.objects ?? {};
  const functions = new Set(policy.functions ?? []);
  const maxBytes = policy.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD;
  const proxies = new Map<string, CloudObjectMethods>();
  const scrub = (value: unknown): unknown => (policy.exposeTokens ? value : redactTokens(value));

  const getObject = (name: string): CloudObjectMethods => {
    let proxy = proxies.get(name);
    if (!proxy) {
      const idempotentMethods = [...(policy.idempotent?.[name] ?? [])];
      proxy = client.importObject(name, { idempotentMethods });
      proxies.set(name, proxy);
    }
    return proxy;
  };

  return async (input: unknown): Promise<BridgeResponse> => {
    if (!isPlainObject(input)) return reject('BRIDGE_INVALID_CALL', 'call must be an object');

    if (input.kind === 'object') {
      const { object, method, args = [] } = input as { object: unknown; method: unknown; args?: unknown };
      if (typeof object !== 'string' || !OBJECT_NAME.test(object)) {
        return reject('BRIDGE_INVALID_CALL', 'invalid object name');
      }
      if (typeof method !== 'string' || !METHOD_NAME.test(method)) {
        return reject('BRIDGE_INVALID_CALL', 'invalid method name');
      }
      if (!Array.isArray(args)) return reject('BRIDGE_INVALID_CALL', 'args must be an array');
      const allowed = Object.prototype.hasOwnProperty.call(objects, object) ? objects[object] : undefined;
      if (!allowed || !allowed.includes(method)) {
        return reject('BRIDGE_NOT_ALLOWED', `${object}.${method} is not allowed`);
      }
      if (payloadSize(args) > maxBytes) return reject('BRIDGE_PAYLOAD_TOO_LARGE', 'payload too large');
      try {
        const fn = getObject(object)[method];
        if (!fn) return reject('BRIDGE_NOT_ALLOWED', `${object}.${method} is not allowed`);
        return { ok: true, result: scrub(await fn(...args)) };
      } catch (error) {
        return { ok: false, error: toErrorPayload(error) };
      }
    }

    if (input.kind === 'function') {
      const { name, data } = input as { name: unknown; data?: unknown };
      if (typeof name !== 'string' || !OBJECT_NAME.test(name)) {
        return reject('BRIDGE_INVALID_CALL', 'invalid function name');
      }
      if (!functions.has(name)) return reject('BRIDGE_NOT_ALLOWED', `${name} is not allowed`);
      if (data !== undefined && !isPlainObject(data)) {
        return reject('BRIDGE_INVALID_CALL', 'data must be a plain object');
      }
      if (payloadSize(data) > maxBytes) return reject('BRIDGE_PAYLOAD_TOO_LARGE', 'payload too large');
      try {
        const response = await client.callFunction({ name, ...(data ? { data } : {}) });
        return { ok: true, result: scrub(response.result) };
      } catch (error) {
        return { ok: false, error: toErrorPayload(error) };
      }
    }

    if (input.kind === 'session') {
      try {
        if (input.op === 'status') {
          const info = await client.getTokenInfo();
          const expired = info?.token ? await client.isTokenExpired() : true;
          const status: SessionStatus = {
            loggedIn: Boolean(info?.token) && !expired,
            tokenExpired: info?.tokenExpired ?? null,
            deviceId: await client.getDeviceId(),
          };
          return { ok: true, result: status };
        }
        if (input.op === 'logout') {
          await client.setUniIdToken(undefined);
          return { ok: true, result: { loggedIn: false } };
        }
      } catch (error) {
        return { ok: false, error: toErrorPayload(error) };
      }
      return reject('BRIDGE_INVALID_CALL', 'unknown session op');
    }

    if (input.kind === 'storage') {
      const storage = policy.storage ?? {};
      if (input.op === 'getTempFileURL') {
        if (!storage.tempFileURL) return reject('BRIDGE_NOT_ALLOWED', 'getTempFileURL is not allowed');
        const { fileList } = input as { fileList?: unknown };
        if (!Array.isArray(fileList) || fileList.some((item) => typeof item !== 'string')) {
          return reject('BRIDGE_INVALID_CALL', 'fileList must be an array of strings');
        }
        if (payloadSize(fileList) > maxBytes) return reject('BRIDGE_PAYLOAD_TOO_LARGE', 'payload too large');
        try {
          return { ok: true, result: await client.getTempFileURL({ fileList: fileList as string[] }) };
        } catch (error) {
          return { ok: false, error: toErrorPayload(error) };
        }
      }
      if (input.op === 'uploadFile') {
        const rule = storage.upload;
        if (!rule) return reject('BRIDGE_NOT_ALLOWED', 'uploadFile is not allowed');
        const { cloudPath, file, fileName, contentType } = input as {
          cloudPath?: unknown;
          file?: unknown;
          fileName?: unknown;
          contentType?: unknown;
        };
        let path: string;
        try {
          path = normalizeCloudPath(cloudPath);
        } catch {
          return reject('BRIDGE_INVALID_CALL', 'invalid cloudPath');
        }
        const prefixes = rule.pathPrefixes.map((p) => p.replace(/^\/+/, ''));
        if (!prefixes.some((prefix) => prefix && path.startsWith(prefix))) {
          return reject('BRIDGE_NOT_ALLOWED', 'cloudPath is outside allowed prefixes');
        }
        if (!(file instanceof ArrayBuffer) && !(file instanceof Uint8Array)) {
          return reject('BRIDGE_INVALID_CALL', 'file must be ArrayBuffer or Uint8Array');
        }
        if (file.byteLength > (rule.maxBytes ?? DEFAULT_MAX_UPLOAD)) {
          return reject('BRIDGE_PAYLOAD_TOO_LARGE', 'file too large');
        }
        if (fileName !== undefined && typeof fileName !== 'string') return reject('BRIDGE_INVALID_CALL', 'invalid fileName');
        if (contentType !== undefined && typeof contentType !== 'string') return reject('BRIDGE_INVALID_CALL', 'invalid contentType');
        try {
          const result = await client.uploadFile({
            cloudPath: path,
            file,
            ...(fileName ? { fileName } : {}),
            ...(contentType ? { contentType } : {}),
          });
          return { ok: true, result };
        } catch (error) {
          return { ok: false, error: toErrorPayload(error) };
        }
      }
      return reject('BRIDGE_INVALID_CALL', 'unknown storage op');
    }

    return reject('BRIDGE_INVALID_CALL', 'unknown call kind');
  };
}

const RESERVED = new Set(['then', 'catch', 'toJSON', 'toString', 'inspect', 'constructor', 'valueOf']);

export interface RemoteClient {
  importObject<T extends CloudObjectMethods>(name: string): T;
  callFunction<T = unknown>(name: string, data?: Record<string, unknown>): Promise<T>;
  getTempFileURL(options: { fileList: string[] }): Promise<TempFileURLResult>;
  /** 当前登录状态（不含 token） */
  getSession(): Promise<SessionStatus>;
  /** 退出登录：宿主清除保存的 token */
  logout(): Promise<{ loggedIn: false }>;
  uploadFile(options: {
    cloudPath: string;
    file: ArrayBuffer | Uint8Array;
    fileName?: string;
    contentType?: string;
  }): Promise<UploadFileResult>;
}

/**
 * 在前端（渲染进程 / WebView）创建与 createClient 写法一致的远程客户端。
 * `invoke` 负责把调用送到宿主，例如：
 *   (call) => window.cloud.invoke(call)               // Electron preload 暴露
 *   (call) => invoke('unicloud_call', { call })        // Tauri
 */
export function createRemoteClient(invoke: (call: BridgeCall) => Promise<unknown>): RemoteClient {
  const unwrap = async (call: BridgeCall): Promise<unknown> => {
    const response = (await invoke(call)) as BridgeResponse | undefined;
    if (response && response.ok === true) return response.result;
    const error = response && response.ok === false ? response.error : undefined;
    throw new UniCloudError({
      errCode: error?.errCode ?? 'BRIDGE_ERROR',
      errMsg: error?.errMsg ?? 'invalid response from host',
      ...(error?.requestId ? { requestId: error.requestId } : {}),
      ...(error?.errSubject ? { errSubject: error.errSubject } : {}),
    });
  };

  return {
    importObject<T extends CloudObjectMethods>(name: string): T {
      return new Proxy({} as T, {
        get: (_target, prop) => {
          if (typeof prop !== 'string' || RESERVED.has(prop)) return undefined;
          return (...args: unknown[]) => unwrap({ kind: 'object', object: name, method: prop, args });
        },
      });
    },
    callFunction<T = unknown>(name: string, data?: Record<string, unknown>): Promise<T> {
      return unwrap({ kind: 'function', name, ...(data ? { data } : {}) }) as Promise<T>;
    },
    getSession() {
      return unwrap({ kind: 'session', op: 'status' }) as Promise<SessionStatus>;
    },
    logout() {
      return unwrap({ kind: 'session', op: 'logout' }) as Promise<{ loggedIn: false }>;
    },
    getTempFileURL(options) {
      return unwrap({ kind: 'storage', op: 'getTempFileURL', fileList: options.fileList }) as Promise<TempFileURLResult>;
    },
    uploadFile(options) {
      return unwrap({ kind: 'storage', op: 'uploadFile', ...options }) as Promise<UploadFileResult>;
    },
  };
}
