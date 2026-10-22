import SwiftUI
import AppKit

@main
struct LocalBotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    /// Shared by the window and the menu bar icon.
    @ObservedObject private var model = AppModel.shared

    init() {
        // Launched by the background service just to post a notification.
        if Notifier.postAndExitIfAsked() { return }
        // Running as a bare executable (swift run) has no bundle; make it a regular app.
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        Appearance.current.apply()
        NSApplication.shared.applicationIconImage = AppIcon.image()
    }

    var body: some Scene {
        WindowGroup("Local Bot", id: MenuBar.windowID) {
            ContentView(model: model)
                .frame(minWidth: 760, minHeight: 560)
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { Updater.shared.checkForUpdates() }
                    .disabled(!Updater.shared.enabled)
            }
        }

    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { _ in
            MenuBar.windowClosed()
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main) { _ in
            MenuBar.quitting = true
        }
        Task { @MainActor in StatusBar.shared.setUp(model: AppModel.shared) }
        // Opened at login: start in the menu bar, without a window.
        if CommandLine.arguments.contains("--background") {
            DispatchQueue.main.async { MenuBar.hide() }
        }
    }

    /// Clicking the Dock icon (or opening the app again) shows the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        sender.setActivationPolicy(.regular)
        return true
    }

    /// AppKit doesn't get here while a sheet is open (it refuses to quit before
    /// asking), so whatever must really quit closes the sheets first: see
    /// `MenuBar.closeSheets`.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // In the menu bar, ⌘Q just closes the window; Quit in its menu, an
        // update or logging out really quits.
        if MenuBar.keepsRunning {
            MenuBar.hide()
            return .terminateCancel
        }
        return .terminateNow
    }
}

enum Selection: Hashable {
    case bot(String)
    case computer(String)
}

enum Sheet: Identifiable {
    case newBot
    case editBot(String)
    case settings
    case newDevice
    case addBots(String)   // device id
    case shareDevice(String)   // device id
    case routine(botID: String, routineID: String?)
    case onboarding

    var id: String {
        switch self {
        case .newDevice: return "new-device"
        case .addBots(let id): return "add-bots-\(id)"
        case .shareDevice(let id): return "share-\(id)"
        case .routine(let bot, let routine): return "routine-\(bot)-\(routine ?? "new")"
        case .onboarding: return "onboarding"
        case .newBot: return "new"
        case .editBot(let id): return "edit-\(id)"
        case .settings: return "settings"
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()
    let brain = Brain()
    let updater = Updater.shared
    @Published var selection: Selection?
    @Published var sheet: Sheet?
    @Published var showSidebar = true
    @Published var showChat = true
    /// The device's screen (center column). Hidden, the chat takes its place.
    @Published var showComputer = true
    /// Device waiting for the user to confirm its removal.
    @Published var removingDevice: Brain.Computer?
    /// Device being renamed, and the name being typed.
    @Published var renamingDevice: Brain.Computer?
    @Published var newDeviceName = ""

    func rename(_ device: Brain.Computer) {
        newDeviceName = device.name
        renamingDevice = device
    }
    /// Bot waiting for the user to confirm its deletion, or its chat being cleared.
    @Published var deletingBot: Brain.Bot?
    @Published var clearingChat: Brain.Bot?
    /// Device preselected when "New bot" is opened from a device.
    var newBotDevice: String?
    /// macOS VMs are booted in-process; one host per Lume bundle.
    private var vmHosts: [String: VMHost] = [:]

    func host(for path: String) -> VMHost {
        if let host = vmHosts[path] { return host }
        let url = URL(fileURLWithPath: path)
        let host = VMHost(bundle: VMBundle(name: url.lastPathComponent, url: url))
        vmHosts[path] = host
        return host
    }
}

struct ContentView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        MainView(model: model, brain: model.brain)
    }
}

struct MainView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    @Environment(\.openWindow) private var openWindow
    @AppStorage("sidebarWidth") private var sidebarWidth: Double = 248
    @AppStorage("chatWidth") private var chatWidth: Double = 380

    var body: some View {
        HStack(spacing: 0) {
            if model.showSidebar {
                Sidebar(model: model, brain: brain, updater: model.updater)
                    .frame(width: sidebarWidth)
                    .transition(.move(edge: .leading))
                ResizeHandle(width: $sidebarWidth, range: 200...380, defaultWidth: 248, edge: .leading)
            }
            if model.showComputer {
                center
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
            }
            if model.showChat {
                if model.showComputer {
                    ResizeHandle(width: $chatWidth, range: 300...620, defaultWidth: 380, edge: .trailing)
                    trailing
                        .frame(width: chatWidth)
                        .transition(.move(edge: .trailing))
                } else {
                    // Without the computer, the chat takes the whole width.
                    trailing
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .environmentObject(model)
        .animation(.easeInOut(duration: 0.18), value: model.showSidebar)
        .animation(.easeInOut(duration: 0.18), value: model.showChat)
        .animation(.easeInOut(duration: 0.18), value: model.showComputer)
        .background(Theme.window)
        .background(WindowChrome())
        .ignoresSafeArea(.container, edges: .top)
        .foregroundStyle(Theme.text)
        .tint(Theme.text)
        .onAppear {
            // The menu bar can reopen the window after it was closed.
            MenuBar.openMainWindow = { [openWindow] in openWindow(id: MenuBar.windowID) }
            brain.start()
            Notifier.shared.setUp()
            Notifier.shared.openBot = { id in model.selection = .bot(id) }
            model.updater.start()
        }
        .task {
            // First run only: decide after the brain has reported everything, and
            // only for a truly empty setup (no AI provider and no bots).
            while !brain.loaded { try? await Task.sleep(for: .milliseconds(200)) }
            let defaults = UserDefaults.standard
            if defaults.bool(forKey: "onboardingDone") { return }
            if brain.providerStatus?.configured == true || !brain.bots.isEmpty {
                defaults.set(true, forKey: "onboardingDone")
            } else if model.sheet == nil {
                model.sheet = .onboarding
            }
        }
        .onReceive(brain.$bots) { _ in fixSelection() }
        .onReceive(brain.$computers) { _ in fixSelection() }
        .sheet(item: $model.sheet) { sheet in
            switch sheet {
            case .newBot: BotEditor(model: model, brain: brain, botID: nil)
            case .editBot(let id): BotEditor(model: model, brain: brain, botID: id)
            case .settings: SettingsSheet(brain: brain) { model.sheet = .onboarding }
            case .onboarding: OnboardingView(model: model, brain: brain)
            case .newDevice: NewDeviceSheet(model: model, brain: brain)
            case .addBots(let id): AddBotsSheet(model: model, brain: brain, deviceID: id)
            case .shareDevice(let id): ShareDeviceSheet(brain: brain, deviceID: id)
            case .routine(let bot, let routine): RoutineEditor(brain: brain, botID: bot, routineID: routine)
            }
        }
        .overlay(alignment: .bottom) { ErrorToast(brain: brain) }
        .alert("Rename device", isPresented: Binding(
            get: { model.renamingDevice != nil }, set: { if !$0 { model.renamingDevice = nil } })
        ) {
            TextField("Name", text: $model.newDeviceName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                guard let device = model.renamingDevice else { return }
                let name = model.newDeviceName
                Task { await brain.renameDevice(device.id, to: name) }
            }
            .disabled(model.newDeviceName.trimmingCharacters(in: .whitespaces).isEmpty)
        } message: {
            Text("Bots see this name too.")
        }
        .confirmationDialog("Remove \(model.removingDevice?.name ?? "device")?", isPresented: Binding(
            get: { model.removingDevice != nil }, set: { if !$0 { model.removingDevice = nil } })
        ) {
            Button("Remove device", role: .destructive) {
                guard let device = model.removingDevice else { return }
                Task { await brain.removeDevice(device.id) }
            }
        } message: {
            Text("Everything on it is deleted: files, logins and installed apps. Bots using it are disconnected; the bots themselves are kept.")
        }
        .confirmationDialog("Delete \(model.deletingBot?.name ?? "bot")?", isPresented: Binding(
            get: { model.deletingBot != nil }, set: { if !$0 { model.deletingBot = nil } })
        ) {
            Button("Delete bot", role: .destructive) {
                guard let bot = model.deletingBot else { return }
                Task { await brain.deleteBot(bot.id) }
            }
        } message: {
            Text("Its conversation and routines are deleted. Devices it used are not affected.")
        }
        .confirmationDialog("Clear the conversation with \(model.clearingChat?.name ?? "this bot")?", isPresented: Binding(
            get: { model.clearingChat != nil }, set: { if !$0 { model.clearingChat = nil } })
        ) {
            Button("Clear conversation", role: .destructive) {
                guard let bot = model.clearingChat else { return }
                Task { await brain.clearChat(bot.id) }
            }
        } message: {
            Text("All messages are removed. The bot, its device and routines stay.")
        }
    }

    @ViewBuilder private var center: some View {
        switch model.selection {
        case .bot(let id):
            if let bot = brain.bots.first(where: { $0.id == id }) {
                if let computer = brain.computers.first(where: { $0.id == bot.workDevice }) {
                    ComputerStage(model: model, brain: brain, computer: computer,
                                  caption: bot.isGuestOnly ? "\(bot.name) · shared device" : "\(bot.name)’s device")
                } else {
                    VStack(spacing: 0) {
                        StageHeader(title: bot.name, subtitle: "No device", state: "stopped") { EmptyView() }
                        Placeholder(icon: "desktopcomputer", text: "\(bot.name) has no device yet",
                                    detail: "Assign a device in the bot settings.")
                            .overlay(alignment: .center) {
                                PillButton(title: "Bot settings", systemImage: "slider.horizontal.3") {
                                    model.sheet = .editBot(bot.id)
                                }
                                .offset(y: 70)
                            }
                    }
                }
            }
        case .computer(let id):
            if let computer = brain.computers.first(where: { $0.id == id }) {
                ComputerStage(model: model, brain: brain, computer: computer, caption: nil)
            }
        case nil:
            VStack(spacing: 0) {
                StageHeader(title: "Local Bot", subtitle: "", state: "stopped") { EmptyView() }
                Placeholder(icon: "sparkles", text: brain.connected ? "Create your first bot" : (brain.lastError ?? "Connecting…"),
                        detail: "Bots work on devices. A bot can have its own device or share one.")
            }
        }
    }

    @ViewBuilder private var trailing: some View {
        switch model.selection {
        case .bot(let id):
            if let bot = brain.bots.first(where: { $0.id == id }) {
                ChatView(model: model, brain: brain, bot: bot).id(bot.id)
            }
        case .computer(let id):
            if let computer = brain.computers.first(where: { $0.id == id }) {
                ComputerBots(model: model, brain: brain, computer: computer)
            }
        case nil:
            Color.clear.background(Theme.sidebar)
        }
    }

    private func fixSelection() {
        switch model.selection {
        case .bot(let id) where brain.bots.contains { $0.id == id }: return
        case .computer(let id) where brain.computers.contains { $0.id == id }: return
        default:
            if let bot = brain.bots.first { model.selection = .bot(bot.id) }
            else if let computer = brain.computers.first { model.selection = .computer(computer.id) }
            else { model.selection = nil }
        }
    }
}

struct ErrorToast: View {
    @ObservedObject var brain: Brain

    var body: some View {
        if let error = brain.lastError, brain.connected {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warn)
                Text(error).font(.system(size: 12)).lineLimit(2)
                IconButton(systemImage: "xmark", help: "Close") { brain.lastError = nil }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.raised))
            .hairline(10)
            .padding(.bottom, 18)
            .task(id: error) {
                try? await Task.sleep(for: .seconds(6))
                if brain.lastError == error { brain.lastError = nil }
            }
        }
    }
}
