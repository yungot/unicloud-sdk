/** 与 uniCloud 响应体规范对齐的错误对象（字段与官方 UniCloudError 一致） */
export class UniCloudError extends Error {
  readonly errCode: string | number;
  readonly errMsg: string;
  readonly requestId: string;
  readonly status?: number;
  /** 错误主题，如 uni-id、uni-secure-network */
  readonly errSubject?: string;
  /** 云对象返回的完整结果，便于读取业务附加字段 */
  readonly detail?: unknown;

  constructor(init: {
    errCode: string | number;
    errMsg: string;
    requestId?: string;
    status?: number;
    errSubject?: string;
    detail?: unknown;
  }) {
    super(init.errMsg);
    this.name = 'UniCloudError';
    this.errCode = init.errCode;
    this.errMsg = init.errMsg;
    this.requestId = init.requestId ?? '';
    this.status = init.status;
    if (init.errSubject !== undefined) this.errSubject = init.errSubject;
    if (init.detail !== undefined) this.detail = init.detail;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      errCode: this.errCode,
      errMsg: this.errMsg,
      errSubject: this.errSubject,
      requestId: this.requestId,
      status: this.status,
    };
  }
}

/** 网络层失败（超时、断网、非 2xx） */
export class TransportError extends UniCloudError {
  constructor(message: string, status?: number, requestId = '') {
    super({ errCode: 'TRANSPORT_ERROR', errMsg: message, status, requestId });
    this.name = 'TransportError';
  }
}

export function isUniCloudError(value: unknown): value is UniCloudError {
  return value instanceof UniCloudError;
}
