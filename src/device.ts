/**
 * 设备身份（S3）：每台设备一把 P-256 私钥，每个请求附带「持有私钥」的证明。
 *
 * 协议（v1，与 cloud/common/ucd-device-auth 一致）：
 *
 *   登记：beginEnroll(publicJwk) → { enrollId, challenge }
 *         completeEnroll(enrollId, sign("UCDE1\n{enrollId}\n{kid}\n{challenge}"))
 *
 *   请求：clientInfo.devicePoP = { v: 1, kid, ts, nonce, sig }
 *         sig = ECDSA-P256-SHA256( "UCDP1\n{kid}\n{target}\n{method}\n{ts}\n{nonce}\n{sha256(params)}\n{sha256(uniIdToken)}" )
 *
 * kid 是公钥的 JWK SHA-256 指纹（RFC 7638），签名为 IEEE-P1363（r||s）的 base64url。
 * 证明绑定了：哪台设备、调用哪个对象/方法、参数内容、当前登录 token、时间和一次性 nonce。
 */
import { lazyCrypto } from './crypto.js';
import type { CryptoBackend } from './types.js';

export const PROOF_VERSION = 1;
export const PROOF_PREFIX = 'UCDP1';
export const ENROLL_PREFIX = 'UCDE1';

const encoder = new TextEncoder();

// ---------------------------------------------------------------- 编码工具

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 确定性 JSON：对象键按 UTF-16 码点排序，undefined 字段省略，数组保持顺序。
 * 云端用同一算法对收到的参数重新计算，保证两端哈希一致。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined && typeof record[key] !== 'function')
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export interface DeviceProof {
  v: number;
  kid: string;
  ts: number;
  nonce: string;
  sig: string;
}

export async function buildProofText(
  crypto: CryptoBackend,
  input: { kid: string; target: string; method: string; ts: number; nonce: string; params: unknown; uniIdToken?: string },
): Promise<string> {
  const paramsHash = await crypto.sha256Hex(canonicalJson(input.params));
  const tokenHash = await crypto.sha256Hex(input.uniIdToken ?? '');
  return [PROOF_PREFIX, input.kid, input.target, input.method, String(input.ts), input.nonce, paramsHash, tokenHash].join('\n');
}

export function buildEnrollText(input: { enrollId: string; kid: string; challenge: string }): string {
  return [ENROLL_PREFIX, input.enrollId, input.kid, input.challenge].join('\n');
}

export function randomNonce(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

// ---------------------------------------------------------------- 设备密钥

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** 设备密钥保护等级（客户端自报，云端只作记录，不作为信任依据） */
export type DeviceKeyAssurance = 'software' | 'os-protected' | 'tpm' | 'webcrypto';

/**
 * 设备密钥。只应存在于宿主（Electron 主进程 / Node），不要暴露给渲染进程。
 * 可替换实现：软件密钥（本文件）、TPM（后续）、浏览器 IndexedDB（预留）。
 */
export interface DeviceKey {
  readonly assurance: DeviceKeyAssurance;
  getKeyId(): Promise<string>;
  getPublicJwk(): Promise<PublicJwk>;
  /** 对 SDK 构造的协议文本签名，返回 base64url(r||s) */
  signText(text: string): Promise<string>;
  /** 删除本机密钥（重置设备身份） */
  reset(): Promise<void>;
}

/** 私钥持久化。宿主负责加密（如 Electron safeStorage / DPAPI / Keychain）。 */
export interface KeyVault {
  load(): Promise<Uint8Array | null>;
  save(data: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

export function createMemoryKeyVault(): KeyVault {
  let data: Uint8Array | null = null;
  return {
    load: async () => (data ? new Uint8Array(data) : null),
    save: async (value) => {
      data = new Uint8Array(value);
    },
    clear: async () => {
      data = null;
    },
  };
}

/** RFC 7638 JWK 指纹（EC 公钥） */
export async function jwkThumbprint(crypto: CryptoBackend, jwk: PublicJwk): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  const hex = await crypto.sha256Hex(canonical);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return base64UrlEncode(bytes);
}

const ECDSA_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

/**
 * 软件设备密钥：WebCrypto 生成 P-256，PKCS#8 交给 vault 持久化（由宿主加密），
 * 运行期以不可导出的 CryptoKey 签名。
 */
export function createSoftwareDeviceKey(options: {
  vault: KeyVault;
  crypto?: CryptoBackend;
  /** vault 由操作系统加密时标记为 os-protected，否则 software */
  assurance?: DeviceKeyAssurance;
  subtle?: SubtleCrypto;
}): DeviceKey {
  const subtle = options.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto is unavailable');
  let state: Promise<{ key: CryptoKey; jwk: PublicJwk; kid: string }> | null = null;

  const load = async (): Promise<{ key: CryptoKey; jwk: PublicJwk; kid: string }> => {
    let pkcs8 = await options.vault.load();
    if (!pkcs8) {
      const pair = (await subtle.generateKey(ECDSA_PARAMS, true, ['sign', 'verify'])) as CryptoKeyPair;
      pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
      await options.vault.save(pkcs8);
    }
    const exportable = await subtle.importKey('pkcs8', pkcs8 as BufferSource, ECDSA_PARAMS, true, ['sign']);
    const full = (await subtle.exportKey('jwk', exportable)) as JsonWebKey;
    if (!full.x || !full.y) throw new Error('invalid device key');
    const jwk: PublicJwk = { kty: 'EC', crv: 'P-256', x: full.x, y: full.y };
    const key = await subtle.importKey('pkcs8', pkcs8 as BufferSource, ECDSA_PARAMS, false, ['sign']);
    pkcs8.fill(0);
    return { key, jwk, kid: await jwkThumbprint(options.crypto ?? lazyCrypto, jwk) };
  };

  const get = (): Promise<{ key: CryptoKey; jwk: PublicJwk; kid: string }> => {
    if (!state) {
      state = load().catch((error) => {
        state = null;
        throw error;
      });
    }
    return state;
  };

  return {
    assurance: options.assurance ?? 'software',
    getKeyId: async () => (await get()).kid,
    getPublicJwk: async () => ({ ...(await get()).jwk }),
    async signText(text) {
      const { key } = await get();
      const sig = await subtle.sign(SIGN_PARAMS, key, encoder.encode(text));
      return base64UrlEncode(new Uint8Array(sig));
    },
    async reset() {
      state = null;
      await options.vault.clear();
    },
  };
}

// ---------------------------------------------------------------- 错误码

export const DEVICE_ERRORS = {
  MISSING: 'DEVICE_PROOF_MISSING',
  MALFORMED: 'DEVICE_PROOF_MALFORMED',
  EXPIRED: 'DEVICE_PROOF_EXPIRED',
  INVALID: 'DEVICE_PROOF_INVALID',
  REPLAYED: 'DEVICE_PROOF_REPLAYED',
  NOT_ENROLLED: 'DEVICE_NOT_ENROLLED',
  REVOKED: 'DEVICE_REVOKED',
  USER_MISMATCH: 'DEVICE_USER_MISMATCH',
  NOT_BOUND: 'DEVICE_NOT_BOUND',
} as const;
