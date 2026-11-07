/**
 * Electron 主进程：用系统加密（Windows DPAPI / macOS Keychain / Linux libsecret）保存设备私钥。
 *
 *   import { createClient, createSoftwareDeviceKey } from '@yungot/unicloud-sdk'
 *   import { createSafeStorageVault } from './electron-device-vault.mjs'
 *
 *   const key = createSoftwareDeviceKey({ vault: createSafeStorageVault(), assurance: 'os-protected' })
 *   const cloud = createClient({ ..., device: { key, deviceName: os.hostname() } })
 *
 * 私钥文件只能由当前 Windows 用户解密；拷到别的电脑或别的账户下无法使用。
 */
import { app, safeStorage } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function createSafeStorageVault(fileName = 'device-key.bin') {
  const file = () => path.join(app.getPath('userData'), 'security', fileName);
  const ensure = () => {
    if (!safeStorage.isEncryptionAvailable()) {
      // 不降级为明文保存：宁可不启用设备身份，也不把私钥写成明文
      throw new Error('system encryption unavailable; refusing to store device key in plaintext');
    }
  };
  return {
    async load() {
      ensure();
      try {
        const encrypted = await readFile(file());
        return new Uint8Array(Buffer.from(safeStorage.decryptString(encrypted), 'base64'));
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async save(data) {
      ensure();
      await mkdir(path.dirname(file()), { recursive: true });
      await writeFile(file(), safeStorage.encryptString(Buffer.from(data).toString('base64')), { mode: 0o600 });
    },
    async clear() {
      await rm(file(), { force: true });
    },
  };
}
