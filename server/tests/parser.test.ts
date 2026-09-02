import { describe, expect, it } from "vitest";
import type { Mailbox } from "../src/domain.js";
import { parseMailNotification } from "../src/parser/mailParser.js";

const mailbox = {
  id: "box_1234",
  workspaceId: "ws",
  postOfficeId: "po",
  name: "PO Box 1234",
  boxNumber: "1234",
  active: true,
  mailWaiting: false,
  updatedAt: new Date().toISOString()
} satisfies Mailbox;

describe("mail parser", () => {
  it.each([
    "There is mail in PO Box 1234",
    "Mail has been received in P.O. Box 1234",
    "Mail2Day: PO Box 1234 has mail.",
    "POBOX 1234 has mail",
    "Post Box 1234 ready",
    "Postbox 1234 waiting",
    "Box 1234 notification"
  ])("matches %s", (subject) => {
    const parsed = parseMailNotification({ sender: "mailroom@example.com", subject }, [mailbox]);
    expect(parsed.requiresReview).toBe(false);
    expect(parsed.mailboxId).toBe("box_1234");
  });

  it("requires review for unknown boxes", () => {
    const parsed = parseMailNotification({ sender: "mailroom@example.com", subject: "Mail waiting in PO Box AB142" }, [mailbox]);
    expect(parsed.requiresReview).toBe(true);
    expect(parsed.mailboxNumber).toBe("AB142");
  });
});
