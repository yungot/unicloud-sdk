/**
 * 云存储（支付宝云客户端协议）。
 *
 * 流程与官方 `@dcloudio/uni-cloud` 一致（已用官方运行时离线抓包做黄金对照）：
 *   上传：GET  /{cloudPath}?post_url   → { file_id, upload_url, form_data[] }
 *         POST upload_url（multipart：form_data 原样 + file 字段）
 *   链接：POST /?download_url  { file_list: [{ file_id, expire: 600 }] } → { file_list[].download_url }
 *
 * 支付宝云客户端协议不提供删除文件，删除需在云对象里调用 uniCloud.deleteFile。
 */
import { TransportError, UniCloudError } from './errors.js';
import { isRecord } from './providers/alipay.js';
import type { FileBody, FileUploader, RawResponse } from './types.js';

export const MAX_TEMP_URL_BATCH = 50;

/** 校验并规范化 cloudPath（去首尾空白和开头的 /） */
export function normalizeCloudPath(cloudPath: unknown): string {
  if (typeof cloudPath !== 'string') {
    throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'cloudPath必须为字符串类型' });
  }
  const trimmed = cloudPath.trim().replace(/^\/+/, '');
  if (!trimmed) throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'cloudPath不可为空' });
  if (/:\/\//.test(trimmed)) throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'cloudPath不合法' });
  // 支付宝云允许：字母、数字、/ ! - _ . * 与中文
  if (!/^[A-Za-z0-9/!\-_.*\u4e00-\u9fa5]+$/.test(trimmed)) {
    throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'cloudPath只能包含字母、数字、中文和 / ! - _ . *' });
  }
  if (trimmed.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'cloudPath不能包含空段、. 或 .. 段' });
  }
  return trimmed;
}

/** cloud://spaceId/path → path；非 cloud:// 形式原样返回 */
export function fileIdToPath(fileID: string, spaceId: string): string {
  const value = fileID.trim();
  if (!value.startsWith('cloud://')) return value;
  const rest = value.slice('cloud://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'fileID不合法' });
  const owner = rest.slice(0, slash);
  if (owner !== spaceId) {
    throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: `fileID不属于当前服务空间：${spaceId}` });
  }
  return rest.slice(slash + 1);
}

export function pathToFileId(path: string, spaceId: string): string {
  return `cloud://${spaceId}/${path.replace(/^\/+/, '')}`;
}

/** 解析存储网关响应：{ success, data } */
export function parseStorageResponse(raw: RawResponse, requestId: string): Record<string, unknown> {
  if (raw.status < 200 || raw.status >= 300) {
    throw new TransportError(`storage gateway returned HTTP ${raw.status}`, raw.status, requestId);
  }
  const data = isRecord(raw.data) ? raw.data : {};
  if (data.success !== true) {
    throw new UniCloudError({
      errCode: (data.errCode as string | number | undefined) ?? 'STORAGE_ERROR',
      errMsg: typeof data.errMsg === 'string' ? data.errMsg : '云存储请求失败',
      requestId,
      detail: raw.data,
    });
  }
  return isRecord(data.data) ? data.data : {};
}

function toBlob(file: FileBody, contentType?: string): Blob {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file;
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file as ArrayBuffer);
  return new Blob([bytes as BlobPart], contentType ? { type: contentType } : {});
}

export function fileSize(file: FileBody): number {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file.size;
  return (file as ArrayBuffer | Uint8Array).byteLength;
}

/** 默认表单直传实现：fetch + FormData（Node 20+ / Electron / 浏览器均可用）。fetch 无上传进度，只在结束时回调一次。 */
export function createFetchUploader(options: { fetchImpl?: typeof fetch; timeout?: number } = {}): FileUploader {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeout = options.timeout ?? 120_000;
  return {
    async upload(input) {
      const form = new FormData();
      for (const [key, value] of Object.entries(input.formData)) form.append(key, value);
      // 对象存储要求文件字段放在最后
      form.append(input.fieldName, toBlob(input.file, input.contentType), input.fileName);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetchImpl(input.url, { method: 'POST', body: form, signal: controller.signal });
        await response.arrayBuffer().catch(() => undefined);
        const total = fileSize(input.file);
        if (response.status < 400) input.onUploadProgress?.({ loaded: total, total });
        return { status: response.status };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 云对象下发的上传参数（扩展存储 getUploadFileOptions 返回的 uploadFileOptions 形状） */
export interface SignedUploadOptions {
  url: string;
  /** 文件字段名 */
  name: string;
  formData?: Record<string, string | number>;
}

/**
 * 用云端下发的上传参数直传文件（扩展存储 / 自定义存储）。
 *
 * 推荐的安全做法：由云对象在校验用户和设备后决定 cloudPath 并生成短期上传凭证，
 * 客户端只负责把文件发过去，不持有任何存储密钥，也无法选择上传路径。
 */
export async function uploadWithOptions(
  input: {
    uploadFileOptions: SignedUploadOptions;
    file: FileBody;
    fileName?: string;
    contentType?: string;
    onUploadProgress?: (progress: { loaded: number; total: number }) => void;
  },
  uploader: FileUploader = createFetchUploader(),
): Promise<{ status: number }> {
  const options = input.uploadFileOptions;
  if (!isRecord(options) || typeof options.url !== 'string' || !/^https:\/\//.test(options.url)) {
    throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'uploadFileOptions.url 必须是 https 地址' });
  }
  if (typeof options.name !== 'string' || !options.name) {
    throw new UniCloudError({ errCode: 'INVALID_PARAM', errMsg: 'uploadFileOptions.name 不能为空' });
  }
  const formData: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.formData ?? {})) formData[key] = String(value);
  const result = await uploader.upload({
    url: options.url,
    formData,
    fieldName: options.name,
    file: input.file,
    fileName: input.fileName ?? 'file',
    ...(input.contentType ? { contentType: input.contentType } : {}),
    ...(input.onUploadProgress ? { onUploadProgress: input.onUploadProgress } : {}),
  });
  if (result.status >= 400) {
    throw new UniCloudError({ errCode: 'UPLOAD_FAILED', errMsg: `文件上传失败（HTTP ${result.status}）`, status: result.status });
  }
  return result;
}
