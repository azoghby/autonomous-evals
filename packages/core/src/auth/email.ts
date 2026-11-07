import { Resend } from "resend";

export interface EmailMessage { to: string; subject: string; text: string; html?: string }

/** Sends via Resend. Throws if RESEND_API_KEY / EMAIL_FROM are missing or the API errors. */
export async function sendEmail(msg: EmailMessage): Promise<{ id: string | null }> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  if (!from) throw new Error("EMAIL_FROM is not set");
  const { data, error } = await new Resend(key).emails.send({
    from, to: msg.to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}),
  });
  if (error) throw new Error(`Email send failed: ${error.message}`);
  return { id: data?.id ?? null };
}
