import XCTest
@testable import PoboxWatchShared

final class LocationReminderPolicyTests: XCTestCase {
    func testMapLinksPreserveCoordinateOrderAndFallbackToAddress() {
        let url = postOfficeMapsURL(name: "South Melbourne", address: "181 Clarendon St", latitude: -37.832, longitude: 144.96)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(items.first { $0.name == "ll" }?.value, "-37.832,144.96")
        let invalid = postOfficeMapsURL(name: "Office", address: "Melbourne VIC", latitude: 190, longitude: 145)
        let fallback = URLComponents(url: invalid, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertNil(fallback.first { $0.name == "ll" })
        XCTAssertEqual(fallback.first { $0.name == "q" }?.value, "Office Melbourne VIC")
    }

    func testReleaseNoticeDecodesSharedAPIResponse() throws {
        let data = Data(#"{"version":"0.13.8","lastSeenVersion":null,"changes":[{"id":"new","title":"Maps","summary":"Better location links","audience":"ALL"}]}"#.utf8)
        let notice = try JSONDecoder().decode(ReleaseNotice.self, from: data)
        XCTAssertEqual(notice.changes.first?.title, "Maps")
    }
    func testRequiresWaitingMail() {
        let policy = LocationReminderPolicy()
        let office = PostOffice(updatedAt: nil,
            id: "po",
            name: "Melbourne GPO",
            address: "350 Bourke Street",
            phone: "+61 13 13 18",
            latitude: -37.8136,
            longitude: 144.9631,
            geofenceRadius: 200,
            active: true,
            mailboxes: [
                Mailbox(updatedAt: nil, id: "box", postOfficeId: "office", name: "PO Box 1234", boxNumber: "1234", active: true, mailWaiting: false, parcelWaiting: false, latestNotificationAt: nil, latestParcelNotificationAt: nil, lastCollectedAt: nil, lastCollectedBy: nil)
            ]
        )
        XCTAssertFalse(policy.shouldPrompt(postOffice: office, now: Date(), lastPromptAt: nil))
    }

    func testAllowsParcelOnlyPrompt() {
        let policy = LocationReminderPolicy()
        let office = PostOffice(updatedAt: nil,
            id: "po",
            name: "Melbourne GPO",
            address: "350 Bourke Street",
            phone: "+61 13 13 18",
            latitude: -37.8136,
            longitude: 144.9631,
            geofenceRadius: 200,
            active: true,
            mailboxes: [
                Mailbox(updatedAt: nil, id: "box", postOfficeId: "office", name: "PO Box 1234", boxNumber: "1234", active: true, mailWaiting: false, parcelWaiting: true, latestNotificationAt: nil, latestParcelNotificationAt: "2026-09-03T02:30:00.000Z", lastCollectedAt: nil, lastCollectedBy: nil)
            ]
        )
        XCTAssertTrue(policy.shouldPrompt(postOffice: office, now: Date(), lastPromptAt: nil))
    }
}
