import SwiftUI

struct Sidebar: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    @ObservedObject var updater: Updater

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Title-bar row: traffic lights, then the sidebar toggle at a fixed
            // spot that doesn't move when the sidebar hides.
            HStack(spacing: 6) {
                PanelToggle(side: .leading)
                Spacer()
            }
            .padding(.leading, sidebarToggleInset)
            .frame(height: titleBarHeight)
            .dragsWindow()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    section("Bots", action: ("plus", "New bot", { model.sheet = .library })) {
                        if brain.bots.isEmpty {
                            Button { model.sheet = .library } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "plus").font(.system(size: 11, weight: .semibold))
                                        .frame(width: 28, height: 28)
                                        .background(RoundedRectangle(cornerRadius: 7).stroke(Theme.border, style: .init(dash: [3])))
                                    Text("Create bot").font(.system(size: 13)).foregroundStyle(Theme.secondary)
                                    Spacer()
                                }
                                .padding(6)
                            }
                            .buttonStyle(.plain)
                        }
                        ForEach(brain.bots) { bot in
                            Row(selected: model.selection == .bot(bot.id)) {
                                AnimatedFace(face: bot.face, size: 28, working: brain.thinking.contains(bot.id), seed: bot.id)
                                VStack(alignment: .leading, spacing: 1) {
                                    HStack(spacing: 4) {
                                        Text(bot.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
                                        if bot.inCloud {
                                            Image(systemName: "cloud.fill").font(.system(size: 9))
                                                .foregroundStyle(Theme.tertiary)
                                                .help("Lives in the cloud: keeps working with the app closed")
                                        }
                                    }
                                    Text(brain.thinking.contains(bot.id) ? "Working…" : (bot.role.isEmpty ? "Bot" : bot.role))
                                        .font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                if brain.thinking.contains(bot.id) { ProgressView().controlSize(.mini) }
                            } action: {
                                model.selection = .bot(bot.id)
                            }
                            .contextMenu { BotMenuItems(bot: bot) }
                        }
                    }

                    section("Devices", action: ("plus", "Add device", { model.sheet = .newDevice })) {
                        ForEach(brain.computers) { computer in
                            Row(selected: model.selection == .computer(computer.id)) {
                                Image(systemName: computer.symbol)
                                    .font(.system(size: 11)).foregroundStyle(Theme.secondary)
                                    .frame(width: 28, height: 28)
                                    .background(RoundedRectangle(cornerRadius: 7).fill(Theme.surface))
                                    .hairline(7)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(computer.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
                                    Text(subtitle(computer)).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                Circle().fill(stateColor(computer.state)).frame(width: 6, height: 6)
                            } action: {
                                model.selection = .computer(computer.id)
                            }
                            .contextMenu {
                                Button("Rename") { model.rename(computer) }
                                Button("Add bots") { model.sheet = .addBots(computer.id) }
                                Divider()
                                Button("Remove device", role: .destructive) { model.removingDevice = computer }
                            }
                        }
                    }
                }
                .padding(.horizontal, 8)
                .thinScrollers()
            }
            .fadesUnderTopBar(Theme.sidebar, height: 12)

            Spacer(minLength: 0)
            if let version = updater.available {
                UpdateBanner(version: version) { updater.checkForUpdates() }
                    .padding(.horizontal, 12).padding(.top, 8)
            }
            HStack {
                ToolbarButton(systemImage: "gearshape", help: "Settings") { model.sheet = .settings }
                    .overlay(alignment: .topTrailing) {
                        // Nudge when no AI provider is ready (or the brain is down).
                        if !brain.connected || brain.providerStatus?.configured != true {
                            Circle().fill(brain.connected ? Theme.warn : Theme.danger)
                                .frame(width: 8, height: 8)
                                .overlay(Circle().stroke(Theme.sidebar, lineWidth: 2))
                                .offset(x: 1, y: -1)
                        }
                    }
                Spacer()
            }
            .padding(12)
        }
        .background(Theme.sidebar)
    }

    private func subtitle(_ c: Brain.Computer) -> String {
        let bots = c.bots.count
        return [c.osLabel, c.placeLabel, stateLabel(c.state)].compactMap { $0 }.joined(separator: " · ") + (bots > 0 ? " · \(bots) bot\(bots == 1 ? "" : "s")" : "")
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, action: (String, String, () -> Void)? = nil,
                                        @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).kerning(0.6)
                    .foregroundStyle(Theme.tertiary)
                Spacer()
                if let action { IconButton(systemImage: action.0, help: action.1, action: action.2) }
            }
            .padding(.leading, 8).padding(.trailing, 2).frame(height: 30)
            content()
        }
    }
}

struct Row<Content: View>: View {
    let selected: Bool
    @ViewBuilder let content: Content
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) { content }
                .padding(.horizontal, 6).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 9).fill(selected ? Theme.raised : (hovering ? Theme.surface : .clear)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
