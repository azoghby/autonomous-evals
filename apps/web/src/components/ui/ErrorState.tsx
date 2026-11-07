import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { GlassCard } from "./GlassCard";

export function ErrorState({ title = "Something went wrong", message, action }: { title?: string; message?: ReactNode; action?: ReactNode }) {
  return (
    <GlassCard role="alert" className="flex flex-col items-center gap-3 border-coral/40 px-6 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-coral/15 text-coral">
        <TriangleAlert size={22} aria-hidden />
      </span>
      <h3 className="text-lg font-medium text-cream">{title}</h3>
      {message && <p className="max-w-sm text-sm text-cream/65">{message}</p>}
      {action && <div className="mt-2">{action}</div>}
    </GlassCard>
  );
}
