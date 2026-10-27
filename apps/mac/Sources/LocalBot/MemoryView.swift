import SwiftUI

/// What a bot remembers: always-known facts, facts, how-tos and recent work.
/// Everything can be searched, edited, pinned, forgotten or deleted.
struct MemoryView: View {
    @ObservedObject var brain: Brain
    let bot: Brain.Bot
    @State private var query = ""
    @State private var adding = false

    private var all: [Brain.Memory] { brain.memories[bot.id] ?? [] }

    private var filtered: [Brain.Memory] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return all }
        return all.filter { $0.text.lowercased().contains(q) || ($0.topic ?? "").lowercased().contains(q) }
    }

    var body: some View {
        VStack(spacing: 0) {
            controls
            if all.isEmpty && !adding {
                empty
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if adding {
                            AddMemoryForm(brain: brain, bot: bot) { adding = false }
                        }
                        section("Always known", icon: "pin.fill", items: filtered.filter { $0.kind == "core" },
                                hint: "In every conversation.")
                        section("Facts", icon: "lightbulb", items: filtered.filter { $0.kind == "fact" })
                        procedures
                        section("Recent work", icon: "clock", items: Array(filtered.filter { $0.kind == "episode" }.prefix(15)))
                    }
                    .padding(14)
                    .thinScrollers()
                }
                .fadesUnderTopBar(Theme.sidebar)
            }
        }
        .task { await brain.refreshMemory(bot.id) }
    }

    private var controls: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                    TextField("Search memory", text: $query).textFieldStyle(.plain).font(.system(size: 12))
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Capsule().fill(Theme.surface)).overlay(Capsule().stroke(Theme.border))
                IconButton(systemImage: "plus", help: "Add memory") { adding = true }
            }
            Toggle(isOn: Binding(get: { bot.memoryAuto != false },
                                 set: { on in Task { await brain.setMemoryAuto(on, bot: bot.id) } })) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Learn from tasks").font(.system(size: 12, weight: .medium))
                    Text("After each task, \(bot.name) saves what’s worth remembering.")
                        .font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                }
            }
            .toggleStyle(.switch).controlSize(.mini)
        }
        .padding(.horizontal, 14).padding(.bottom, 8)
    }

    private var empty: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "brain").font(.system(size: 28, weight: .light)).foregroundStyle(Theme.tertiary)
            Text("Nothing remembered yet").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.secondary)
            Text("\(bot.name) saves facts, preferences and how-tos as it works. You can add things too.")
                .font(.system(size: 12)).foregroundStyle(Theme.tertiary)
                .multilineTextAlignment(.center).frame(maxWidth: 260)
            PillButton(title: "Add memory", systemImage: "plus") { adding = true }
            Spacer()
        }
        .padding(.horizontal, 24)
    }

    /// How-tos grouped by app/site.
    @ViewBuilder private var procedures: some View {
        let items = filtered.filter { $0.kind == "procedure" }
        if !items.isEmpty {
            let topics = Dictionary(grouping: items) { $0.topic ?? "General" }
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(title: "How-tos", icon: "list.bullet.rectangle", count: items.count)
                ForEach(topics.keys.sorted(), id: \.self) { topic in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(topic).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondary)
                            .padding(.leading, 4)
                        ForEach(topics[topic] ?? []) { MemoryRow(brain: brain, bot: bot, memory: $0) }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, icon: String, items: [Brain.Memory], hint: String? = nil) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel(title: title, icon: icon, count: items.count, hint: hint)
                ForEach(items) { MemoryRow(brain: brain, bot: bot, memory: $0) }
            }
        }
    }
}

struct SectionLabel: View {
    let title: String
    let icon: String
    let count: Int
    var hint: String?

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 10)).foregroundStyle(Theme.tertiary)
            Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).kerning(0.5).foregroundStyle(Theme.tertiary)
            Text("\(count)").font(.system(size: 10)).foregroundStyle(Theme.tertiary)
            if let hint { Text("· \(hint)").font(.system(size: 10)).foregroundStyle(Theme.tertiary) }
        }
        .padding(.leading, 4)
    }
}

struct MemoryRow: View {
    @ObservedObject var brain: Brain
    let bot: Brain.Bot
    let memory: Brain.Memory
    @State private var editing = false
    @State private var draft = ""
    @State private var hovering = false
    @State private var confirmDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if editing {
                TextField("", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 12)).lineLimit(1...6)
                    .padding(8).background(RoundedRectangle(cornerRadius: 7).fill(Theme.window)).hairline(7)
                HStack {
                    Spacer()
                    PillButton(title: "Cancel", systemImage: "xmark") { editing = false }
                    PillButton(title: "Save", systemImage: "checkmark", prominent: true) {
                        Task { await brain.editMemory(memory.id, bot: bot.id, text: draft); editing = false }
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else {
                HStack(alignment: .top, spacing: 8) {
                    Text(memory.text).font(.system(size: 12)).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    menu.opacity(hovering ? 1 : 0.35)
                }
                HStack(spacing: 6) {
                    Label(sourceLabel, systemImage: sourceIcon)
                    if memory.botId == nil { Label("Team", systemImage: "person.2") }
                    Text(relative(memory.updatedAt))
                }
                .font(.system(size: 10)).foregroundStyle(Theme.tertiary)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
        .hairline(10)
        .onHover { hovering = $0 }
        .confirmationDialog("Delete this memory for good?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { Task { await brain.deleteMemory(memory.id, bot: bot.id) } }
        } message: {
            Text("“Forget” keeps it as history; delete erases it completely.")
        }
    }

    private var menu: some View {
        Menu {
            Button("Edit") { draft = memory.text; editing = true }
            if memory.kind == "fact" {
                Button("Pin as always known") { Task { await brain.editMemory(memory.id, bot: bot.id, kind: "core") } }
            } else if memory.kind == "core" {
                Button("Unpin") { Task { await brain.editMemory(memory.id, bot: bot.id, kind: "fact") } }
            }
            if memory.botId == nil {
                Button("Only for \(bot.name)") { Task { await brain.editMemory(memory.id, bot: bot.id, team: false) } }
            } else {
                Button("Share with all bots") { Task { await brain.editMemory(memory.id, bot: bot.id, team: true) } }
            }
            Divider()
            Button("Forget") { Task { await brain.forgetMemory(memory.id, bot: bot.id) } }
            Button("Delete forever", role: .destructive) { confirmDelete = true }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.secondary)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Theme.raised.opacity(0.7)))
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("Memory options")
    }

    private var sourceLabel: String {
        switch memory.source {
        case "user": return "You"
        case "learned": return "Learned"
        default: return bot.name
        }
    }

    private var sourceIcon: String {
        switch memory.source {
        case "user": return "person"
        case "learned": return "sparkles"
        default: return "bubble.left"
        }
    }

    private func relative(_ iso: String) -> String {
        guard let d = ISO8601DateFormatter.withFractions.date(from: iso) else { return "" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: d, relativeTo: .now)
    }
}

struct AddMemoryForm: View {
    @ObservedObject var brain: Brain
    let bot: Brain.Bot
    let onDone: () -> Void
    @State private var text = ""
    @State private var kind = "fact"
    @State private var topic = ""
    @State private var team = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Something \(bot.name) should remember…", text: $text, axis: .vertical)
                .textFieldStyle(.plain).font(.system(size: 12)).lineLimit(2...6)
                .padding(8).background(RoundedRectangle(cornerRadius: 7).fill(Theme.window)).hairline(7)
            HStack(spacing: 8) {
                Picker("", selection: $kind) {
                    Text("Fact").tag("fact")
                    Text("Always known").tag("core")
                    Text("How-to").tag("procedure")
                }
                .labelsHidden().frame(width: 130)
                if kind == "procedure" {
                    TextField("App or site", text: $topic).textFieldStyle(.plain).font(.system(size: 12))
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.window)).hairline(6)
                        .frame(width: 110)
                }
                Toggle("Team", isOn: $team).toggleStyle(.checkbox).font(.system(size: 11))
                    .help("Every bot can use it. For things about you, not a project")
                Spacer()
            }
            HStack {
                Spacer()
                PillButton(title: "Cancel", systemImage: "xmark", action: onDone)
                PillButton(title: "Save", systemImage: "checkmark", prominent: true) {
                    Task {
                        await brain.addMemory(bot: bot.id, kind: kind, text: text, topic: kind == "procedure" ? topic : nil, team: team)
                        onDone()
                    }
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
        .hairline(10)
    }
}
