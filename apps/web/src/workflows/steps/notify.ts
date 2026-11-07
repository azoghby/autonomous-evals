import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { sendEmail } from "@ae/core/auth/email";
import { recordProgress } from "@/server/job-store";

/** Emails the customer. A failed email never fails the job (the report is already delivered); it is logged as progress. */
export async function notifyCustomerStep(jobId: string): Promise<void> {
  "use step";
  const [row] = await db().select({ email: schema.customers.email, isMock: schema.jobs.isMock })
    .from(schema.jobs).innerJoin(schema.customers, eq(schema.jobs.customerId, schema.customers.id))
    .where(eq(schema.jobs.id, jobId)).limit(1);
  if (!row) return;
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const link = `${base}/jobs/${jobId}`;
  try {
    await sendEmail({
      to: row.email,
      subject: row.isMock ? "[MOCK] Your Autonomous Evals report is ready" : "Your Autonomous Evals report is ready",
      text: `Your report is ready. Sign in to view findings and evidence:\n\n${link}\n\nCredentials you provided are deleted 24 hours after delivery.`,
    });
    await recordProgress(jobId, "customer_notified", "Delivery email sent.");
  } catch (err) {
    console.error("notifyCustomerStep email failed", jobId, err instanceof Error ? err.message : err);
    await recordProgress(jobId, "notify_failed", "Delivery email could not be sent. The report is available in the app.");
  }
}
