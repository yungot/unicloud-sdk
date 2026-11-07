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

/**
 * 阿里云 / 腾讯云版客户端协议适配器（实验性，未做真实联调）。
 *
 * 与支付宝云差异：
 * - 入口为 `${endpoint}/client`，而非 /functions/invokeFunction
 * - 报文为 `method=serverless.function.runtime.invoke` + JSON 字符串 params
 * - 签名头 x-serverless-sign = HMAC(排序拼接的报文字段, clientSecret)
 * - 匿名授权 token 由宿主预先获取后通过 space.accessToken 传入
 *
 * 若你的服务空间是支付宝云（如 env-xxx.api-hz.cloudbasefunction.cn），请使用 AlipayAdapter。
 */
export class AliyunAdapter implements ProviderAdapter {
  constructor(private readonly crypto: CryptoBackend) {}

  async build(
    target: string,
    payload: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<OutboundRequest> {
    const { space } = ctx;
    const bodyObject: Record<string, unknown> = {
      method: 'serverless.function.runtime.invoke',
      params: JSON.stringify({ functionTarget: target, functionArgs: payload }),
      spaceId: space.spaceId,
      timestamp: Number(ctx.timestamp),
    };
    if (space.accessToken) bodyObject.token = space.accessToken;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (space.accessToken) headers['x-basement-token'] = space.accessToken;
    return {
      url: `${space.endpoint.replace(/\/$/, '')}/client`,
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObject),
    };
  }

  async sign(
    request: OutboundRequest,
    _ctx: RequestContext,
    signer: Signer,
  ): Promise<OutboundRequest> {
    const parsed: unknown = JSON.parse(request.body ?? '{}');
    const fields = Object.keys(parsed as Record<string, unknown>)
      .sort()
      .filter((key) => {
        const value = (parsed as Record<string, unknown>)[key];
        return value !== undefined && value !== null && value !== '';
      })
      .map((key) => `${key}=${String((parsed as Record<string, unknown>)[key])}`)
      .join('&');
    const signature = await signer.sign({ kind: 'aliyun', payload: fields });
    return { ...request, headers: { ...request.headers, 'x-serverless-sign': signature } };
  }

  parse(raw: RawResponse): InvocationResult {
    if (raw.status < 200 || raw.status >= 300) {
      throw new TransportError(`gateway returned HTTP ${raw.status}`, raw.status);
    }
    const data = raw.data as Record<string, unknown> | null;
    if (data?.error) {
      const error = data.error as Record<string, unknown>;
      throw new UniCloudError({
        errCode: String(error.code ?? 'SYS_ERR'),
        errMsg: String(error.message ?? 'uniCloud error'),
      });
    }
    return {
      result: data?.data ?? data?.result ?? data ?? null,
      requestId: raw.headers['x-serverless-request-id'] ?? raw.headers['request-id'] ?? '',
      raw,
    };
  }
}
