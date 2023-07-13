import EventEmitter2 from "eventemitter2";

interface PaymentProvider {
  checkout(options: CheckoutOptions): Promise<CheckoutResult>;

  refund(options: RefundOptions): Promise<RefundResult>;

  useEventEmitter(eventEmitter: EventEmitter2): void;

  handleWebhook(body: Record<string, any>): Promise<void>;
}

enum PaymentMethod {
  WAVE = "WAVE",
  ORANGE_MONEY = "ORANGE_MONEY",
  CREDIT_CARD = "CREDIT_CARD",
}

enum Currency {
  XOF = "XOF",
}

type BasicCheckoutOptions = {
  amount: number;
  description: string;
  currency: Currency;
  transactionId: string;
  customer: {
    firstName: string;
    lastName: string;
    email?: string;
    phoneNumber: string;
  };
  metadata?: Record<string, any>;
  successRedirectUrl?: string;
  failureRedirectUrl?: string;
};

type WaveCheckoutOptions = BasicCheckoutOptions & {
  paymentMethod: PaymentMethod.WAVE;
};

type OrangeMoneyCheckoutOptions = BasicCheckoutOptions & {
  paymentMethod: PaymentMethod.ORANGE_MONEY;
  authorizationCode: string;
};

type CreditCardCheckoutOptions = BasicCheckoutOptions & {
  paymentMethod: PaymentMethod.CREDIT_CARD;
  cardNumber: string;
  cardExpirationMonth: string;
  cardExpirationYear: string;
  cardCvv: string;
};

type CheckoutOptions =
  | WaveCheckoutOptions
  | OrangeMoneyCheckoutOptions
  | CreditCardCheckoutOptions;

type CheckoutResult = {
  transactionId: string;
  transactionReference: string;
  transactionStatus: TransactionStatus;
  transactionAmount: number;
  transactionCurrency: Currency;
  redirectUrl?: string;
};

enum TransactionStatus {
  PENDING = "PENDING",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
}

type RefundOptions = {
  transactionId: string;
  refundedTransactionReference: string;
  refundedAmount?: number;
};

type RefundResult = {
  transactionId: string;
  transactionReference: string;
  transactionStatus: TransactionStatus;
  transactionAmount: number;
  transactionCurrency: Currency;
};

export {
  PaymentProvider,
  PaymentMethod,
  Currency,
  BasicCheckoutOptions,
  WaveCheckoutOptions,
  OrangeMoneyCheckoutOptions,
  CreditCardCheckoutOptions,
  CheckoutOptions,
  CheckoutResult,
  TransactionStatus,
  RefundOptions,
  RefundResult,
};
