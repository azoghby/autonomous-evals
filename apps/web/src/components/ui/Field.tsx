import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

const control =
  "w-full rounded-md border border-line bg-white/[0.02] px-4 py-3 text-[15px] text-fg placeholder:text-subtle transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-bright aria-[invalid=true]:border-danger";

type FieldBase = {
  label: string;
  /** id for the control; required for label association. */
  id: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
};
type InputField = FieldBase & { multiline?: false } & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className">;
type TextareaField = FieldBase & { multiline: true } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "className">;
export type FieldProps = InputField | TextareaField;

/** Label + input/textarea wrapper with hint and error text. */
export function Field(props: FieldProps) {
  const { label, id, hint, error, className, multiline, ...rest } = props;
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  const shared = { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined };
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      {multiline ? (
        <textarea
          rows={6}
          {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
          {...shared}
          className={cn(control, "min-h-28 resize-y")}
        />
      ) : (
        <input {...(rest as InputHTMLAttributes<HTMLInputElement>)} {...shared} className={control} />
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-fg/60">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
