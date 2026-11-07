/**
 * Lỗi của thư viện. Mọi lỗi từ API đều là `BankOpenAPIError` (hoặc lớp con theo mã HTTP), có `code` giống trường
 * `error.code` trong phản hồi (vd. `INVALID_API_KEY`, `NOT_FOUND`), `message` là câu tiếng Việt từ BankOpenAPI.
 *
 * Errors thrown by the library. API errors are `BankOpenAPIError` (or a subclass by HTTP status) with `code` matching
 * the response's `error.code`.
 */

export interface ErrorDetails {
  status?: number;
  code?: string;
  requestId?: string;
  headers?: Headers;
  cause?: unknown;
}

export class BankOpenAPIError extends Error {
  /** Mã HTTP, không có với lỗi kết nối */
  readonly status: number | undefined;
  /** Mã lỗi, vd. `INVALID_API_KEY`, `VALIDATION_ERROR`, `RATE_LIMITED`; lỗi kết nối là `CONNECTION_ERROR` */
  readonly code: string;
  /** Header `Request-ID` của request lỗi: gửi kèm khi cần hỗ trợ */
  readonly requestId: string | undefined;
  readonly headers: Headers | undefined;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = new.target.name;
    this.status = details.status;
    this.code = details.code ?? 'UNKNOWN_ERROR';
    this.requestId = details.requestId;
    this.headers = details.headers;
  }
}

/** 400, 422: tham số sai */
export class InvalidRequestError extends BankOpenAPIError {}
/** 401: thiếu hoặc sai API key, khóa hết hạn */
export class AuthenticationError extends BankOpenAPIError {}
/** 403: khóa chỉ đọc gọi lệnh ghi, IP ngoài danh sách cho phép */
export class PermissionDeniedError extends BankOpenAPIError {}
/** 404 */
export class NotFoundError extends BankOpenAPIError {}
/** 409: trạng thái không cho phép (vd. hủy yêu cầu đã thanh toán), Idempotency-Key dùng lại với body khác */
export class ConflictError extends BankOpenAPIError {}
/** 429: gọi quá nhanh; thư viện đã tự thử lại theo `Retry-After` trước khi ném lỗi này */
export class RateLimitError extends BankOpenAPIError {}
/** 5xx */
export class InternalServerError extends BankOpenAPIError {}
/** Không kết nối được tới BankOpenAPI (mạng, DNS…) */
export class APIConnectionError extends BankOpenAPIError {}
/** Quá thời gian chờ phản hồi (`timeout`) */
export class APITimeoutError extends APIConnectionError {}

/** Webhook sai chữ ký, thiếu header hoặc timestamp quá cũ */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export function errorForStatus(status: number, message: string, details: ErrorDetails): BankOpenAPIError {
  const d = { ...details, status };
  if (status === 400 || status === 422) return new InvalidRequestError(message, d);
  if (status === 401) return new AuthenticationError(message, d);
  if (status === 403) return new PermissionDeniedError(message, d);
  if (status === 404) return new NotFoundError(message, d);
  if (status === 409) return new ConflictError(message, d);
  if (status === 429) return new RateLimitError(message, d);
  if (status >= 500) return new InternalServerError(message, d);
  return new BankOpenAPIError(message, d);
}
