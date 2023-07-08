import { parsePhoneNumber } from "libphonenumber-js";
import {
  CheckoutOptions,
  CheckoutResult,
  Currency,
  PaymentMethod,
  PaymentProvider,
  TransactionStatus,
} from "../payment-provider.interface";
import { ApisauceInstance, create } from "apisauce";
import EventEmitter2 from "eventemitter2";
import {
  PaymentEventType,
  PaymentInitiatedEvent,
  PaymentSuccessfulEvent,
} from "../payment-events";
import { createHash } from "crypto";

class PaydunyaPaymentProvider implements PaymentProvider {
  private api: ApisauceInstance;
  private eventEmitter?: EventEmitter2;
  private masterKeySha512Hash: string;

  constructor(private config: PaydunyaPaymentProviderConfig) {
    this.api = create({
      baseURL:
        config.mode === "test"
          ? "https://app.sandbox.paydunya.com/api/v1/"
          : "https://app.paydunya.com/api/v1/",
      headers: {
        "Content-Type": "application/json",
        "PAYDUNYA-MASTER-KEY": config.masterKey,
        "PAYDUNYA-PRIVATE-KEY": config.privateKey,
        "PAYDUNYA-PUBLIC-KEY": config.publicKey,
        "PAYDUNYA-TOKEN": config.token,
      },
    });

    this.api.addResponseTransform((response) => {
      if (!response.ok) {
        throw new Error(
          "Paydunya error: " +
            response.problem +
            ". Status: " +
            response.status +
            ". Data: " +
            JSON.stringify(response.data)
        );
      }
    });

    const hash = createHash("sha512");
    hash.update(this.config.masterKey, "utf-8");
    this.masterKeySha512Hash = hash.digest("hex");
  }

  useEventEmitter(eventEmitter: EventEmitter2) {
    this.eventEmitter = eventEmitter;
  }

  async checkout(options: CheckoutOptions): Promise<CheckoutResult> {
    if (options.currency !== Currency.XOF) {
      throw new Error(
        "Paydunya does not support the currency: " + options.currency
      );
    }
    const parsedCustomerPhoneNumber = parsePhoneNumber(
      options.customer.phoneNumber,
      "SN"
    );
    if (!parsedCustomerPhoneNumber.isValid()) {
      throw new Error("Invalid phone number: " + options.customer.phoneNumber);
    }
    if (!parsedCustomerPhoneNumber.isPossible()) {
      throw new Error(
        "Phone number is not possible: " + options.customer.phoneNumber
      );
    }
    const createInvoiceResponse = await this.api.post<
      PaydunyaCreateInvoiceSuccessResponse,
      PaydunyaCreateInvoiceErrorResponse
    >("checkout-invoice/create", {
      invoice: {
        total_amount: options.amount,
        description: options.description,
      },
      store: {
        name: this.config.store.name,
      },
      custom_data: {
        transaction_id: options.transactionId,
        ...options.metadata,
      },
    });

    const invoiceData = createInvoiceResponse.data;

    if (!invoiceData) {
      throw new Error("Paydunya error: " + createInvoiceResponse.problem);
    }

    if (invoiceData.response_code !== "00") {
      throw new Error("Paydunya error: " + invoiceData.response_text);
    }

    if (!("token" in invoiceData)) {
      throw new Error(
        "Missing invoice token in Paydunya response: " +
          invoiceData.response_text
      );
    }

    const invoiceToken = invoiceData.token;

    if (options.paymentMethod === PaymentMethod.WAVE) {
      const paydunyaWaveResponse = await this.api.post<
        PaydunyaWavePaymentSuccessResponse,
        PaydunyaWavePaymentErrorResponse
      >("/softpay/wave-senegal", {
        wave_senegal_fullName: `${options.customer.firstName || ""} ${
          options.customer.lastName || ""
        }`.trim(),
        wave_senegal_email:
          options.customer.email ||
          `${options.customer.phoneNumber}@yopmail.com`,
        wave_senegal_phone: parsedCustomerPhoneNumber.nationalNumber,
        wave_senegal_payment_token: invoiceToken,
      });

      const waveData = paydunyaWaveResponse.data;

      if (!waveData) {
        throw new Error("Paydunya error: " + paydunyaWaveResponse.problem);
      }

      if (!waveData.success) {
        throw new Error("Paydunya error: " + waveData.message);
      }

      if (!waveData.url) {
        throw new Error(
          "Missing wave payment url in Paydunya response: " + waveData.message
        );
      }

      const result: CheckoutResult = {
        success: true,
        message: waveData.message,
        transactionAmount: options.amount,
        transactionCurrency: options.currency,
        transactionId: options.transactionId,
        transactionReference: invoiceToken,
        transactionStatus: TransactionStatus.PENDING,
        redirectUrl: waveData.url,
      };

      const paymentInitiatedEvent: PaymentInitiatedEvent = {
        type: PaymentEventType.PAYMENT_INITIATED,
        paymentMethod: options.paymentMethod,
        transactionId: options.transactionId,
        transactionAmount: options.amount,
        transactionCurrency: options.currency,
        transactionReference: invoiceToken,
        redirectUrl: waveData.url,
        metadata: options.metadata,
      };
      this.eventEmitter?.emit(
        PaymentEventType.PAYMENT_INITIATED,
        paymentInitiatedEvent
      );

      return result;
    } else if (options.paymentMethod === PaymentMethod.ORANGE_MONEY) {
      throw new Error("Orange Money is not supported yet");
    } else {
      throw new Error(
        "Paydunya does not support the payment method: " + options.paymentMethod
      );
    }
  }

  async handleWebhook(body: PaydunyaPaymentWebhookBody): Promise<void> {
    if (!body.hash) {
      console.error("Missing hash in Paydunya webhook body");
      return;
    }
    if (body.hash !== this.masterKeySha512Hash) {
      console.error("Invalid hash in Paydunya webhook body");
      return;
    }
    if (body.status === "completed" && body.response_code == "00") {
      const paymentMethod =
        body.customer.payment_method === "wave_senegal"
          ? PaymentMethod.WAVE
          : body.customer.payment_method === "orange_money_senegal"
          ? PaymentMethod.ORANGE_MONEY
          : null;
      if (!paymentMethod) {
        console.error(
          "Unknown payment method: " + body.customer.payment_method
        );
        return;
      }
      const paymentSuccessfulEvent: PaymentSuccessfulEvent = {
        type: PaymentEventType.PAYMENT_SUCCESSFUL,
        paymentMethod,
        transactionAmount: Number(body.invoice.total_amount),
        transactionCurrency: Currency.XOF,
        transactionId: body.custom_data.transaction_id,
        transactionReference: body.invoice.token,
        metadata: body.custom_data,
      };
      this.eventEmitter?.emit(
        PaymentEventType.PAYMENT_SUCCESSFUL,
        paymentSuccessfulEvent
      );
    }
  }
}

type PaydunyaPaymentProviderConfig = {
  masterKey: string;
  privateKey: string;
  publicKey: string;
  token: string;
  mode: "test" | "live";
  store: {
    name: string;
  };
};

type PaydunyaCreateInvoiceSuccessResponse = {
  response_code: "00";
  response_text: string;
  description: string;
  token: string;
};

type PaydunyaCreateInvoiceErrorResponse = {
  response_code: string;
  response_text: string;
};

type PaydunyaWavePaymentSuccessResponse = {
  success: true;
  message: string;
  url: string;
};

type PaydunyaWavePaymentErrorResponse = {
  success: false | undefined;
  message: string;
};

type PaydunyaPaymentWebhookBody = {
  response_code: string;
  response_text: string;
  hash: string;
  invoice: {
    token: string;
    pal_is_on: string;
    total_amount: string;
    total_amount_without_fees: string;
    description: string;
    expire_date: string;
  };
  custom_data: Record<string, any>;
  actions: {
    cancel_url: string;
    callback_url: string;
    return_url: string;
  };
  mode: string;
  status: string;
  fail_reason: string;
  customer: {
    name: string;
    phone: string;
    email: string;
    payment_method: string;
  };
  receipt_identifier: string;
  receipt_url: string;
  provider_reference: string;
};

export default PaydunyaPaymentProvider;
