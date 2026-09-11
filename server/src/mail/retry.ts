import { setTimeout as delay } from "node:timers/promises";

export class MailAuthenticationError extends Error {
  constructor() { super("Gmail authorization failed. Reconnect the Gmail account; pending messages have been retained."); }
}

function details(error: unknown) {
  const value = error as { code?: string | number; response?: { status?: number; data?: { error?: string | { errors?: Array<{ reason?: string }> } } } } | null;
  const status = value?.response?.status ?? (typeof value?.code === "number" ? value.code : undefined);
  const providerError = value?.response?.data?.error;
  return { status, code: value?.code, providerError };
}

export function safeMailError(error: unknown) {
  if (error instanceof MailAuthenticationError) return error.message;
  const { status } = details(error);
  return status ? `Mail operation failed (HTTP ${status}); it will be retried.` : "Mail operation failed; pending work has been retained for retry.";
}

export async function withMailRetry<T>(operation: () => Promise<T>, sleep: (ms: number) => Promise<unknown> = delay): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const { status, code, providerError } = details(error);
      if (status === 401 || providerError === "invalid_grant") throw new MailAuthenticationError();
      const rateLimited = typeof providerError === "object" && providerError?.errors?.some((item) => ["rateLimitExceeded", "userRateLimitExceeded"].includes(item.reason ?? ""));
      const transient = status === 429 || status === 408 || (status !== undefined && status >= 500)
        || rateLimited || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(String(code));
      if (!transient || attempt >= 2) throw error;
      await sleep(250 * 2 ** attempt);
    }
  }
}
