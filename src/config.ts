import type { ProviderName, ResolvedSpaceConfig, SpaceConfig } from './types.js';

const ENV_KEYS = {
  provider: 'UNICLOUD_PROVIDER',
  spaceId: 'UNICLOUD_SPACE_ID',
  spaceAppId: 'UNICLOUD_SPACE_APP_ID',
  accessKey: 'UNICLOUD_ACCESS_KEY',
  secretKey: 'UNICLOUD_SECRET_KEY',
  clientSecret: 'UNICLOUD_CLIENT_SECRET',
  endpoint: 'UNICLOUD_ENDPOINT',
} as const;

function readProcessEnv(): Record<string, string | undefined> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

/** 从环境变量构造配置（Node / Electron 主进程 / 构建期注入均可用） */
export function spaceFromEnv(env: Readonly<Record<string, string | undefined>> = readProcessEnv()): SpaceConfig {
  return {
    provider: (env[ENV_KEYS.provider] as ProviderName | undefined) ?? undefined,
    spaceId: env[ENV_KEYS.spaceId] ?? '',
    spaceAppId: env[ENV_KEYS.spaceAppId],
    accessKey: env[ENV_KEYS.accessKey],
    secretKey: env[ENV_KEYS.secretKey],
    clientSecret: env[ENV_KEYS.clientSecret],
    endpoint: env[ENV_KEYS.endpoint],
  };
}

export function defaultEndpoint(provider: ProviderName, spaceId: string): string {
  if (provider === 'alipay') return `https://${spaceId}.api-hz.cloudbasefunction.cn`;
  return spaceId.startsWith('mp-') ? 'https://api.next.bspapp.com' : 'https://api.bspapp.com';
}

/** 合并显式配置与环境变量，并校验必填项 */
export function resolveSpace(
  space: SpaceConfig,
  env?: Record<string, string | undefined>,
  options: { skipSecretCheck?: boolean } = {},
): ResolvedSpaceConfig {
  const fallback = env === undefined ? spaceFromEnv() : spaceFromEnv(env);
  const provider: ProviderName = space.provider ?? fallback.provider ?? 'alipay';
  const spaceId = space.spaceId || fallback.spaceId;
  if (!spaceId) throw new Error('spaceId is required (or set UNICLOUD_SPACE_ID)');

  const resolved: ResolvedSpaceConfig = {
    provider,
    spaceId,
    endpoint: space.endpoint || fallback.endpoint || defaultEndpoint(provider, spaceId),
    ...(space.spaceAppId ?? fallback.spaceAppId ? { spaceAppId: space.spaceAppId ?? fallback.spaceAppId } : {}),
    ...(space.accessKey ?? fallback.accessKey ? { accessKey: space.accessKey ?? fallback.accessKey } : {}),
    ...(space.secretKey ?? fallback.secretKey ? { secretKey: space.secretKey ?? fallback.secretKey } : {}),
    ...(space.clientSecret ?? fallback.clientSecret ? { clientSecret: space.clientSecret ?? fallback.clientSecret } : {}),
    ...(space.accessToken ? { accessToken: space.accessToken } : {}),
  };

  // 宿主进程签名 / 自定义签名器模式下，密钥不需要出现在 JS 运行环境
  if (!options.skipSecretCheck) {
    if (provider === 'alipay') {
      const missing = (['spaceAppId', 'accessKey', 'secretKey'] as const).filter((k) => !resolved[k]);
      if (missing.length) throw new Error(`alipay space requires: ${missing.join(', ')}`);
    } else if (!resolved.clientSecret) {
      throw new Error('aliyun space requires: clientSecret');
    }
  }
  return resolved;
}
