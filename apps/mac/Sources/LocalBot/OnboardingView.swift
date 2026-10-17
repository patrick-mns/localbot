import SwiftUI

/// First-run setup: what Local Bot is, connect an AI provider (key goes to the
/// Keychain), create a device, create the first bot. Every step can be skipped
/// and it can be reopened from Settings.
struct OnboardingView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    @Environment(\.dismiss) private var dismiss
    @AppStorage("onboardingDone") private var onboardingDone = false

    enum Step: Int, CaseIterable { case welcome, ai, device, bot }
    @State private var step: Step = .welcome

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                ProgressDots(count: Step.allCases.count, current: step.rawValue)
                Spacer()
                if step != .welcome {
                    Button("Skip setup") { finish() }
                        .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.tertiary)
                }
            }
            .padding(.horizontal, 28).padding(.top, 22)

            Group {
                switch step {
                case .welcome: WelcomeStep { next() }
                case .ai: ConnectAIStep(brain: brain) { next() }
                case .device: DeviceStep(brain: brain) { next() }
                case .bot: FirstBotStep(model: model, brain: brain) { finish() }
                }
            }
            .padding(.horizontal, 36).padding(.vertical, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))
            .id(step)
        }
        .frame(width: 640, height: 540)
        .background(Theme.sidebar)
        .animation(.easeInOut(duration: 0.2), value: step)
    }

    private func next() {
        if let n = Step(rawValue: step.rawValue + 1) { step = n } else { finish() }
    }

    private func finish() {
        onboardingDone = true
        dismiss()
    }
}

struct ProgressDots: View {
    let count: Int
    let current: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { i in
                Capsule().fill(i == current ? Theme.text : (i < current ? Theme.secondary : Theme.border))
                    .frame(width: i == current ? 18 : 6, height: 6)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Step \(current + 1) of \(count)")
    }
}

/// Shared layout: title, subtitle, content, primary action at the bottom.
struct StepLayout<Content: View, Footer: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let content: Content
    @ViewBuilder let footer: Footer

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.system(size: 24, weight: .semibold)).padding(.bottom, 6)
            Text(subtitle).font(.system(size: 13)).foregroundStyle(Theme.secondary).padding(.bottom, 22)
            content
            Spacer(minLength: 16)
            HStack { Spacer(); footer }
        }
    }
}

// MARK: Steps

struct WelcomeStep: View {
    let onNext: () -> Void
    private let face = Brain.Face(color: "sky", eyes: "dot", mouth: "smile", accessory: "none", fill: "#4f9cf9", deep: "#08245c", shape: nil)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            AnimatedFace(face: face, size: 72, seed: "welcome").padding(.bottom, 20)
            Text("Meet Local Bot").font(.system(size: 28, weight: .semibold)).padding(.bottom, 8)
            Text("AI teammates that work on their own computers, right here on your Mac.")
                .font(.system(size: 14)).foregroundStyle(Theme.secondary).padding(.bottom, 26)
            VStack(alignment: .leading, spacing: 16) {
                Point(icon: "desktopcomputer", title: "Bots have devices",
                      text: "Each bot works on a Linux desktop or macOS VM. Watch live, or take control anytime.")
                Point(icon: "clock.arrow.circlepath", title: "Routines run on their own",
                      text: "Schedule tasks and bots do them while you’re away.")
                Point(icon: "lock.fill", title: "Yours, locally",
                      text: "Devices run on your Mac. API keys are stored in your Keychain.")
            }
            Spacer()
            HStack {
                Spacer()
                PillButton(title: "Get started", systemImage: "arrow.right", prominent: true, action: onNext)
            }
        }
    }

    private struct Point: View {
        let icon: String
        let title: String
        let text: String

        var body: some View {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon).font(.system(size: 13))
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Theme.raised))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 13, weight: .semibold))
                    Text(text).font(.system(size: 12)).foregroundStyle(Theme.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

struct ConnectAIStep: View {
    @ObservedObject var brain: Brain
    let onNext: () -> Void

    @State private var preset: Brain.ProviderStatus.Preset?
    @State private var key = ""
    @State private var connecting = false
    @State private var result: Brain.TestResult?

    private var connected: Brain.ProviderStatus.Entry? { brain.providerStatus?.providers.first { $0.configured } }
    private var presets: [Brain.ProviderStatus.Preset] { (brain.providerStatus?.presets ?? []).filter { $0.id != "custom" } }

    var body: some View {
        StepLayout(title: "Connect an AI", subtitle: "Bots think with a model from the provider you choose. Your key is saved in the Keychain.") {
            if let connected, result == nil {
                Label("\(connected.label) is connected", systemImage: "checkmark.circle.fill")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.live)
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface)).hairline(12)
                    .padding(.bottom, 14)
                Text("You can add more providers later in Settings.").font(.system(size: 12)).foregroundStyle(Theme.tertiary)
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                    ForEach(presets) { p in
                        Button {
                            preset = p
                            result = nil
                        } label: {
                            VStack(spacing: 6) {
                                SymbolIcon(name: presetSymbol(p.id), size: 14)
                                Text(p.label).font(.system(size: 11, weight: .medium)).lineLimit(1)
                                if p.id == "openrouter" {
                                    Text("Recommended").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.live)
                                } else if p.local == true {
                                    Text("No key").font(.system(size: 9)).foregroundStyle(Theme.tertiary)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 68)
                            .background(RoundedRectangle(cornerRadius: 10).fill(preset?.id == p.id ? Theme.raised : Theme.surface))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(preset?.id == p.id ? Theme.text.opacity(0.6) : Theme.border))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(p.label)
                    }
                }
                .padding(.bottom, 16)

                if let preset, preset.keyless != true {
                    HStack(spacing: 8) {
                        InlineField(text: $key, placeholder: "Paste your \(preset.label) API key", secure: true, width: 380)
                        if let url = preset.keyURL.flatMap(URL.init(string:)) {
                            Link(destination: url) { Label("Get a key", systemImage: "arrow.up.right").font(.system(size: 12)) }
                                .foregroundStyle(Theme.secondary)
                        }
                    }
                }
                if let result {
                    Label(result.ok ? "Connected · \(result.models ?? 0) models" : (result.error ?? "Couldn’t connect"),
                          systemImage: result.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .font(.system(size: 12)).foregroundStyle(result.ok ? Theme.live : Theme.warn)
                        .padding(.top, 10)
                }
            }
        } footer: {
            if connected != nil {
                PillButton(title: "Continue", systemImage: "arrow.right", prominent: true, action: onNext)
            } else {
                PillButton(title: connecting ? "Connecting…" : "Connect", systemImage: "bolt.horizontal", prominent: true) { connect() }
                    .disabled(preset == nil || (preset?.keyless != true && key.isEmpty) || connecting)
            }
        }
    }

    private func connect() {
        guard let preset else { return }
        connecting = true
        Task {
            if let id = await brain.addProvider(preset: preset.id, label: preset.label, baseURL: preset.baseURL, apiKey: key) {
                result = await brain.testProvider(id)
                if result?.ok == false { await brain.removeProvider(id) }
                key = ""
            }
            connecting = false
        }
    }
}

struct DeviceStep: View {
    @ObservedObject var brain: Brain
    let onNext: () -> Void
    @State private var req: Brain.Requirements?
    @State private var setupId: String?
    @State private var failedToStart: String?
    @State private var openingDocker = false

    private var steps: [String: Brain.SetupStep] { setupId.flatMap { brain.setups[$0] } ?? [:] }
    private var failed: String? { failedToStart ?? steps.values.first { $0.status == "failed" }?.error }
    private var finished: Bool { steps["screen"]?.status == "done" }
    private var lowDisk: Bool { (req?.freeGB ?? .infinity) < (req?.needGB ?? 0) && req?.imageReady != true }

    var body: some View {
        StepLayout(title: "Give bots a computer", subtitle: "A device is where a bot works: it sees the screen, clicks, types and runs commands.") {
            if setupId != nil {
                SetupList(steps: steps, imageReady: req?.imageReady == true)
                if let failed {
                    Label(failed, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 12)).foregroundStyle(Theme.warn)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 10)
                }
            } else if !brain.computers.isEmpty {
                VStack(spacing: 6) {
                    ForEach(brain.computers) { c in
                        HStack(spacing: 10) {
                            Image(systemName: c.symbol).frame(width: 28)
                            Text(c.name).font(.system(size: 13, weight: .medium))
                            Text(c.osLabel).font(.system(size: 12)).foregroundStyle(Theme.tertiary)
                            Spacer()
                            Circle().fill(stateColor(c.state)).frame(width: 6, height: 6)
                        }
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface)).hairline(10)
                    }
                }
            } else if let req {
                requirements(req)
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Checking your Mac…").font(.system(size: 12)).foregroundStyle(Theme.secondary)
                }
            }
        } footer: {
            if setupId != nil {
                if failed != nil {
                    PillButton(title: "Try again", systemImage: "arrow.clockwise", prominent: true) { create() }
                } else {
                    PillButton(title: finished ? "Continue" : "Setting up…", systemImage: "arrow.right", prominent: true, action: onNext)
                        .disabled(!finished)
                }
            } else if brain.computers.isEmpty {
                Button("Later") { onNext() }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.tertiary)
                    .padding(.trailing, 8)
                PillButton(title: "Create Linux device", systemImage: "plus", prominent: true) { create() }
                    .disabled(req?.docker != "running")
            } else {
                PillButton(title: "Continue", systemImage: "arrow.right", prominent: true, action: onNext)
            }
        }
        // Keep checking while something is missing: Docker starting, installed…
        .task {
            while !Task.isCancelled {
                req = await brain.requirements()
                if req?.docker == "running" { openingDocker = false }
                if req?.docker == "running" && setupId == nil && !brain.computers.isEmpty { break }
                try? await Task.sleep(for: .seconds(req?.docker == "running" ? 10 : 2))
            }
        }
    }

    @ViewBuilder private func requirements(_ req: Brain.Requirements) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            switch req.docker {
            case "missing":
                Label("Docker Desktop is needed", systemImage: "shippingbox")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.warn)
                Text("Linux devices run in Docker, a free app. Install it, open it once, and come back: this page notices on its own.")
                    .font(.system(size: 12)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
                Link(destination: URL(string: "https://www.docker.com/products/docker-desktop/")!) {
                    Label("Get Docker Desktop", systemImage: "arrow.up.right").font(.system(size: 12, weight: .medium))
                }
            case "stopped":
                Label(openingDocker ? "Starting Docker…" : "Docker Desktop isn’t running", systemImage: "shippingbox")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(openingDocker ? Theme.secondary : Theme.warn)
                Text(openingDocker ? "It takes a few seconds the first time." : "It’s installed. Open it and Local Bot continues as soon as it’s up.")
                    .font(.system(size: 12)).foregroundStyle(Theme.secondary)
                if !openingDocker {
                    PillButton(title: "Open Docker", systemImage: "play.fill", prominent: true) {
                        openingDocker = true
                        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/Applications/Docker.app"),
                                                           configuration: NSWorkspace.OpenConfiguration())
                    }
                } else {
                    ProgressView().controlSize(.small)
                }
            default:
                Label("Docker is running", systemImage: "checkmark.circle.fill")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.live)
                Text(req.imageReady
                     ? "A Linux desktop (Debian + Firefox) starts in seconds."
                     : "The first device downloads the Linux desktop (about 1–2 GB). It takes a few minutes, once.")
                    .font(.system(size: 12)).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
                if lowDisk, let free = req.freeGB {
                    Label("Only \(String(format: "%.1f", free)) GB free. Free up some space first (about \(Int(req.needGB)) GB).",
                          systemImage: "externaldrive.badge.exclamationmark")
                        .font(.system(size: 12)).foregroundStyle(Theme.warn)
                }
            }
        }
    }

    private func create() {
        let id = UUID().uuidString
        failedToStart = nil
        setupId = id
        Task {
            if await brain.createDevice(kind: "docker", name: "Linux", setupId: id) == nil {
                failedToStart = brain.lastError ?? "Couldn’t create the device"
            }
        }
    }
}

/// The steps of a device being set up, each with its state.
private struct SetupList: View {
    let steps: [String: Brain.SetupStep]
    let imageReady: Bool

    private let order: [(id: String, title: String)] = [
        ("download", "Download the Linux desktop"),
        ("start", "Start the desktop"),
        ("controls", "Install the bot’s controls"),
        ("screen", "Get the screen ready"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(order, id: \.id) { item in
                let step = steps[item.id]
                HStack(spacing: 10) {
                    icon(step).frame(width: 18)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(step?.status == "skipped" ? "\(item.title) · already on this Mac" : item.title)
                            .font(.system(size: 13, weight: step?.status == "active" ? .medium : .regular))
                            .foregroundStyle(step == nil ? Theme.tertiary : Theme.text)
                        if item.id == "download", step?.status == "active" {
                            ProgressView(value: step?.fraction ?? 0).progressViewStyle(.linear).frame(width: 260)
                            Text("About 1–2 GB, only the first time.").font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                        }
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface)).hairline(12)
    }

    @ViewBuilder private func icon(_ step: Brain.SetupStep?) -> some View {
        switch step?.status {
        case "active": ProgressView().controlSize(.small)
        case "done", "skipped": Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.live)
        case "failed": Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.danger)
        default: Image(systemName: "circle").foregroundStyle(Theme.tertiary)
        }
    }
}

struct FirstBotStep: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    let onDone: () -> Void

    @State private var name = "Assistant"
    @State private var role = "General tasks on the computer"
    @State private var avatar = ""
    @State private var face: Brain.Face?
    @State private var creating = false
    /// Starts as the provider's suggestion; any model id can be typed.
    @State private var chosenModel = ""

    /// The provider connected in the first step.
    private var providerID: String {
        let status = brain.providerStatus
        if let d = status?.defaultProvider, status?.entry(d)?.configured == true { return d }
        return status?.providers.first { $0.configured }?.id ?? status?.defaultProvider ?? ""
    }

    var body: some View {
        StepLayout(title: brain.bots.isEmpty ? "Create your first bot" : "You’re all set",
                   subtitle: brain.bots.isEmpty ? "Give it a name and a face. You can change everything later."
                                                : "You already have bots. Pick one in the sidebar and give it a task.") {
            if brain.bots.isEmpty {
                HStack(alignment: .top, spacing: 18) {
                    ZStack(alignment: .bottomTrailing) {
                        if let face { AnimatedFace(face: face, size: 72, seed: avatar) } else { Circle().fill(Theme.raised).frame(width: 72, height: 72) }
                        IconButton(systemImage: "dice", help: "New face") { roll() }
                            .offset(x: 6, y: 6)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        Field(label: "Name", text: $name, placeholder: "e.g. Assistant")
                        Field(label: "Role", text: $role, placeholder: "What it’s for")
                        if !providerID.isEmpty {
                            ModelPicker(brain: brain, provider: providerID, model: $chosenModel)
                        }
                        if let device = brain.computers.first {
                            Label("Works on \(device.name)", systemImage: "desktopcomputer")
                                .font(.system(size: 12)).foregroundStyle(Theme.secondary)
                        }
                    }
                }
            }
        } footer: {
            if brain.bots.isEmpty {
                PillButton(title: creating ? "Creating…" : "Create bot", systemImage: "checkmark", prominent: true) { create() }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || creating)
            } else {
                PillButton(title: "Done", systemImage: "checkmark", prominent: true, action: onDone)
            }
        }
        .task {
            if avatar.isEmpty { roll() }
            if chosenModel.isEmpty { chosenModel = brain.providerStatus?.defaultModel ?? "" }
        }
    }

    private func roll() {
        Task {
            guard let random = await brain.randomAvatar() else { return }
            avatar = random
            face = await brain.avatarOptions(random)?.face
        }
    }

    private func create() {
        creating = true
        Task {
            var draft = Brain.BotDraft()
            draft.name = name
            draft.role = role
            draft.provider = providerID
            draft.model = chosenModel.isEmpty ? (brain.providerStatus?.defaultModel ?? "") : chosenModel
            draft.computerId = brain.computers.first?.id
            draft.avatarSeed = avatar
            if let bot = await brain.createBot(draft) { model.selection = .bot(bot.id) }
            creating = false
            onDone()
        }
    }
}
