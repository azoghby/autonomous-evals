/**
 * Report-Only first: violations show in the browser console, nothing is blocked. Fonts (next/font), Vercel Analytics,
 * Speed Insights and BotID are all served from this origin; Stripe is redirect-only (form-action); AI Gateway calls are
 * server-side. vercel.live is the preview toolbar. Next inline bootstrap scripts need 'unsafe-inline' until nonces.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://vercel.live",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://vercel.live wss://ws-us3.pusher.com",
  "frame-src 'self' https://vercel.live https://js.stripe.com https://checkout.stripe.com",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");
