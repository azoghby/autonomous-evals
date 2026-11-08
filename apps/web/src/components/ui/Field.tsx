import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

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

/** Label + input/textarea wrapper with hint and error text. Styling comes from the `.input` class in globals.css. */
export function Field(props: FieldProps) {
  const { label, id, hint, error, className, multiline, ...rest } = props;
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  const shared = { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined };
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] leading-none text-fg-2">
        {label}
      </label>
      {multiline ? (
        <textarea rows={6} {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} {...shared} className="input" />
      ) : (
        <input {...(rest as InputHTMLAttributes<HTMLInputElement>)} {...shared} className="input" />
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-subtle">
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
