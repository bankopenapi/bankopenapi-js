import { APIClient, type ClientOptions } from './core.ts';
import { WebhookVerificationError } from './errors.ts';
import { AccountResource, BankAccounts, Events, PaymentRequests, Sandbox, Transactions, WebhookEndpoints } from './resources.ts';
import type { WebhookEvent } from './types.ts';
import { signWebhook, verifyWebhook, type VerifyOptions, type WebhookHeaders } from './webhooks.ts';

/**
 * Thư viện chính thức của BankOpenAPI: nhận tiền chuyển khoản vào tài khoản ngân hàng Việt Nam, hiện VietQR, nhận
 * webhook khi tiền về. Tài liệu: https://bankopenapi.com/tai-lieu
 *
 * @example
 * import BankOpenAPI from 'bankopenapi';
 *
 * const boa = new BankOpenAPI(); // đọc BANKOPENAPI_API_KEY
 * const pr = await boa.paymentRequests.create({ amount: 150000, orderId: 'DH1028' }, { idempotencyKey: 'order-DH1028' });
 * // Hiện pr.qr.payload thành mã QR, hoặc chuyển người mua tới pr.hostedUrl
 */
export class BankOpenAPI {
  readonly account: AccountResource;
  readonly paymentRequests: PaymentRequests;
  readonly transactions: Transactions;
  readonly bankAccounts: BankAccounts;
  readonly webhookEndpoints: WebhookEndpoints;
  readonly events: Events;
  /** Giả lập tiền về, thanh toán, tài khoản ngân hàng thử: chỉ với API key `boa_test_…` */
  readonly sandbox: Sandbox;
  readonly webhooks: Webhooks;
  private readonly client: APIClient;

  /**
   * @param options API key (mặc định biến môi trường `BANKOPENAPI_API_KEY`), signing secret webhook, timeout, số lần thử lại.
   * Truyền chuỗi thì coi là API key.
   */
  constructor(options: ClientOptions | string = {}) {
    this.client = new APIClient(typeof options === 'string' ? { apiKey: options } : options);
    this.account = new AccountResource(this.client);
    this.paymentRequests = new PaymentRequests(this.client);
    this.transactions = new Transactions(this.client);
    this.bankAccounts = new BankAccounts(this.client);
    this.webhookEndpoints = new WebhookEndpoints(this.client);
    this.events = new Events(this.client);
    this.sandbox = new Sandbox(this.client);
    this.webhooks = new Webhooks(this.client.webhookSecret);
  }

  /** true với khóa `boa_live_` (tiền thật), false với khóa Sandbox `boa_test_` */
  get livemode(): boolean {
    return this.client.livemode;
  }
}

export class Webhooks {
  private readonly secret: string | undefined;

  constructor(secret: string | undefined) {
    this.secret = secret;
  }

  private secretOrThrow(secret: string | undefined) {
    const s = secret ?? this.secret;
    if (!s)
      throw new WebhookVerificationError(
        'Thiếu signing secret: truyền { webhookSecret } khi tạo client hoặc đặt BANKOPENAPI_WEBHOOK_SECRET (lấy ở trang Webhook trong app). / Missing webhook secret.',
      );
    return s;
  }

  /**
   * Kiểm chữ ký webhook rồi trả sự kiện. Truyền **body thô** (`await req.text()`, `express.raw()`), không parse trước.
   * Sai chữ ký thì ném `WebhookVerificationError`: trả HTTP 400.
   */
  verify(payload: string | ArrayBuffer | Uint8Array, headers: WebhookHeaders, secret?: string, options?: VerifyOptions): Promise<WebhookEvent> {
    return verifyWebhook(payload, headers, this.secretOrThrow(secret), options);
  }

  /** Ký payload như BankOpenAPI gửi, để viết test cho endpoint nhận webhook */
  sign(payload: string, secret?: string, options?: { id?: string; timestamp?: Date }) {
    return signWebhook(payload, this.secretOrThrow(secret), options);
  }
}

export default BankOpenAPI;
export { VERSION, type ClientOptions, type RequestOptions } from './core.ts';
export * from './errors.ts';
export type { PagePromise } from './pagination.ts';
export type * from './resources.ts';
export type * from './types.ts';
export { signWebhook, verifyWebhook, type VerifyOptions, type WebhookHeaders } from './webhooks.ts';
