import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

export function ErrorState({ title = "Something went wrong", message, action }: { title?: string; message?: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 border-t border-danger/40 px-6 py-14 text-center">
      <span className="text-danger">
        <TriangleAlert size={22} aria-hidden />
      </span>
      <h3 className="text-lg font-medium text-fg">{title}</h3>
      {message && <p className="max-w-sm text-sm text-muted">{message}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
