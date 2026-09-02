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
  parcelWaiting: false,
  updatedAt: new Date().toISOString()
} satisfies Mailbox;

const postOffice = {
  id: "po",
  workspaceId: "ws",
  name: "SOUTH MELBOURNE",
  address: "South Melbourne VIC",
  latitude: -37.832,
  longitude: 144.957,
  geofenceRadius: 200,
  active: true
};

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

  it("treats exact Mail2Day subjects for saved boxes as fully confident", () => {
    const box229 = { ...mailbox, id: "box_229", name: "PO Box 229", boxNumber: "229" };
    const parsed = parseMailNotification({ sender: "mailroom@example.com", subject: "Mail2Day: PO Box 229 has mail" }, [box229]);
    expect(parsed).toMatchObject({
      requiresReview: false,
      mailboxId: "box_229",
      mailboxNumber: "229",
      notificationType: "MAIL",
      confidence: 1,
      ruleId: "mail2day-subject-box-number-v1"
    });
  });

  it("matches parcel pickup notices by collect-from post office", () => {
    const parsed = parseMailNotification(
      {
        sender: "mailroom@example.com",
        subject: "Your PO Box item is ready to collect",
        bodyPreview: "| Collect from: | **SOUTH MELBOURNE ** |"
      },
      [mailbox],
      [postOffice]
    );
    expect(parsed).toMatchObject({
      requiresReview: false,
      mailboxId: "box_1234",
      notificationType: "PARCEL",
      postOfficeName: "SOUTH MELBOURNE"
    });
  });

  it("requires review when a parcel pickup location has no saved box", () => {
    const parsed = parseMailNotification(
      {
        sender: "mailroom@example.com",
        subject: "Your PO Box item is ready to collect",
        bodyPreview: "| Collect from: | **SOUTH MELBOURNE ** |"
      },
      [],
      [postOffice]
    );
    expect(parsed).toMatchObject({
      requiresReview: true,
      notificationType: "PARCEL",
      postOfficeName: "SOUTH MELBOURNE"
    });
  });
});
