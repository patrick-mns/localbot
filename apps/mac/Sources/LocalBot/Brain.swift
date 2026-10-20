import Foundation
import AppKit

/// Client for the TypeScript brain process. Protocol: one JSON object per line
/// over stdio. Requests `{id, method, params}` get `{id, result}` or `{id, error}`;
/// the brain also pushes `{event, data}` notifications.
@MainActor
final class Brain: ObservableObject {
    struct Computer: Decodable, Identifiable, Hashable {
        struct Display: Decodable, Hashable {
            let kind: String          // "vnc" | "native-vz" | "none"
            let url: String?
            let password: String?
            let bundlePath: String?
        }

        let id: String
        let name: String
        let provider: String
        let os: String
        let state: String             // creating | stopped | starting | running | stopping | error
        let display: Display
        let bots: [String]

        var osLabel: String {
            switch os {
            case "macos": return "macOS"
            case "linux": return "Linux"
            case "windows": return "Windows"
            default: return os
            }
        }

        /// Where it runs, so cloud and remote machines read differently from local ones.
        var symbol: String {
            switch provider {
            case "railway": return "cloud"
            case "remote": return "point.3.connected.trianglepath.dotted"
            default: return os == "macos" ? "apple.logo" : "terminal"
            }
        }

        /// "Cloud" / "Remote" for machines off this Mac, nil for local ones.
        var placeLabel: String? {
            switch provider {
            case "railway": return "Cloud"
            case "remote": return "Remote"
            default: return nil
            }
        }
    }

    struct Access: Decodable, Hashable {
        let botId: String
        let computerId: String
        let role: String              // owner | guest
        let expiresAt: String?
    }

    /// Face parts (see brain/src/bots/avatar.ts) for native drawing.
    struct Face: Decodable, Hashable {
        let color: String
        let eyes: String
        let mouth: String
        let accessory: String
        let fill: String
        let deep: String
        /// Head silhouette (round, egg, wide, bean); chosen in the face picker.
        let shape: String?
    }

    struct Bot: Decodable, Identifiable, Hashable {
        let id: String
        let name: String
        let role: String
        let instructions: String
        let provider: String
        let model: String
        let avatar: String            // SVG
        let avatarSeed: String        // catalog spec ("v1:…") or legacy seed
        let face: Face
        let memoryAuto: Bool?
        /// MCP servers this bot may use.
        let mcpServers: [String]?
        /// "cloud" when the bot lives in the cloud brain (keeps working with the app closed).
        let host: String?
        /// Snapshot used to restore execution controls after opening or reconnecting.
        let status: String?

        var inCloud: Bool { host == "cloud" }
        let computers: [Access]

        var ownedComputer: String? { computers.first { $0.role == "owner" }?.computerId }
        /// Where the bot works: its own device, else the first one it's a guest on
        /// (the brain picks devices in this same order).
        var workDevice: String? { ownedComputer ?? computers.first?.computerId }
        var isGuestOnly: Bool { ownedComputer == nil && workDevice != nil }
    }

    struct Message: Decodable, Identifiable, Hashable {
        let id: String
        let botId: String
        let role: String              // user | assistant
        var text: String
        let at: String
        var error: String?
        /// Technical detail behind `error`, shown only on request.
        var detail: String?
        /// Set when a routine posted this prompt.
        var routine: RoutineRef?
        /// Set when another bot sent this prompt (ask_bot).
        var from: FromRef?
        /// Files the bot shared (share_file).
        var files: [Attachment]?
        /// A card asking to connect (or allow) an app.
        var connect: ConnectRequest?
        /// Posted by Local Bot itself (an app got connected), not the user.
        var notice: Bool?

        struct ConnectRequest: Decodable, Hashable {
            let connector: String
            let name: String
            let description: String
            let mode: String          // connect | allow
            let reason: String?
            let state: String         // pending | connected | dismissed
        }

        struct FromRef: Decodable, Hashable { let botId: String; let name: String }

        struct RoutineRef: Decodable, Hashable { let id: String; let name: String }
    }

    /// Mirrors brain/src/chat/files.ts.
    struct Attachment: Decodable, Identifiable, Hashable {
        let id: String
        let name: String
        let size: Int
        let mime: String
    }

    /// Mirrors brain/src/routines/schedule.ts.
    enum Schedule: Codable, Hashable {
        case interval(every: Int, unit: String)            // "minutes" | "hours"
        case daily(time: String, days: [Int])               // "HH:MM", 0=Sun…6=Sat
        case once(at: Date)

        private enum Keys: String, CodingKey { case kind, every, unit, time, days, at }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            switch try c.decode(String.self, forKey: .kind) {
            case "interval": self = .interval(every: try c.decode(Int.self, forKey: .every), unit: try c.decode(String.self, forKey: .unit))
            case "daily": self = .daily(time: try c.decode(String.self, forKey: .time), days: try c.decode([Int].self, forKey: .days))
            default:
                let iso = try c.decode(String.self, forKey: .at)
                self = .once(at: ISO8601DateFormatter.withFractions.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) ?? .now)
            }
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: Keys.self)
            switch self {
            case .interval(let every, let unit):
                try c.encode("interval", forKey: .kind); try c.encode(every, forKey: .every); try c.encode(unit, forKey: .unit)
            case .daily(let time, let days):
                try c.encode("daily", forKey: .kind); try c.encode(time, forKey: .time); try c.encode(days, forKey: .days)
            case .once(let at):
                try c.encode("once", forKey: .kind); try c.encode(ISO8601DateFormatter().string(from: at), forKey: .at)
            }
        }

        var json: [String: Any] {
            let data = (try? JSONEncoder().encode(self)) ?? Data()
            return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        }
    }

    struct Routine: Decodable, Identifiable, Hashable {
        let id: String
        let botId: String
        let name: String
        let task: String
        let schedule: Schedule
        let enabled: Bool
        let nextRunAt: String?
        let lastRunAt: String?
        let lastStatus: String?      // ok | failed | running | skipped
        let lastError: String?
        let scheduleText: String
    }

    struct ProviderStatus: Decodable {
        struct Preset: Decodable, Identifiable, Hashable {
            let id: String
            let label: String
            let baseURL: String
            let envKey: String?
            let keyless: Bool?
            let local: Bool?
            let editableURL: Bool?
            let suggestedModel: String?
            let keyURL: String?
        }

        struct Entry: Decodable, Identifiable, Hashable {
            let id: String
            let preset: String
            let label: String
            let baseURL: String
            let local: Bool
            let keyless: Bool
            let configured: Bool
            let keySource: String?     // "config" | "env" | nil
            let keyHint: String?
        }

        let defaultProvider: String
        let defaultModel: String
        let presets: [Preset]
        let providers: [Entry]

        var configured: Bool { providers.contains { $0.configured } }
        var defaultEntry: Entry? { providers.first { $0.id == defaultProvider } }
        func entry(_ id: String) -> Entry? { providers.first { $0.id == id } }
        func preset(_ id: String) -> Preset? { presets.first { $0.id == id } }
    }

    struct TestResult: Decodable {
        let ok: Bool
        let models: Int?
        let error: String?
    }

    struct Model: Decodable, Identifiable, Hashable {
        let id: String
        let name: String
    }

    @Published private(set) var connected = false
    /// True once bots, providers and routines have been read after startup.
    @Published private(set) var loaded = false
    @Published private(set) var computers: [Computer] = []
    @Published private(set) var bots: [Bot] = []
    @Published private(set) var messages: [String: [Message]] = [:]
    /// Chats with older messages not loaded yet (they load as you scroll up).
    @Published private(set) var olderMessages: Set<String> = []
    private var loadingOlder: Set<String> = []
    @Published private(set) var thinking: Set<String> = []
    private var botStatusRevision: [String: Int] = [:]
    @Published private(set) var routines: [Routine] = []
    @Published private(set) var mcpServers: [McpServer] = []
    @Published private(set) var connectors: [Connector] = []
    @Published private(set) var memories: [String: [Memory]] = [:]
    @Published private(set) var providerStatus: ProviderStatus?
    /// Model lists per provider id.
    @Published private(set) var models: [String: [Model]] = [:]
    @Published private(set) var busy: Set<String> = []
    @Published var lastError: String?

    private var process: Process?
    private var stdin: FileHandle?
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<Any?, Error>] = [:]

    /// Brain lives at <repo>/brain. Set LOCALBOT_BRAIN_DIR to override.
    private var brainDir: URL {
        if let dir = ProcessInfo.processInfo.environment["LOCALBOT_BRAIN_DIR"] {
            return URL(fileURLWithPath: dir)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("brain")
    }

    // MARK: Lifecycle

    private var restarts = 0
    private var stopping = false

    /// Where the brain's stderr goes: ~/Library/Logs/LocalBot/brain.log.
    static let logURL = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs/LocalBot/brain.log")

    /// The packaged app ships Node and a bundled brain in Resources; a dev
    /// checkout runs the TypeScript sources through tsx.
    private func launchCommand() -> (URL, [String], URL?) {
        if let res = Bundle.main.resourceURL,
           FileManager.default.fileExists(atPath: res.appendingPathComponent("node").path),
           FileManager.default.fileExists(atPath: res.appendingPathComponent("brain/brain.mjs").path) {
            return (res.appendingPathComponent("node"), [res.appendingPathComponent("brain/brain.mjs").path], nil)
        }
        // GUI apps don't inherit the login shell PATH; zsh -l finds node in a dev setup.
        return (URL(fileURLWithPath: "/bin/zsh"), ["-lc", "exec node --import tsx src/index.ts"], brainDir)
    }

    /// The running brain, for views that fetch shared files on their own.
    static private(set) weak var shared: Brain?

    /// A file a bot shared in the chat.
    func fileData(botID: String, fileID: String) async -> Data? {
        do {
            // Same Mac: the brain says where the file is and we read it directly.
            if let raw = try await call("chat.file", ["botId": botID, "fileId": fileID, "inline": false]) as? [String: Any],
               let path = raw["path"] as? String, FileManager.default.isReadableFile(atPath: path) {
                return await Task.detached(priority: .userInitiated) { try? Data(contentsOf: URL(fileURLWithPath: path)) }.value
            }
            // A brain elsewhere (cloud): the bytes come in the reply.
            let raw = try await call("chat.file", ["botId": botID, "fileId": fileID])
            guard let b64 = (raw as? [String: Any])?["data"] as? String else { return nil }
            return await Task.detached(priority: .userInitiated) { Data(base64Encoded: b64) }.value
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func start() {
        Brain.shared = self
        guard process == nil else { return }
        let p = Process()
        let (exe, args, cwd) = launchCommand()
        p.executableURL = exe
        p.arguments = args
        if let cwd { p.currentDirectoryURL = cwd }
        // Docker's CLI lives outside the default GUI PATH.
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin",
                       env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
        env["NODE_NO_WARNINGS"] = "1"
        p.environment = env

        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = Self.logHandle() ?? FileHandle.standardError
        // Lines are split and parsed on the pipe's own queue: a big reply (a
        // file, a long history) never blocks the window.
        let reader = LineReader()
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let objects = reader.feed(handle.availableData)
            guard !objects.isEmpty else { return }
            Task { @MainActor in self?.receive(objects) }
        }
        p.terminationHandler = { [weak self] proc in
            Task { @MainActor in self?.brainExited(code: proc.terminationStatus) }
        }
        do {
            try p.run()
            process = p
            stdin = inPipe.fileHandleForWriting
            connected = true
            lastError = nil
            Task {
                await refreshBots()
                await refreshProviders()
                await refreshRoutines()
                await refreshCloud()
                await refreshMcp()
                await refreshUserAccount()
                loaded = true
                await checkService()
                // Computers change outside the app too (docker, lume); poll for state.
                while !Task.isCancelled && self.connected && self.process === p {
                    await refreshComputers()
                    try? await Task.sleep(for: .seconds(4))
                }
            }
        } catch {
            lastError = "Couldn’t start the brain: \(error.localizedDescription)"
        }
    }

    /// Connected to a background service from an older app version (after an
    /// update): restart it so it runs this version's brain.
    private func checkService() async {
        guard let info = try? await call("app.info") as? [String: Any], info["service"] as? Bool == true,
              let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              info["version"] as? String != version else { return }
        BackgroundService.refresh()
    }

    func stop() {
        stopping = true
        process?.terminate()
    }

    /// Restarts a crashed brain a few times, backing off, before giving up.
    private func brainExited(code: Int32) {
        connected = false
        process = nil
        stdin = nil
        for (_, cont) in pending { cont.resume(throwing: NSError(domain: "Brain", code: 3, userInfo: [NSLocalizedDescriptionKey: "Brain restarted"])) }
        pending = [:]
        guard !stopping else { return }
        guard restarts < 5 else {
            lastError = "The brain keeps stopping (code \(code)). See \(Self.logURL.path)."
            return
        }
        restarts += 1
        lastError = "The brain stopped (code \(code)); restarting…"
        Task {
            try? await Task.sleep(for: .seconds(Double(restarts) * 1.5))
            self.start()
        }
    }

    private static func logHandle() -> FileHandle? {
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        // Keep the log from growing forever: start over past 5 MB.
        if let size = (try? fm.attributesOfItem(atPath: logURL.path))?[.size] as? Int, size > 5_000_000 {
            try? Data().write(to: logURL)
        }
        guard let h = try? FileHandle(forWritingTo: logURL) else { return nil }
        h.seekToEndOfFile()
        h.write(Data("\n--- \(Date()) brain starting ---\n".utf8))
        return h
    }

    // MARK: Computers

    func refreshComputers() async {
        if let list: [Computer] = try? await request("computers.list") { computers = list }
    }

    struct DeviceKind: Decodable, Identifiable, Hashable {
        let id: String
        let label: String
        let detail: String
        let available: Bool
        let reason: String?
        /// Extra inputs this kind needs to create a device (URL, token…).
        let fields: [KindField]?
    }

    struct KindField: Decodable, Identifiable, Hashable {
        let id: String
        let label: String
        let placeholder: String
        let secure: Bool
    }

    /// A cloud account devices are created on (Railway…), managed in Settings.
    struct DeviceAccount: Decodable, Identifiable, Hashable {
        let id: String
        let label: String
        let detail: String
        let tokenLabel: String
        let tokenURL: String?
        let connected: Bool
        let tokenHint: String?
        let devices: Int
    }

    /// User account (GitHub OAuth).
    struct UserAccount: Decodable, Identifiable, Hashable {
        let id: String
        let name: String
        let email: String
        let login: String?
        let createdAt: String

        var displayName: String { login ?? name }
    }

    @Published private(set) var deviceAccounts: [DeviceAccount] = []
    @Published private(set) var userAccount: UserAccount? = nil

    func refreshDeviceAccounts() async {
        if let list: [DeviceAccount] = try? await request("deviceProviders.status") { deviceAccounts = list }
    }

    /// Returns an error message, or nil when the token was accepted.
    func connectDeviceAccount(_ id: String, token: String) async -> String? {
        do {
            deviceAccounts = try await request("deviceProviders.connect", ["id": id, "token": token])
            await refreshComputers()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func disconnectDeviceAccount(_ id: String) async {
        if let list: [DeviceAccount] = try? await request("deviceProviders.disconnect", ["id": id]) { deviceAccounts = list }
        await refreshComputers()
    }

    func refreshUserAccount() async {
        if let account: UserAccount = try? await request("auth.user") { userAccount = account }
    }

    /// Start GitHub sign-in flow: returns URL to open in browser.
    func startUserSignIn() async -> String? {
        try? await request("auth.signInURL")
    }

    /// Complete sign-in with one-time token from callback.
    func completeUserSignIn(_ token: String) async -> String? {
        do {
            userAccount = try await request("auth.verifyToken", ["token": token])
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func signOutUser() async {
        do {
            try await request("auth.signOut")
            userAccount = nil
        } catch {
            print("Sign out error: \(error)")
        }
    }

    func deviceKinds() async -> [DeviceKind] {
        (try? await request("computers.kinds")) ?? []
    }

    /// Returns the new device id, or nil (error in `lastError`).
    /// What a Linux device needs on this Mac. Mirrors DockerProvider.requirements.
    struct Requirements: Decodable, Equatable {
        let docker: String        // running | stopped | missing
        let imageReady: Bool
        let freeGB: Double?
        let needGB: Double
    }

    func requirements() async -> Requirements? {
        try? await request("computers.requirements")
    }

    /// One step of a device being set up (download, start, controls, screen).
    struct SetupStep: Equatable {
        var status: String        // active | done | skipped | failed
        var fraction: Double?
        var error: String?
    }

    /// Setup progress by setupId, from the brain's device.setup events.
    @Published private(set) var setups: [String: [String: SetupStep]] = [:]

    func createDevice(kind: String, name: String, options: [String: String] = [:], setupId: String? = nil) async -> String? {
        do {
            var params: [String: Any] = ["kind": kind, "name": name, "options": options]
            if let setupId { params["setupId"] = setupId; setups[setupId] = [:] }
            let raw = try await call("computers.create", params)
            await refreshComputers()
            return (raw as? [String: Any])?["id"] as? String
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    /// A code another Local Bot pastes to connect to this device; nil on error (in `lastError`).
    // MARK: MCP servers

    /// Mirrors brain/src/mcp/servers.ts.
    struct McpServer: Decodable, Identifiable, Hashable {
        struct Tool: Decodable, Hashable, Identifiable {
            let name: String
            let description: String?
            var id: String { name }
        }
        struct Failure: Decodable, Hashable {
            let at: String
            let message: String
        }
        let id: String
        let name: String
        let transport: String          // http | stdio
        let url: String?
        let command: String?
        let args: [String]?
        let envKeys: [String]?
        let enabled: Bool
        let hasToken: Bool
        let state: String              // off | signin | idle | connecting | connected | error
        /// Offered to every bot (connectors).
        let allBots: Bool?
        let connector: String?
        let signingIn: Bool?
        let tools: [Tool]?
        let errors: [Failure]

        var isRemote: Bool { transport == "http" }
        /// The command line as typed, for display.
        var commandLine: String { ([command ?? ""] + (args ?? [])).joined(separator: " ") }
    }

    func refreshMcp() async {
        if let list: [McpServer] = try? await request("mcp.list") { mcpServers = list }
        if let list: [Connector] = try? await request("connectors.list") { connectors = list }
    }

    /// Mirrors brain/src/mcp/connectors.ts, with its server once connected.
    struct Connector: Decodable, Identifiable, Hashable {
        let id: String
        let name: String
        let description: String
        let url: String
        let category: String
        let server: McpServer?

        var connected: Bool { server?.state == "connected" || server?.state == "idle" || server?.state == "connecting" }
    }

    /// Starts signing in; opens the service's page in the browser.
    func connect(_ connectorID: String) async -> String? {
        do {
            let raw = try await call("connectors.connect", ["id": connectorID])
            await refreshMcp()
            guard let s = (raw as? [String: Any])?["url"] as? String, let url = URL(string: s) else { return "No sign-in page" }
            NSWorkspace.shared.open(url)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Adds or updates a server; returns its id, or nil with `lastError` set.
    func saveMcpServer(id: String?, _ params: [String: Any]) async -> (id: String?, error: String?) {
        do {
            var p = params
            if let id { p["id"] = id }
            let server: McpServer = try await request(id == nil ? "mcp.add" : "mcp.update", p)
            await refreshMcp()
            return (server.id, nil)
        } catch {
            return (nil, error.localizedDescription)
        }
    }

    /// Connects and lists the tools; returns an error message on failure.
    func testMcpServer(_ id: String) async -> String? {
        defer { Task { await refreshMcp() } }
        do { _ = try await call("mcp.test", ["id": id]); return nil } catch { return error.localizedDescription }
    }

    /// "Allow" on a chat card: the bot may use a connected app and continues.
    func allowConnector(botID: String, connectorID: String) async {
        await perform("connectors.allow", ["botId": botID, "id": connectorID])
        await refreshBots()
    }

    /// "Not now" on a chat card.
    func dismissConnect(messageID: String) async {
        await perform("connectors.dismiss", ["messageId": messageID])
    }

    /// Lets one bot use a server (or not), keeping its other servers.
    func setBotMcpServer(_ botID: String, _ serverID: String, on: Bool) async {
        guard let bot = bots.first(where: { $0.id == botID }) else { return }
        var list = (bot.mcpServers ?? []).filter { $0 != serverID }
        if on { list.append(serverID) }
        await perform("bots.update", ["id": botID, "mcpServers": list])
        await refreshBots()
    }

    func removeMcpServer(_ id: String) async {
        await perform("mcp.remove", ["id": id])
        await refreshMcp()
        await refreshBots()
    }

    /// Hides the device's own pointer while watching; shows it for Take control.
    func setDevicePointer(_ id: String, hidden: Bool) async {
        // The device screen can show up before the brain is ready.
        while !loaded && !Task.isCancelled { try? await Task.sleep(for: .milliseconds(200)) }
        _ = try? await call("computers.pointer", ["id": id, "hidden": hidden])
    }

    func shareDevice(_ id: String) async -> String? {
        do {
            let raw = try await call("computers.share", ["id": id])
            return (raw as? [String: Any])?["code"] as? String
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func renameDevice(_ id: String, to name: String) async {
        await perform("computers.rename", ["id": id, "name": name])
        await refreshComputers()
    }

    func removeDevice(_ id: String) async {
        busy.insert(id)
        defer { busy.remove(id) }
        await perform("computers.remove", ["id": id])
        await refreshComputers()
        await refreshBots()
    }

    func setPower(_ on: Bool, computer id: String) async {
        busy.insert(id)
        defer { busy.remove(id) }
        await perform(on ? "computers.start" : "computers.stop", ["id": id])
        await refreshComputers()
    }

    // MARK: Bots

    func refreshBots() async {
        let revisions = botStatusRevision
        if let list: [Bot] = try? await request("bots.list") {
            bots = list
            thinking.formIntersection(Set(list.map(\.id)))
            for bot in list where revisions[bot.id] == botStatusRevision[bot.id] {
                // An event received during this request is newer than its snapshot.
                if bot.status == "thinking" { thinking.insert(bot.id) }
                else if bot.status == "idle" { thinking.remove(bot.id) }
            }
        }
    }

    struct BotDraft {
        var name = ""
        var role = ""
        var instructions = ""
        var provider = ""
        var model = ""
        var computerId: String?
        var avatarSeed = UUID().uuidString   // replaced by a catalog spec once the editor loads
        var mcpServers: [String] = []
    }

    func createBot(_ d: BotDraft) async -> Bot? {
        var params: [String: Any] = ["name": d.name, "role": d.role, "instructions": d.instructions,
                                     "provider": d.provider, "model": d.model, "avatarSeed": d.avatarSeed]
        if let c = d.computerId { params["computerId"] = c }
        do {
            let bot: Bot = try await request("bots.create", params)
            if !d.mcpServers.isEmpty { await perform("bots.update", ["id": bot.id, "mcpServers": d.mcpServers]) }
            await refreshBots()
            return bot
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func updateBot(_ id: String, _ d: BotDraft) async {
        var patch: [String: Any] = ["id": id, "name": d.name, "role": d.role,
                                    "instructions": d.instructions, "provider": d.provider, "model": d.model]
        if !d.avatarSeed.isEmpty { patch["avatarSeed"] = d.avatarSeed }
        patch["mcpServers"] = d.mcpServers
        await perform("bots.update", patch)
        let current = bots.first { $0.id == id }?.ownedComputer
        if current != d.computerId {
            if let old = current { await perform("access.revoke", ["botId": id, "computerId": old]) }
            if let new = d.computerId {
                await perform("access.grant", ["botId": id, "computerId": new, "role": "owner"])
            }
        }
        await refreshBots()
    }

    /// role: "owner" (the bot's main device) or "guest" (shared access).
    func grantAccess(bot: String, device: String, role: String) async {
        await perform("access.grant", ["botId": bot, "computerId": device, "role": role])
    }

    func revokeAccess(bot: String, device: String) async {
        await perform("access.revoke", ["botId": bot, "computerId": device])
    }

    func regenerateAvatar(_ id: String) async { await perform("bots.regenerateAvatar", ["id": id]) }

    // MARK: Cloud brain

    struct CloudStatus: Decodable, Hashable {
        let connected: Bool
        let url: String?
        let managed: String?
        let healthy: Bool
        let bots: Int
    }

    @Published private(set) var cloudStatus: CloudStatus?
    /// Bots being moved between the Mac and the cloud right now.
    @Published private(set) var moving: Set<String> = []

    func refreshCloud() async {
        if let s: CloudStatus = try? await request("cloud.status") { cloudStatus = s }
    }

    /// Creates the cloud brain on Railway (takes a few minutes); returns an error message or nil.
    func setupCloudBrain() async -> String? {
        defer { Task { await refreshCloud() } }
        do {
            _ = try await call("cloud.setupRailway")
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func disconnectCloud(deleteBrain: Bool) async -> String? {
        defer { Task { await refreshCloud() } }
        do {
            _ = try await call("cloud.disconnect", ["deleteBrain": deleteBrain])
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Moves a bot (chat, routines, memory) to the cloud brain or back to this Mac.
    func moveBot(_ id: String, toCloud: Bool) async {
        moving.insert(id)
        await perform("cloud.moveBot", ["botId": id, "to": toCloud ? "cloud" : "mac"])
        moving.remove(id)
        await refreshBots()
        await refreshCloud()
        await loadHistory(id)
    }

    func deleteBot(_ id: String) async {
        await perform("bots.delete", ["id": id])
        messages[id] = nil
        await refreshBots()
    }

    struct AvatarOption: Decodable, Identifiable, Hashable {
        let id: String
        let label: String
        let value: String
        let svg: String
        let fill: String?
    }

    struct AvatarOptions: Decodable {
        let value: String
        let svg: String
        let face: Face
        let colors: [AvatarOption]
        let eyes: [AvatarOption]
        let mouths: [AvatarOption]
        let accessories: [AvatarOption]
        let shapes: [AvatarOption]?
    }

    /// Every catalog option rendered on top of `value` (a spec or legacy seed).
    func avatarOptions(_ value: String) async -> AvatarOptions? {
        try? await request("bots.avatarOptions", ["value": value])
    }

    func randomAvatar() async -> String? {
        try? await request("bots.randomAvatar")
    }

    func previewAvatar(seed: String) async -> String? {
        try? await request("bots.previewAvatar", ["seed": seed])
    }

    // MARK: Reset

    /// Back to a fresh install (see brain `app.reset`). Returns false on failure.
    func resetApp(removeDevices: Bool) async -> Bool {
        do {
            _ = try await call("app.reset", ["removeDevices": removeDevices])
        } catch {
            lastError = error.localizedDescription
            return false
        }
        messages = [:]
        memories = [:]
        models = [:]
        await refreshBots()
        await refreshProviders()
        await refreshRoutines()
        await refreshComputers()
        return true
    }

    // MARK: Memory

    struct Memory: Decodable, Identifiable, Hashable {
        let id: String
        let botId: String?          // nil = shared with the team
        let kind: String            // core | fact | procedure | episode
        let text: String
        let topic: String?
        let source: String          // bot | user | learned
        let importance: Int
        let createdAt: String
        let updatedAt: String
        let validTo: String?
        let useCount: Int
    }

    func refreshMemory(_ botID: String) async {
        if let list: [Memory] = try? await request("memory.list", ["botId": botID]) { memories[botID] = list }
    }

    func addMemory(bot: String, kind: String, text: String, topic: String?, team: Bool) async {
        var params: [String: Any] = ["botId": bot, "kind": kind, "text": text, "scope": team ? "team" : "me"]
        if let topic, !topic.isEmpty { params["topic"] = topic }
        await perform("memory.add", params)
        await refreshMemory(bot)
    }

    func editMemory(_ id: String, bot: String, text: String? = nil, kind: String? = nil) async {
        var params: [String: Any] = ["id": id, "botId": bot]
        if let text { params["text"] = text }
        if let kind { params["kind"] = kind }
        await perform("memory.edit", params)
        await refreshMemory(bot)
    }

    func forgetMemory(_ id: String, bot: String) async {
        await perform("memory.forget", ["id": id, "botId": bot])
        await refreshMemory(bot)
    }

    func deleteMemory(_ id: String, bot: String) async {
        await perform("memory.delete", ["id": id, "botId": bot])
        await refreshMemory(bot)
    }

    func setMemoryAuto(_ on: Bool, bot: String) async {
        await perform("bots.update", ["id": bot, "memoryAuto": on])
        await refreshBots()
    }

    // MARK: Routines

    func refreshRoutines() async {
        if let list: [Routine] = try? await request("routines.list") { routines = list }
    }

    func saveRoutine(id: String?, botId: String, name: String, task: String, schedule: Schedule, enabled: Bool) async -> Bool {
        do {
            var params: [String: Any] = ["name": name, "task": task, "schedule": schedule.json, "enabled": enabled]
            if let id { params["id"] = id } else { params["botId"] = botId }
            _ = try await call(id == nil ? "routines.create" : "routines.update", params)
            await refreshRoutines()
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func setRoutineEnabled(_ id: String, _ enabled: Bool) async {
        await perform("routines.update", ["id": id, "enabled": enabled])
        await refreshRoutines()
    }

    func runRoutineNow(_ id: String) async {
        await perform("routines.runNow", ["id": id])
        await refreshRoutines()
    }

    func deleteRoutine(_ id: String) async {
        await perform("routines.delete", ["id": id])
        await refreshRoutines()
    }

    // MARK: Chat

    private struct Page: Decodable { let messages: [Message]; let more: Bool }

    /// Opens a chat with its latest messages; older ones come with `loadOlder`.
    func loadHistory(_ botID: String) async {
        if let page: Page = try? await request("chat.page", ["botId": botID, "limit": 100]) {
            messages[botID] = page.messages
            if page.more { olderMessages.insert(botID) } else { olderMessages.remove(botID) }
        } else if let list: [Message] = try? await request("chat.history", ["botId": botID]) {
            // An older brain (e.g. a cloud brain not updated yet).
            messages[botID] = list
            olderMessages.remove(botID)
        }
    }

    /// The page before the oldest loaded message.
    func loadOlder(_ botID: String) async {
        guard olderMessages.contains(botID), !loadingOlder.contains(botID),
              let first = messages[botID]?.first else { return }
        loadingOlder.insert(botID)
        defer { loadingOlder.remove(botID) }
        guard let page: Page = try? await request("chat.page", ["botId": botID, "limit": 100, "before": first.id]) else { return }
        let known = Set((messages[botID] ?? []).map(\.id))
        messages[botID] = page.messages.filter { !known.contains($0.id) } + (messages[botID] ?? [])
        if page.more { olderMessages.insert(botID) } else { olderMessages.remove(botID) }
    }

    /// A message, with files picked, dropped or pasted (sent by path: same Mac).
    func send(_ text: String, to botID: String, files: [URL] = []) async {
        var params: [String: Any] = ["botId": botID, "text": text]
        if !files.isEmpty { params["files"] = files.map { ["name": $0.lastPathComponent, "path": $0.path] } }
        await perform("chat.send", params)
    }
    func stop(_ botID: String) async { await perform("chat.stop", ["botId": botID]) }

    func clearChat(_ botID: String) async {
        await perform("chat.clear", ["botId": botID])
        messages[botID] = []
    }

    // MARK: Providers

    func refreshProviders() async {
        providerStatus = try? await request("providers.status")
    }

    func loadModels(_ provider: String, fresh: Bool = false) async {
        guard fresh || (models[provider] ?? []).isEmpty else { return }
        do {
            let list: [Model] = try await request("providers.models", ["provider": provider])
            models[provider] = list
        } catch {
            models[provider] = []
        }
    }

    @discardableResult
    func addProvider(preset: String, label: String, baseURL: String, apiKey: String) async -> String? {
        do {
            let raw = try await call("providers.add", ["preset": preset, "label": label, "baseURL": baseURL, "apiKey": apiKey])
            await refreshProviders()
            return (raw as? [String: Any])?["id"] as? String
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    /// `apiKey == nil` keeps the stored key; an empty string removes it.
    func updateProvider(_ id: String, label: String, baseURL: String, apiKey: String?) async {
        var params: [String: Any] = ["id": id, "label": label, "baseURL": baseURL]
        if let apiKey { params["apiKey"] = apiKey }
        await perform("providers.update", params)
        models[id] = nil
        await refreshProviders()
    }

    func removeProvider(_ id: String) async {
        await perform("providers.remove", ["id": id])
        models[id] = nil
        await refreshProviders()
    }

    func testProvider(_ id: String) async -> TestResult {
        (try? await request("providers.test", ["id": id])) ?? TestResult(ok: false, models: nil, error: "No response from the brain")
    }

    func setDefault(provider: String, model: String) async {
        await perform("providers.setDefault", ["provider": provider, "model": model])
        await refreshProviders()
    }

    // MARK: Transport

    private func perform(_ method: String, _ params: [String: Any] = [:]) async {
        do { _ = try await call(method, params) } catch { lastError = error.localizedDescription }
    }

    private func request<T: Decodable>(_ method: String, _ params: [String: Any] = [:]) async throws -> T {
        let raw = try await call(method, params)
        let data = try JSONSerialization.data(withJSONObject: raw ?? NSNull(), options: .fragmentsAllowed)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func call(_ method: String, _ params: [String: Any] = [:]) async throws -> Any? {
        guard let stdin else {
            throw NSError(domain: "Brain", code: 1, userInfo: [NSLocalizedDescriptionKey: "Brain disconnected"])
        }
        let id = nextID
        nextID += 1
        var line = try JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
        line.append(0x0A)
        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            stdin.write(line)
        }
    }

    private func receive(_ objects: [[String: Any]]) {
        for obj in objects {
            if let id = obj["id"] as? Int, let cont = pending.removeValue(forKey: id) {
                if let err = obj["error"] as? String {
                    cont.resume(throwing: NSError(domain: "Brain", code: 2, userInfo: [NSLocalizedDescriptionKey: err]))
                } else {
                    cont.resume(returning: obj["result"] is NSNull ? nil : obj["result"])
                }
            } else if let event = obj["event"] as? String {
                handle(event: event, data: obj["data"])
            }
        }
    }

    private func decode<T: Decodable>(_ value: Any?) -> T? {
        guard let value, !(value is NSNull),
              let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func handle(event: String, data: Any?) {
        switch event {
        case "message", "message.done":
            guard let msg: Message = decode(data) else { return }
            var list = messages[msg.botId] ?? []
            // A reply that was only tool calls has no text; drop its placeholder.
            if event == "message.done", (data as? [String: Any])?["empty"] as? Bool == true {
                list.removeAll { $0.id == msg.id }
                messages[msg.botId] = list
                return
            }
            if let i = list.firstIndex(where: { $0.id == msg.id }) {
                // The final message carries the full text; keep streamed text if it's empty.
                // Cards (connect, files) have no text but do change (connected, dismissed).
                if !msg.text.isEmpty || msg.error != nil || msg.connect != nil || msg.files != nil { list[i] = msg }
            } else {
                list.append(msg)
            }
            messages[msg.botId] = list
        case "message.delta":
            guard let d = data as? [String: Any], let id = d["id"] as? String,
                  let botID = d["botId"] as? String, let delta = d["delta"] as? String,
                  let i = messages[botID]?.firstIndex(where: { $0.id == id }) else { return }
            messages[botID]?[i].text += delta
        case "bot.status":
            guard let d = data as? [String: Any], let id = d["botId"] as? String else { return }
            botStatusRevision[id, default: 0] += 1
            if d["status"] as? String == "thinking" { thinking.insert(id) } else { thinking.remove(id) }
        case "bots":
            Task { await refreshBots(); await refreshComputers() }
        case "computers":
            Task { await refreshComputers() }
        case "routines":
            Task { await refreshRoutines() }
        case "memory":
            if let botID = (data as? [String: Any])?["botId"] as? String, memories[botID] != nil {
                Task { await refreshMemory(botID) }
            }
        case "providers":
            Task { await refreshProviders() }
        case "cloud":
            Task { await refreshCloud() }
        case "mcp":
            Task { await refreshMcp() }
        case "device.setup":
            guard let d = data as? [String: Any], let id = d["setupId"] as? String,
                  let step = d["step"] as? String, let status = d["status"] as? String else { return }
            var steps = setups[id] ?? [:]
            steps[step] = SetupStep(status: status, fraction: d["fraction"] as? Double, error: d["error"] as? String)
            setups[id] = steps
        case "routine.finished":
            Notifier.shared.routineFinished(data)
        default:
            break
        }
    }
}

extension ISO8601DateFormatter {
    /// The brain writes dates with milliseconds (JavaScript's toISOString).
    static let withFractions: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

/// Splits the brain's output into JSON lines and parses them, off the main
/// thread. Only the new bytes are searched for the end of a line, so a reply
/// of many megabytes arriving in small chunks costs one pass, not one per chunk.
/// Used from one pipe's handler, which runs serially.
final class LineReader: @unchecked Sendable {
    private var buffer = Data()
    private var scanned = 0

    func feed(_ data: Data) -> [[String: Any]] {
        buffer.append(data)
        var objects: [[String: Any]] = []
        while let newline = buffer[(buffer.startIndex + scanned)...].firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { objects.append(obj) }
            buffer = Data(buffer[(newline + 1)...])
            scanned = 0
        }
        scanned = buffer.count
        return objects
    }
}
