/**
 * Electron 主进程：用系统加密（Windows DPAPI / macOS Keychain）保存 uni-id 登录态，重启后免登录。
 *
 *   import { createClient } from '@yungot/unicloud-sdk'
 *   import { createSafeStorageTokenStore } from './electron-token-store.mjs'
 *
 *   const cloud = createClient({ ..., tokenStore: createSafeStorageTokenStore() })
 *
 * 登录：渲染进程经宿主桥调用 uni-id-co.login，SDK 自动保存结果中的 token，
 *       宿主桥返回给页面前删除 token 字段（HostPolicy.exposeTokens 默认 false）。
 * 未在真实 Electron 中测试。
 */
import { app, safeStorage } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function createSafeStorageTokenStore(fileName = 'session.bin') {
  const file = () => path.join(app.getPath('userData'), 'security', fileName);
  let cache; // undefined = 未读取；null = 未登录
  return {
    async get() {
      if (cache !== undefined) return cache;
      if (!safeStorage.isEncryptionAvailable()) return (cache = null);
      try {
        cache = JSON.parse(safeStorage.decryptString(await readFile(file())));
      } catch {
        cache = null; // 文件不存在或已损坏：视为未登录
      }
      return cache;
    },
    async set(info) {
      cache = { ...info };
      if (!safeStorage.isEncryptionAvailable()) return; // 不加密就不落盘，只在内存中保持登录
      await mkdir(path.dirname(file()), { recursive: true });
      await writeFile(file(), safeStorage.encryptString(JSON.stringify(cache)), { mode: 0o600 });
    },
    async clear() {
      cache = null;
      await rm(file(), { force: true });
    },
  };
}
