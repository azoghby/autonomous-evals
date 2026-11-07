import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { GlassCard } from "./GlassCard";

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <GlassCard className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-full border border-glass-border bg-glass text-cream/70">
        {icon ?? <Inbox size={22} aria-hidden />}
      </span>
      <h3 className="text-lg font-medium text-cream">{title}</h3>
      {description && <p className="max-w-sm text-sm text-cream/60">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </GlassCard>
  );
}
