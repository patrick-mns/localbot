import Containerization
import ContainerizationOCI
import Foundation

// SPIKE: create the Cua device with the embedded framework (no `container`
// CLI), print its IP, run a command as `cua`, then keep it running.
// Usage: LocalBotRuntime <kernel path>
setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
guard args.count > 1 else { fatalError("usage: LocalBotRuntime <vmlinux>") }
let root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".local-bot/runtime-spike")

var manager = try await ContainerManager(
    kernel: Kernel(path: URL(fileURLWithPath: args[1]), platform: .linuxArm),
    initfsReference: "ghcr.io/apple/containerization/vminit:0.52.1",
    root: root,
    network: try VmnetNetwork()
)

let id = "lb-spike"
var ip = "?"
let started = Date()
// Reuse the device's disk when it's already there (a restart); else unpack the image.
let rootfsPath = root.appendingPathComponent("containers/\(id)/rootfs.ext4").path
let configure: (inout LinuxContainer.Configuration) throws -> Void = { config in
    config.cpus = 4
    config.memoryInBytes = 4.gib()
    config.hostname = id
    config.process.environmentVariables.append("VNC_PW=spikepass1")
    // Firefox needs more than the default 64 MB of /dev/shm (docker --shm-size=1g).
    config.mounts = config.mounts.map { m in
        m.destination == "/dev/shm"
            ? .any(type: "tmpfs", source: "tmpfs", destination: "/dev/shm", options: ["nosuid", "nodev", "mode=1777", "size=1g"])
            : m
    }
    ip = config.interfaces.first.map { "\($0.ipv4Address)" } ?? "?"
    // Docker writes /etc/hosts (localhost and the container's own name); the
    // desktop's VNC server needs it.
    var hosts = Hosts.default
    if let address = config.interfaces.first?.ipv4Address.address {
        hosts.entries.append(.init(ipAddress: "\(address)", hostnames: [id]))
    }
    config.hosts = hosts
    let log = FileLog(path: root.appendingPathComponent("main.log").path)
    config.process.stdout = log
    config.process.stderr = log
    print("process: \(config.process.arguments) user=\(config.process.user.username)/\(config.process.user.uid) cwd=\(config.process.workingDirectory)")
    print("env: \(config.process.environmentVariables)")
}
let container: LinuxContainer
if FileManager.default.fileExists(atPath: rootfsPath) {
    try? manager.releaseNetwork(id)
    let image = try await manager.imageStore.get(reference: "docker.io/trycua/xfce-cua:latest")
    container = try await manager.create(id, image: image, rootfs: .block(format: "ext4", source: rootfsPath, destination: "/", options: []), configuration: configure)
} else {
    container = try await manager.create(id, reference: "docker.io/trycua/xfce-cua:latest", rootfsSizeInBytes: 16.gib(), configuration: configure)
}
print("created in \(Int(Date().timeIntervalSince(started)))s, IP \(ip)")
try await container.create()
try await container.start()
print("started in \(Int(Date().timeIntervalSince(started)))s")

final class FileLog: Writer, @unchecked Sendable {
    let handle: FileHandle
    init(path: String) {
        FileManager.default.createFile(atPath: path, contents: nil)
        handle = FileHandle(forWritingAtPath: path)!
    }
    func write(_ d: Data) throws { handle.write(d) }
    func close() throws {}
}

// `docker exec -u cua -e DISPLAY=:1 … sh -c '…'`
final class Collect: Writer, @unchecked Sendable {
    var data = Data()
    func write(_ d: Data) throws { data.append(d) }
    func close() throws {}
}
let out = Collect()
let process = try await container.exec("whoami") { config in
    config.arguments = ["sh", "-c", "whoami; echo DISPLAY=$DISPLAY; id"]
    config.user = .init(username: "cua")
    config.environmentVariables = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "DISPLAY=:1", "HOME=/home/cua"]
    config.stdout = out
}
try await process.start()
let status = try await process.wait()
try await process.delete()
print("exec exit \(status.exitCode): \(String(decoding: out.data, as: UTF8.self))")
try await Task.sleep(for: .seconds(20))
let diag = Collect()
let ps = try await container.exec("diag") { config in
    config.arguments = ["sh", "-c", "cat /etc/hosts; echo ---; ps aux | grep -E 'Xvnc|Xtigervnc|websockify|xfce4-session' | grep -v grep | awk '{print $11, $12}'; echo ---; (ss -ltn || netstat -ltn) 2>/dev/null | grep -E '5901|6901'; tail -15 /home/cua/.vnc/*.log 2>/dev/null"]
    config.stdout = diag
    config.stderr = diag
}
try await ps.start()
_ = try await ps.wait()
try await ps.delete()
print(String(decoding: diag.data, as: UTF8.self))
print("running; open http://\(ip.split(separator: "/").first ?? ""):6901/vnc_lite.html (Ctrl-C to stop)")
_ = try await container.wait()
