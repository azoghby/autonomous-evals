import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 border-t border-line-2 px-6 py-14 text-center">
      <span className="text-fg/45">
        {icon ?? <Inbox size={22} aria-hidden />}
      </span>
      <h3 className="text-lg font-normal text-fg">{title}</h3>
      {description && <p className="max-w-sm text-sm text-fg/60">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
