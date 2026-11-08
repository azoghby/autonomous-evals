import Link from "next/link";

/** Plan-limit errors from the sandbox service are 402s whose text ends with "See /pricing." */
export function isPlanLimitError(message: string | null | undefined): boolean {
  return !!message && /See \/pricing\.?\s*$/.test(message);
}

/** Error block that turns a plan-limit message into an upgrade call-to-action; other errors render as before. */
export function FatalNotice({ message }: { message: string }) {
  if (!isPlanLimitError(message)) {
    return <p role="alert" className="border border-danger/40 px-4 py-3 text-sm text-danger break-words">{message}</p>;
  }
  const text = message.replace(/\s*See \/pricing\.?\s*$/, "");
  return (
    <div role="alert" className="bill-limit">
      <p className="bill-kicker">Plan limit reached</p>
      <p className="mt-1 text-[14px] text-fg break-words">{text}</p>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[14px]">
        <Link className="bill-limit-cta" href="/pricing">See plans and upgrade</Link>
        <Link className="underline" href="/settings/billing">View your usage</Link>
      </div>
    </div>
  );
}
