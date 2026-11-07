import { redirect } from "next/navigation";
import { peekMagicLink } from "@ae/core/auth/magic-link";
import { safeNextPath } from "@ae/core/auth/tokens";
import { SignInConfirm } from "@/components/app/signin-confirm";

export const metadata = { title: "Confirm sign-in · Autonomous Evals", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function SignInConfirmPage({ searchParams }: { searchParams: Promise<{ token?: string; next?: string }> }) {
  const { token, next } = await searchParams;
  const safeNext = safeNextPath(next);
  if (!token || token.length > 200) redirect("/signin?auth_error=invalid");
  const peek = await peekMagicLink(token);
  if (!peek.ok) {
    const qs = new URLSearchParams({ auth_error: peek.reason });
    if (next && safeNextPath(next, "") !== "") qs.set("next", safeNext);
    redirect(`/signin?${qs}`);
  }
  return <SignInConfirm token={token} next={safeNext} maskedEmail={peek.maskedEmail} />;
}
