import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { customerForSessionToken } from "@ae/core/auth/magic-link";
import { PageHead, Panel } from "@/components/app/page-parts";
import { parseAuthorizeParams } from "@/server/oauth/core";
import { signConsent } from "@/server/oauth/consent";
import { oauthService, originFromHeaders } from "@/server/oauth/service";
import { getSessionToken } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Authorize · Standard Evals", robots: { index: false } };

type SP = Record<string, string | string[] | undefined>;

function toQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  return q;
}

function hostOf(uri: string): string {
  try { return new URL(uri).host; } catch { return uri; }
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SP> }) {
  const query = toQuery(await searchParams);
  const origin = originFromHeaders(await headers());
  const v = await oauthService(origin).validateAuthorize(parseAuthorizeParams(query));
  if (!v.ok && v.redirect) redirect(v.redirectTo);
  if (!v.ok) {
    return (
      <div className="max-w-[560px] pt-2 sm:pt-8">
        <PageHead eyebrow="Authorize" title="Can't connect this app" lead={v.error.description} />
        <p className="text-[15px] text-muted">Start the connection again from your coding agent (for example run <code>/mcp</code> in Claude Code and choose Authenticate).</p>
      </div>
    );
  }

  const sessionToken = await getSessionToken();
  const me = sessionToken ? await customerForSessionToken(sessionToken) : null;
  if (!sessionToken || !me) redirect(`/signin?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);

  const { client, redirectUri } = v.req;
  const ticket = signConsent(sessionToken, query.toString(), me.id);
  return (
    <div className="max-w-[560px] pt-2 sm:pt-8">
      <PageHead
        eyebrow="Authorize"
        title={<>Allow <span className="break-words">{client.clientName}</span> to use Standard Evals as {me.email}?</>}
        lead="It will act on your account through the MCP server: list packages, create and pay for eval jobs, and read reports."
      />
      <Panel title="Details">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[14px]">
          <dt className="text-subtle">App</dt><dd className="break-words text-fg">{client.clientName}</dd>
          <dt className="text-subtle">Returns to</dt><dd className="t-data break-all text-fg-2">{hostOf(redirectUri)}</dd>
          <dt className="text-subtle">Access</dt><dd className="text-fg-2">MCP tools ({v.req.scope}). Revocable at any time.</dd>
        </dl>
        <p className="mt-4 text-[13px] text-muted">Only approve if you just started this from your own coding agent.</p>
        <form method="post" action="/oauth/authorize/decision" className="mt-6 flex flex-wrap gap-3">
          <input type="hidden" name="ticket" value={ticket} />
          <button type="submit" name="decision" value="allow" autoFocus className="inline-flex h-10 items-center rounded-[4px] bg-accent px-4 text-[15px] font-medium text-white hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Allow</button>
          <button type="submit" name="decision" value="deny" className="inline-flex h-10 items-center rounded-[4px] border border-line-3 px-4 text-[15px] text-fg hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Deny</button>
        </form>
      </Panel>
    </div>
  );
}
