import SwiftUI

/// Account page in Settings: GitHub OAuth sign in/out.
struct AccountPage: View {
    @ObservedObject var brain: Brain
    @State private var isSigningIn = false
    @State private var errorMessage: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("GitHub Account").font(.system(size: 13, weight: .semibold))
                Text("Sign in to save your devices and settings to the cloud.")
                    .font(.system(size: 12)).foregroundStyle(Theme.secondary)
            }

            if let account = brain.userAccount {
                // Signed in
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(account.displayName)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Theme.primary)
                                if let email = account.email as String? {
                                    Text(email)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.secondary)
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(Theme.live)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.window))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border))
                    }

                    HStack {
                        PillButton(title: "Sign out", systemImage: "arrow.left.circle") {
                            Task {
                                await brain.signOutUser()
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .environment(\.compactPills, true)
                }
            } else {
                // Not signed in
                VStack(alignment: .leading, spacing: 12) {
                    Text("No account connected")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.secondary)
                        .padding(.vertical, 12)

                    HStack {
                        PillButton(title: "Sign in with GitHub", systemImage: "arrow.right.circle") {
                            signInWithGitHub()
                        }
                        Spacer(minLength: 0)
                    }
                    .environment(\.compactPills, true)
                }

                if let error = errorMessage {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.warn)
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.warn)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.warn.opacity(0.1)))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.warn.opacity(0.3)))
                }
            }

            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .topLeading)
    }

    private func signInWithGitHub() {
        isSigningIn = true
        errorMessage = nil

        Task {
            if let urlString = await brain.startUserSignIn(),
               let url = URL(string: urlString) {
                // Open browser for GitHub OAuth
                NSWorkspace.shared.open(url)

                // Start polling for callback on localhost
                await pollForCallback()
            } else {
                errorMessage = "Failed to start sign-in. Check your server connection."
                isSigningIn = false
            }
        }
    }

    private func pollForCallback() async {
        // The browser will redirect to: http://127.0.0.1:5173/auth/callback?token=XXX
        // We need to extract the token from the URL
        // For now, we'll show a dialog asking the user to paste the token

        let alert = NSAlert()
        alert.messageText = "Sign-in successful?"
        alert.informativeText = "Check your browser for the GitHub sign-in page. After authorizing, paste the token you receive here."
        alert.addButton(withTitle: "Paste token")
        alert.addButton(withTitle: "Cancel")

        let result = alert.runModal()
        if result == NSApplication.ModalResponse.alertFirstButtonReturn {
            // Get token from pasteboard
            if let token = NSPasteboard.general.string(forType: .string) {
                let error = await brain.completeUserSignIn(token)
                if let error = error {
                    errorMessage = error
                } else {
                    errorMessage = nil
                }
            } else {
                errorMessage = "No token found in clipboard"
            }
        }
        isSigningIn = false
    }
}

#Preview {
    AccountPage(brain: Brain())
        .frame(width: 600, height: 300)
}
