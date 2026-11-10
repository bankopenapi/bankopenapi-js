import type { APIClient, RequestOptions } from './core.ts';
import { BankOpenAPIError } from './errors.ts';
import { pagePromise, type PagePromise } from './pagination.ts';
import type { Account, BankAccount, Event, List, PaymentRequest, Transaction, WebhookDelivery, WebhookEndpoint, WebhookEventType } from './types.ts';

const enc = encodeURIComponent;

/** Lớp gốc của các nhóm API: giữ client dùng chung */
class Resource {
  protected readonly client: APIClient;
  constructor(client: APIClient) {
    this.client = client;
  }
}

interface PageParams {
  /** 1–100 */
  limit?: number;
  /** ID của phần tử cuối trang trước */
  startingAfter?: string;
}

// ---------- Tài khoản ----------

export class AccountResource extends Resource {
  /** Tài khoản sở hữu API key: dùng để thử khóa có hoạt động không */
  retrieve(options?: RequestOptions): Promise<Account> {
    return this.client.request('GET', '/account', options);
  }
}

// ---------- Yêu cầu thanh toán ----------

export interface PaymentRequestCreateParams {
  /** Số tiền VND, số nguyên 1.000–500.000.000 */
  amount: number;
  /** Mã đơn hàng bên hệ thống của bạn (chữ, số, `_ . : / # -`, tối đa 64 ký tự) */
  orderId?: string;
  /** Mô tả hiện cho người trả, tối đa 200 ký tự */
  description?: string;
  /** Hạn thanh toán, phút (5–10080). Mặc định 1440 (24 giờ) */
  expiresInMinutes?: number;
  /** Tài khoản nhận tiền `ba_…`. Mặc định: tài khoản liên kết gần nhất */
  bankAccountId?: string;
  /**
   * Link quay lại website của bạn (vd. trang đơn hàng): trang `hostedUrl` có nút "Quay lại" và tự chuyển về sau khi trả
   * xong. Phải là `https://` (sandbox cho thêm `http://`), tối đa 2048 ký tự
   */
  returnUrl?: string;
}

export interface PaymentRequestListParams extends PageParams {
  /** open: chờ thanh toán; paid: đã thanh toán; attention: thiếu hoặc thừa tiền; closed: hết hạn hoặc đã hủy */
  status?: 'open' | 'paid' | 'attention' | 'closed';
  /** Lọc đúng mã đơn hàng */
  orderId?: string;
}

export class PaymentRequests extends Resource {
  /**
   * Tạo yêu cầu thanh toán cho một đơn: trả về `qr.payload` (vẽ mã QR), `transfer` (thông tin chuyển khoản) và `hostedUrl`
   * (trang thanh toán để gửi cho người trả). Tiền về đúng mã thì trạng thái tự thành `paid` và có webhook
   * `payment_request.paid`.
   *
   * Nên truyền `idempotencyKey` gắn với đơn hàng (vd. `order-${orderId}`): bấm hai lần cũng chỉ tạo một yêu cầu.
   */
  create(params: PaymentRequestCreateParams, options?: RequestOptions): Promise<PaymentRequest> {
    return this.client.request('POST', '/payment-requests', { ...options, body: params });
  }

  /** Xem một yêu cầu, kèm danh sách giao dịch đã khớp (`transactions`) */
  retrieve(id: string, options?: RequestOptions): Promise<PaymentRequest> {
    return this.client.request('GET', `/payment-requests/${enc(id)}`, options);
  }

  /** Danh sách, mới nhất trước */
  list(params: PaymentRequestListParams = {}, options?: RequestOptions): PagePromise<PaymentRequest> {
    return pagePromise((startingAfter) =>
      this.client.request<List<PaymentRequest>>('GET', '/payment-requests', {
        ...options,
        query: { limit: params.limit, status: params.status, order_id: params.orderId, starting_after: startingAfter },
      }),
    params.startingAfter);
  }

  /** Hủy yêu cầu chưa nhận tiền (đang chờ hoặc đã hết hạn). Tiền chuyển tới sau khi hủy không khớp yêu cầu này nữa */
  cancel(id: string, options?: RequestOptions): Promise<PaymentRequest> {
    return this.client.request('POST', `/payment-requests/${enc(id)}/cancel`, options);
  }
}

// ---------- Giao dịch ----------

export interface TransactionListParams extends PageParams {
  /** Lọc theo tài khoản ngân hàng `ba_…` */
  bankAccountId?: string;
  /** credit: tiền vào, debit: tiền ra */
  type?: 'credit' | 'debit';
  /** Từ thời điểm (Date hoặc chuỗi ISO 8601), tính theo `transactedAt` */
  from?: Date | string;
  /** Đến thời điểm (Date hoặc chuỗi ISO 8601) */
  to?: Date | string;
}

export class Transactions extends Resource {
  /** Giao dịch trên các tài khoản đã liên kết, mới nhất trước */
  list(params: TransactionListParams = {}, options?: RequestOptions): PagePromise<Transaction> {
    return pagePromise((startingAfter) =>
      this.client.request<List<Transaction>>('GET', '/transactions', {
        ...options,
        query: { limit: params.limit, bank_account: params.bankAccountId, type: params.type, from: params.from, to: params.to, starting_after: startingAfter },
      }),
    params.startingAfter);
  }

  retrieve(id: string, options?: RequestOptions): Promise<Transaction> {
    return this.client.request('GET', `/transactions/${enc(id)}`, options);
  }
}

// ---------- Tài khoản ngân hàng ----------

export class BankAccounts extends Resource {
  /** Tài khoản đang liên kết (không phân trang). Liên kết tài khoản mới làm trong app vì cần OTP của ngân hàng */
  list(options?: RequestOptions): Promise<List<BankAccount>> {
    return this.client.request('GET', '/bank-accounts', options);
  }

  /** Xem một tài khoản ở mọi trạng thái (cả đã hủy liên kết) */
  retrieve(id: string, options?: RequestOptions): Promise<BankAccount> {
    return this.client.request('GET', `/bank-accounts/${enc(id)}`, options);
  }
}

// ---------- Webhook endpoint ----------

export interface WebhookHeader {
  name: string;
  value: string;
}

export interface WebhookEndpointCreateParams {
  /** URL https công khai nhận webhook */
  url: string;
  /** Loại sự kiện cần nhận, hoặc `['*']` để nhận mọi loại */
  events: (WebhookEventType | '*')[];
  description?: string | null;
  /** Chỉ nhận sự kiện của các tài khoản ngân hàng này. null: mọi tài khoản */
  bankAccountIds?: string[] | null;
  /** Tối đa 5 header gửi kèm mỗi webhook (vd. khóa riêng của hệ thống bạn) */
  headers?: WebhookHeader[] | null;
  /**
   * Vé kiểm tra URL (`testUrl().token`). Bỏ trống thì thư viện tự gọi `testUrl` trước: URL phải trả 2xx, 401 hoặc 403
   * mới tạo được endpoint.
   */
  urlTestToken?: string;
}

export interface WebhookEndpointUpdateParams extends Partial<Omit<WebhookEndpointCreateParams, 'urlTestToken'>> {
  /** Tắt hoặc bật lại endpoint */
  status?: 'enabled' | 'disabled';
  urlTestToken?: string;
}

export interface UrlTestResult {
  object: 'url_test';
  url: string;
  /** true khi URL trả 2xx, 401 hoặc 403 */
  reachable: boolean;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
  message: string | null;
  /** Vé dùng cho `create`/`update` (30 phút), null khi không thông */
  token: string | null;
}

export class WebhookEndpoints extends Resource {
  list(options?: RequestOptions): Promise<List<WebhookEndpoint>> {
    return this.client.request('GET', '/webhook-endpoints', options);
  }

  /** Gửi thử một request tới URL để chắc chắn URL nhận được webhook */
  testUrl(params: { url: string; headers?: WebhookHeader[]; endpointId?: string }, options?: RequestOptions): Promise<UrlTestResult> {
    return this.client.request('POST', '/webhook-endpoints/test-url', { ...options, body: params });
  }

  private async tokenFor(url: string, headers: WebhookHeader[] | null | undefined, endpointId?: string) {
    const test = await this.testUrl({ url, headers: headers ?? undefined, endpointId });
    if (!test.reachable || !test.token)
      throw new BankOpenAPIError(
        `URL ${url} chưa nhận được request thử${test.responseStatus ? ` (HTTP ${test.responseStatus})` : ''}${test.message ? `: ${test.message}` : ''}. Endpoint phải trả 2xx, 401 hoặc 403. / Webhook URL is not reachable.`,
        { code: 'URL_NOT_REACHABLE' },
      );
    return test.token;
  }

  /**
   * Tạo endpoint. Thư viện tự kiểm tra URL trước (trừ khi truyền `urlTestToken`). Lấy signing secret bằng
   * `retrieveSecret(endpoint.id)`.
   */
  async create(params: WebhookEndpointCreateParams, options?: RequestOptions): Promise<WebhookEndpoint> {
    const urlTestToken = params.urlTestToken ?? (await this.tokenFor(params.url, params.headers));
    return this.client.request('POST', '/webhook-endpoints', { ...options, body: { ...params, urlTestToken } });
  }

  retrieve(id: string, options?: RequestOptions): Promise<WebhookEndpoint> {
    return this.client.request('GET', `/webhook-endpoints/${enc(id)}`, options);
  }

  /** Sửa endpoint. Đổi `url` thì thư viện tự kiểm tra URL mới (trừ khi truyền `urlTestToken`) */
  async update(id: string, params: WebhookEndpointUpdateParams, options?: RequestOptions): Promise<WebhookEndpoint> {
    let body = params;
    if (params.url !== undefined && params.urlTestToken === undefined) {
      const current = await this.retrieve(id, options);
      if (current.url !== params.url) body = { ...params, urlTestToken: await this.tokenFor(params.url, params.headers, id) };
    }
    return this.client.request('PATCH', `/webhook-endpoints/${enc(id)}`, { ...options, body });
  }

  delete(id: string, options?: RequestOptions): Promise<{ id: string; object: 'webhook_endpoint'; deleted: true }> {
    return this.client.request('DELETE', `/webhook-endpoints/${enc(id)}`, options);
  }

  /** Signing secret (`whsec_…`) để verify webhook. Cần API key toàn quyền */
  retrieveSecret(id: string, options?: RequestOptions): Promise<{ object: 'webhook_endpoint_secret'; secret: string }> {
    return this.client.request('GET', `/webhook-endpoints/${enc(id)}/secret`, options);
  }

  /**
   * Đổi signing secret. Secret cũ vẫn ký song song trong `expiresInHours` giờ (0, 1, 24 hoặc 168; mặc định 24) để bạn kịp
   * cập nhật hệ thống.
   */
  rotateSecret(
    id: string,
    params: { expiresInHours?: 0 | 1 | 24 | 168 } = {},
    options?: RequestOptions,
  ): Promise<{ object: 'webhook_endpoint_secret'; secret: string; previousSecretExpiresAt: string | null }> {
    return this.client.request('POST', `/webhook-endpoints/${enc(id)}/rotate-secret`, { ...options, body: params });
  }

  /** Gửi ngay một sự kiện `webhook.test` (một lần, không thử lại) và trả kết quả */
  sendTest(id: string, options?: RequestOptions): Promise<WebhookDelivery> {
    return this.client.request('POST', `/webhook-endpoints/${enc(id)}/test`, options);
  }

  /** Lịch sử gửi webhook tới endpoint, mới nhất trước */
  listDeliveries(id: string, params: PageParams = {}, options?: RequestOptions): PagePromise<WebhookDelivery> {
    return pagePromise((startingAfter) =>
      this.client.request<List<WebhookDelivery>>('GET', `/webhook-endpoints/${enc(id)}/deliveries`, {
        ...options,
        query: { limit: params.limit, starting_after: startingAfter },
      }),
    params.startingAfter);
  }

  retrieveDelivery(id: string, deliveryId: string, options?: RequestOptions): Promise<WebhookDelivery> {
    return this.client.request('GET', `/webhook-endpoints/${enc(id)}/deliveries/${enc(deliveryId)}`, options);
  }

  /** Gửi lại một lần gửi */
  retryDelivery(id: string, deliveryId: string, options?: RequestOptions): Promise<WebhookDelivery> {
    return this.client.request('POST', `/webhook-endpoints/${enc(id)}/deliveries/${enc(deliveryId)}/retry`, options);
  }

  /** Gửi lại mọi sự kiện lỗi hoặc bị lỡ từ `since` (tối đa 30 ngày trước), mỗi sự kiện một lần, tối đa 500 */
  retryFailed(
    id: string,
    params: { since: Date | string },
    options?: RequestOptions,
  ): Promise<{ object: 'webhook_bulk_retry'; queued: number; failed: number; missed: number; hasMore: boolean }> {
    const since = params.since instanceof Date ? params.since.toISOString() : params.since;
    return this.client.request('POST', `/webhook-endpoints/${enc(id)}/deliveries/retry-failed`, { ...options, body: { since } });
  }
}

// ---------- Sự kiện ----------

export interface EventListParams extends PageParams {
  type?: WebhookEventType | 'webhook.test';
}

export type EventWithDeliveryCounts = Event & { deliveries: { succeeded: number; pending: number; failed: number } };
export type EventWithDeliveries = Event & { deliveries: (WebhookDelivery & { endpointUrl: string })[] };

export class Events extends Resource {
  /** Sự kiện 30 ngày gần nhất (kể cả khi chưa có endpoint nhận), mới nhất trước */
  list(params: EventListParams = {}, options?: RequestOptions): PagePromise<EventWithDeliveryCounts> {
    return pagePromise((startingAfter) =>
      this.client.request<List<EventWithDeliveryCounts>>('GET', '/events', {
        ...options,
        query: { limit: params.limit, type: params.type, starting_after: startingAfter },
      }),
    params.startingAfter);
  }

  retrieve(id: string, options?: RequestOptions): Promise<EventWithDeliveries> {
    return this.client.request('GET', `/events/${enc(id)}`, options);
  }

  /** Gửi lại một sự kiện tới một endpoint */
  resend(id: string, params: { endpointId: string }, options?: RequestOptions): Promise<WebhookDelivery & { endpointUrl: string }> {
    return this.client.request('POST', `/events/${enc(id)}/resend`, { ...options, body: params });
  }
}

// ---------- Sandbox ----------

/**
 * Giả lập cho Sandbox, chỉ dùng với API key `boa_test_…`: chạy đúng luồng thật (khớp đơn, webhook `livemode: false`),
 * không cần ngân hàng, không tính phí. Tối đa 10 lần mỗi phút.
 */
export class Sandbox extends Resource {
  private assertTest() {
    if (this.client.livemode)
      throw new BankOpenAPIError('Sandbox chỉ dùng với API key boa_test_…. / Sandbox helpers require a boa_test_ key.', { code: 'LIVE_MODE' });
  }

  /** Tạo tài khoản ngân hàng thử, liên kết xong ngay (không cần OTP). Tối đa 5 tài khoản thử */
  createBankAccount(params: { accountName?: string } = {}, options?: RequestOptions): Promise<BankAccount> {
    this.assertTest();
    return this.client.request('POST', '/test/bank-accounts', { ...options, body: params });
  }

  /** Giả lập tiền chuyển vào tài khoản thử. Nội dung có mã `TT…` của một yêu cầu thanh toán thì khớp yêu cầu đó */
  createTransaction(params: { amount: number; content?: string; bankAccountId?: string }, options?: RequestOptions): Promise<Transaction> {
    this.assertTest();
    return this.client.request('POST', '/test/transactions', { ...options, body: params });
  }

  /** Giả lập người mua thanh toán một yêu cầu. `amount` mặc định là số tiền còn thiếu */
  payPaymentRequest(id: string, params: { amount?: number } = {}, options?: RequestOptions): Promise<PaymentRequest> {
    this.assertTest();
    return this.client.request('POST', `/test/payment-requests/${enc(id)}/pay`, { ...options, body: params });
  }
}
