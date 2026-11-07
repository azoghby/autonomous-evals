import "server-only";
import { confirmAndResume, reconcile, type PaymentRow } from "@ae/core/payments/checkout";
import { sendJobEvent } from "./events";

/** Payment helpers bound to the workflow's event sender (core must not import the web app). */
export const resumeJobForPayment = (payment: PaymentRow) => confirmAndResume(payment, sendJobEvent);
export const reconcilePayments = () => reconcile(sendJobEvent);
