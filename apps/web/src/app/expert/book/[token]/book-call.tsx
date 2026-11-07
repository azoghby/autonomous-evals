"use client";
import { useMemo, useState } from "react";
import { Button, Chip, ErrorState, Spinner, cn } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { useFetch } from "@/lib/client/use-fetch";

interface Slot { id: string; startsAt: string; durationMin: number }
interface Booking { slotId: string; startsAt: string; durationMin: number; meetUrl: string; recordingConsent: boolean }
interface SlotsResponse { slots: Slot[]; booking: Booking | null; domain: string }

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { dateStyle: "short" }).format(new Date(iso));
const dayLabel = (iso: string) => new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date(iso));
const timeLabel = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const fullLabel = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(new Date(iso));

export function BookCall({ token }: { token: string }) {
  const base = `/api/expert/r/${encodeURIComponent(token)}`;
  const { data, error, loading, reload } = useFetch<SlotsResponse>(`${base}/slots`);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const [justBooked, setJustBooked] = useState<Booking | null>(null);

  const days = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of data?.slots ?? []) map.set(dayKey(s.startsAt), [...(map.get(dayKey(s.startsAt)) ?? []), s]);
    return [...map.values()];
  }, [data]);

  if (loading) return <div className="flex justify-center py-24"><Spinner size={28} label="Loading available times" /></div>;
  if (error || !data) {
    const gone = error?.status === 404 || error?.status === 410 || error?.status === 409;
    return (
      <ErrorState title={gone ? "This link can't be used to book" : "Could not load available times"}
        message={error?.message ?? "Unknown error"}
        action={gone ? undefined : <Button variant="outline" onClick={() => void reload()}>Try again</Button>} />
    );
  }

  const booking = justBooked ?? data.booking;
  if (booking && !rescheduling) {
    return (
      <Confirmation token={token} booking={booking} fresh={!!justBooked}
        onReschedule={() => { setRescheduling(true); setSlotId(null); setConsent(booking.recordingConsent); }}
        onCancelled={() => { setJustBooked(null); void reload(); }} />
    );
  }

  async function book(e: React.FormEvent) {
    e.preventDefault();
    if (!slotId) return;
    setBusy(true); setFormError(null);
    try {
      const b = await api<Booking>(`${base}/book`, { method: "POST", json: { slotId, recordingConsent: consent } });
      setJustBooked(b); setRescheduling(false);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      if (err instanceof ApiError && err.status === 409) { setSlotId(null); void reload(); }
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={book} className="space-y-8">
      <header className="space-y-3">
        <Chip tone="info" dot>{data.domain}</Chip>
        <h1 className="text-3xl font-semibold tracking-tight">{rescheduling ? "Pick a new time" : "Book a short call"}</h1>
        <p className="text-sm text-muted">Times are shown in your timezone ({tz()}). The call happens in your browser over Jitsi Meet, with no account or install.</p>
        <p className="text-xs text-subtle">
          Autonomous Evals builds AI agents that evaluate other AI agents. An AI agent prepared this call and its questions; people at Autonomous Evals will run it.
        </p>
      </header>

      {days.length === 0 ? (
        <p className="border border-line px-5 py-8 text-sm text-muted">No times are open right now. Check back soon, or reply to the invitation email and we will find a time.</p>
      ) : (
        <div className="space-y-6" role="radiogroup" aria-label="Available times">
          {days.map((group) => (
            <section key={dayKey(group[0]!.startsAt)} className="space-y-2 border-t border-line pt-4">
              <h2 className="text-sm font-medium text-fg">{dayLabel(group[0]!.startsAt)}</h2>
              <div className="flex flex-wrap gap-2">
                {group.map((s) => (
                  <button key={s.id} type="button" role="radio" aria-checked={slotId === s.id} onClick={() => setSlotId(s.id)}
                    className={cn(
                      "h-10 border px-4 text-sm tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright",
                      slotId === s.id ? "border-accent-bright bg-accent text-white" : "border-line-strong text-fg hover:border-accent-bright",
                    )}>
                    {timeLabel(s.startsAt)} <span className="text-xs opacity-70">{s.durationMin} min</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <fieldset className="space-y-2 border border-line p-5">
        <legend className="px-2 text-sm font-medium">Recording</legend>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 size-4 accent-[#2F6BFF]" />
          <span>I consent to this call being recorded and transcribed. We will ask again at the start of the call.</span>
        </label>
        <p className="text-xs text-subtle">Leave this unchecked and we will only take written notes. Either choice is fine.</p>
      </fieldset>

      {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" size="lg" disabled={!slotId || busy}>{busy ? "Booking..." : "Confirm time"}</Button>
        {rescheduling && <Button type="button" variant="quiet" onClick={() => setRescheduling(false)}>Keep current time</Button>}
      </div>
    </form>
  );
}

function Confirmation({ token, booking, fresh, onReschedule, onCancelled }: {
  token: string; booking: Booking; fresh: boolean; onReschedule: () => void; onCancelled: () => void;
}) {
  const base = `/api/expert/r/${encodeURIComponent(token)}`;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function cancel() {
    if (!window.confirm("Cancel this call?")) return;
    setBusy(true); setErr(null);
    try { await api(`${base}/cancel-booking`, { method: "POST" }); onCancelled(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not cancel. Please try again."); }
    finally { setBusy(false); }
  }
  return (
    <section role="status" className="space-y-6 border border-line-strong p-6">
      <header className="space-y-2">
        <Chip tone="ok" dot>{fresh ? "Booked" : "Scheduled"}</Chip>
        <h1 className="text-3xl font-semibold tracking-tight">{fullLabel(booking.startsAt)}</h1>
        <p className="text-sm text-muted">{booking.durationMin} minutes, {tz()}. A calendar invite is on its way to your email.</p>
      </header>
      <dl className="space-y-3 border-t border-line pt-4 text-sm">
        <div><dt className="text-subtle">Join link</dt>
          <dd><a href={booking.meetUrl} className="break-all text-accent-bright underline underline-offset-4" target="_blank" rel="noopener noreferrer">{booking.meetUrl}</a></dd></div>
        <div><dt className="text-subtle">Recording</dt>
          <dd>{booking.recordingConsent ? "You consented. We will confirm again at the start of the call." : "Not recorded. We will take written notes only."}</dd></div>
      </dl>
      <div className="flex flex-wrap items-center gap-4">
        <a href={`${base}/ics`} download="expert-call.ics" className="inline-flex h-11 items-center bg-accent px-6 text-[15px] font-medium text-white hover:bg-accent-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright">Add to calendar</a>
        <Button type="button" variant="outline" onClick={onReschedule}>Reschedule</Button>
        <Button type="button" variant="quiet" onClick={() => void cancel()} disabled={busy}>Cancel call</Button>
      </div>
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
    </section>
  );
}
