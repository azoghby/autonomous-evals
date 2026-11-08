import { NextResponse } from "next/server";
import { suppressEmail } from "@/server/owner-shared";
import { verifySignedToken } from "@/server/owner-policy";

export const dynamic = "force-dynamic";

async function suppress(token: string | null): Promise<boolean> {
  if (!token) return false;
  const p = verifySignedToken<{ e?: unknown }>("unsubscribe", token);
  if (!p || typeof p.e !== "string" || !p.e.includes("@")) return false;
  await suppressEmail(p.e, "owner_unsubscribe");
  return true;
}

const bad = () => NextResponse.json({ error: "invalid_token" }, { status: 400 });

/** Link click from the email footer: show a confirm button (GET must not mutate; link scanners prefetch GETs). */
export async function GET(req: Request) {
  const t = new URL(req.url).searchParams.get("t");
  if (!t || !verifySignedToken<{ e?: unknown }>("unsubscribe", t)) return bad();
  const esc = t.replace(/[^A-Za-z0-9._~-]/g, "");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribe · Standard Evals</title></head>
<body style="background:#000;color:#fff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
<form method="post" action="/api/leaderboard/unsubscribe?t=${esc}" style="max-width:420px;padding:24px;border:1px solid #303236;border-radius:4px">
<h1 style="font-weight:400;font-size:24px;margin:0 0 12px">Stop emails about your agent?</h1>
<p style="color:#94979e;margin:0 0 20px">You'll still get emails you explicitly ask for (like verification links).</p>
<button type="submit" style="background:#2b59ff;color:#fff;border:0;border-radius:4px;padding:10px 16px;font-size:15px;cursor:pointer">Unsubscribe</button>
</form></body></html>`;
  return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** POST: RFC 8058 one-click (List-Unsubscribe-Post) from mail clients, or the confirm form above. */
export async function POST(req: Request) {
  if (!(await suppress(new URL(req.url).searchParams.get("t")))) return bad();
  const isForm = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  const body = isForm ? await req.text().catch(() => "") : "";
  // RFC 8058 clients send body "List-Unsubscribe=One-Click"; browsers submitting the confirm form send an empty body.
  if (isForm && !body.includes("List-Unsubscribe=One-Click")) return NextResponse.redirect(new URL("/leaderboard/unsubscribed", req.url), 303);
  return NextResponse.json({ ok: true }, { status: 200 });
}
