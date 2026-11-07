import type { CryptoBackend, SignatureMaterial, Signer } from './types.js';

interface HashLike {
  update(data: string, encoding: string): { digest(encoding: string): string };
}
interface NodeCryptoLike {
  createHash(algorithm: string): HashLike;
  createHmac(algorithm: string, key: string): HashLike;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 浏览器 / WebView / Node 20+ 通用实现 */
export function createWebCryptoBackend(subtle?: SubtleCrypto): CryptoBackend {
  const backend = subtle ?? globalThis.crypto?.subtle;
  if (!backend) throw new Error('WebCrypto is unavailable; pass a CryptoBackend explicitly');
  return {
    async sha256Hex(input: string): Promise<string> {
      return toHex(await backend.digest('SHA-256', encoder.encode(input)));
    },
    async hmacSha256Hex(input: string, secret: string): Promise<string> {
      const key = await backend.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      return toHex(await backend.sign('HMAC', key, encoder.encode(input)));
    },
  };
}

let resolved: Promise<CryptoBackend> | null = null;

/** 自动选择可用实现，懒初始化，避免同步 import node:crypto 影响浏览器打包 */
export function resolveCrypto(): Promise<CryptoBackend> {
  if (!resolved) {
    resolved = (async (): Promise<CryptoBackend> => {
      if (globalThis.crypto?.subtle) return createWebCryptoBackend();
      // 用变量做动态导入，避免浏览器打包器静态解析 node: 内置模块，也无需 @types/node
      const moduleName = 'node:crypto';
      const nodeCrypto = (await import(/* @vite-ignore */ moduleName)) as NodeCryptoLike;
      return {
        async sha256Hex(input: string): Promise<string> {
          return nodeCrypto.createHash('sha256').update(input, 'utf8').digest('hex');
        },
        async hmacSha256Hex(input: string, secret: string): Promise<string> {
          return nodeCrypto.createHmac('sha256', secret).update(input, 'utf8').digest('hex');
        },
      };
    })();
  }
  return resolved;
}

/** 供自定义 CryptoBackend 使用的便捷代理 */
export const lazyCrypto: CryptoBackend = {
  sha256Hex: async (input) => (await resolveCrypto()).sha256Hex(input),
  hmacSha256Hex: async (input, secret) => (await resolveCrypto()).hmacSha256Hex(input, secret),
};

/**
 * 本地签名器：密钥在 SDK 进程内。适合 Node 工具、本地脚本、可信环境。
 * 桌面程序请只在主进程（宿主）创建 client，网页通过宿主桥调用（见 README §3.2）。
 */
export class LocalSigner implements Signer {
  constructor(
    private readonly crypto: CryptoBackend,
    private readonly secrets: { accessKey?: string; secretKey?: string; clientSecret?: string },
  ) {}

  async sign(material: SignatureMaterial): Promise<string> {
    if (material.kind === 'aliyun') {
      if (!this.secrets.clientSecret) throw new Error('clientSecret is required for aliyun signing');
      return this.crypto.hmacSha256Hex(material.payload, this.secrets.clientSecret);
    }
    if (!this.secrets.secretKey) throw new Error('secretKey is required for alipay signing');
    const signature = await this.crypto.hmacSha256Hex(material.stringToSign, this.secrets.secretKey);
    return `HMAC-SHA256 Credential=${material.credential}, SignedHeaders=${material.signedHeaders.join(';')}, Signature=${signature}`;
  }
}
