"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { IconExpand, IconX } from "@/components/chat/icons";
import { NovaChat } from "@/components/chat/NovaChat";
import { NOVA, NovaAvatar } from "@/components/chat/NovaAvatar";

/** "Ask Nova" card on /sandbox/new: opens the chat in a modal drawer (a full-height sheet on phones). */
export function OnboardingChat() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <section aria-labelledby="nv-launch-h" className="nv-launch">
      <NovaAvatar size={40} />
      <div>
        <b id="nv-launch-h">Rather talk it through? Ask {NOVA.name}.</b>
        <p>{NOVA.name} collects what the run needs, builds the sandbox and reports back here, step by step.</p>
      </div>
      <div className="nv-launch-actions">
        <button ref={openerRef} type="button" className="nv-btn" data-v="primary" aria-haspopup="dialog" onClick={() => setOpen(true)}>Chat with {NOVA.name}</button>
        <Link href="/chat" className="nv-btn" data-v="ghost">Full page</Link>
      </div>
      <dialog
        ref={dialogRef} className="nv-drawer" aria-labelledby="nv-drawer-h"
        onClose={() => { setOpen(false); openerRef.current?.focus(); }}
        onClick={(e) => { if (e.target === dialogRef.current) setOpen(false); }}
      >
        {open && (
          <div className="nv-drawer-inner">
            <header className="nv-drawer-head">
              <NovaAvatar size={28} />
              <div>
                <b id="nv-drawer-h">{NOVA.name}</b>
                <span>{NOVA.role}</span>
              </div>
              <nav aria-label="Chat window">
                <Link href="/chat" className="nv-icon-btn" aria-label="Open the full chat page" title="Full page"><IconExpand /></Link>
                <button type="button" className="nv-icon-btn" aria-label="Close chat" onClick={() => setOpen(false)}><IconX /></button>
              </nav>
            </header>
            <NovaChat variant="panel" />
          </div>
        )}
      </dialog>
    </section>
  );
}
