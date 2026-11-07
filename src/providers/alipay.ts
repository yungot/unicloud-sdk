import { TransportError, UniCloudError } from '../errors.js';
import type {
  CryptoBackend,
  InvocationResult,
  OutboundRequest,
  ProviderAdapter,
  RawResponse,
  RequestContext,
  Signer,
} from '../types.js';

const INVOKE_PATH = '/functions/invokeFunction';

/** 所有支付宝云客户端请求都签名的基础头 */
const BASE_SIGNED_HEADERS = [
  'x-from-app-id',
  'x-from-env-id',
  'x-to-env-id',
  'x-from-instance-id',
  'x-from-function-name',
  'x-client-timestamp',
];

const INVOKE_SIGNED_HEADERS = [...BASE_SIGNED_HEADERS, 'x-to-function-name'].sort();
const STORAGE_SIGNED_HEADERS = [...BASE_SIGNED_HEADERS, 'x-data-api-type', 'x-expire-timestamp'].sort();

/** 存储签名有效期（与官方客户端一致：60 秒） */
const STORAGE_EXPIRE_MS = 60_000;

function baseHeaders(ctx: RequestContext, functionName: string): Record<string, string> {
  const { space } = ctx;
  return {
    'x-from-app-id': space.spaceAppId ?? '',
    'x-from-env-id': space.spaceId,
    'x-to-env-id': space.spaceId,
    'x-from-instance-id': ctx.timestamp,
    'x-from-function-name': functionName,
    'x-client-timestamp': ctx.timestamp,
    'x-alipay-source': 'client',
    'x-request-id': ctx.requestId,
    'x-alipay-callid': ctx.requestId,
    'x-trace-id': ctx.requestId,
  };
}

/**
 * 支付宝云客户端签名（与官方 `@dcloudio/uni-cloud` 逐字节对照）：
 *   canonical = METHOD \n path \n query \n signedHeaderLines \n signedHeaders \n sha256(body) \n
 *   stringToSign = `HMAC-SHA256\n${timestamp}\n${sha256(canonical)}\n`
 *
 * path / query 使用调用方给出的原始字符串（不做 URL 编码），与官方行为一致。
 */
export async function signAlipayRequest(
  request: OutboundRequest,
  input: { path: string; query: string; signedHeaders: string[]; timestamp: string; accessKey: string },
  crypto: CryptoBackend,
  signer: Signer,
): Promise<OutboundRequest> {
  const headerLines = input.signedHeaders
    .map((key) => `${key.toLowerCase()}:${request.headers[key] ?? ''}\n`)
    .join('');
  const bodyHash = await crypto.sha256Hex(request.body ?? '');
  const canonical =
    `${request.method}\n${input.path}\n${input.query}\n` +
    `${headerLines}\n${input.signedHeaders.join(';')}\n${bodyHash}\n`;
  const canonicalHash = await crypto.sha256Hex(canonical);
  const stringToSign = `HMAC-SHA256\n${input.timestamp}\n${canonicalHash}\n`;

  const authorization = await signer.sign({
    kind: 'alipay',
    timestamp: input.timestamp,
    stringToSign,
    credential: input.accessKey,
    signedHeaders: input.signedHeaders,
  });
  return { ...request, headers: { ...request.headers, Authorization: authorization } };
}

/**
 * 构造支付宝云对象存储（OSS 模式）请求，未签名。
 * @param pathWithQuery 如 `/avatar/u1.png?post_url` 或 `/?download_url`
 */
export function buildAlipayStorageRequest(
  endpoint: string,
  pathWithQuery: string,
  method: 'GET' | 'POST',
  data: unknown,
  ctx: RequestContext,
): { request: OutboundRequest; path: string; query: string } {
  const [path = '', query = ''] = pathWithQuery.split('?');
  const headers: Record<string, string> = {
    'x-alipay-cloud-mode': 'oss',
    'x-data-api-type': 'oss',
    'x-expire-timestamp': String(Number(ctx.timestamp) + STORAGE_EXPIRE_MS),
    ...baseHeaders(ctx, ''),
  };
  const request: OutboundRequest = {
    url: `${endpoint.replace(/\/$/, '')}${pathWithQuery}`,
    method,
    headers,
  };
  if (data !== undefined) {
    request.body = JSON.stringify(data);
    request.headers['Content-Type'] = 'application/json';
  }
  return { request, path, query };
}

export const ALIPAY_STORAGE_SIGNED_HEADERS: readonly string[] = STORAGE_SIGNED_HEADERS;

/**
 * 支付宝云客户端协议适配器（云函数 / 云对象调用）。
 *
 * 错误语义与官方客户端一致：
 * - HTTP ≥ 400：抛 TransportError；
 * - HTTP 2xx：云函数返回值原样作为 result，即使其中带非零 errCode
 *   （云对象的 errCode 由 client.importObject 统一抛出）。
 */
export class AlipayAdapter implements ProviderAdapter {
  constructor(private readonly crypto: CryptoBackend) {}

  async build(
    target: string,
    payload: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<OutboundRequest> {
    const headers: Record<string, string> = {
      'x-to-function-name': target,
      ...baseHeaders(ctx, target),
      'Content-Type': 'application/json',
    };
    return {
      url: `${ctx.space.endpoint.replace(/\/$/, '')}${INVOKE_PATH}`,
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    };
  }

  async sign(request: OutboundRequest, ctx: RequestContext, signer: Signer): Promise<OutboundRequest> {
    return signAlipayRequest(
      request,
      {
        path: INVOKE_PATH,
        query: '',
        signedHeaders: INVOKE_SIGNED_HEADERS,
        timestamp: ctx.timestamp,
        accessKey: ctx.space.accessKey ?? '',
      },
      this.crypto,
      signer,
    );
  }

  parse(raw: RawResponse): InvocationResult {
    const requestId = readRequestId(raw);
    if (raw.status < 200 || raw.status >= 300) {
      const data = isRecord(raw.data) ? raw.data : {};
      const message =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.errMsg === 'string' && data.errMsg) ||
        (typeof raw.data === 'string' ? raw.data.slice(0, 300) : '') ||
        'request:fail';
      throw new TransportError(`gateway returned HTTP ${raw.status}: ${message}`, raw.status, requestId);
    }
    return { result: raw.data, requestId, raw };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** errCode 是否表示成功（0、'0'、空串、null、undefined） */
export function isSuccessCode(value: unknown): boolean {
  return value === undefined || value === 0 || value === '0' || value === '' || value === null;
}

export function readRequestId(raw: RawResponse): string {
  const fromHeader =
    raw.headers['x-trace-id'] ?? raw.headers['x-request-id'] ?? raw.headers['request-id'];
  if (fromHeader) return fromHeader;
  if (isRecord(raw.data)) {
    if (typeof raw.data.requestId === 'string') return raw.data.requestId;
    if (typeof raw.data.trace_id === 'string') return raw.data.trace_id;
  }
  return '';
}
