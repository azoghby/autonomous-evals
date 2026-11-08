import { NextResponse } from "next/server";
import { optOutByToken } from "@/server/feedback";

export const dynamic = "force-dynamic";

const page = (title: string, body: string, form = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Standard Evals</title></head>
<body style="background:#000;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:420px;padding:24px;border:1px solid #303236;border-radius:4px">
<h1 style="font-weight:400;font-size:24px;margin:0 0 12px">${title}</h1>
<p style="color:#94979e;margin:0 0 20px">${body}</p>${form}</div></body></html>`;

const html = (s: string, status = 200) => new NextResponse(s, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const cleanRef = (ref: string | null) => (ref ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);

/** Link click from the feedback invite footer: confirm button only (GET must not mutate; link scanners prefetch GETs). */
export async function GET(req: Request) {
  const ref = cleanRef(new URL(req.url).searchParams.get("ref"));
  if (!ref) return html(page("Link not valid", "This opt-out link is missing its reference."), 400);
  const form = `<form method="post" action="/api/feedback/unsubscribe?ref=${ref}"><button type="submit" style="background:#2b59ff;color:#fff;border:0;border-radius:4px;padding:10px 16px;font-size:15px;cursor:pointer">Don't email me again</button></form>`;
  return html(page("Stop emails from Standard Evals?", "One click and we won't contact this address again.", form));
}

/** POST: RFC 8058 one-click (List-Unsubscribe-Post) from mail clients, or the confirm form above. */
export async function POST(req: Request) {
  const ref = cleanRef(new URL(req.url).searchParams.get("ref"));
  let ok = false;
  try { ok = await optOutByToken(ref); } catch (err) { console.error("feedback opt-out failed", err instanceof Error ? err.message : err); return html(page("Something went wrong", "Please try again, or just reply STOP to the email."), 500); }
  if (!ok) return html(page("Link not valid", "We couldn't find this opt-out link. Reply STOP to the email and we'll remove you."), 400);
  const isForm = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  const body = isForm ? await req.text().catch(() => "") : "";
  if (isForm && !body.includes("List-Unsubscribe=One-Click")) return html(page("You're unsubscribed", "We won't email this address again."));
  return NextResponse.json({ ok: true });
}
