export { createClient, UniCloudDesktopClient } from './client.js';
export type { ExtendedClientOptions, HostDispatcher } from './client.js';

export { UniCloudError, TransportError, isUniCloudError } from './errors.js';
export { createHostHandler, createRemoteClient } from './bridge.js';
export { createMemoryTokenStore, createLocalStorageTokenStore } from './token.js';
export {
  createSoftwareDeviceKey,
  createMemoryKeyVault,
  jwkThumbprint,
  canonicalJson,
  buildProofText,
  buildEnrollText,
  DEVICE_ERRORS,
} from './device.js';
export type { DeviceKey, KeyVault, PublicJwk, DeviceProof, DeviceKeyAssurance } from './device.js';
export { createFetchUploader, uploadWithOptions, normalizeCloudPath, fileIdToPath, pathToFileId } from './storage.js';
export type { SignedUploadOptions } from './storage.js';
export type { BridgeCall, BridgeResponse, BridgeErrorPayload, HostPolicy, RemoteClient, SessionStatus } from './bridge.js';
export { LocalSigner, resolveCrypto, createWebCryptoBackend, lazyCrypto } from './crypto.js';
export { resolveSpace, spaceFromEnv, defaultEndpoint } from './config.js';
export {
  buildClientInfo,
  detectOsName,
  resolveDeviceId,
  uuid,
  createMemoryDeviceIdStore,
  createLocalStorageDeviceIdStore,
} from './identity.js';
export { FetchTransport, createFetchTransport, createMockTransport, normalizeHeaders } from './transport.js';
export { AlipayAdapter, signAlipayRequest } from './providers/alipay.js';
export { AliyunAdapter } from './providers/aliyun.js';

export type {
  ProviderName,
  SpaceConfig,
  ResolvedSpaceConfig,
  ClientInfo,
  DeviceIdStore,
  CryptoBackend,
  SignatureMaterial,
  Signer,
  OutboundRequest,
  RawResponse,
  Transport,
  InvocationResult,
  RequestContext,
  ProviderAdapter,
  Hooks,
  DesktopClientOptions,
  CallFunctionOptions,
  ImportObjectOptions,
  CloudObjectMethods,
  TokenInfo,
  TokenStore,
  DeviceAuthOptions,
  FileBody,
  FileUploader,
  UploadFileOptions,
  UploadFileResult,
  GetTempFileURLOptions,
  TempFileURLResult,
} from './types.js';
