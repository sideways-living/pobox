import type { Mailbox, PostOffice, ParsedMailNotification } from "../domain.js";

const mailboxPattern =
  /\b(?:p\.?\s*o\.?\s*box|pobox|post\s*box|postbox|box)\s*([a-z0-9-]{2,12})\b/i;
const parcelSubjectPattern = /^your po box item is ready to collect$/i;
const collectFromPattern = /collect\s+from:\s*\|?\s*\*{0,2}\s*([A-Z][A-Z\s'.-]{2,80}?)(?:\s*\*{0,2}\s*(?:\n|\r|$|\|))/i;

export interface IncomingMailInput {
  sender: string;
  subject: string;
  bodyPreview?: string;
}

export function parseMailNotification(input: IncomingMailInput, mailboxes: Mailbox[], postOffices: PostOffice[] = []): ParsedMailNotification {
  const haystack = `${input.subject}\n${input.bodyPreview ?? ""}`;
  if (parcelSubjectPattern.test(input.subject.trim())) {
    return parseParcelNotification(input, mailboxes, postOffices);
  }

  const match = haystack.match(mailboxPattern);
  if (!match) {
    return { notificationType: "MAIL", confidence: 0, requiresReview: true };
  }

  const mailboxNumber = normalizeBoxNumber(match[1]);
  const mailbox = mailboxes.find((box) => normalizeBoxNumber(box.boxNumber) === mailboxNumber && box.active);
  if (!mailbox) {
    return { mailboxNumber, notificationType: "MAIL", confidence: 0.55, requiresReview: true };
  }

  return {
    mailboxNumber,
    mailboxId: mailbox.id,
    notificationType: "MAIL",
    confidence: 0.96,
    requiresReview: false,
    ruleId: "deterministic-box-number-v1"
  };
}

export function normalizeBoxNumber(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function parseParcelNotification(input: IncomingMailInput, mailboxes: Mailbox[], postOffices: PostOffice[]): ParsedMailNotification {
  const collectFrom = extractCollectFrom(input.bodyPreview ?? "");
  if (!collectFrom) {
    return { notificationType: "PARCEL", confidence: 0.35, requiresReview: true };
  }

  const postOffice = postOffices.find((office) => normalizeLocationName(office.name) === normalizeLocationName(collectFrom) && office.active);
  if (!postOffice) {
    return { postOfficeName: collectFrom, notificationType: "PARCEL", confidence: 0.55, requiresReview: true };
  }

  const activeBoxes = mailboxes.filter((box) => box.postOfficeId === postOffice.id && box.active);
  if (activeBoxes.length !== 1) {
    return { postOfficeName: postOffice.name, notificationType: "PARCEL", confidence: activeBoxes.length > 1 ? 0.65 : 0.55, requiresReview: true };
  }

  return {
    postOfficeName: postOffice.name,
    mailboxNumber: activeBoxes[0].boxNumber,
    mailboxId: activeBoxes[0].id,
    notificationType: "PARCEL",
    confidence: 0.92,
    requiresReview: false,
    ruleId: "deterministic-parcel-collect-from-v1"
  };
}

function extractCollectFrom(bodyPreview: string): string | undefined {
  const match = bodyPreview.match(collectFromPattern);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}

function normalizeLocationName(value: string): string {
  return value.replace(/\b(?:post\s+office|po)\b/gi, "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}
