import SwiftUI

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

public enum PoboxTheme {
    public static let blue = Color(red: 0.52, green: 0.12, blue: 0.62)
    public static let green = Color(red: 0.15, green: 0.62, blue: 0.31)
    public static let orange = Color(red: 0.91, green: 0.38, blue: 0.12)
    public static let ink = Color(red: 0.08, green: 0.14, blue: 0.18)
    public static let sky = Color(red: 0.91, green: 0.97, blue: 0.92)

    #if os(iOS)
    public static let pageBackground = Color(uiColor: .systemGroupedBackground)
    public static let surface = Color(uiColor: .secondarySystemGroupedBackground)
    public static let border = Color(uiColor: .separator).opacity(0.45)
    #elseif os(macOS)
    public static let pageBackground = Color(nsColor: .windowBackgroundColor)
    public static let surface = Color(nsColor: .controlBackgroundColor)
    public static let border = Color(nsColor: .separatorColor).opacity(0.55)
    #else
    public static let pageBackground = Color.primary.opacity(0.035)
    public static let surface = Color.primary.opacity(0.06)
    public static let border = Color.primary.opacity(0.14)
    #endif
}

public struct PasswordSettingsView: View {
    @State private var current = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var message = ""
    @State private var busy = false
    @State private var completed = false
    private let onChanged: () async -> Void
    public init(onChanged: @escaping () async -> Void) { self.onChanged = onChanged }
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Change Password", systemImage: "lock.rotation")
                .font(.headline)
                .foregroundStyle(.primary)
            SecureField("Current password", text: $current)
            SecureField("New password", text: $password)
            SecureField("Confirm new password", text: $confirmation)
            Text("Use at least 12 characters. Passkeys and two-factor authentication stay enabled.").font(.caption).foregroundStyle(.secondary)
            if !message.isEmpty { Text(message).font(.callout).accessibilityLabel(message) }
            if completed {
                Button("Return to Sign In") { Task { await onChanged() } }
            } else {
                Button(busy ? "Updating..." : "Update Password") {
                    guard password == confirmation else { message = "Passwords do not match."; return }
                    busy = true
                    Task {
                        do {
                            try await PoboxWatchAPIClient.live.changePassword(current: current, password: password)
                            current = ""; password = ""; confirmation = ""
                            completed = true; message = "Password updated. Sign in again."
                        } catch { message = error.localizedDescription }
                        busy = false
                    }
                }.disabled(busy || current.isEmpty || password.count < 12 || password.count > 200)
                    .buttonStyle(.borderedProminent)
            }
            Link("Forgot Password?", destination: URL(string: "https://pobox.watch/?forgot-password=1")!)
        }
        .textFieldStyle(.roundedBorder)
        .tint(PoboxTheme.blue)
    }
}
