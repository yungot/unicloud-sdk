import type { OutboundRequest, RawResponse, Transport } from './types.js';

export interface FetchTransportOptions {
  timeout?: number;
  fetchImpl?: typeof fetch;
}

/** 把 fetch 的 Headers 归一化为小写 key 的普通对象 */
export function normalizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** 默认传输层：标准 fetch，可在 Tauri WebView / Electron 渲染进程 / Node 20+ 使用 */
export class FetchTransport implements Transport {
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FetchTransportOptions = {}) {
    this.timeout = options.timeout ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async send(request: OutboundRequest): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      const text = await response.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // 保留原始文本，交给上层报错
      }
      return { status: response.status, data, headers: normalizeHeaders(response.headers) };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createFetchTransport(options?: FetchTransportOptions): Transport {
  return new FetchTransport(options);
}

/** 内存传输层，供测试或宿主自定义分发使用 */
export function createMockTransport(
  handler: (request: OutboundRequest) => RawResponse | Promise<RawResponse>,
): Transport & { requests: OutboundRequest[] } {
  const requests: OutboundRequest[] = [];
  return {
    requests,
    async send(request: OutboundRequest): Promise<RawResponse> {
      requests.push(request);
      return handler(request);
    },
  };
}
