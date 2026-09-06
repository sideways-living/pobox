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

  it("deterministically parses Mail2Day PO Box 3020 subjects", () => {
    const box3020 = { ...mailbox, id: "box_3020", name: "PO Box 3020", boxNumber: "3020" };
    const parsed = parseMailNotification({ sender: "mail2day@example.com", subject: "Mail2Day: PO Box 3020 has mail" }, [box3020]);

    expect(parsed).toEqual({
      mailboxNumber: "3020",
      mailboxId: "box_3020",
      notificationType: "MAIL",
      confidence: 1,
      requiresReview: false,
      ruleId: "mail2day-subject-box-number-v1"
    });
  });

  it("matches saved boxes that include a PO Box prefix", () => {
    const prefixedBox = { ...mailbox, id: "box_229", name: "PO Box 229", boxNumber: "PO Box 229" };
    const parsed = parseMailNotification({ sender: "mailroom@example.com", subject: "Mail2Day: PO Box 229 has mail" }, [prefixedBox]);

    expect(parsed).toMatchObject({
      requiresReview: false,
      mailboxId: "box_229",
      mailboxNumber: "229",
      notificationType: "MAIL",
      confidence: 1
    });
  });

  it("requires review when the same box number exists at multiple active post offices", () => {
    const firstBox = { ...mailbox, id: "box_229_a", postOfficeId: "po_a", name: "PO Box 229", boxNumber: "229" };
    const secondBox = { ...mailbox, id: "box_229_b", postOfficeId: "po_b", name: "PO Box 229", boxNumber: "229" };
    const parsed = parseMailNotification({ sender: "mailroom@example.com", subject: "Mail2Day: PO Box 229 has mail" }, [firstBox, secondBox]);

    expect(parsed).toMatchObject({
      requiresReview: true,
      mailboxNumber: "229",
      notificationType: "MAIL",
      confidence: 0.7
    });
    expect(parsed.mailboxId).toBeUndefined();
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

  it("deterministically parses plain-text parcel pickup collect-from bodies", () => {
    const parsed = parseMailNotification(
      {
        sender: "parcel@example.com",
        subject: "Your PO Box item is ready to collect",
        bodyPreview: "Collect from: SOUTH MELBOURNE"
      },
      [mailbox],
      [postOffice]
    );

    expect(parsed).toMatchObject({
      requiresReview: false,
      mailboxId: "box_1234",
      mailboxNumber: "1234",
      notificationType: "PARCEL",
      confidence: 0.92,
      postOfficeName: "SOUTH MELBOURNE",
      ruleId: "deterministic-parcel-collect-from-v1"
    });
  });

  it("deterministically parses HTML parcel pickup collect-from bodies", () => {
    const parsed = parseMailNotification(
      {
        sender: "parcel@example.com",
        subject: "Your PO Box item is ready to collect",
        bodyPreview: "<table><tr><td>Collect from:</td><td><strong>SOUTH MELBOURNE</strong></td></tr></table>"
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

  it("matches parcel pickup notices across duplicate normalized post office names when only one box is active", () => {
    const secondOffice = { ...postOffice, id: "po_2", name: "SOUTH MELBOURNE POST OFFICE" };
    const parsed = parseMailNotification(
      {
        sender: "parcel@example.com",
        subject: "Your PO Box item is ready to collect",
        bodyPreview: "Collect from: SOUTH MELBOURNE"
      },
      [mailbox],
      [secondOffice, postOffice]
    );

    expect(parsed).toMatchObject({
      requiresReview: false,
      mailboxId: "box_1234",
      notificationType: "PARCEL",
      postOfficeName: "SOUTH MELBOURNE"
    });
  });

  it("requires review for parcel pickup notices when a post office has multiple active boxes", () => {
    const secondMailbox = { ...mailbox, id: "box_5678", name: "PO Box 5678", boxNumber: "5678" };
    const parsed = parseMailNotification(
      {
        sender: "parcel@example.com",
        subject: "Your PO Box item is ready to collect",
        bodyPreview: "Collect from: SOUTH MELBOURNE"
      },
      [mailbox, secondMailbox],
      [postOffice]
    );

    expect(parsed).toMatchObject({
      requiresReview: true,
      notificationType: "PARCEL",
      postOfficeName: "SOUTH MELBOURNE",
      confidence: 0.65
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
