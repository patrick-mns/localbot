import SwiftUI

/// Settings → Connectors: apps bots can use after a sign-in in the browser.
/// Each is an MCP server underneath; the technical setup is in MCP Servers.
struct ConnectorsPage: View {
    @ObservedObject var brain: Brain
    /// Opens a connected one's page (tools, who can use it, disconnect).
    let open: (String) -> Void
    @State private var errors: [String: String] = [:]

    private let categories = ["Work", "Design", "Media", "Developer", "Business"]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(title: "Connectors",
                       subtitle: "Let bots use your apps. Sign in once in the browser; bots use them when a task needs it.",
                       icon: "square.grid.2x2")
            ForEach(categories, id: \.self) { category in
                let items = brain.connectors.filter { $0.category == category }
                if !items.isEmpty {
                    Text(category).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
                        .padding(.leading, 4).padding(.bottom, 8)
                    // Two fixed columns and fixed-height tiles: hovering never re-lays out the grid.
                    Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                        ForEach(Array(stride(from: 0, to: items.count, by: 2)), id: \.self) { i in
                            GridRow {
                                ForEach(items[i..<min(i + 2, items.count)]) { c in
                                    tile(c)
                                }
                                if i + 1 == items.count { Color.clear.gridCellUnsizedAxes([.horizontal, .vertical]) }
                            }
                        }
                    }
                    .padding(.bottom, 20)
                }
            }
            Text("More apps are coming. Anything else that speaks MCP can be added in MCP Servers.")
                .font(.system(size: 11)).foregroundStyle(Theme.tertiary)
        }
        .task { await brain.refreshMcp() }
    }

    private func tile(_ c: Brain.Connector) -> some View {
        ConnectorTile(connector: c, error: errors[c.id]) {
            if let server = c.server, c.connected {
                open(server.id)
            } else {
                errors[c.id] = nil
                Task { errors[c.id] = await brain.connect(c.id) }
            }
        }
    }
}

private struct ConnectorTile: View {
    let connector: Brain.Connector
    let error: String?
    let action: () -> Void
    @State private var hovering = false

    private var signingIn: Bool { connector.server?.signingIn == true }
    private var failed: Bool { connector.server?.state == "error" }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                ConnectorLogo(id: connector.id, name: connector.name)
                VStack(alignment: .leading, spacing: 2) {
                    Text(connector.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
                    Text(error ?? connector.description).font(.system(size: 11))
                        .foregroundStyle(error == nil ? Theme.secondary : Theme.warn).lineLimit(2)
                }
                Spacer(minLength: 6)
                status
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 62, maxHeight: 62)
            .background(RoundedRectangle(cornerRadius: 12).fill(hovering ? Theme.raised : Theme.surface))
            .hairline(12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { over in
            // No implicit animation: a hover only changes the fill.
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) { hovering = over }
        }
        .accessibilityLabel("\(connector.name), \(connector.connected ? "connected" : "not connected")")
    }

    @ViewBuilder private var status: some View {
        if signingIn {
            HStack(spacing: 5) {
                ProgressView().controlSize(.mini)
                Text("Signing in…").font(.system(size: 11)).foregroundStyle(Theme.secondary)
            }
        } else if connector.connected {
            Label("Connected", systemImage: "checkmark.circle.fill")
                .font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.live)
        } else {
            Text(connector.server == nil ? "Connect" : (failed ? "Retry" : "Reconnect"))
                .font(.system(size: 11, weight: .medium))
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Capsule().fill(Theme.text))
                .foregroundStyle(Theme.onText)
        }
    }
}

/// The service's logo, or its initial when there's none.
struct ConnectorLogo: View {
    let id: String
    let name: String
    var size: CGFloat = 34

    var body: some View {
        Group {
            if let logo = ConnectorLogos.image(id) {
                Image(nsImage: logo).renderingMode(.template).resizable().scaledToFit()
                    .padding(size * 0.22)
            } else {
                Text(String(name.prefix(1))).font(.system(size: size * 0.42, weight: .semibold))
            }
        }
        .frame(width: size, height: size)
        .background(RoundedRectangle(cornerRadius: size * 0.26).fill(Theme.raised))
    }
}

/// In the chat: the bot asks to connect (or allow) an app it needs.
struct ConnectCard: View {
    let request: Brain.Message.ConnectRequest
    let messageID: String
    let botID: String
    @EnvironmentObject private var model: AppModel
    @State private var error: String?

    private var brain: Brain { model.brain }
    private var server: Brain.McpServer? { brain.connectors.first { $0.id == request.connector }?.server }
    private var signingIn: Bool { server?.signingIn == true }

    var body: some View {
        HStack(spacing: 12) {
            ConnectorLogo(id: request.connector, name: request.name, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13, weight: .medium))
                Text(error ?? detail).font(.system(size: 11))
                    .foregroundStyle(error == nil ? Theme.secondary : Theme.warn)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            actions
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.sidebar))
        .hairline(12)
        .opacity(request.state == "dismissed" ? 0.6 : 1)
        .frame(maxWidth: 440, alignment: .leading)
    }

    private var title: String {
        switch request.state {
        case "connected": return "\(request.name) connected"
        case "dismissed": return "\(request.name) not connected"
        default:
            if signingIn { return "Connecting \(request.name)…" }
            return request.mode == "allow" ? "Use \(request.name) here?" : "Connect \(request.name)"
        }
    }

    private var detail: String {
        switch request.state {
        case "connected": return "Available to this bot · manage in Settings → Connectors"
        case "dismissed": return "You can connect it later in Settings → Connectors."
        default:
            if signingIn { return "Finish signing in in your browser, then come back." }
            if request.mode == "allow" { return request.reason ?? "It’s connected, but not on for this bot." }
            return request.reason ?? request.description
        }
    }

    @ViewBuilder private var actions: some View {
        switch request.state {
        case "connected":
            Label("Connected", systemImage: "checkmark.circle.fill")
                .font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.live)
        case "dismissed":
            EmptyView()
        default:
            HStack(spacing: 6) {
                if !signingIn {
                    PillButton(title: "Not now", systemImage: "xmark") {
                        Task { await brain.dismissConnect(messageID: messageID) }
                    }
                    .environment(\.compactPills, false)
                }
                if request.mode == "allow" {
                    PillButton(title: "Allow", systemImage: "checkmark", prominent: true) {
                        Task { await brain.allowConnector(botID: botID, connectorID: request.connector) }
                    }
                } else {
                    PillButton(title: signingIn ? "Open again" : "Connect", systemImage: "arrow.up.forward.app", prominent: !signingIn) {
                        error = nil
                        Task { error = await brain.connect(request.connector) }
                    }
                }
            }
        }
    }
}
