import { Currency, PaymentMethod } from "./payment-provider.interface";

export enum PaymentEventType {
  PAYMENT_INITIATED = "PAYMENT_INITIATED",
  PAYMENT_SUCCESSFUL = "PAYMENT_SUCCESSFUL",
  PAYMENT_FAILED = "PAYMENT_FAILED",
  PAYMENT_CANCELLED = "PAYMENT_CANCELLED",
}

export type PaymentInitiatedEvent = {
  type: PaymentEventType.PAYMENT_INITIATED;
  transactionId: string;
  transactionReference: string;
  transactionAmount: number;
  transactionCurrency: Currency;
  paymentMethod: PaymentMethod | null;
  metadata?: Record<string, any>;
  redirectUrl?: string;
  paymentProvider: string;
};

export type PaymentSuccessfulEvent = {
  type: PaymentEventType.PAYMENT_SUCCESSFUL;
  transactionId: string;
  transactionReference: string;
  transactionAmount: number;
  transactionCurrency: Currency;
  metadata?: Record<string, any>;
  paymentMethod: PaymentMethod | null;
  paymentProvider: string;
};

export type PaymentFailedEvent = {
  type: PaymentEventType.PAYMENT_FAILED;
  transactionId: string;
  transactionReference: string;
  transactionAmount: number;
  transactionCurrency: Currency;
  paymentMethod: PaymentMethod | null;
  metadata?: Record<string, any>;
  reason: string;
  paymentProvider: string;
};

export type PaymentCancelledEvent = {
  type: PaymentEventType.PAYMENT_CANCELLED;
  transactionId: string;
  transactionReference: string;
  transactionAmount: number;
  transactionCurrency: Currency;
  paymentMethod: PaymentMethod | null;
  metadata?: Record<string, any>;
  reason: string;
  paymentProvider: string;
};

export type PaymentEvent = PaymentInitiatedEvent | PaymentSuccessfulEvent | PaymentFailedEvent | PaymentCancelledEvent;