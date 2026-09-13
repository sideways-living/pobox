import SwiftUI

public enum PoboxTheme {
    public static let blue = Color(red: 0.02, green: 0.43, blue: 0.68)
    public static let green = Color(red: 0.06, green: 0.47, blue: 0.24)
    public static let orange = Color(red: 0.72, green: 0.35, blue: 0)
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
            Text("Change Password").font(.headline)
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
            }
            Link("Forgot Password?", destination: URL(string: "https://pobox.watch/?forgot-password=1")!)
        }
        .textFieldStyle(.roundedBorder)
        .tint(PoboxTheme.blue)
    }
}
