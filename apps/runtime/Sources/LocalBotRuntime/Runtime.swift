import Containerization
import ContainerizationExtras
import ContainerizationOCI
import Darwin
import Foundation

/// The devices: their settings on disk (devices.json, next to each one's
/// root filesystem), the running VMs in memory. A device is created once
/// (image unpacked into its own ext4 disk) and then started from that disk,
/// which takes about a second.
actor Runtime {
    struct Device: Codable {
        var id: String
        var image: String
        var cpus: Int
        var memoryMiB: UInt64
        var shmMiB: Int
        /// Extra environment for the device's main process (e.g. VNC_PW).
        var env: [String]
        var labels: [String: String]
        var createdAt: Date
        /// The image's own environment, also given to commands (like docker exec).
        var imageEnv: [String]?
    }

    private struct Running {
        let container: LinuxContainer
        let ip: String
    }

    static let initfs = "ghcr.io/apple/containerization/vminit:0.52.1"

    private let root: URL
    /// A value type that also tracks the network's addresses: every change
    /// goes through `mutate`, one at a time, so two devices starting together
    /// can't get the same IP.
    private var manager: ContainerManager
    private let managerLock = AsyncLock()
    private var devices: [String: Device] = [:]
    private var running: [String: Running] = [:]
    /// Commands started with `detach` (e.g. Cua Driver's daemon), until they exit.
    private var detached: [String: LinuxProcess] = [:]
    /// Starts in progress, so two callers don't boot the same device twice.
    private var starting: [String: Task<Running, Error>] = [:]

    init(root: URL, kernel: URL) async throws {
        self.root = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        manager = try await ContainerManager(
            kernel: Kernel(path: kernel, platform: .linuxArm),
            initfsReference: Self.initfs,
            root: root,
            network: try VmnetNetwork()
        )
        devices = Self.load(root)
    }

    // MARK: Requests

    func handle(_ method: String, _ p: [String: Any], emit: @escaping Server.Emit) async throws -> Any {
        switch method {
        case "ping":
            return ["version": version]
        case "images.has":
            return await hasImage(try string(p, "image"))
        case "images.pull":
            try await pull(try string(p, "image"), emit: emit)
            return true
        case "ls":
            return devices.values.sorted { $0.createdAt < $1.createdAt }.map(view)
        case "create":
            return view(try await create(p, emit: emit))
        case "start":
            let id = try string(p, "id")
            _ = try await start(id)
            return view(try device(id))
        case "stop":
            try await stop(try string(p, "id"))
            return true
        case "rm":
            try await remove(try string(p, "id"))
            return true
        case "exec":
            return try await exec(p)
        default:
            throw RuntimeError("Unknown method \(method)")
        }
    }

    /// Stops every running device (the helper is quitting).
    func shutdown() async {
        for id in Array(running.keys) { try? await stop(id) }
    }

    // MARK: Images

    private func hasImage(_ reference: String) async -> Bool {
        (try? await manager.imageStore.get(reference: reference)) != nil
    }

    private func pull(_ reference: String, emit: @escaping Server.Emit) async throws {
        if await hasImage(reference) { return }
        let progress = Progress(emit: emit)
        _ = try await manager.imageStore.pull(reference: reference, platform: .current, progress: progress.handler)
    }

    // MARK: Devices

    private func create(_ p: [String: Any], emit: @escaping Server.Emit) async throws -> Device {
        let id = try string(p, "id")
        guard id.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$"#, options: .regularExpression) != nil else {
            throw RuntimeError("Invalid device id \(id)")
        }
        guard devices[id] == nil else { throw RuntimeError("A device named \(id) already exists") }
        var dev = Device(
            id: id,
            image: try string(p, "image"),
            cpus: p["cpus"] as? Int ?? 4,
            memoryMiB: UInt64(p["memoryMiB"] as? Int ?? 4096),
            shmMiB: p["shmMiB"] as? Int ?? 1024,
            env: p["env"] as? [String] ?? [],
            labels: p["labels"] as? [String: String] ?? [:],
            createdAt: Date(),
            imageEnv: nil
        )
        try await pull(dev.image, emit: emit)
        let image = try await manager.imageStore.get(reference: dev.image)
        let diskGiB = UInt64(p["diskGiB"] as? Int ?? 16)
        emit("progress", ["step": "unpack"])
        var captured: (ip: String, env: [String]) = ("", [])
        let container = try await mutate { m in
            try await m.create(id, image: image, rootfsSizeInBytes: diskGiB.gib()) { config in
                captured = Self.configure(&config, dev)
            }
        }
        dev.imageEnv = captured.env
        devices[id] = dev
        save()
        try await boot(container, ip: captured.ip, id: id)
        return dev
    }

    private func start(_ id: String) async throws -> Running {
        if let r = running[id] { return r }
        if let task = starting[id] { return try await task.value }
        let dev = try device(id)
        let task = Task<Running, Error> {
            let disk = self.root.appendingPathComponent("containers/\(id)/rootfs.ext4").path
            guard FileManager.default.fileExists(atPath: disk) else { throw RuntimeError("\(id)'s disk is missing") }
            let image = try await self.manager.imageStore.get(reference: dev.image)
            var captured: (ip: String, env: [String]) = ("", [])
            let container = try await self.makeContainer(id, image: image, disk: disk) { config in
                captured = Self.configure(&config, dev)
            }
            try await self.boot(container, ip: captured.ip, id: id)
            return self.running[id]!
        }
        starting[id] = task
        defer { starting[id] = nil }
        return try await task.value
    }

    private func makeContainer(_ id: String, image: Containerization.Image, disk: String,
                               configure: @escaping (inout LinuxContainer.Configuration) throws -> Void) async throws -> LinuxContainer {
        return try await mutate { m in
            try? m.releaseNetwork(id)
            return try await m.create(id, image: image, rootfs: .block(format: "ext4", source: disk, destination: "/", options: []),
                                      configuration: configure)
        }
    }

    private func boot(_ container: LinuxContainer, ip: String, id: String) async throws {
        do {
            try await container.create()
            try await container.start()
        } catch {
            await release(id)
            throw error
        }
        running[id] = Running(container: container, ip: ip)
        // The device stopping by itself (a shutdown inside it) is noticed too.
        Task {
            _ = try? await container.wait()
            await self.exited(id, container)
        }
    }

    private func exited(_ id: String, _ container: LinuxContainer) async {
        guard running[id]?.container === container else { return }
        running[id] = nil
        await release(id)
    }

    private func release(_ id: String) async {
        _ = try? await mutate { m in try m.releaseNetwork(id) }
    }

    private func mutate<T>(_ body: (inout ContainerManager) async throws -> T) async throws -> T {
        await managerLock.lock()
        var m = manager
        do {
            let result = try await body(&m)
            manager = m
            await managerLock.unlock()
            return result
        } catch {
            manager = m
            await managerLock.unlock()
            throw error
        }
    }

    private func stop(_ id: String) async throws {
        guard let r = running.removeValue(forKey: id) else { return }
        for (key, process) in detached where key.hasPrefix("\(id)/") {
            detached[key] = nil
            try? await process.kill(.kill)
        }
        try? await r.container.stop()
        await release(id)
    }

    private func remove(_ id: String) async throws {
        try await stop(id)
        guard devices.removeValue(forKey: id) != nil else { return }
        save()
        _ = try? await mutate { m in try m.delete(id) }
    }

    /// Docker sets these up on its own: /etc/hosts (the desktop's VNC server
    /// won't start without it), a 1 GB /dev/shm (Firefox), CPUs and memory.
    private static func configure(_ config: inout LinuxContainer.Configuration, _ dev: Device) -> (ip: String, env: [String]) {
        config.cpus = dev.cpus
        config.memoryInBytes = dev.memoryMiB.mib()
        config.hostname = dev.id
        let imageEnv = config.process.environmentVariables
        config.process.environmentVariables = merge(imageEnv, dev.env)
        config.mounts = config.mounts.map { m in
            m.destination == "/dev/shm"
                ? .any(type: "tmpfs", source: "tmpfs", destination: "/dev/shm",
                       options: ["nosuid", "nodev", "mode=1777", "size=\(dev.shmMiB)m"])
                : m
        }
        var hosts = Hosts.default
        let ip = config.interfaces.first.map { "\($0.ipv4Address.address)" } ?? ""
        if !ip.isEmpty { hosts.entries.append(.init(ipAddress: ip, hostnames: [dev.id])) }
        config.hosts = hosts
        return (ip, imageEnv)
    }

    // MARK: Commands

    /// `docker exec [-d] [-u user] [-e K=V] id args…`: stdout and stderr come
    /// back base64-encoded (screenshots are binary), with the exit code.
    private func exec(_ p: [String: Any]) async throws -> Any {
        let id = try string(p, "id")
        guard let args = p["args"] as? [String], !args.isEmpty else { throw RuntimeError("exec needs args") }
        let dev = try device(id)
        guard let r = running[id] else { throw RuntimeError("\(id) is not running") }
        let user = p["user"] as? String ?? "root"
        let env = Self.merge(Self.merge(dev.imageEnv ?? [], dev.env), p["env"] as? [String] ?? [])
        let detach = p["detach"] as? Bool ?? false
        let timeout = (p["timeoutMs"] as? Int).map { Int64(max(1, $0 / 1000)) }
        let out = Collect(), err = Collect()
        let execId = "\(id)/\(UUID().uuidString.prefix(8))"
        let process = try await r.container.exec(String(execId.split(separator: "/").last!)) { config in
            config.arguments = args
            config.user = .init(username: user)
            config.environmentVariables = env
            if let cwd = p["cwd"] as? String { config.workingDirectory = cwd }
            else if user != "root" { config.workingDirectory = "/home/\(user)" }
            if !detach {
                config.stdout = out
                config.stderr = err
            }
        }
        try await process.start()
        if detach {
            detached[execId] = process
            Task {
                _ = try? await process.wait()
                try? await process.delete()
                await self.forget(execId)
            }
            return ["code": 0, "stdout": "", "stderr": ""]
        }
        var code: Int32
        var timedOut = false
        do {
            code = try await process.wait(timeoutInSeconds: timeout).exitCode
        } catch {
            // Past its time: stop it and say so, like a killed command.
            timedOut = true
            try? await process.kill(.kill)
            code = 124
        }
        try? await process.delete()
        return [
            "code": Int(code),
            "timedOut": timedOut,
            "stdout": out.data.base64EncodedString(),
            "stderr": err.data.base64EncodedString(),
        ]
    }

    private func forget(_ execId: String) { detached[execId] = nil }

    // MARK: Helpers

    private func view(_ dev: Device) -> [String: Any] {
        [
            "id": dev.id,
            "image": dev.image,
            "labels": dev.labels,
            "state": running[dev.id] != nil ? "running" : "stopped",
            "ip": running[dev.id]?.ip ?? "",
            "cpus": dev.cpus,
            "memoryMiB": dev.memoryMiB,
            "createdAt": ISO8601DateFormatter().string(from: dev.createdAt),
        ]
    }

    private func device(_ id: String) throws -> Device {
        guard let d = devices[id] else { throw RuntimeError("No device named \(id)") }
        return d
    }

    private func string(_ p: [String: Any], _ key: String) throws -> String {
        guard let v = p[key] as? String, !v.isEmpty else { throw RuntimeError("Missing \(key)") }
        return v
    }

    /// Later KEY=VALUE entries replace earlier ones with the same key.
    private static func merge(_ base: [String], _ extra: [String]) -> [String] {
        var out = base
        for e in extra {
            let key = e.split(separator: "=", maxSplits: 1).first.map(String.init) ?? e
            out.removeAll { $0.hasPrefix("\(key)=") || $0 == key }
            out.append(e)
        }
        return out
    }

    private var file: URL { root.appendingPathComponent("devices.json") }

    private static func load(_ root: URL) -> [String: Device] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let data = try? Data(contentsOf: root.appendingPathComponent("devices.json")),
              let list = try? decoder.decode([Device].self, from: data) else { return [:] }
        return Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(Array(devices.values)) {
            try? data.write(to: file, options: .atomic)
        }
    }
}

/// A command's output, gathered in memory.
final class Collect: Writer, @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    var data: Data { lock.lock(); defer { lock.unlock() }; return buffer }
    func write(_ d: Data) throws { lock.lock(); buffer.append(d); lock.unlock() }
    func close() throws {}
}

/// Image download progress, as a fraction, sent at most a few times a second.
final class Progress: @unchecked Sendable {
    private let emit: Server.Emit
    private let lock = NSLock()
    private var size: Int64 = 0, total: Int64 = 0
    private var last = Date.distantPast

    init(emit: @escaping Server.Emit) { self.emit = emit }

    var handler: ProgressHandler {
        { [self] events in
            lock.lock()
            for e in events {
                switch e {
                case .addSize(let n): size += n
                case .addTotalSize(let n): total += n
                default: break
                }
            }
            let now = Date()
            let send = total > 0 && now.timeIntervalSince(last) > 0.25
            if send { last = now }
            let fraction = total > 0 ? Double(size) / Double(total) : 0
            lock.unlock()
            if send { emit("progress", ["step": "download", "fraction": min(1, fraction)]) }
        }
    }
}

/// A first-come, first-served lock for async code.
actor AsyncLock {
    private var held = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func lock() async {
        if !held { held = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func unlock() {
        if waiters.isEmpty { held = false } else { waiters.removeFirst().resume() }
    }
}
