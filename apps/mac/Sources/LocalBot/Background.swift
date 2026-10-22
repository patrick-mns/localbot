import SwiftUI
import AppKit
import UserNotifications
import Combine

/// The brain as a launchd agent, so routines run while Local Bot is closed.
/// The agent runs the app's bundled Node and brain with `--service`; it waits
/// while the app's own brain runs and takes over when the app quits (see
/// brain/src/index.ts). Only the packaged app can install it.
@MainActor
enum BackgroundService {
    static let label = "io.github.patrick-mns.localbot.brain"
    /// Opens the app in the menu bar at login (the service alone has no icon).
    static let appLabel = "io.github.patrick-mns.localbot.app"

    static var plistURL: URL { agentURL(label) }

    private static func agentURL(_ label: String) -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    /// Bundled Node and brain; nil when running from source.
    private static var runtime: (node: URL, brain: URL)? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let node = res.appendingPathComponent("node"), brain = res.appendingPathComponent("brain/brain.mjs")
        let fm = FileManager.default
        return fm.fileExists(atPath: node.path) && fm.fileExists(atPath: brain.path) ? (node, brain) : nil
    }

    static var available: Bool { runtime != nil }
    static var installed: Bool { FileManager.default.fileExists(atPath: plistURL.path) }

    private static var domain: String { "gui/\(getuid())" }

    static func install() throws {
        guard let runtime, let executable = Bundle.main.executableURL else { return }
        let path = ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin",
                    "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        var environment = [
            "PATH": path,
            "NODE_NO_WARNINGS": "1",
            // With no app open, the service posts notifications through the app.
            "LOCALBOT_APP_EXECUTABLE": executable.path,
        ]
        if let deviceRuntime = Brain.deviceRuntimeURL { environment["LOCALBOT_RUNTIME"] = deviceRuntime.path }
        let plist: [String: Any] = [
            "Label": label,
            "ProgramArguments": [runtime.node.path, runtime.brain.path, "--service"],
            "EnvironmentVariables": environment,
            "RunAtLoad": true,
            "KeepAlive": true,
            "ProcessType": "Background",
            "StandardErrorPath": Brain.logURL.path,
        ]
        try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: plistURL)
        launchctl("bootout", "\(domain)/\(label)")
        launchctl("bootstrap", domain, plistURL.path)

        // Loaded at the next login (not now: the app is open), once, no
        // KeepAlive; "open -g" so it doesn't take focus.
        let app: [String: Any] = [
            "Label": appLabel,
            "ProgramArguments": ["/usr/bin/open", "-g", Bundle.main.bundleURL.path, "--args", "--background"],
            "RunAtLoad": true,
            "LimitLoadToSessionType": "Aqua",
        ]
        try PropertyListSerialization.data(fromPropertyList: app, format: .xml, options: 0).write(to: agentURL(appLabel))
    }

    static func uninstall() {
        launchctl("bootout", "\(domain)/\(label)")
        try? FileManager.default.removeItem(at: plistURL)
        try? FileManager.default.removeItem(at: agentURL(appLabel))
    }

    /// Picks up a new app version: the agent points into the app bundle, so
    /// reinstalling the plist and restarting is enough.
    static func refresh() {
        guard installed else { return }
        try? install()
    }

    @discardableResult
    private static func launchctl(_ args: String...) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }
}

/// Routine notifications. With the app open, they come from the brain's
/// `routine.finished` event; with it closed, the background service launches
/// the app's executable with `--notify` (see `postAndExit`).
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    /// Opens the chat of the bot a clicked notification is about.
    var openBot: ((String) -> Void)?

    /// Notifications need a bundled app (a bundle id).
    private var enabled: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.resourceURL.map {
        FileManager.default.fileExists(atPath: $0.appendingPathComponent("node").path)
    } == true }

    func setUp() {
        guard enabled else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func routineFinished(_ data: Any?) {
        guard enabled, let note = data as? [String: Any] else { return }
        Self.post(note)
    }

    nonisolated static func post(_ note: [String: Any], done: (() -> Void)? = nil) {
        let content = UNMutableNotificationContent()
        content.title = note["title"] as? String ?? "Local Bot"
        content.body = note["body"] as? String ?? ""
        if note["ok"] as? Bool == false { content.sound = .default }
        content.userInfo = ["botId": note["botId"] as? String ?? ""]
        let id = (note["routineId"] as? String ?? UUID().uuidString) + "-" + UUID().uuidString
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { _ in
            done?()
        }
    }

    /// `LocalBot --notify '<json>'`: post one notification and quit, with no
    /// window or Dock icon. Returns false when not in that mode.
    nonisolated static func postAndExitIfAsked() -> Bool {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--notify"), i + 1 < args.count else { return false }
        NSApplication.shared.setActivationPolicy(.prohibited)
        guard let data = args[i + 1].data(using: .utf8),
              let note = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { exit(1) }
        let done = DispatchSemaphore(value: 0)
        post(note) { done.signal() }
        _ = done.wait(timeout: .now() + 5)
        exit(0)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let botID = response.notification.request.content.userInfo["botId"] as? String
        Task { @MainActor in
            NSApplication.shared.activate(ignoringOtherApps: true)
            if let botID, !botID.isEmpty { self.openBot?(botID) }
            completionHandler()
        }
    }
}

/// Settings → Background.
struct BackgroundPage: View {
    @State private var on = BackgroundService.installed
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(title: "Background", subtitle: "Routines and notifications while Local Bot is closed.")
            Card {
                SettingRow(label: "Keep routines running when Local Bot is closed",
                           detail: BackgroundService.available
                               ? "A small background service keeps the brain running, so routines run on time and you get notified. Devices still need Docker running."
                               : "Available in the installed app.") {
                    Toggle("", isOn: $on).toggleStyle(.switch).labelsHidden()
                        .disabled(!BackgroundService.available)
                }
                SettingRow(label: "Notifications",
                           detail: "A notification when a routine finishes or fails. Choose how they show in System Settings.") {
                    PillButton(title: "Open", systemImage: "bell") {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                }
            }
            if let error {
                Text(error).font(.system(size: 12)).foregroundStyle(Theme.danger).padding(.top, 10)
            }
        }
        .onChange(of: on) { _, enable in
            do {
                if enable { try BackgroundService.install() } else { BackgroundService.uninstall() }
                UserDefaults.standard.set(enable, forKey: MenuBar.key)
                error = nil
            } catch {
                self.error = "Couldn’t \(enable ? "turn on" : "turn off") the background service: \(error.localizedDescription)"
                on = BackgroundService.installed
            }
        }
    }
}

/// The menu bar icon while the background service is on: which bots are
/// working, and the way back to the window. Closing the window leaves the app
/// here (no Dock icon); Quit leaves routines to the service.
enum MenuBar {
    static let key = "menuBarIcon"
    static let windowID = "main"
    /// Set when the app should really quit (menu bar Quit, update, log out).
    static var quitting = false
    /// Opens a new main window (set by the window, from SwiftUI's openWindow).
    static var openMainWindow: (() -> Void)?

    /// Brings the window (and the Dock icon) back.
    static func showWindow() {
        NSApplication.shared.setActivationPolicy(.regular)
        if let window = NSApplication.shared.windows.first(where: { $0.canBecomeMain }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            openMainWindow?()
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    static var keepsRunning: Bool { UserDefaults.standard.bool(forKey: key) && !quitting }

    /// AppKit won't quit while a sheet (Settings, a bot editor, a confirmation)
    /// is open, and doesn't ask the app first. Closes them all, then calls
    /// `done` once they're gone (or after a couple of seconds regardless).
    @MainActor
    static func closeSheets(then done: @escaping () -> Void) {
        AppModel.shared.sheet = nil
        func sheets() -> [(NSWindow, NSWindow)] {
            NSApplication.shared.windows.compactMap { w in w.attachedSheet.map { (w, $0) } }
        }
        for (window, sheet) in sheets() { window.endSheet(sheet) }
        func wait(_ tries: Int) {
            if sheets().isEmpty || tries == 0 { return done() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { wait(tries - 1) }
        }
        DispatchQueue.main.async { wait(20) }
    }

    /// Closes the windows and drops the Dock icon; the menu bar icon stays.
    static func hide() {
        for window in NSApplication.shared.windows where window.canBecomeMain { window.close() }
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    /// No Dock icon once the last window closes; it comes back with the window.
    static func windowClosed() {
        guard UserDefaults.standard.bool(forKey: key) else { return }
        DispatchQueue.main.async {
            let visible = NSApplication.shared.windows.contains { $0.isVisible && $0.canBecomeMain }
            if !visible { NSApplication.shared.setActivationPolicy(.accessory) }
        }
    }
}

/// The menu bar panel: bots and what they're doing, the next routines, and
/// the way back to the window.
struct MenuBarMenu: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    /// Closes the popover.
    let close: () -> Void

    private var working: Int { brain.bots.filter { brain.thinking.contains($0.id) }.count }

    private static let face = Brain.Face(color: "sky", eyes: "dot", mouth: "smile", accessory: "none",
                                         fill: "#4f9cf9", deep: "#08245c", shape: "round")

    private var upcoming: [Brain.Routine] {
        brain.routines
            .filter { $0.enabled && $0.nextRunAt != nil }
            .sorted { ($0.nextRunAt ?? "") < ($1.nextRunAt ?? "") }
            .prefix(3).map { $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(Theme.border).frame(height: 1)
            if brain.bots.isEmpty {
                Text("No bots yet").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 18)
            } else {
                VStack(spacing: 2) {
                    ForEach(brain.bots) { bot in
                        PanelRow(action: { open(bot: bot.id) }) {
                            AnimatedFace(face: bot.face, size: 24, working: brain.thinking.contains(bot.id), seed: bot.id)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(bot.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
                                Text(status(bot)).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            if brain.thinking.contains(bot.id) {
                                Circle().fill(Theme.live).frame(width: 6, height: 6)
                            }
                        }
                    }
                }
                .padding(6)
            }
            if !upcoming.isEmpty {
                Rectangle().fill(Theme.border).frame(height: 1)
                VStack(alignment: .leading, spacing: 6) {
                    Text("NEXT ROUTINES").font(.system(size: 10, weight: .semibold)).kerning(0.6).foregroundStyle(Theme.tertiary)
                    ForEach(upcoming) { r in
                        HStack(spacing: 8) {
                            Image(systemName: "clock").font(.system(size: 11)).foregroundStyle(Theme.secondary)
                            Text(r.name).font(.system(size: 12)).lineLimit(1)
                            Spacer(minLength: 6)
                            Text(Self.when(r.nextRunAt)).font(.system(size: 11)).foregroundStyle(Theme.secondary)
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
            }
            Rectangle().fill(Theme.border).frame(height: 1)
            HStack {
                Label("Routines keep running in the background", systemImage: "moon.zzz")
                    .font(.system(size: 11)).foregroundStyle(Theme.tertiary).lineLimit(1)
                Spacer(minLength: 6)
                Button("Quit") {
                    MenuBar.quitting = true
                    MenuBar.closeSheets { NSApplication.shared.terminate(nil) }
                }
                .buttonStyle(.plain).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.secondary)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
        }
        .frame(width: 320)
        // No background of its own: the popover's material, so it matches the arrow.
        .foregroundStyle(Theme.text)
    }

    private var header: some View {
        HStack(spacing: 10) {
            // Local Bot's own face, without the app icon's tile.
            AnimatedFace(face: Self.face, size: 28, working: working > 0, seed: "local-bot")
            VStack(alignment: .leading, spacing: 1) {
                Text("Local Bot").font(.system(size: 13, weight: .semibold))
                Text(!brain.connected ? "Starting…" : working == 0 ? "All bots idle" : "\(working) bot\(working == 1 ? "" : "s") working")
                    .font(.system(size: 11)).foregroundStyle(Theme.secondary)
            }
            Spacer()
            IconButton(systemImage: "macwindow", help: "Open Local Bot") { open() }
            IconButton(systemImage: "gearshape", help: "Settings") {
                model.sheet = .settings
                open()
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
    }

    private func status(_ bot: Brain.Bot) -> String {
        let device = bot.workDevice.flatMap { id in brain.computers.first { $0.id == id }?.name }
        let doing = brain.thinking.contains(bot.id) ? "Working…" : (bot.role.isEmpty ? "Idle" : bot.role)
        return [doing, device].compactMap { $0 }.joined(separator: " · ")
    }

    private static func when(_ iso: String?) -> String {
        guard let iso, let d = ISO8601DateFormatter.withFractions.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
        if Calendar.current.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
        return d.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }

    private func open(bot: String? = nil) {
        if let bot { model.selection = .bot(bot) }
        close()
        MenuBar.showWindow()
    }
}

/// A full-width hover row in the menu bar panel.
private struct PanelRow<Content: View>: View {
    let action: () -> Void
    @ViewBuilder let content: Content
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) { content }
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 8).fill(hovering ? Theme.raised : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// The menu bar icon and its popover (centered under the icon, with the arrow,
/// like system extras). Shown while the background mode is on.
@MainActor
final class StatusBar: NSObject {
    static let shared = StatusBar()
    private var item: NSStatusItem?
    private let popover = NSPopover()
    private var bag: Set<AnyCancellable> = []
    private weak var model: AppModel?

    func setUp(model: AppModel) {
        guard self.model == nil else { return }
        self.model = model
        popover.behavior = .transient
        popover.animates = true
        popover.contentViewController = NSHostingController(rootView: MenuBarMenu(model: model, brain: model.brain) { [weak self] in
            self?.popover.performClose(nil)
        })
        // The brain starts here too when the app opens at login without a window.
        model.brain.start()
        NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.sync() }
            .store(in: &bag)
        model.brain.$thinking
            .receive(on: RunLoop.main)
            .sink { [weak self] thinking in self?.updateIcon(working: !thinking.isEmpty) }
            .store(in: &bag)
        sync()
    }

    /// Adds or removes the icon to match Settings → Background.
    private func sync() {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: MenuBar.key) == nil { defaults.set(BackgroundService.installed, forKey: MenuBar.key) }
        let wanted = defaults.bool(forKey: MenuBar.key)
        if wanted, item == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            item.button?.target = self
            item.button?.action = #selector(toggle)
            self.item = item
            updateIcon(working: !(model?.brain.thinking.isEmpty ?? true))
        } else if !wanted, let item {
            popover.performClose(nil)
            NSStatusBar.system.removeStatusItem(item)
            self.item = nil
        }
    }

    private func updateIcon(working: Bool) {
        let image = NSImage(systemSymbolName: working ? "face.smiling.inverse" : "face.smiling",
                            accessibilityDescription: working ? "Local Bot · bots working" : "Local Bot")
        image?.isTemplate = true
        item?.button?.image = image
    }

    @objc private func toggle() {
        guard let button = item?.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }
}
