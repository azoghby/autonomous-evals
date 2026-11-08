export class FatalError extends Error {}
export class RetryableError extends Error { constructor(message: string, readonly options: { retryAfter: number }) { super(message); } }
