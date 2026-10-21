import Darwin
import Foundation

/// localbot-runtime: Local Bot's Linux devices without Docker. A long-running
/// helper (a VM lives as long as the process that started it) that serves
/// the brain over ~/.local-bot/runtime.sock, one JSON object per line:
///   request  {id, method, params}  ->  {id, result} | {id, error}
///   event    {id, event, data}      (progress of a request, e.g. a pull)
/// Devices are the Cua desktop image (trycua/xfce-cua) run with Apple's
/// Containerization, one lightweight VM each, kept in ~/.local-bot/runtime.

setvbuf(stdout, nil, _IOLBF, 0)
setvbuf(stderr, nil, _IOLBF, 0)

let version = "0.1.0"
if CommandLine.arguments.contains("--version") {
    print(version)
    exit(0)
}

let home = URL(fileURLWithPath: ProcessInfo.processInfo.environment["LOCALBOT_HOME"]
    ?? NSHomeDirectory() + "/.local-bot")
let socketPath = home.appendingPathComponent("runtime.sock").path

// One runtime per data folder: if one already answers, leave it be.
if Server.isAlive(socketPath) {
    log("another runtime is already running")
    exit(0)
}

do {
    let kernel = try Kernels.find()
    let runtime = try await Runtime(root: home.appendingPathComponent("runtime"), kernel: kernel)
    let server = Server(path: socketPath) { method, params, emit in
        try await runtime.handle(method, params, emit: emit)
    }
    try server.listen()

    // Stopping the helper stops its devices cleanly first.
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let signals = [SIGTERM, SIGINT].map { DispatchSource.makeSignalSource(signal: $0, queue: .main) }
    for source in signals {
        source.setEventHandler {
            Task {
                await runtime.shutdown()
                unlink(socketPath)
                exit(0)
            }
        }
        source.resume()
    }
    log("ready (\(version)) on \(socketPath), kernel \(kernel.lastPathComponent)")
    while true { try await Task.sleep(for: .seconds(3600)) }
} catch {
    log("failed to start: \(error)")
    exit(1)
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("[runtime] \(message)\n".utf8))
}
