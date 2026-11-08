/** Customer-facing replacement for jobs.error (raw text may contain internals). Operators see the raw value. */
export const GENERIC_JOB_ERROR = "Something went wrong on our side; an operator has been notified.";

export function publicJobError(error: string | null | undefined, isOperator: boolean): string | null {
  if (error == null || error === "") return null;
  return isOperator ? error : GENERIC_JOB_ERROR;
}
