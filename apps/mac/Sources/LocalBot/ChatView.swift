import SwiftUI
import UniformTypeIdentifiers

struct ChatView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    let bot: Brain.Bot
    @State private var draft = ""
    /// Files to send with the next message.
    @State private var pending: [URL] = []
    @State private var dropping = false
    /// Whether the end of the chat is on screen; new text follows only then.
    @State private var atBottom = true
    /// The first scroll to the end has landed; until then, nothing else scrolls
    /// (or loads older messages, which would pin the chat to the top).
    @State private var settled = false
    @State private var tab: Tab = .chat
    @FocusState private var focused: Bool

    enum Tab { case chat, routines, memory }

    private var messages: [Brain.Message] { brain.messages[bot.id] ?? [] }
    private var deviceName: String {
        brain.computers.first { $0.id == bot.workDevice }?.name ?? "the device"
    }
    private var thinking: Bool { brain.thinking.contains(bot.id) }
    private var ready: Bool { brain.providerStatus?.configured == true }

    var body: some View {
        VStack(spacing: 0) {
            header
            tabs
            if tab == .routines {
                RoutinesView(model: model, brain: brain, bot: bot)
            } else if tab == .memory {
                MemoryView(brain: brain, bot: bot)
            } else if messages.isEmpty {
                Placeholder(icon: "bubble.left", text: "Chat with \(bot.name)",
                            detail: ready ? "Give it a task or ask a question." : "Add an AI provider in Settings to start.")
            } else {
                transcript
            }
            if tab == .chat { composer }
        }
        .background(Theme.sidebar)
        // Drop files anywhere in the chat to send them with the next message.
        .onDrop(of: [.fileURL, .image], isTargeted: $dropping) { providers in
            guard tab == .chat, ready else { return false }
            addFiles(from: providers)
            return true
        }
        .task { await brain.loadHistory(bot.id) }
        .onAppear { focused = true }
    }

    private var header: some View {
        HStack(spacing: 10) {
            AnimatedFace(face: bot.face, size: 26, working: thinking, seed: bot.id,
                         failed: messages.last?.error != nil)
            VStack(alignment: .leading, spacing: 1) {
                Text(bot.name).font(.system(size: 13, weight: .semibold))
                Text(bot.model).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
            }
            Spacer()
            if thinking {
                PillButton(title: "Stop", systemImage: "stop.fill") { stop() }
                    .help("Stop the current task")
                    .keyboardShortcut(.cancelAction)
            }
            BotMenu(bot: bot)
            PanelToggle(side: .trailing)
        }
        .padding(.leading, 16).padding(.trailing, 12)
        .frame(height: titleBarHeight)
        .background(Theme.sidebar)
        .dragsWindow()
        .zIndex(1)
    }

    private var tabs: some View {
        let count = brain.routines.filter { $0.botId == bot.id }.count
        return HStack(spacing: 4) {
            TabPill(title: "Chat", selected: tab == .chat) { tab = .chat }
            TabPill(title: count > 0 ? "Routines · \(count)" : "Routines", selected: tab == .routines) { tab = .routines }
            TabPill(title: "Memory", selected: tab == .memory) { tab = .memory }
            Spacer()
        }
        .padding(.horizontal, 14).padding(.bottom, 6)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    // Older messages load as you reach the top, keeping your place.
                    if brain.olderMessages.contains(bot.id) && settled {
                        ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                            .onAppear {
                                let anchor = messages.first?.id
                                Task {
                                    await brain.loadOlder(bot.id)
                                    if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                                }
                            }
                    }
                    let liveFace = messages.last(where: { $0.role == "assistant" })?.id
                    ForEach(ChatItem.group(messages)) { item in
                        switch item {
                        case .message(let message):
                            MessageRow(message: message, bot: bot, streaming: thinking && message.id == messages.last?.id,
                                       animated: message.id == liveFace)
                                .id(message.id)
                        case .steps(let steps):
                            StepsGroup(steps: steps, deviceName: deviceName,
                                       live: thinking && steps.last?.id == messages.last?.id)
                                .id(steps.first!.id)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, 18).padding(.vertical, 18)
                .thinScrollers()
            }
            // Streaming text follows the end only if the user is there; their
            // own message always brings them back down.
            .onChange(of: messages.last?.text) {
                if atBottom { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: messages.count) {
                if !settled || atBottom || messages.last?.role == "user" { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            // Opening a chat: the lazy list measures its rows over a few passes,
            // so one scroll to the end can land short. Repeat until it sticks.
            .task(id: bot.id) {
                settled = false
                for delay in [0, 60, 200, 500] {
                    try? await Task.sleep(for: .milliseconds(delay))
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
                try? await Task.sleep(for: .milliseconds(100))
                settled = true
            }
            .overlay(alignment: .bottom) {
                if !atBottom && !messages.isEmpty {
                    ScrollToBottomButton {
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                    .padding(.bottom, 12)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .animation(.easeOut(duration: 0.15), value: atBottom)
        }
        .fadesUnderTopBar(Theme.sidebar)
    }

    private var composer: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                if !pending.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(pending, id: \.self) { url in
                                PendingFileChip(url: url) { pending.removeAll { $0 == url } }
                            }
                        }
                    }
                }
            HStack(alignment: .bottom, spacing: 8) {
                IconButton(systemImage: "plus", help: "Add files or images") { pickFiles() }
                    .disabled(!ready)
                    .padding(.bottom, 2)
                TextField(ready ? "Message \(bot.name)…" : "Add an AI provider in Settings",
                          text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .lineLimit(1...8)
                    .focused($focused)
                    .disabled(!ready)
                    .onSubmit(send)
                    .padding(.vertical, 6)
                Button(action: thinking ? stop : send) {
                    Image(systemName: thinking ? "stop.fill" : "arrow.up")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(canSend || thinking ? Theme.onText : Theme.tertiary)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(canSend || thinking ? Theme.text : Theme.raised))
                }
                .buttonStyle(.plain)
                .disabled(!canSend && !thinking)
                .accessibilityLabel(thinking ? "Stop" : "Send")
                .help(thinking ? "Stop the current task" : "Send message")
            }
            }
            .padding(.leading, 8).padding(.trailing, 8).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 18).fill(Theme.surface))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(dropping ? Theme.text.opacity(0.6) : Theme.border, lineWidth: dropping ? 1.5 : 1))
            .padding(14)
            // ⌘V with an image or files copied adds them; plain text pastes as usual.
            .onPasteCommand(of: [.fileURL, .png, .tiff, .image]) { providers in addFiles(from: providers) }
        }
    }

    private func pickFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.prompt = "Add"
        if panel.runModal() == .OK { add(panel.urls) }
    }

    private func add(_ urls: [URL]) {
        for url in urls where !pending.contains(url) && pending.count < 10 { pending.append(url) }
    }

    /// Dropped or pasted: files come as URLs; a copied image (a screenshot) is
    /// saved to a temporary PNG first.
    private func addFiles(from providers: [NSItemProvider]) {
        for p in providers {
            if p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url { Task { @MainActor in add([url]) } }
                }
            } else if p.canLoadObject(ofClass: NSImage.self) {
                _ = p.loadObject(ofClass: NSImage.self) { image, _ in
                    guard let image = image as? NSImage, let tiff = image.tiffRepresentation,
                          let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                    let url = FileManager.default.temporaryDirectory
                        .appendingPathComponent("Pasted image \(Self.stamp()).png")
                    try? png.write(to: url)
                    Task { @MainActor in add([url]) }
                }
            }
        }
    }

    private static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        return f.string(from: Date())
    }

    private var canSend: Bool { ready && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pending.isEmpty) }

    private func send() {
        guard canSend, !thinking else { return }
        let text = draft, files = pending
        draft = ""
        pending = []
        Task { await brain.send(text, to: bot.id, files: files) }
    }

    private func stop() { Task { await brain.stop(bot.id) } }
}

struct MessageRow: View {
    let message: Brain.Message
    let bot: Brain.Bot
    let streaming: Bool
    /// Only the latest reply's face moves; the rest are drawn once.
    var animated = true
    @State private var hovering = false

    var body: some View {
        content
            .onHover { hovering = $0 }
            .help(Self.fullDate(message.at))
    }

    /// The send time, shown while the pointer is over the message.
    private var time: some View {
        Text(Self.shortTime(message.at))
            .font(.system(size: 10.5).monospacedDigit())
            .foregroundStyle(Theme.tertiary)
            .opacity(hovering ? 1 : 0)
            .animation(.easeOut(duration: 0.12), value: hovering)
    }

    @ViewBuilder private var content: some View {
        if message.notice == true {
            // From Local Bot itself: a quiet line, not a user bubble.
            Label(message.text.replacingOccurrences(of: " Continue the task you were working on.", with: " · continuing"),
                  systemImage: "checkmark.circle")
                .font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                .frame(maxWidth: .infinity)
        } else if message.role == "user" {
            VStack(alignment: .trailing, spacing: 4) {
              if let routine = message.routine {
                Label("Routine · \(routine.name)", systemImage: "clock.arrow.circlepath")
                    .font(.system(size: 10.5, weight: .medium)).foregroundStyle(Theme.tertiary)
              }
              if let from = message.from {
                Label("From \(from.name)", systemImage: "arrow.turn.down.left")
                    .font(.system(size: 10.5, weight: .medium)).foregroundStyle(Theme.tertiary)
              }
              if let files = message.files, !files.isEmpty {
                AttachmentsView(files: files, botID: message.botId)
              }
              if message.text != "(sent files)" {
              HStack {
                Spacer(minLength: 48)
                Text(message.text)
                    .font(.system(size: 13))
                    .textSelection(.enabled)
                    .padding(.horizontal, 13).padding(.vertical, 9)
                    // A teammate's request is outlined so it doesn't read as the user's own message.
                    .background(RoundedRectangle(cornerRadius: 16).fill(message.from == nil ? Theme.raised : Theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(message.from == nil ? Color.clear : Theme.border))
              }
              }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            // Drawn in the gap below the message so nothing moves on hover.
            .overlay(alignment: .bottomTrailing) { time.fixedSize().offset(y: 15) }
        } else {
            HStack(alignment: .top, spacing: 10) {
                AnimatedFace(face: bot.face, size: 22, working: streaming, seed: bot.id,
                             failed: message.error != nil, still: !animated && !streaming).padding(.top, 1)
                VStack(alignment: .leading, spacing: 6) {
                    if message.text.isEmpty && message.error == nil && (message.files ?? []).isEmpty && message.connect == nil {
                        TypingDots()
                    } else if !message.text.isEmpty {
                        MarkdownText(text: message.text)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let request = message.connect {
                        ConnectCard(request: request, messageID: message.id, botID: message.botId)
                    }
                    if let files = message.files, !files.isEmpty {
                        AttachmentsView(files: files, botID: message.botId)
                    }
                    if let error = message.error {
                        ErrorNote(title: error, detail: message.detail ?? (error.count > 90 ? error : nil))
                    }
                }
                // Drawn in the gap below the message so nothing moves on hover.
                .overlay(alignment: .bottomLeading) {
                    if !streaming { time.fixedSize().offset(y: 15) }
                }
                Spacer(minLength: 0)
            }
        }
    }
}

extension MessageRow {
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func date(_ at: String) -> Date? {
        iso.date(from: at) ?? ISO8601DateFormatter().date(from: at)
    }

    /// "16:02" today, "Mon 16:02" this week, "Oct 3" before that.
    static func shortTime(_ at: String) -> String {
        guard let d = date(at) else { return "" }
        let cal = Calendar.current
        if cal.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
        if let days = cal.dateComponents([.day], from: d, to: .now).day, days < 7 {
            return d.formatted(.dateTime.weekday(.abbreviated).hour().minute())
        }
        return d.formatted(.dateTime.month(.abbreviated).day())
    }

    static func fullDate(_ at: String) -> String {
        date(at)?.formatted(date: .complete, time: .shortened) ?? ""
    }
}

/// Round "jump to latest" button shown while scrolled up in the chat.
struct ScrollToBottomButton: View {
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.text)
                .frame(width: 32, height: 32)
                .background(Circle().fill(hovering ? Theme.hover : Theme.raised))
                .overlay(Circle().stroke(Theme.border))
                .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Jump to latest")
    }
}

struct TypingDots: View {
    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<3) { i in
                    Circle().fill(Theme.secondary).frame(width: 5, height: 5)
                        .opacity(0.3 + 0.7 * max(0, sin(t * 5 - Double(i) * 0.7)))
                }
            }
            .padding(.vertical, 6)
        }
    }
}

/// Chat rows: plain messages, or a run of consecutive bot actions shown as one group.
enum ChatItem: Identifiable {
    case message(Brain.Message)
    case steps([Brain.Message])

    var id: String {
        switch self {
        case .message(let m): return m.id
        case .steps(let s): return "steps-" + (s.first?.id ?? "")
        }
    }

    static func group(_ messages: [Brain.Message]) -> [ChatItem] {
        var items: [ChatItem] = []
        var run: [Brain.Message] = []
        for m in messages {
            if m.role == "activity" {
                run.append(m)
            } else {
                if !run.isEmpty { items.append(.steps(run)); run = [] }
                items.append(.message(m))
            }
        }
        if !run.isEmpty { items.append(.steps(run)) }
        return items
    }
}

/// A step, normalized: older history stored raw errors inside the text.
struct Step {
    let title: String
    let problem: String?
    let detail: String?

    init(_ m: Brain.Message) {
        if let error = m.error {
            title = m.text; problem = error; detail = m.detail
        } else if let range = m.text.range(of: ": Command failed") ?? m.text.range(of: ": Error") {
            title = String(m.text[..<range.lowerBound])
            problem = m.text.contains("is not running") ? "The device is off." : "Something went wrong on the device."
            detail = String(m.text[range.lowerBound...].dropFirst(2))
        } else {
            title = m.text; problem = nil; detail = nil
        }
    }
}

/// Collapsed by default: "Used Linux · 6 steps". While the bot works it shows
/// the current step; expand to see every step and any problems.
struct StepsGroup: View {
    let steps: [Brain.Message]
    let deviceName: String
    let live: Bool
    @State private var expanded = false
    @State private var hovering = false

    private var parsed: [Step] { steps.map(Step.init) }
    private var problems: Int { parsed.filter { $0.problem != nil }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    if live {
                        ProgressView().controlSize(.mini).frame(width: 14)
                    } else {
                        Image(systemName: problems > 0 ? "exclamationmark.triangle" : "cursorarrow.rays")
                            .font(.system(size: 11)).frame(width: 14)
                            .foregroundStyle(problems > 0 ? Theme.warn : Theme.secondary)
                    }
                    Text(summary).font(.system(size: 12)).foregroundStyle(Theme.secondary).lineLimit(1)
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 9).fill(hovering || expanded ? Theme.surface : .clear))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }

            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(parsed.enumerated()), id: \.offset) { _, step in
                        StepRow(step: step)
                    }
                }
                .padding(.leading, 32).padding(.trailing, 10).padding(.top, 4).padding(.bottom, 6)
                .transition(.opacity)
            }
        }
        .padding(.leading, 22)
    }

    private var summary: String {
        if live, let last = parsed.last { return last.title }
        let n = steps.count
        let asked = parsed.filter { $0.title.hasPrefix("Asked ") }.count
        let deviceSteps = n - asked - parsed.filter { $0.title.contains(" replied: ") }.count
        var parts: [String] = []
        if deviceSteps > 0 { parts.append("Used \(deviceName) · \(deviceSteps) step\(deviceSteps == 1 ? "" : "s")") }
        if asked > 0 { parts.append("Asked \(asked) teammate\(asked == 1 ? "" : "s")") }
        var text = parts.isEmpty ? "\(n) step\(n == 1 ? "" : "s")" : parts.joined(separator: " · ")
        if problems > 0 { text += " · \(problems) issue\(problems == 1 ? "" : "s")" }
        return text
    }
}

struct StepRow: View {
    let step: Step
    @State private var showDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                if step.title.hasPrefix("Asked ") || step.title.contains(" replied: ") {
                    Image(systemName: step.title.hasPrefix("Asked ") ? "arrow.turn.up.right" : "arrow.turn.down.left")
                        .font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.control)
                        .frame(width: 10)
                } else {
                    Circle().fill(step.problem == nil ? Theme.tertiary : Theme.warn).frame(width: 5, height: 5)
                }
                Text(step.title).font(.system(size: 12)).foregroundStyle(Theme.secondary)
                    .lineLimit(2).truncationMode(.middle)
            }
            if let problem = step.problem {
                ErrorNote(title: problem, detail: step.detail, compact: true).padding(.leading, 12)
            }
        }
    }
}

/// A plain-language problem; the technical text stays behind "Details".
struct ErrorNote: View {
    let title: String
    let detail: String?
    var compact = false
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.circle.fill").font(.system(size: compact ? 10 : 11))
                    .foregroundStyle(Theme.warn)
                Text(title).font(.system(size: compact ? 11 : 12)).foregroundStyle(Theme.text.opacity(0.85))
                if detail != nil {
                    Button(open ? "Hide details" : "Details") { open.toggle() }
                        .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                }
            }
            if open, let detail {
                Text(detail)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(Theme.secondary)
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 7).fill(Theme.surface))
            }
        }
    }
}

struct TabPill: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? Theme.text : Theme.secondary)
                .padding(.horizontal, 11).padding(.vertical, 5)
                .background(Capsule().fill(selected ? Theme.raised : (hovering ? Theme.surface : .clear)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// Actions for a bot, shared by the chat header "⋯" and the sidebar's right-click menu.
struct BotMenuItems: View {
    @EnvironmentObject private var model: AppModel
    let bot: Brain.Bot

    var body: some View {
        Button("Bot settings") { model.sheet = .editBot(bot.id) }
        Button("New face") { Task { await model.brain.regenerateAvatar(bot.id) } }
        Divider()
        if model.brain.moving.contains(bot.id) {
            Button("Moving…") {}.disabled(true)
        } else if bot.inCloud {
            Button("Move to this Mac") { Task { await model.brain.moveBot(bot.id, toCloud: false) } }
        } else if model.brain.cloudStatus?.connected == true {
            Button("Move to the cloud (keeps working with the app closed)") { Task { await model.brain.moveBot(bot.id, toCloud: true) } }
        }
        Divider()
        Button("Clear conversation") { model.clearingChat = bot }
        Button("Delete bot", role: .destructive) { model.deletingBot = bot }
    }
}

struct BotMenu: View {
    let bot: Brain.Bot

    var body: some View {
        Menu { BotMenuItems(bot: bot) } label: {
            Image(systemName: "ellipsis").font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(Theme.secondary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Theme.raised.opacity(0.7)))
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .help("Bot options")
        .accessibilityLabel("Bot options")
    }
}


/// A file waiting to be sent: a thumbnail for images, an icon otherwise, and ×.
private struct PendingFileChip: View {
    let url: URL
    let remove: () -> Void
    @State private var thumb: NSImage?

    private var isImage: Bool { UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true }

    var body: some View {
        HStack(spacing: 6) {
            Group {
                if let thumb {
                    Image(nsImage: thumb).resizable().scaledToFill()
                } else {
                    Image(systemName: isImage ? "photo" : "doc").font(.system(size: 13)).foregroundStyle(Theme.secondary)
                }
            }
            .frame(width: 30, height: 30)
            .background(Theme.raised)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            Text(url.lastPathComponent).font(.system(size: 11)).lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: 120, alignment: .leading)
            IconButton(systemImage: "xmark", help: "Remove") { remove() }
        }
        .padding(.leading, 4).padding(.trailing, 2).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.raised.opacity(0.6)))
        .task(id: url) {
            if isImage { thumb = await Thumbnails.downsampled(url, maxPixels: 120) }
        }
    }
}
