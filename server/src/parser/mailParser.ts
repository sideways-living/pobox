import type { Mailbox, ParsedMailNotification } from "../domain.js";

const mailboxPattern =
  /\b(?:p\.?\s*o\.?\s*box|pobox|post\s*box|postbox|box)\s*([a-z0-9-]{2,12})\b/i;

export interface IncomingMailInput {
  sender: string;
  subject: string;
  bodyPreview?: string;
}

export function parseMailNotification(input: IncomingMailInput, mailboxes: Mailbox[]): ParsedMailNotification {
  const haystack = `${input.subject}\n${input.bodyPreview ?? ""}`;
  const match = haystack.match(mailboxPattern);
  if (!match) {
    return { confidence: 0, requiresReview: true };
  }

  const mailboxNumber = normalizeBoxNumber(match[1]);
  const mailbox = mailboxes.find((box) => normalizeBoxNumber(box.boxNumber) === mailboxNumber && box.active);
  if (!mailbox) {
    return { mailboxNumber, confidence: 0.55, requiresReview: true };
  }

  return {
    mailboxNumber,
    mailboxId: mailbox.id,
    confidence: 0.96,
    requiresReview: false,
    ruleId: "deterministic-box-number-v1"
  };
}

export function normalizeBoxNumber(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}
