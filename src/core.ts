import { APIConnectionError, APITimeoutError, BankOpenAPIError, errorForStatus } from './errors.ts';

export const VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://app.bankopenapi.com/api/v1';

export interface ClientOptions {
  /** API key `boa_live_…` (tiền thật) hoặc `boa_test_…` (Sandbox). Mặc định đọc biến môi trường `BANKOPENAPI_API_KEY` */
  apiKey?: string;
  /** Signing secret của webhook endpoint (`whsec_…`), dùng cho `webhooks.verify`. Mặc định đọc `BANKOPENAPI_WEBHOOK_SECRET` */
  webhookSecret?: string;
  /** Mặc định `https://app.bankopenapi.com/api/v1` (hoặc biến môi trường `BANKOPENAPI_BASE_URL`) */
  baseURL?: string;
  /** Thời gian chờ mỗi lần gọi, mili giây. Mặc định 30 000 */
  timeout?: number;
  /** Số lần tự thử lại khi lỗi mạng, 429 hoặc 5xx. Mặc định 2 */
  maxRetries?: number;
  /** Hàm fetch riêng (vd. để test). Mặc định `globalThis.fetch` */
  fetch?: typeof fetch;
  /**
   * API key là bí mật, chỉ dùng ở backend. Thư viện báo lỗi khi chạy trên trình duyệt; đặt `true` nếu bạn hiểu rủi ro
   * (vd. công cụ nội bộ chạy trên máy của chính bạn).
   */
  dangerouslyAllowBrowser?: boolean;
}

export interface RequestOptions {
  /**
   * Khóa chống trùng cho lệnh tạo (POST). Gửi lại cùng khóa trong 24 giờ thì nhận lại đúng kết quả lần đầu, không tạo
   * thêm. Không truyền thì thư viện tự sinh một khóa cho mỗi lần gọi (dùng lại khi tự thử lại). Nên truyền khóa gắn với
   * đơn hàng của bạn, vd. `order-${orderId}`, để bấm hai lần cũng chỉ tạo một yêu cầu thanh toán.
   */
  idempotencyKey?: string;
  /** Hủy request */
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
}

type QueryValue = string | number | boolean | Date | null | undefined;
export type Query = Record<string, QueryValue>;

interface InternalRequest extends RequestOptions {
  query?: Query;
  body?: unknown;
}

function readEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> }; Deno?: { env?: { get(k: string): string | undefined } } };
  try {
    return g.process?.env?.[name]?.trim() || g.Deno?.env?.get(name)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined' && typeof navigator !== 'undefined';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chờ trước lần thử lại thứ `attempt` (0, 1, …): theo Retry-After nếu có, không thì 0,5 s · 2^n kèm nhiễu, tối đa 8 s */
function retryDelay(attempt: number, headers?: Headers) {
  const retryAfter = Number(headers?.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 60) return retryAfter * 1000;
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base * (0.75 + Math.random() * 0.5);
}

const shouldRetry = (status: number) => status === 408 || status === 429 || status >= 500;

function serializeQuery(query: Query | undefined) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    params.set(key, value instanceof Date ? value.toISOString() : String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export class APIClient {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly webhookSecret: string | undefined;
  readonly timeout: number;
  readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? readEnv('BANKOPENAPI_API_KEY');
    if (!apiKey)
      throw new BankOpenAPIError(
        'Thiếu API key. Truyền { apiKey } hoặc đặt biến môi trường BANKOPENAPI_API_KEY (tạo khóa ở https://app.bankopenapi.com/api-key). / Missing API key.',
        { code: 'MISSING_API_KEY' },
      );
    if (!/^boa_(live|test)_[0-9A-Za-z]+$/.test(apiKey))
      throw new BankOpenAPIError('API key phải có dạng boa_live_… hoặc boa_test_…. / API key must start with boa_live_ or boa_test_.', { code: 'INVALID_API_KEY' });
    if (isBrowser() && !options.dangerouslyAllowBrowser)
      throw new BankOpenAPIError(
        'Không dùng API key BankOpenAPI trên trình duyệt: ai mở trang cũng đọc được khóa. Gọi API từ backend (route handler, server action, API route). / Do not use your API key in the browser.',
        { code: 'BROWSER_NOT_ALLOWED' },
      );
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new BankOpenAPIError('Môi trường này không có fetch: cần Node.js 20 trở lên. / fetch is not available: use Node.js 20+.', { code: 'NO_FETCH' });

    this.apiKey = apiKey;
    this.baseURL = (options.baseURL ?? readEnv('BANKOPENAPI_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.webhookSecret = options.webhookSecret ?? readEnv('BANKOPENAPI_WEBHOOK_SECRET');
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  /** true với khóa `boa_live_` (tiền thật), false với khóa Sandbox `boa_test_` */
  get livemode() {
    return this.apiKey.startsWith('boa_live_');
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, options: InternalRequest = {}): Promise<T> {
    const url = this.baseURL + path + serializeQuery(options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (!isBrowser()) headers['User-Agent'] = `bankopenapi-js/${VERSION}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    // Một khóa cho mọi lần thử lại của cùng một lệnh tạo: thử lại không bao giờ tạo bản ghi thứ hai
    if (method === 'POST') headers['Idempotency-Key'] = options.idempotencyKey ?? `bankopenapi-js-${crypto.randomUUID()}`;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const timeout = options.timeout ?? this.timeout;

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });

      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        const err = timedOut
          ? new APITimeoutError(`Quá ${timeout / 1000} giây không có phản hồi từ BankOpenAPI. / Request timed out.`, { code: 'TIMEOUT', cause })
          : new APIConnectionError('Không kết nối được tới BankOpenAPI. Kiểm tra mạng rồi thử lại. / Connection error.', { code: 'CONNECTION_ERROR', cause });
        if (attempt < maxRetries) {
          await sleep(retryDelay(attempt));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }

      const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const message = json?.error?.message ?? `BankOpenAPI trả HTTP ${res.status}.`;
      const err = errorForStatus(res.status, message, {
        code: json?.error?.code ?? `HTTP_${res.status}`,
        requestId: res.headers.get('request-id') ?? undefined,
        headers: res.headers,
      });
      if (shouldRetry(res.status) && attempt < maxRetries) {
        await sleep(retryDelay(attempt, res.headers));
        continue;
      }
      throw err;
    }
  }
}
