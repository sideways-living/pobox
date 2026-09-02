import type { MailPollerDependencies, MailPollerOptions, MailPollSummary } from "./types.js";

export class MailPoller {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly dependencies: MailPollerDependencies,
    private readonly options: MailPollerOptions
  ) {}

  async pollOnce(): Promise<MailPollSummary> {
    if (this.running) {
      this.options.logger?.warn("Mail poll skipped because a previous poll is still running.");
      return { scanned: 0, processed: 0, duplicates: 0, needsReview: 0, markedRead: 0 };
    }

    this.running = true;
    const summary: MailPollSummary = { scanned: 0, processed: 0, duplicates: 0, needsReview: 0, markedRead: 0 };
    try {
      const messages = await this.dependencies.provider.listUnreadMessages();
      summary.scanned = messages.length;

      for (const message of messages) {
        const result = await this.dependencies.store.processIncomingMail({
          workspaceId: this.options.workspaceId,
          provider: this.dependencies.provider.providerName,
          providerMessageId: message.providerMessageId,
          sender: message.sender,
          subject: message.subject,
          bodyPreview: message.bodyPreview,
          receivedAt: message.receivedAt
        });

        if (result.kind === "processed") {
          summary.processed += 1;
          await this.dependencies.provider.markMessageRead(message.providerMessageId);
          summary.markedRead += 1;
        } else if (result.kind === "duplicate") {
          summary.duplicates += 1;
          await this.dependencies.provider.markMessageRead(message.providerMessageId);
          summary.markedRead += 1;
        } else {
          summary.needsReview += 1;
        }
      }

      this.options.logger?.info(`Mail poll complete: ${JSON.stringify(summary)}`);
      return summary;
    } catch (error) {
      this.options.logger?.error(error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  start() {
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
