import {
  MobileMoneyCheckoutOptions,
  CheckoutResult,
  PaymentProvider,
  RefundOptions,
  RefundResult,
  CreditCardCheckoutOptions,
  RedirectCheckoutOptions,
  TransactionStatus,
  PaymentMethod,
  HandleWebhookOptions,
  Currency,
  MobileMoneyPayoutOptions,
  PayoutResult,
} from "../payment-provider.interface";
import EventEmitter2 from "eventemitter2";
import {
  PaymentEventType,
  PaymentFailedEvent,
  PaymentInitiatedEvent,
  PaymentSuccessfulEvent,
} from "../payment-events";
import Stripe from "stripe";
import { PaymentError, PaymentErrorType } from "../payment-error";
import { isString, mapValues } from "lodash";

class StripePaymentProvider implements PaymentProvider {
  private eventEmitter?: EventEmitter2;
  private stripe: Stripe;
  private webhookSecret?: string;

  constructor(private config: StripePaymentProviderConfig) {
    this.stripe = new Stripe(config.privateKey, {
      apiVersion: "2023-08-16",
    });
    this.init().catch((error) => {
      console.error("Error initializing stripe provider", error);
    });
    this.webhookSecret = config.webhookSecret;
  }

  async init() {
    if (this.config.webhookUrl) {
      const existingWebhooks = await this.stripe.webhookEndpoints.list();
      const existingWebhook = existingWebhooks.data.find(
        (webhook) => webhook.url === this.config.webhookUrl
      );
      if (!existingWebhook) {
        const installedWebhook = await this.stripe.webhookEndpoints.create({
          enabled_events: [
            "checkout.session.completed",
            "checkout.session.expired",
            "checkout.session.async_payment_succeeded",
            "checkout.session.async_payment_failed",
          ],
          url: this.config.webhookUrl,
        });
        this.webhookSecret = installedWebhook.secret;
      }
    }
  }

  useEventEmitter(eventEmitter: EventEmitter2) {
    this.eventEmitter = eventEmitter;
  }

  async checkoutMobileMoney(
    options: MobileMoneyCheckoutOptions
  ): Promise<CheckoutResult> {
    throw new PaymentError(
      "Stripe does not support mobile money payments",
      PaymentErrorType.UNSUPPORTED_PAYMENT_METHOD
    );
  }

  async checkoutCreditCard(
    options: CreditCardCheckoutOptions
  ): Promise<CheckoutResult> {
    throw new PaymentError(
      "Stripe does not support credit card payments. Use credit card tokens instead",
      PaymentErrorType.UNSUPPORTED_PAYMENT_METHOD
    );
  }

  async checkoutRedirect(
    options: RedirectCheckoutOptions
  ): Promise<CheckoutResult> {
    const checkoutSession = await this.stripe.checkout.sessions.create({
      customer_email: options.customer.email,
      payment_method_types:
        options.paymentMethod === PaymentMethod.CREDIT_CARD
          ? ["card"]
          : undefined,
      line_items: [
        {
          price_data: {
            currency: options.currency,
            product_data: {
              name: options.description,
            },
            unit_amount: options.amount,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: options.successRedirectUrl,
      cancel_url: options.failureRedirectUrl,
      metadata: {
        ...mapValues(options.metadata, (value) => JSON.stringify(value)),
        transactionId: options.transactionId,
      },
    });
    if (!checkoutSession.url) {
      throw new PaymentError(
        "Stripe did not return a checkout URL",
        PaymentErrorType.UNKNOWN_ERROR
      );
    }
    return {
      transactionAmount: options.amount,
      transactionCurrency: options.currency,
      transactionId: options.transactionId,
      transactionReference: checkoutSession.id,
      transactionStatus: TransactionStatus.PENDING,
      redirectUrl: checkoutSession.url,
    };
  }

  async refund(options: RefundOptions): Promise<RefundResult> {
    const checkoutSession = await this.stripe.checkout.sessions.retrieve(
      options.refundedTransactionReference
    );
    if (!checkoutSession) {
      throw new PaymentError(
        "No checkout session found with reference " +
          options.refundedTransactionReference,
        PaymentErrorType.UNKNOWN_ERROR
      );
    }
    if (!checkoutSession.payment_intent) {
      throw new PaymentError(
        "No payment intent found for checkout session " + checkoutSession.id,
        PaymentErrorType.UNKNOWN_ERROR
      );
    }
    const refund = await this.stripe.refunds.create({
      payment_intent: isString(checkoutSession.payment_intent)
        ? checkoutSession.payment_intent
        : checkoutSession.payment_intent.id,
      amount: options.refundedAmount,
      reason: "requested_by_customer",
    });
    return {
      transactionAmount: refund.amount,
      transactionCurrency: refund.currency as Currency,
      transactionId: options.transactionId,
      transactionReference: refund.id,
      transactionStatus: TransactionStatus.SUCCESS,
    };
  }

  payoutMobileMoney(options: MobileMoneyPayoutOptions): Promise<PayoutResult> {
    throw new PaymentError(
      "Stripe does not support mobile money payouts",
      PaymentErrorType.UNSUPPORTED_PAYMENT_METHOD
    );
  }

  async handleWebhook(
    rawBody: Buffer | string,
    options: HandleWebhookOptions
  ) {
    const signature = options.headers?.["stripe-signature"];
    if (!signature) {
      console.warn("No signature found in stripe webhook request");
      return null;
    }
    if (!this.webhookSecret) {
      console.warn("No stripe webhook secret found");
      return null;
    }
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret
      );
    } catch (error) {
      console.warn("Error verifying stripe webhook signature", error);
      return null;
    }

    const emitSuccessfulPayment = (session: Stripe.Checkout.Session) => {
      if (!session.metadata?.transactionId) {
        console.warn("No transaction ID found in stripe webhook");
        return null;
      }
      const paymentSuccessfulEvent: PaymentSuccessfulEvent = {
        type: PaymentEventType.PAYMENT_SUCCESSFUL,
        paymentMethod: PaymentMethod.CREDIT_CARD,
        transactionAmount: Number(session.amount_total),
        transactionCurrency: session.currency as Currency,
        transactionId: session.metadata?.transactionId,
        transactionReference: session.id,
        metadata: parseMetadata(session.metadata),
        paymentProvider: StripePaymentProvider.name,
      };
      this.eventEmitter?.emit(
        PaymentEventType.PAYMENT_SUCCESSFUL,
        paymentSuccessfulEvent
      );
      return paymentSuccessfulEvent;
    };

    const parseMetadata = (
      metadata: Stripe.Metadata
    ): Record<string, string> => {
      return mapValues(metadata, (value) => {
        try {
          return JSON.parse(value);
        } catch (error) {
          return value;
        }
      });
    };

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      if (!session.metadata?.transactionId) {
        console.warn("No transaction ID found in stripe webhook");
        return null;
      }

      const paymentInitiatedEvent: PaymentInitiatedEvent = {
        type: PaymentEventType.PAYMENT_INITIATED,
        paymentMethod: PaymentMethod.CREDIT_CARD,
        transactionAmount: Number(session.amount_total),
        transactionCurrency: session.currency as Currency,
        transactionId: session.metadata?.transactionId,
        transactionReference: session.id,
        metadata: parseMetadata(session.metadata),
        paymentProvider: StripePaymentProvider.name,
      };
      this.eventEmitter?.emit(
        PaymentEventType.PAYMENT_INITIATED,
        paymentInitiatedEvent
      );

      if (session.payment_status === "paid") {
        return emitSuccessfulPayment(session);
      }
      return paymentInitiatedEvent;
    } else if (event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object as Stripe.Checkout.Session;
      return emitSuccessfulPayment(session);
    } else if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (!session.metadata?.transactionId) {
        console.warn("No transaction ID found in stripe webhook");
        return null;
      }
      const paymentFailedEvent: PaymentFailedEvent = {
        type: PaymentEventType.PAYMENT_FAILED,
        paymentMethod: PaymentMethod.CREDIT_CARD,
        transactionAmount: Number(session.amount_total),
        transactionCurrency: session.currency as Currency,
        transactionId: session.metadata?.transactionId,
        transactionReference: session.id,
        metadata: parseMetadata(session.metadata),
        reason: "Payment failed",
        paymentProvider: StripePaymentProvider.name,
      };
      this.eventEmitter?.emit(
        PaymentEventType.PAYMENT_FAILED,
        paymentFailedEvent
      );
      return paymentFailedEvent;
    }
    return null;
  }
}

type StripePaymentProviderConfig = {
  privateKey: string;
  webhookUrl?: string;
  webhookSecret?: string;
};

export default StripePaymentProvider;
