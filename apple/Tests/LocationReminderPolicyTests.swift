import XCTest
@testable import MailboxShared

final class LocationReminderPolicyTests: XCTestCase {
    func testRequiresWaitingMail() {
        let policy = LocationReminderPolicy()
        let office = PostOffice(
            id: "po",
            name: "Melbourne GPO",
            address: "350 Bourke Street",
            phone: "+61 13 13 18",
            latitude: -37.8136,
            longitude: 144.9631,
            geofenceRadius: 200,
            active: true,
            mailboxes: [
                Mailbox(id: "box", postOfficeId: "office", name: "PO Box 1234", boxNumber: "1234", active: true, mailWaiting: false, parcelWaiting: false, latestNotificationAt: nil, latestParcelNotificationAt: nil, lastCollectedAt: nil, lastCollectedBy: nil)
            ]
        )
        XCTAssertFalse(policy.shouldPrompt(postOffice: office, now: Date(), lastPromptAt: nil))
    }

    func testAllowsParcelOnlyPrompt() {
        let policy = LocationReminderPolicy()
        let office = PostOffice(
            id: "po",
            name: "Melbourne GPO",
            address: "350 Bourke Street",
            phone: "+61 13 13 18",
            latitude: -37.8136,
            longitude: 144.9631,
            geofenceRadius: 200,
            active: true,
            mailboxes: [
                Mailbox(id: "box", postOfficeId: "office", name: "PO Box 1234", boxNumber: "1234", active: true, mailWaiting: false, parcelWaiting: true, latestNotificationAt: nil, latestParcelNotificationAt: "2026-09-03T02:30:00.000Z", lastCollectedAt: nil, lastCollectedBy: nil)
            ]
        )
        XCTAssertTrue(policy.shouldPrompt(postOffice: office, now: Date(), lastPromptAt: nil))
    }
}
