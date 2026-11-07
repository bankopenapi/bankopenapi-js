// Kiểu dữ liệu của API BankOpenAPI v1, khớp với apps/app/worker (serializer của từng đối tượng).
// Trường camelCase, thời gian là chuỗi ISO 8601 (UTC), tiền là số nguyên VND.

/** Danh sách. `hasMore` chỉ có ở danh sách phân trang (yêu cầu thanh toán, giao dịch, sự kiện, lần gửi webhook) */
export interface List<T> {
  object: 'list';
  data: T[];
  hasMore?: boolean;
}

/** Tài khoản ngân hàng gắn kèm trong yêu cầu thanh toán và giao dịch */
export interface BankAccountRef {
  id: string;
  bank: { bin: string; name: string | null };
  accountNumber: string | null;
  /** vd. "MB Bank •••• 6789" */
  label: string;
}

export type PaymentRequestStatus = 'pending' | 'paid' | 'underpaid' | 'overpaid' | 'expired' | 'canceled';

export interface PaymentRequest {
  /** pr_… */
  id: string;
  object: 'payment_request';
  livemode: boolean;
  amount: number;
  amountReceived: number;
  currency: 'VND';
  /** `expired`: quá `expiresAt` mà chưa nhận đủ tiền */
  status: PaymentRequestStatus;
  /** Mã ghi trong nội dung chuyển khoản, vd. "TT7K3M9Q" */
  code: string;
  orderId: string | null;
  description: string | null;
  bankAccount: BankAccountRef;
  /** Thông tin chuyển khoản (số tiền còn thiếu, nội dung = code) để hiện cho người trả hoặc tự dựng VietQR */
  transfer: {
    bankBin: string;
    accountNumber: string;
    accountName: string | null;
    /** Số tiền còn phải trả */
    amount: number;
    content: string;
  };
  /**
   * Chuỗi QR để vẽ ảnh (vd. `qrcode.toDataURL(qr.payload)`): QR động một lần của ngân hàng nếu tài khoản hỗ trợ, không thì
   * VietQR tĩnh. null khi yêu cầu không còn nhận tiền.
   */
  qr: { type: 'dynamic'; payload: string; expiresAt: string } | { type: 'static'; payload: string; expiresAt: null } | null;
  /** Trang thanh toán của BankOpenAPI để gửi cho người trả (QR, thông tin chuyển khoản, tự cập nhật khi tiền về) */
  hostedUrl: string;
  paymentLinkId: string | null;
  expiresAt: string;
  paidAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  /** Giao dịch đã khớp. Chỉ có khi `retrieve`, `cancel` và `sandbox.payPaymentRequest` */
  transactions?: { id: string; amount: number; content: string | null; transactedAt: string }[];
}

export interface Transaction {
  /** txn_… */
  id: string;
  object: 'transaction';
  livemode: boolean;
  /** credit: tiền vào, debit: tiền ra */
  type: 'credit' | 'debit';
  amount: number;
  currency: 'VND';
  /** Nội dung chuyển khoản */
  content: string | null;
  /** Mã giao dịch của ngân hàng */
  reference: string;
  /** Số nhận báo có (tài khoản định danh hoặc số tài khoản) */
  receivingNumber: string | null;
  /** Yêu cầu thanh toán đã khớp, nếu có */
  paymentRequestId: string | null;
  /** Lúc đã báo có (webhook, kênh). null: chưa báo vì đang tạm dừng báo có */
  notifiedAt: string | null;
  bankAccount: BankAccountRef;
  transactedAt: string;
  createdAt: string;
}

export interface BankAccount {
  /** ba_… */
  id: string;
  object: 'bank_account';
  livemode: boolean;
  bank: { bin: string; code: string | null; name: string | null };
  accountType: 'personal-account' | 'business-household-account' | 'business-account';
  accountNumber: string | null;
  accountName: string | null;
  receivingNumber: string | null;
  notifyRealAccount: boolean;
  status: 'pending' | 'active' | 'failed' | 'removed';
  pendingStep: 'link' | 'notify' | 'unlink' | 'bank-app' | 'bank-web' | 'unlink-web' | null;
  linkedAt: string | null;
  createdAt: string;
}

export interface Account {
  object: 'account';
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export type WebhookEventType =
  | 'transaction.received'
  | 'payment_request.paid'
  | 'payment_request.underpaid'
  | 'bank_account.linked'
  | 'bank_account.removed';

export interface WebhookEndpoint {
  /** we_… */
  id: string;
  object: 'webhook_endpoint';
  livemode: boolean;
  url: string;
  description: string | null;
  /** `['*']` là mọi loại sự kiện */
  events: (WebhookEventType | '*')[];
  /** null: mọi tài khoản ngân hàng */
  bankAccountIds: string[] | null;
  /** Tên header tùy chỉnh (giá trị không bao giờ trả về) */
  headerNames: string[];
  status: 'enabled' | 'disabled';
  /** manual: tự tắt; gone: endpoint trả 410; failing: lỗi liên tục 5 ngày */
  disabledReason: 'manual' | 'gone' | 'failing' | null;
  statusChangedAt: string | null;
  /** Secret cũ còn ký song song tới lúc này (sau khi rotate) */
  previousSecretExpiresAt: string | null;
  createdAt: string;
}

export interface WebhookDelivery {
  /** whd_… */
  id: string;
  object: 'webhook_delivery';
  endpointId: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'succeeded' | 'failed';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  durationMs: number | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Body JSON đã ký (chuỗi), chỉ có ở xem chi tiết */
  payload?: string;
  /** 1 KB đầu phản hồi của endpoint, chỉ có ở xem chi tiết */
  responseBody?: string | null;
  endpointUrl?: string;
}

/** Sự kiện đọc qua API (`events.list`, `events.retrieve`). Khác payload webhook: có `object`, `createdAt` */
export interface Event {
  /** evt_… */
  id: string;
  object: 'event';
  type: WebhookEventType | 'webhook.test';
  livemode: boolean;
  data: Record<string, unknown> | null;
  createdAt: string;
}

// ---------- Payload webhook (body BankOpenAPI POST tới endpoint của bạn) ----------

interface WebhookEventBase<T extends string, D> {
  /** evt_…, giữ nguyên qua mọi lần gửi lại (cũng là header webhook-id): dùng để chống xử lý trùng */
  id: string;
  type: T;
  livemode: boolean;
  /** Thời điểm sự kiện, ISO 8601 */
  timestamp: string;
  data: D;
}

/**
 * Sự kiện nhận qua webhook. Kiểm `event.type` để TypeScript biết kiểu của `event.data`:
 * - `transaction.received`: tiền vào một tài khoản đã liên kết (`Transaction`)
 * - `payment_request.paid`: yêu cầu thanh toán đã nhận đủ hoặc thừa tiền (`status` là `paid` hoặc `overpaid`)
 * - `payment_request.underpaid`: nhận thiếu tiền, có thể đến nhiều lần khi người trả chuyển thêm
 * - `bank_account.linked`, `bank_account.removed`
 * - `webhook.test`: tin gửi thử từ app hoặc `webhookEndpoints.sendTest`
 */
export type WebhookEvent =
  | WebhookEventBase<'transaction.received', Transaction>
  | WebhookEventBase<'payment_request.paid', PaymentRequest>
  | WebhookEventBase<'payment_request.underpaid', PaymentRequest>
  | WebhookEventBase<'bank_account.linked', BankAccount>
  | WebhookEventBase<'bank_account.removed', BankAccount>
  | WebhookEventBase<'webhook.test', { message: string; endpointId: string; livemode: boolean }>;
