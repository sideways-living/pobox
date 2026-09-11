import XCTest
import CryptoKit
@testable import PoboxWatchShared

final class NativeSignInProofTests: XCTestCase {
    func testEachSignInHasUniqueURLSafeProof() {
        let first = NativeSignInProof()
        let second = NativeSignInProof()
        XCTAssertNotEqual(first.verifier, second.verifier)
        XCTAssertEqual(first.verifier.count, 43)
        XCTAssertEqual(first.challenge.count, 43)
        XCTAssertNotNil(first.challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression))
        let expected = Data(SHA256.hash(data: Data(first.verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(first.challenge, expected)
    }
}
