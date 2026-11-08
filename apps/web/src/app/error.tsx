"use client";

import { ErrorState } from "@/components/ui/ErrorState";
import { PageShell } from "@/components/ui/PageShell";

/**
 * App-wide error state for server render failures (e.g. the session lookup failing on a signed-in page). Server error
 * messages are redacted in production, so the copy is generic; "Try again" re-renders the segment.
 */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell narrow>
      <ErrorState
        title="We couldn't load this page"
        message="Something went wrong on our side. You're still signed in; please try again in a moment."
        action={
          <button type="button" onClick={() => reset()} className="text-sm text-fg underline underline-offset-4 hover:text-accent focus-visible:outline-2">
            Try again
          </button>
        }
      />
    </PageShell>
  );
}
