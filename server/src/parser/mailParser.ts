import type { Mailbox, PostOffice, ParsedMailNotification } from "../domain.js";
import { mailText } from "./mailText.js";

const mailboxPattern =
  /\b(?:p\.?\s*o\.?\s*box|pobox|post\s*box|postbox|box)\s*#?\s*([a-z0-9-]{1,12})(?![a-z0-9-])/gi;
const mail2DaySubjectPattern = /^mail2day\s*[:\-]\s*p\.?\s*o\.?\s*box\s*#?\s*([a-z0-9-]{1,12})\s+has\s+mail[.!]?$/i;
const parcelSubjectPattern = /^your\s+p\.?\s*o\.?\s*box\s+item\s+is\s+ready\s+to\s+collect[.!]?$/i;

export interface IncomingMailInput {
  sender: string;
  subject: string;
  bodyPreview?: string;
}

export function parseMailNotification(input: IncomingMailInput, mailboxes: Mailbox[], postOffices: PostOffice[] = []): ParsedMailNotification {
  const subject = mailText(input.subject).replace(/\s+/g, " ");
  const haystack = `${subject}\n${mailText(input.bodyPreview ?? "")}`;
  if (parcelSubjectPattern.test(subject)) {
    return parseParcelNotification(input, mailboxes, postOffices);
  }

  const mail2DayMatch = subject.match(mail2DaySubjectPattern);
  const candidates = [...haystack.matchAll(mailboxPattern)];
  const match = mail2DayMatch ?? candidates[0];
  if (!mail2DayMatch && new Set(candidates.map((candidate) => normalizeBoxNumber(candidate[1]))).size > 1) {
    return { notificationType: "MAIL", confidence: 0, requiresReview: true };
  }
  if (!match) {
    return { notificationType: "MAIL", confidence: 0, requiresReview: true };
  }

  const mailboxNumber = normalizeBoxNumber(match[1]);
  const matchingMailboxes = mailboxes.filter((box) => normalizeBoxNumber(box.boxNumber) === mailboxNumber && box.active &&
    (!postOffices.length || postOffices.some((office) => office.id === box.postOfficeId && office.active)));
  if (matchingMailboxes.length === 0) {
    return { mailboxNumber, notificationType: "MAIL", confidence: 0.55, requiresReview: true };
  }
  if (matchingMailboxes.length > 1) {
    return { mailboxNumber, notificationType: "MAIL", confidence: 0.7, requiresReview: true };
  }

  return {
    mailboxNumber,
    mailboxId: matchingMailboxes[0].id,
    notificationType: "MAIL",
    confidence: mail2DayMatch ? 1 : 0.96,
    requiresReview: false,
    ruleId: mail2DayMatch ? "mail2day-subject-box-number-v1" : "deterministic-box-number-v1"
  };
}

export function normalizeBoxNumber(value: string): string {
  return value.replace(/^\s*(?:p\.?\s*o\.?\s*box|pobox|post\s*box|postbox|box)\s*/i, "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function parseParcelNotification(input: IncomingMailInput, mailboxes: Mailbox[], postOffices: PostOffice[]): ParsedMailNotification {
  const destinations = extractCollectFrom(input.bodyPreview ?? "");
  const collectFrom = destinations[0];
  if (!collectFrom) {
    return { notificationType: "PARCEL", confidence: 0.35, requiresReview: true };
  }

  const matchingPostOffices = postOffices.filter((office) => normalizeLocationName(office.name) === normalizeLocationName(collectFrom) && office.active);
  if (new Set(destinations.map(normalizeLocationName)).size !== 1 || matchingPostOffices.length !== 1) {
    return { postOfficeName: collectFrom, notificationType: "PARCEL", confidence: 0.55, requiresReview: true };
  }

  const matchingPostOfficeIds = new Set(matchingPostOffices.map((office) => office.id));
  const activeBoxes = mailboxes.filter((box) => matchingPostOfficeIds.has(box.postOfficeId) && box.active);
  if (activeBoxes.length !== 1) {
    return { postOfficeName: collectFrom, notificationType: "PARCEL", confidence: activeBoxes.length > 1 ? 0.65 : 0.55, requiresReview: true };
  }

  return {
    postOfficeName: matchingPostOffices.find((office) => office.id === activeBoxes[0].postOfficeId)?.name ?? collectFrom,
    mailboxNumber: activeBoxes[0].boxNumber,
    mailboxId: activeBoxes[0].id,
    notificationType: "PARCEL",
    confidence: 0.92,
    requiresReview: false,
    ruleId: "deterministic-parcel-collect-from-v1"
  };
}

function extractCollectFrom(bodyPreview: string): string[] {
  const text = mailText(bodyPreview);
  return [...text.matchAll(/\bcollect\s+from\s*:\s*[|*\s]*([^\n|]+)/gi)]
    .map((match) => match[1].replace(/\*+/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function normalizeLocationName(value: string): string {
  return value.normalize("NFKC").toUpperCase()
    .replace(/[.'\u2019]/g, "").replace(/[^A-Z0-9]+/g, " ").trim()
    .replace(/^AUSTRALIA POST\s+/, "")
    .replace(/\s+(?:(?:LOCAL|LICENSED|LICENCED)\s+)?POST OFFICE$/, "")
    .replace(/\s+(?:LPO|GPO|PO)$/, "").trim();
}
