import type { ClientInfo, DesktopClientOptions, DeviceIdStore } from './types.js';

/** 生成 RFC 4122 v4 形式的 ID */
export function uuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 内存设备 ID 存储：进程退出即丢失，仅用于临时脚本 */
export function createMemoryDeviceIdStore(): DeviceIdStore {
  let id: string | null = null;
  return {
    get: () => id,
    set: (value: string) => {
      id = value;
    },
  };
}

/** 浏览器 / WebView 的 localStorage 存储 */
export function createLocalStorageDeviceIdStore(key = 'unicloud.deviceId'): DeviceIdStore {
  return {
    get: () => globalThis.localStorage?.getItem(key) ?? null,
    set: (value: string) => globalThis.localStorage?.setItem(key, value),
  };
}

/** 解析设备 ID：显式传入 > 环境变量 > Store > 新建并持久化 */
export async function resolveDeviceId(options: DesktopClientOptions): Promise<string> {
  if (options.deviceId) return options.deviceId;
  const envId = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.UNICLOUD_DEVICE_ID;
  if (envId) return envId;
  const store = options.deviceIdStore ?? createMemoryDeviceIdStore();
  const existing = await store.get();
  if (existing) return existing;
  const generated = `desktop-${uuid()}`;
  await store.set(generated);
  return generated;
}

/**
 * 构造 clientInfo。字段与官方 uniCloud 客户端 SDK 的 `ge()` 保持一致，
 * 大写字段供云函数 context 读取，小写字段供云对象 getClientInfo() 读取。
 */
export function buildClientInfo(options: DesktopClientOptions, deviceId: string): ClientInfo {
  const appId = options.appId;
  const osName = options.osName ?? detectOsName();
  const uniPlatform = options.uniPlatform ?? 'web';
  const locale = options.locale ?? 'zh-Hans';
  return {
    PLATFORM: uniPlatform,
    OS: osName,
    APPID: appId,
    DEVICEID: deviceId,
    deviceId,
    osName,
    uniPlatform,
    appId,
    appVersion: options.appVersion ?? '1.0.0',
    appVersionCode: options.appVersionCode ?? '100',
    appLanguage: locale,
    ua: options.userAgent ?? `unicloud-sdk/1.0 (${osName})`,
    locale,
    LOCALE: locale,
    ...(options.extraClientInfo ?? {}),
  };
}

export function detectOsName(): string {
  const nav = globalThis.navigator as { userAgent?: string; userAgentData?: { platform?: string } } | undefined;
  const ua = nav?.userAgent ?? '';
  // 移动端必须先于桌面判断：iOS 的 UA 含 "like Mac OS X"，Android 的 UA 含 "Linux"
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua) || nav?.userAgentData?.platform === 'Windows') return 'windows';
  if (/Mac/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  const proc = (globalThis as { process?: { platform?: string } }).process;
  if (proc?.platform === 'win32') return 'windows';
  if (proc?.platform === 'darwin') return 'macos';
  if (proc?.platform) return proc.platform;
  return 'windows';
}
