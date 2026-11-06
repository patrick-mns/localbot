import SwiftUI

/// Create or edit a bot: face, name, role, instructions, model and computer.
struct BotEditor: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    let botID: String?
    @Environment(\.dismiss) private var dismiss

    @State private var draft = Brain.BotDraft()
    @State private var avatar: String?
    /// Parts of the draft face, for the animated preview.
    @State private var face: Brain.Face?
    @State private var choosingFace = false
    @State private var saving = false
    @State private var confirmDelete = false

    private var bot: Brain.Bot? { botID.flatMap { id in brain.bots.first { $0.id == id } } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 16) {
                ZStack(alignment: .bottomTrailing) {
                    Button { choosingFace = true } label: {
                        if let face { AnimatedFace(face: face, size: 64, seed: draft.avatarSeed, followsPointer: true) } else { Avatar(svg: avatar, size: 64) }
                    }
                        .buttonStyle(.plain)
                        .help("Choose a face")
                        .accessibilityLabel("Choose a face")
                        .popover(isPresented: $choosingFace, arrowEdge: .bottom) {
                            AvatarPicker(brain: brain, value: $draft.avatarSeed, svg: $avatar)
                        }
                    Button(action: newFace) {
                        Image(systemName: "dice.fill").font(.system(size: 10))
                            .foregroundStyle(Theme.onText)
                            .frame(width: 22, height: 22)
                            .background(Circle().fill(Theme.text))
                    }
                    .buttonStyle(.plain)
                    .offset(x: 6, y: 6)
                    .help("New face")
                    .accessibilityLabel("New face")
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(bot == nil ? "New bot" : "\(bot!.name) settings").font(.system(size: 17, weight: .semibold))
                    Text("A bot is a teammate that works on a device.")
                        .font(.system(size: 12)).foregroundStyle(Theme.secondary)
                }
            }
            .padding(.bottom, 22)

            // The fields scroll when they don't fit; the header and the
            // buttons stay put.
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Field(label: "Name", text: $draft.name, placeholder: "e.g. Sales, Researcher, Support")
                    Field(label: "Role", text: $draft.role, placeholder: "e.g. B2B lead prospecting")
                    Field(label: "Instructions", text: $draft.instructions,
                          placeholder: "How it should work, tone, rules, what never to do…", axis: .vertical)
                    ProviderModelPicker(brain: brain, provider: $draft.provider, model: $draft.model)
                    ComputerPicker(brain: brain, selection: $draft.computerId)
                }
                .padding(.horizontal, 2).padding(.bottom, 4)
                .thinScrollers()
            }
            .scrollBounceBehavior(.basedOnSize)
            .padding(.bottom, 18)

            HStack {
                if bot != nil {
                    Button("Delete bot", role: .destructive) { confirmDelete = true }
                        .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.danger)
                }
                Spacer()
                PillButton(title: "Cancel", systemImage: "xmark") { dismiss() }
                PillButton(title: bot == nil ? "Create bot" : "Save", systemImage: "checkmark", prominent: true, action: save)
                    .disabled(draft.name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
            }
        }
        .padding(26)
        .frame(width: 520, height: 640)
        .background(Theme.sidebar)
        .confirmationDialog("Delete \(bot?.name ?? "bot")?", isPresented: $confirmDelete) {
            Button("Delete bot and conversation", role: .destructive) {
                guard let id = botID else { return }
                Task { await brain.deleteBot(id); dismiss() }
            }
        } message: {
            Text("The conversation history will be deleted. The device is not affected.")
        }
        .task { await load() }
        .task(id: draft.avatarSeed) {
            guard !draft.avatarSeed.isEmpty else { return }
            face = await brain.avatarOptions(draft.avatarSeed)?.face
        }
    }

    private func load() async {
        if let bot {
            draft = .init(name: bot.name, role: bot.role, instructions: bot.instructions, provider: bot.provider,
                          model: bot.model, computerId: bot.ownedComputer, avatarSeed: bot.avatarSeed,
                          mcpServers: bot.mcpServers ?? [])
            avatar = bot.avatar
            // The saved face right away, so the preview doesn't change shape while options load.
            face = bot.face
        } else {
            draft.provider = brain.providerStatus?.defaultProvider ?? ""
            draft.model = brain.providerStatus?.defaultModel ?? ""
            if let id = model.newBotDevice { draft.computerId = id; model.newBotDevice = nil }
            else if case .computer(let id) = model.selection { draft.computerId = id }
            else { draft.computerId = brain.computers.first { $0.os == "linux" }?.id }
            if let entry = model.newBotTemplate {
                model.newBotTemplate = nil
                draft.name = entry.name
                draft.role = entry.role
                draft.instructions = entry.instructions
                draft.avatarSeed = entry.avatarSeed
                face = entry.face
            } else if let random = await brain.randomAvatar() { draft.avatarSeed = random }
            avatar = await brain.previewAvatar(seed: draft.avatarSeed)
        }
    }

    /// Random face; like any other edit it applies on Save.
    private func newFace() {
        Task {
            guard let random = await brain.randomAvatar() else { return }
            draft.avatarSeed = random
            avatar = await brain.previewAvatar(seed: random)
        }
    }

    private func save() {
        saving = true
        Task {
            if let id = botID {
                await brain.updateBot(id, draft)
            } else if let bot = await brain.createBot(draft) {
                model.selection = .bot(bot.id)
            }
            saving = false
            dismiss()
        }
    }
}

/// Pick a face part by part. Each option is previewed on the current face.
struct AvatarPicker: View {
    @ObservedObject var brain: Brain
    @Binding var value: String
    @Binding var svg: String?
    @State private var options: Brain.AvatarOptions?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                if let face = options?.face {
                    AnimatedFace(face: face, size: 52, seed: value, followsPointer: true)
                } else {
                    Avatar(svg: options?.svg ?? svg, size: 52)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Face").font(.system(size: 14, weight: .semibold))
                    Text("Pick each part, or roll the dice.").font(.system(size: 11)).foregroundStyle(Theme.secondary)
                }
                Spacer()
                IconButton(systemImage: "dice", help: "Random face") {
                    Task { if let random = await brain.randomAvatar() { await choose(random) } }
                }
            }

            if let options {
                part("Color") {
                    HStack(spacing: 8) {
                        ForEach(options.colors) { o in
                            Button { Task { await choose(o.value) } } label: {
                                Circle().fill(Color(hex: o.fill ?? "#888"))
                                    .frame(width: 22, height: 22)
                                    .overlay(Circle().stroke(Theme.text, lineWidth: o.value == options.value ? 2 : 0).padding(-3))
                            }
                            .buttonStyle(.plain)
                            .help(o.label)
                            .accessibilityLabel(o.label)
                        }
                    }
                    .padding(.leading, 3)
                }
                part("Eyes") { faces(options.eyes, current: options.value) }
                part("Mouth") { faces(options.mouths, current: options.value) }
                part("Extra") { faces(options.accessories, current: options.value) }
                if let shapes = options.shapes { part("Shape") { faces(shapes, current: options.value) } }
            } else {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 200)
            }
        }
        .padding(16)
        .frame(width: 340)
        .background(Theme.sidebar)
        .task { options = await brain.avatarOptions(value) }
    }

    private func choose(_ newValue: String) async {
        value = newValue
        options = await brain.avatarOptions(newValue)
        svg = options?.svg
    }

    @ViewBuilder
    private func part<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.secondary)
            content()
        }
    }

    private func faces(_ list: [Brain.AvatarOption], current: String) -> some View {
        HStack(spacing: 6) {
            ForEach(list) { o in
                Button { Task { await choose(o.value) } } label: {
                    Avatar(svg: o.svg, size: 36)
                        .padding(3)
                        .background(Circle().stroke(o.value == current ? Theme.text : Color.clear, lineWidth: 2))
                }
                .buttonStyle(.plain)
                .help(o.label)
                .accessibilityLabel(o.label)
            }
        }
    }
}

extension Color {
    /// "#rrggbb" → Color.
    init(hex: String) {
        let v = UInt64(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0x888888
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}

struct ComputerPicker: View {
    @ObservedObject var brain: Brain
    @Binding var selection: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Device").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.secondary)
            Menu {
                Button("None") { selection = nil }
                Divider()
                ForEach(brain.computers) { c in
                    Button("\(c.name) · \(c.osLabel)") { selection = c.id }
                }
            } label: {
                HStack {
                    Text(label).font(.system(size: 13))
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 10)).foregroundStyle(Theme.secondary)
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
                .hairline(8)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            Text("The bot owns this device. Other bots can share it.")
                .font(.system(size: 11)).foregroundStyle(Theme.tertiary)
        }
    }

    private var label: String {
        guard let c = brain.computers.first(where: { $0.id == selection }) else { return "None" }
        return "\(c.name) · \(c.osLabel)"
    }
}
