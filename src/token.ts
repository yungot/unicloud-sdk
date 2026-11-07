import type { TokenInfo, TokenStore } from './types.js';

/** 内存登录态存储：进程退出即丢失 */
export function createMemoryTokenStore(initial?: TokenInfo): TokenStore {
  let current: TokenInfo | null = initial ?? null;
  return {
    get: () => (current ? { ...current } : null),
    set: (info) => {
      current = { ...info };
    },
    clear: () => {
      current = null;
    },
  };
}

/**
 * 浏览器 / WebView 的 localStorage 存储，键名与官方 uni-app 一致（uni_id_token / uni_id_token_expired），
 * 便于 Web 端与 uni-app H5 共享登录态。注意：localStorage 可被页面脚本读取，只适合 Web 端。
 */
export function createLocalStorageTokenStore(): TokenStore {
  const ls = (): Storage | undefined => (globalThis as { localStorage?: Storage }).localStorage;
  return {
    get: () => {
      const token = ls()?.getItem('uni_id_token');
      if (!token) return null;
      const expired = Number(ls()?.getItem('uni_id_token_expired'));
      return Number.isFinite(expired) && expired > 0 ? { token, tokenExpired: expired } : { token };
    },
    set: (info) => {
      ls()?.setItem('uni_id_token', info.token);
      if (info.tokenExpired) ls()?.setItem('uni_id_token_expired', String(info.tokenExpired));
      else ls()?.removeItem('uni_id_token_expired');
    },
    clear: () => {
      ls()?.removeItem('uni_id_token');
      ls()?.removeItem('uni_id_token_expired');
    },
  };
}
