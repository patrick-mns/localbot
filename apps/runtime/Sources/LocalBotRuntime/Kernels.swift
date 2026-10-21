import Foundation

/// The Linux kernel the device VMs boot: shipped inside Local Bot.app
/// (Contents/Resources/runtime/vmlinux), or LOCALBOT_KERNEL; a development
/// Mac can use the one Apple's `container` CLI installed.
enum Kernels {
    static func find() throws -> URL {
        let env = ProcessInfo.processInfo.environment
        var candidates: [URL] = []
        if let path = env["LOCALBOT_KERNEL"] { candidates.append(URL(fileURLWithPath: path)) }
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        // Contents/Helpers/localbot-runtime → Contents/Resources/runtime/vmlinux
        candidates.append(exe.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Resources/runtime/vmlinux"))
        candidates.append(URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/com.apple.container/kernels/default.kernel-arm64"))
        for url in candidates where FileManager.default.fileExists(atPath: url.resolvingSymlinksInPath().path) {
            return url.resolvingSymlinksInPath()
        }
        throw RuntimeError("No Linux kernel found for devices (looked in \(candidates.map(\.path)))")
    }
}

struct RuntimeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
