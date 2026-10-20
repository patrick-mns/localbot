import SwiftUI
import Sparkle

/// In-app updates through Sparkle. The feed is `appcast.xml` on the latest
/// GitHub release, and every update must carry an EdDSA signature that matches
/// `SUPublicEDKey` in Info.plist: the private key never goes to GitHub, so a
/// release someone else published can't install itself.
///
/// Sparkle shows its own window when it finds an update; the sidebar banner
/// keeps the nudge after "Later". Dev builds (no bundle) don't check.
@MainActor
final class Updater: NSObject, ObservableObject, SPUUpdaterDelegate {
    static let shared = Updater()

    /// Version of an update Sparkle found and verified, if any.
    @Published private(set) var available: String?

    private var controller: SPUStandardUpdaterController?

    /// Only a bundled app has the feed and key; `swift run` has neither.
    var enabled: Bool { Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") != nil }

    func start() {
        guard enabled, controller == nil else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }

    /// Shows Sparkle's window: the update found, or "you're up to date".
    func checkForUpdates() {
        controller?.checkForUpdates(nil)
    }

    /// GitHub redirects the feed to a fresh asset URL on each release, but the
    /// redirect gets cached and the app keeps reading the previous appcast.
    /// A unique query makes every check go to GitHub.
    nonisolated func feedURLString(for updater: SPUUpdater) -> String? {
        guard let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String else { return nil }
        return feed + "?t=\(Int(Date().timeIntervalSince1970))"
    }

    nonisolated func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        let version = item.displayVersionString
        Task { @MainActor in self.available = version }
    }

    /// Sparkle's "Install and Relaunch" asks the app to quit, and AppKit
    /// refuses while a sheet (Settings, where "Check for updates" is) is open,
    /// so the install waited forever. Sparkle asks here first: close the
    /// sheets, allow quitting past the menu bar (which otherwise only hides
    /// the window), then let it go on.
    nonisolated func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                             untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        DispatchQueue.main.async {
            MenuBar.quitting = true
            MenuBar.closeSheets(then: installHandler)
        }
        return true
    }

    /// Updates installed on quit relaunch without asking first.
    nonisolated func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
        DispatchQueue.main.async { MenuBar.quitting = true }
    }

    nonisolated func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        Task { @MainActor in self.available = nil }
    }
}

/// The sidebar's standing nudge while an update is available.
struct UpdateBanner: View {
    let version: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.down.circle.fill").foregroundStyle(Theme.live)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Update available").font(.system(size: 12, weight: .semibold))
                    Text("Version \(version) · Install").font(.system(size: 11)).foregroundStyle(Theme.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 10).fill(hovering ? Theme.raised : Theme.surface))
            .hairline(10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
