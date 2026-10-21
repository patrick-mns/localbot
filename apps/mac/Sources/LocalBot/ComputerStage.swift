import SwiftUI
import Virtualization

/// The computer's live screen with power and take-control actions.
struct ComputerStage: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    let computer: Brain.Computer
    let caption: String?

    var body: some View {
        if computer.state == "creating" || computer.state == "error" {
            VStack(spacing: 0) {
                StageHeader(title: caption ?? computer.name,
                            subtitle: "\(computer.osLabel) · \(stateLabel(computer.state))", state: computer.state) {
                    EmptyView()
                }
                Screen {
                    if computer.state == "error" {
                        Placeholder(icon: "exclamationmark.triangle", text: "Creating this device failed",
                                    detail: "Remove it from the sidebar and try again.")
                    } else {
                        VStack(spacing: 12) {
                            DeviceLoader(size: 120)
                            Text("Setting up \(computer.name)…").font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.secondary)
                            Text(computer.os == "macos" ? "Downloading and installing macOS. This can take a while." : "Almost ready.")
                                .font(.system(size: 12)).foregroundStyle(Theme.tertiary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            }
        } else if computer.display.kind == "native-vz", let path = computer.display.bundlePath {
            NativeVMStage(computer: computer, host: model.host(for: path), caption: caption)
        } else {
            VNCStage(brain: brain, computer: computer, caption: caption)
        }
    }
}

/// Top bar of the center column. It sits in the title-bar strip (the window
/// has no title bar), so it leaves room for the traffic lights when the
/// sidebar is hidden, and carries the panel toggles.
struct StageHeader<Actions: View>: View {
    @EnvironmentObject private var model: AppModel
    let title: String
    let subtitle: String
    let state: String
    @ViewBuilder let actions: Actions

    var body: some View {
        HStack(spacing: 10) {
            if !model.showSidebar {
                PanelToggle(side: .leading)
                ToolbarButton(systemImage: "plus", help: "New bot") { model.sheet = .newBot }
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                if !subtitle.isEmpty {
                    HStack(spacing: 5) {
                        Circle().fill(stateColor(state)).frame(width: 5, height: 5)
                        Text(subtitle).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 8)
            // Full buttons when they fit; icons only when the column is narrow.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { actions }
                HStack(spacing: 6) { actions }.environment(\.compactPills, true)
            }
            .layoutPriority(1)
            if !model.showChat { PanelToggle(side: .trailing) }
        }
        .padding(.leading, model.showSidebar ? 16 : sidebarToggleInset)
        .padding(.trailing, 12)
        .frame(height: titleBarHeight)
        .dragsWindow()
    }
}

/// Shows or hides the sidebar (leading) or the chat column (trailing). The
/// chat and the computer are never both hidden: hiding one shows the other.
struct PanelToggle: View {
    @EnvironmentObject private var model: AppModel
    let side: HorizontalEdge

    var body: some View {
        ToolbarButton(systemImage: side == .leading ? "sidebar.left" : "sidebar.right",
                   help: side == .leading ? (model.showSidebar ? "Hide sidebar" : "Show sidebar")
                                          : (model.showChat ? "Hide chat" : "Show chat")) {
            if side == .leading {
                model.showSidebar.toggle()
            } else {
                model.showChat.toggle()
                if !model.showChat { model.showComputer = true }
            }
        }
    }
}

/// Shows or hides the computer (the device's screen); the chat fills the window.
struct ComputerToggle: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ToolbarButton(systemImage: "display", help: model.showComputer ? "Hide computer" : "Show computer") {
            model.showComputer.toggle()
            if !model.showComputer { model.showChat = true }
        }
    }
}

/// With the computer hidden, the right column reaches the window's left edge
/// when the sidebar is hidden too: it then takes the sidebar toggle and leaves
/// room for the traffic lights.
struct ColumnLeadingChrome: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if !model.showComputer && !model.showSidebar {
            PanelToggle(side: .leading)
            ToolbarButton(systemImage: "plus", help: "New bot") { model.sheet = .newBot }
        }
    }
}

extension AppModel {
    /// Leading padding of a right-column header (see ColumnLeadingChrome).
    var columnHeaderInset: CGFloat { !showComputer && !showSidebar ? sidebarToggleInset : 16 }
}

struct Screen<Content: View>: View {
    var highlighted = false
    @ViewBuilder let content: Content

    var body: some View {
        content
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .stroke(highlighted ? Theme.control : Theme.border, lineWidth: highlighted ? 2 : 1))
            .padding(.horizontal, 12).padding(.bottom, 12)
    }
}

/// A computer reached over VNC (the Linux container).
struct VNCStage: View {
    @ObservedObject var brain: Brain
    let computer: Brain.Computer
    let caption: String?
    @State private var controlling = false

    private var running: Bool { computer.state == "running" }
    private var busy: Bool { brain.busy.contains(computer.id) }

    var body: some View {
        VStack(spacing: 0) {
            StageHeader(title: caption ?? computer.name,
                        subtitle: [caption == nil || computer.name == computer.osLabel ? nil : computer.name,
                                   computer.osLabel, busy ? "Please wait…" : stateLabel(computer.state)]
                            .compactMap { $0 }.joined(separator: " · ")
                            + (controlling ? " · you are in control" : ""),
                        state: computer.state) {
                if running {
                    PillButton(title: controlling ? "Release control" : "Take control",
                               systemImage: controlling ? "hand.raised.slash" : "hand.raised",
                               tint: controlling ? Theme.control : nil) {
                        controlling.toggle()
                    }
                }
                PillButton(title: running ? "Shut down" : "Start",
                           systemImage: running ? "power" : "play.fill", prominent: !running) {
                    controlling = false
                    Task { await brain.setPower(!running, computer: computer.id) }
                }
                .disabled(busy)
                DeviceMenu(computer: computer)
            }
            Screen(highlighted: controlling) {
                if running, let url = computer.display.url {
                    VNCScreen(url: url, password: computer.display.password, controlling: controlling)
                        // Watching shows only the bot's cursor; Take control brings the device's back.
                        .task(id: controlling) { await brain.setDevicePointer(computer.id, hidden: !controlling) }
                } else {
                    Placeholder(icon: "power", text: busy ? "Starting device…" : "Device is off",
                                detail: busy ? nil : "Start it to see the screen and let bots work.")
                }
            }
        }
    }
}

/// A macOS VM booted in-process with Virtualization.framework.
struct NativeVMStage: View {
    let computer: Brain.Computer
    @ObservedObject var host: VMHost
    let caption: String?

    var body: some View {
        VStack(spacing: 0) {
            StageHeader(title: caption ?? computer.name,
                        subtitle: [caption == nil ? nil : computer.name, computer.osLabel,
                                   host.bundle.isReady ? host.state.label : "Being created by Lume…"]
                            .compactMap { $0 }.joined(separator: " · "),
                        state: host.state == .running ? "running" : (host.bundle.isReady ? "stopped" : "creating")) {
                if host.state == .running {
                    PillButton(title: "Shut down", systemImage: "power") { host.stop() }
                } else {
                    PillButton(title: "Start", systemImage: "play.fill", prominent: true) { host.start() }
                        .disabled(!host.bundle.isReady || host.state == .starting || host.state == .stopping)
                }
                DeviceMenu(computer: computer, removeBlocked: host.state == .stopped || host.isFailed ? nil : "Shut it down first")
            }
            Screen {
                if let vm = host.machine {
                    VMScreen(machine: vm)
                } else {
                    if host.bundle.isReady {
                        Placeholder(icon: "apple.logo", text: "Device is off")
                    } else {
                        VStack(spacing: 12) {
                            DeviceLoader(size: 120)
                            Text("Lume is still creating this VM…").font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.secondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            }
        }
    }
}

/// Native VM display: the guest's framebuffer, keyboard and mouse.
struct VMScreen: NSViewRepresentable {
    let machine: VZVirtualMachine

    func makeNSView(context: Context) -> VZVirtualMachineView {
        let view = VZVirtualMachineView()
        view.capturesSystemKeys = true
        view.automaticallyReconfiguresDisplay = true
        view.virtualMachine = machine
        return view
    }

    func updateNSView(_ view: VZVirtualMachineView, context: Context) {
        if view.virtualMachine !== machine { view.virtualMachine = machine }
    }
}

/// Right column when a computer is selected: which bots work on it.
struct ComputerBots: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    let computer: Brain.Computer

    private var bots: [Brain.Bot] { brain.bots.filter { computer.bots.contains($0.id) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                ColumnLeadingChrome()
                VStack(alignment: .leading, spacing: 1) {
                    Text("Bots on this device").font(.system(size: 13, weight: .semibold))
                    Text(bots.isEmpty ? "None yet" : "\(bots.count) with access")
                        .font(.system(size: 11)).foregroundStyle(Theme.secondary)
                }
                Spacer()
                ComputerToggle()
                PanelToggle(side: .trailing)
            }
            .padding(.leading, model.columnHeaderInset).padding(.trailing, 12)
            .frame(height: titleBarHeight)
            .dragsWindow()

            VStack(spacing: 2) {
                ForEach(bots) { bot in
                    let access = bot.computers.first { $0.computerId == computer.id }
                    // The row opens the bot's chat; the "⋯" next to it is a separate control.
                    HStack(spacing: 4) {
                        Row(selected: false) {
                            AnimatedFace(face: bot.face, size: 28, working: brain.thinking.contains(bot.id), seed: bot.id)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(bot.name).font(.system(size: 13, weight: .medium))
                                Text(access?.role == "owner" ? "Owner" : "Guest")
                                    .font(.system(size: 11)).foregroundStyle(Theme.secondary)
                            }
                            Spacer()
                        } action: {
                            model.selection = .bot(bot.id)
                        }
                        Menu {
                            Button("Open chat") { model.selection = .bot(bot.id) }
                            Divider()
                            if access?.role == "owner" {
                                Button("Make guest") { Task { await setRole(bot, "guest") } }
                            } else {
                                Button("Make owner") { Task { await setRole(bot, "owner") } }
                            }
                            Button("Disconnect from this device", role: .destructive) {
                                Task {
                                    await brain.revokeAccess(bot: bot.id, device: computer.id)
                                    await brain.refreshBots()
                                    await brain.refreshComputers()
                                }
                            }
                        } label: {
                            Image(systemName: "ellipsis").font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Theme.secondary)
                                .frame(width: 26, height: 26)
                                .background(Circle().fill(Theme.raised.opacity(0.7)))
                        }
                        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                        .accessibilityLabel("\(bot.name) options")
                    }
                }
            }
            .padding(.horizontal, 10).padding(.top, 8)

            if bots.isEmpty {
                Text("No bot uses this device yet. Add one to let it work here.")
                    .font(.system(size: 12)).foregroundStyle(Theme.tertiary)
                    .padding(.horizontal, 18).padding(.top, 6)
            }

            Spacer()
            PillButton(title: "Add bots to this device", systemImage: "plus") { model.sheet = .addBots(computer.id) }
                .frame(maxWidth: .infinity)
                .padding(18)
        }
        .background(Theme.sidebar)
    }

    private func setRole(_ bot: Brain.Bot, _ role: String) async {
        await brain.grantAccess(bot: bot.id, device: computer.id, role: role)
        await brain.refreshBots()
        await brain.refreshComputers()
    }
}

/// "⋯" for a device: manage bots, remove it.
struct DeviceMenu: View {
    @EnvironmentObject private var model: AppModel
    let computer: Brain.Computer
    /// Why removing isn't possible right now (e.g. a running VM), or nil.
    var removeBlocked: String?

    var body: some View {
        Menu {
            Button("Rename") { model.rename(computer) }
            Button("Add bots") { model.sheet = .addBots(computer.id) }
            if computer.provider == "railway" || computer.provider == "remote" {
                Button("Share device…") { model.sheet = .shareDevice(computer.id) }
            }
            Divider()
            if let removeBlocked {
                Button("Remove device (\(removeBlocked))") {}.disabled(true)
            } else {
                Button("Remove device", role: .destructive) { model.removingDevice = computer }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(Theme.secondary)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Theme.raised.opacity(0.7)))
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
        .help("Device options")
        .accessibilityLabel("Device options")
    }
}
