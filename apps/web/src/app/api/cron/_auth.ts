import { timingSafeEqual } from "node:crypto";

/** Returns an error Response unless the request carries `Authorization: Bearer ${CRON_SECRET}`. Fails closed. */
export function requireCronAuth(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  const header = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
