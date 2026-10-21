import Darwin
import Foundation

/// A Unix socket server speaking JSON lines. Each request runs in its own
/// task, so a long one (a pull, a slow command) never holds up the others.
final class Server: @unchecked Sendable {
    typealias Emit = @Sendable (_ event: String, _ data: Any) -> Void
    typealias Handler = @Sendable (_ method: String, _ params: [String: Any], _ emit: @escaping Emit) async throws -> Any

    private let path: String
    private let handler: Handler

    init(path: String, handler: @escaping Handler) {
        self.path = path
        self.handler = handler
    }

    /// Whether something already answers on `path`.
    static func isAlive(_ path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = address(path)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        return ok == 0
    }

    func listen() throws {
        // sun_path holds 104 bytes; a longer path would be silently cut.
        guard path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
            throw RuntimeError("Socket path too long (\(path.utf8.count) bytes): \(path)")
        }
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw RuntimeError("socket() failed") }
        var addr = Self.address(path)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0 else { throw RuntimeError("bind(\(path)) failed: \(String(cString: strerror(errno)))") }
        chmod(path, 0o600)
        guard Darwin.listen(fd, 16) == 0 else { throw RuntimeError("listen() failed") }
        Thread.detachNewThread { [self] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 { continue }
                Thread.detachNewThread { [self] in serve(client) }
            }
        }
    }

    private func serve(_ fd: Int32) {
        let out = LineWriter(fd: fd)
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(chunk, count: n)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                dispatch(line, out)
            }
        }
        out.close()
    }

    private func dispatch(_ line: Data, _ out: LineWriter) {
        guard let req = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let method = req["method"] as? String else { return }
        let id = req["id"] ?? NSNull()
        let params = req["params"] as? [String: Any] ?? [:]
        let handler = self.handler
        let emit: Emit = { event, data in out.send(["id": id, "event": event, "data": data]) }
        Task {
            do {
                let result = try await handler(method, params, emit)
                out.send(["id": id, "result": result])
            } catch {
                out.send(["id": id, "error": "\(error)"])
            }
        }
    }

    private static func address(_ path: String) -> sockaddr_un {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8.prefix(MemoryLayout.size(ofValue: addr.sun_path) - 1))
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        return addr
    }
}

/// Writes whole lines to a socket from any thread.
final class LineWriter: @unchecked Sendable {
    private let fd: Int32
    private let lock = NSLock()
    private var closed = false

    init(fd: Int32) { self.fd = fd }

    func send(_ object: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = write(fd, raw.baseAddress! + offset, raw.count - offset)
                if n <= 0 { break }
                offset += n
            }
        }
    }

    func close() {
        lock.lock()
        closed = true
        lock.unlock()
        Darwin.close(fd)
    }
}
