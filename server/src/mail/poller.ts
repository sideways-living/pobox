import type { MailPollerDependencies, MailPollerOptions, MailPollSummary } from "./types.js";
import { MailAuthenticationError, safeMailError } from "./retry.js";

export class MailPoller {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly dependencies: MailPollerDependencies,
    private readonly options: MailPollerOptions
  ) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1000 || options.intervalMs > 2147483647) {
      throw new Error("Mail poll interval must be between 1000 and 2147483647 milliseconds.");
    }
  }

  async pollOnce(): Promise<MailPollSummary> {
    if (this.running) {
      this.options.logger?.warn("Mail poll skipped because a previous poll is still running.");
      return { scanned: 0, processed: 0, duplicates: 0, needsReview: 0, markedRead: 0, failed: 0 };
    }

    this.running = true;
    const summary: MailPollSummary = { scanned: 0, processed: 0, duplicates: 0, needsReview: 0, markedRead: 0, failed: 0 };
    const { store, provider } = this.dependencies;
    const { workspaceId } = this.options;
    const attempted = new Set<string>();
    const flushAcknowledgements = async () => {
      for (const id of await store.pendingMailAcknowledgements(workspaceId, provider.providerName)) {
        if (attempted.has(id)) continue;
        attempted.add(id);
        try {
          await provider.markMessageRead(id);
          await store.acknowledgeMail(workspaceId, provider.providerName, id);
          summary.markedRead += 1;
        } catch (error) {
          summary.failed += 1;
          const reason = safeMailError(error);
          await store.failMailAcknowledgement(workspaceId, provider.providerName, id, reason);
          this.options.logger?.error(reason);
          if (error instanceof MailAuthenticationError) throw error;
        }
      }
    };
    try {
      // Committed acknowledgements survive restarts and unread-query changes.
      await flushAcknowledgements();
      const messages = await this.dependencies.provider.listUnreadMessages();
      summary.scanned = messages.length;

      for (const message of messages) {
        if (attempted.has(message.providerMessageId)) {
          summary.duplicates += 1;
          continue;
        }
        try {
          const result = await store.processIncomingMail({ workspaceId, provider: provider.providerName, ...message });
          if (result.kind === "processed") summary.processed += 1;
          else if (result.kind === "duplicate") summary.duplicates += 1;
          else summary.needsReview += 1;
        } catch (error) {
          summary.failed += 1;
          this.options.logger?.error(safeMailError(error));
        }
      }

      await flushAcknowledgements();

      this.options.logger?.info(`Mail poll complete: ${JSON.stringify(summary)}`);
      return summary;
    } catch (error) {
      this.options.logger?.error(safeMailError(error));
      throw error;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    void this.pollOnce().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, this.options.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
