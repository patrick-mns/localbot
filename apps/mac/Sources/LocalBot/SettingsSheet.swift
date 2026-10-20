import SwiftUI

/// Settings, laid out like macOS System Settings: a quiet sidebar and grouped
/// cards of label/control rows on the right.
struct SettingsSheet: View {
    @ObservedObject var brain: Brain
    /// Reopens the first-run setup assistant.
    var onRunSetup: () -> Void = {}
    @Environment(\.dismiss) private var dismiss

    enum Page: Hashable {
        case reset
        case appearance
        case background
        case defaults
        case account
        case addProvider
        case provider(String)
        case deviceAccount(String)
        case addMcp
        case mcp(String)
        case connectors
    }

    @State private var page: Page = .appearance

    private var status: Brain.ProviderStatus? { brain.providerStatus }

    var body: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: 220)
            Rectangle().fill(Theme.border).frame(width: 1)
            ScrollView {
                detail
                    .padding(.horizontal, 32).padding(.top, 28).padding(.bottom, 32)
                    .thinScrollers()
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .scrollIndicators(.never)
            .background(Theme.window)
            .overlay(alignment: .topTrailing) {
                IconButton(systemImage: "xmark", help: "Close") { dismiss() }
                    .padding(14)
            }
        }
        .frame(width: 860, height: 580)
        .background(Theme.sidebar)
        .onAppear {
            if status?.providers.isEmpty == true { page = .addProvider }
        }
        .task { await brain.refreshDeviceAccounts() }
    }

    // MARK: Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Settings").font(.system(size: 15, weight: .semibold))
                .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 18)

            // The lists scroll; the version and update check stay at the bottom.
            ScrollView {
            VStack(alignment: .leading, spacing: 0) {
            SidebarGroup("General") {
                SidebarItem(icon: "circle.lefthalf.filled", title: "Appearance", selected: page == .appearance) { page = .appearance }
                SidebarItem(icon: "sparkles", title: "Default model", selected: page == .defaults) { page = .defaults }
                SidebarItem(icon: "moon.zzz", title: "Background", selected: page == .background) { page = .background }
                SidebarItem(icon: "person.crop.circle", title: "Account", selected: page == .account) { page = .account }
                SidebarItem(icon: "square.grid.2x2", title: "Connectors", selected: page == .connectors) { page = .connectors }
                SidebarItem(icon: "wand.and.stars", title: "Setup assistant", muted: true, selected: false) { onRunSetup() }
                SidebarItem(icon: "arrow.counterclockwise", title: "Reset", selected: page == .reset) { page = .reset }
            }

            SidebarGroup("AI Providers") {
                ForEach(status?.providers ?? []) { e in
                    SidebarItem(icon: presetSymbol(e.preset), title: e.label,
                                dot: e.configured ? Theme.live : Theme.warn,
                                selected: page == .provider(e.id)) { page = .provider(e.id) }
                }
                SidebarItem(icon: "plus", title: "Add provider", muted: true, selected: page == .addProvider) { page = .addProvider }
            }

            SidebarGroup("MCP Servers") {
                ForEach(brain.mcpServers.filter { $0.connector == nil }) { s in
                    SidebarItem(icon: s.isRemote ? "globe" : "terminal", title: s.name,
                                dot: s.stateColor, selected: page == .mcp(s.id)) { page = .mcp(s.id) }
                }
                SidebarItem(icon: "plus", title: "Add server", muted: true, selected: page == .addMcp) { page = .addMcp }
            }

            SidebarGroup("Device Providers") {
                ForEach(brain.deviceAccounts) { a in
                    SidebarItem(icon: a.id == "railway" ? "railway" : "cloud", title: a.label,
                                dot: a.connected ? Theme.live : Theme.tertiary,
                                selected: page == .deviceAccount(a.id)) { page = .deviceAccount(a.id) }
                }
            }
            }
            .padding(.horizontal, 8).padding(.bottom, 12)
            .thinScrollers()
            }

            Rectangle().fill(Theme.border).frame(height: 1)
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Local Bot").font(.system(size: 12, weight: .medium))
                    Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")")
                        .font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                        .textSelection(.enabled)
                }
                Spacer(minLength: 0)
                if Updater.shared.enabled {
                    PillButton(title: "Check for updates", systemImage: "arrow.triangle.2.circlepath") {
                        Updater.shared.checkForUpdates()
                    }
                    .environment(\.compactPills, true)
                    .help("Check for updates")
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
        }
    }

    // MARK: Detail

    @ViewBuilder private var detail: some View {
        switch page {
        case .reset:
            ResetPage(brain: brain, onReset: onRunSetup)
        case .appearance:
            AppearancePage()
        case .background:
            BackgroundPage()
        case .defaults:
            DefaultsPage(brain: brain)
        case .account:
            AccountPage(brain: brain)
        case .addProvider:
            AddProviderPage(brain: brain) { id in page = .provider(id) }
        case .addMcp:
            AddMcpServerPage(brain: brain) { id in page = .mcp(id) }
        case .connectors:
            ConnectorsPage(brain: brain) { id in page = .mcp(id) }
        case .mcp(let id):
            if let server = brain.mcpServers.first(where: { $0.id == id }) {
                McpServerPage(brain: brain, server: server) { page = server.connector == nil ? .addMcp : .connectors }
                    .id(server.id)
            }
        case .provider(let id):
            if let entry = status?.entry(id) {
                ProviderPage(brain: brain, preset: status?.preset(entry.preset), entry: entry) { page = .addProvider }
                    .id(id)
            }
        case .deviceAccount(let id):
            if let account = brain.deviceAccounts.first(where: { $0.id == id }) {
                DeviceAccountPage(brain: brain, account: account).id(id)
            }
        }
    }
}

// MARK: - Building blocks

struct SidebarGroup<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.tertiary)
                .padding(.horizontal, 12).padding(.bottom, 4)
            content
        }
        .padding(.bottom, 18)
    }
}

struct SidebarItem: View {
    let icon: String
    let title: String
    var dot: Color?
    var muted = false
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                iconView
                    .foregroundStyle(selected ? Theme.text : Theme.secondary)
                    .frame(width: 18)
                Text(title).font(.system(size: 13))
                    .foregroundStyle(muted && !selected ? Theme.secondary : Theme.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let dot { Circle().fill(dot).frame(width: 6, height: 6) }
            }
            .padding(.horizontal, 10).frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 7).fill(selected ? Theme.raised : (hovering ? Theme.surface : .clear)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(title)
    }

    private var iconView: some View { SymbolIcon(name: icon, size: 12) }
}

struct PageHeader: View {
    let title: String
    let subtitle: String
    var icon: String?
    var badge: (String, Color)?

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            if let icon {
                SymbolIcon(name: icon, size: 18)
                    .frame(width: 44, height: 44)
                    .background(RoundedRectangle(cornerRadius: 11).fill(Theme.surface))
                    .hairline(11)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(title).font(.system(size: 20, weight: .semibold))
                    if let badge {
                        HStack(spacing: 5) {
                            Circle().fill(badge.1).frame(width: 6, height: 6)
                            Text(badge.0).font(.system(size: 11, weight: .medium))
                        }
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Theme.surface))
                        .overlay(Capsule().stroke(Theme.border))
                    }
                }
                Text(subtitle).font(.system(size: 12)).foregroundStyle(Theme.secondary)
            }
        }
        .padding(.bottom, 22)
    }
}

/// A rounded group of rows separated by hairlines.
struct Card<Content: View>: View {
    var title: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
                    .padding(.leading, 4)
            }
            VStack(spacing: 0) {
                _VariadicView.Tree(Separated()) { content }
            }
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
            .hairline(12)
        }
        .padding(.bottom, 20)
    }
}

/// Inserts a hairline between card rows.
private struct Separated: _VariadicView_MultiViewRoot {
    func body(children: _VariadicView.Children) -> some View {
        let last = children.last?.id
        ForEach(children) { child in
            child
            if child.id != last {
                Rectangle().fill(Theme.border).frame(height: 1).padding(.leading, 14)
            }
        }
    }
}

struct SettingRow<Control: View>: View {
    let label: String
    var detail: String?
    @ViewBuilder let control: Control

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.system(size: 13))
                if let detail {
                    Text(detail).font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 12)
            control
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .frame(minHeight: 48)
    }
}

/// Compact inline text input for card rows.
struct InlineField: View {
    @Binding var text: String
    var placeholder = ""
    var secure = false
    var monospaced = false
    var width: CGFloat = 300

    var body: some View {
        Group {
            if secure {
                SecureField(placeholder, text: $text)
            } else {
                TextField(placeholder, text: $text)
            }
        }
        .textFieldStyle(.plain)
        .font(.system(size: 12, design: monospaced ? .monospaced : .default))
        .padding(.horizontal, 9).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 7).fill(Theme.window))
        .hairline(7)
        .frame(width: width)
    }
}

// MARK: - Pages

struct AppearancePage: View {
    @AppStorage(Appearance.key) private var appearance = Appearance.dark.rawValue

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(title: "Appearance", subtitle: "How Local Bot looks. Auto follows your macOS setting.")
            HStack(spacing: 14) {
                ForEach(Appearance.allCases) { option in
                    AppearanceTile(option: option, selected: appearance == option.rawValue) {
                        appearance = option.rawValue
                    }
                }
            }
        }
        .onChange(of: appearance) { (Appearance(rawValue: appearance) ?? .dark).apply() }
    }
}

struct AppearanceTile: View {
    let option: Appearance
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 9) {
                preview
                    .frame(width: 150, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10)
                        .stroke(selected ? Theme.control : Theme.border, lineWidth: selected ? 2 : 1))
                Text(option.label).font(.system(size: 12, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Theme.text : Theme.secondary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.label)
    }

    @ViewBuilder private var preview: some View {
        switch option {
        case .light: MiniWindow(dark: false)
        case .dark: MiniWindow(dark: true)
        case .auto:
            HStack(spacing: 0) {
                MiniWindow(dark: false)
                MiniWindow(dark: true)
            }
        }
    }
}

/// Tiny sketch of the app window in a given appearance.
struct MiniWindow: View {
    let dark: Bool

    var body: some View {
        let bg = Color(white: dark ? 0.04 : 0.97)
        let side = Color(white: dark ? 0.09 : 0.92)
        let line = Color(white: dark ? 0.22 : 0.80)
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(0..<4) { i in
                    RoundedRectangle(cornerRadius: 2).fill(line).frame(width: i == 0 ? 22 : 30, height: 4)
                }
                Spacer()
            }
            .padding(8)
            .frame(maxHeight: .infinity)
            .background(side)
            VStack(alignment: .leading, spacing: 5) {
                RoundedRectangle(cornerRadius: 3).fill(line.opacity(0.6)).frame(height: 40)
                RoundedRectangle(cornerRadius: 2).fill(line).frame(width: 40, height: 4)
                Spacer()
            }
            .padding(8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(bg)
        }
    }
}

/// Factory reset, then the setup assistant: the first-run experience again.
struct ResetPage: View {
    @ObservedObject var brain: Brain
    let onReset: () -> Void
    @State private var removeDevices = false
    @State private var confirming = false
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(title: "Reset", subtitle: "Start over as if Local Bot was just installed, then run the setup assistant.")
            Card(title: "What gets erased") {
                SettingRow(label: "Bots, chats and memory", detail: "Every bot, its conversations, routines and what it remembers.") {
                    Image(systemName: "trash").foregroundStyle(Theme.tertiary)
                }
                SettingRow(label: "AI providers", detail: "Providers and their API keys, removed from the Keychain.") {
                    Image(systemName: "key").foregroundStyle(Theme.tertiary)
                }
                SettingRow(label: "Also remove Linux devices",
                           detail: "Deletes the Docker containers and everything on them. Off: devices stay and show up again.") {
                    Toggle("", isOn: $removeDevices).toggleStyle(.switch).labelsHidden()
                }
            }
            HStack {
                Spacer()
                DestructiveButton(title: working ? "Resetting…" : "Reset Local Bot") { confirming = true }
                    .disabled(working)
            }
        }
        .confirmationDialog("Reset Local Bot?", isPresented: $confirming) {
            Button(removeDevices ? "Erase everything, including devices" : "Erase everything", role: .destructive) { reset() }
        } message: {
            Text("This can’t be undone. Bots, chats, memory, routines, AI providers and their keys are deleted\(removeDevices ? ", and Linux devices are removed" : "").")
        }
    }

    private func reset() {
        working = true
        Task {
            if await brain.resetApp(removeDevices: removeDevices) {
                UserDefaults.standard.set(false, forKey: "onboardingDone")
                onReset()
            }
            working = false
        }
    }
}

/// Which provider and model new bots start with. Saves on change.
struct DefaultsPage: View {
    @ObservedObject var brain: Brain
    @State private var provider = ""
    @State private var model = ""
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(title: "Default model", subtitle: "New bots start with this. Each bot can switch in its own settings.")
            if brain.providerStatus?.providers.isEmpty ?? true {
                Card {
                    SettingRow(label: "No AI provider yet", detail: "Add one from the sidebar to choose a model.") { EmptyView() }
                }
            } else {
                Card {
                    SettingRow(label: "Provider") {
                        Menu {
                            ForEach(brain.providerStatus?.providers ?? []) { e in
                                Button(e.label) {
                                    provider = e.id
                                    model = brain.providerStatus?.preset(e.preset)?.suggestedModel ?? ""
                                }
                            }
                        } label: {
                            FieldLabel(text: brain.providerStatus?.entry(provider)?.label ?? "Choose").frame(width: 300)
                        }
                        .menuStyle(.button).buttonStyle(.plain)
                    }
                    SettingRow(label: "Model") {
                        ModelPicker(brain: brain, provider: provider, model: $model, label: nil).frame(width: 300)
                    }
                }
            }
        }
        .onAppear {
            provider = brain.providerStatus?.defaultProvider ?? ""
            model = brain.providerStatus?.defaultModel ?? ""
            loaded = true
        }
        .onChange(of: model) {
            guard loaded, !provider.isEmpty, !model.isEmpty,
                  model != brain.providerStatus?.defaultModel || provider != brain.providerStatus?.defaultProvider else { return }
            Task { await brain.setDefault(provider: provider, model: model) }
        }
    }
}

/// Gallery of known services to add.
struct AddProviderPage: View {
    @ObservedObject var brain: Brain
    let onAdded: (String) -> Void
    @State private var chosen: Brain.ProviderStatus.Preset?

    var body: some View {
        if let chosen {
            NewProviderForm(brain: brain, preset: chosen, onCancel: { self.chosen = nil }, onAdded: onAdded)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                PageHeader(title: "Add provider", subtitle: "Any service that speaks the OpenAI API works. Local ones need no key.")
                let presets = brain.providerStatus?.presets ?? []
                section("Cloud", presets.filter { $0.local != true && $0.id != "custom" })
                section("On this Mac", presets.filter { $0.local == true })
                section("Other", presets.filter { $0.id == "custom" })
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ presets: [Brain.ProviderStatus.Preset]) -> some View {
        if !presets.isEmpty {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.secondary)
                .padding(.leading, 4).padding(.bottom, 8)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                ForEach(presets) { p in PresetTile(preset: p) { chosen = p } }
            }
            .padding(.bottom, 20)
        }
    }
}

struct PresetTile: View {
    let preset: Brain.ProviderStatus.Preset
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                SymbolIcon(name: presetSymbol(preset.id), size: 13)
                    .frame(width: 30, height: 30)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.raised))
                VStack(alignment: .leading, spacing: 1) {
                    Text(preset.label).font(.system(size: 13, weight: .medium)).lineLimit(1)
                    Text(preset.local == true ? "Local · no key" : (preset.id == "custom" ? "Any URL" : "API key"))
                        .font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                }
                Spacer(minLength: 0)
                Image(systemName: "plus").font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(hovering ? Theme.text : Theme.tertiary)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(hovering ? Theme.raised : Theme.surface))
            .hairline(10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel("Add \(preset.label)")
    }
}

/// First-time setup for a chosen preset.
struct NewProviderForm: View {
    @ObservedObject var brain: Brain
    let preset: Brain.ProviderStatus.Preset
    let onCancel: () -> Void
    let onAdded: (String) -> Void

    @State private var label = ""
    @State private var baseURL = ""
    @State private var key = ""
    @State private var saving = false

    private var canAdd: Bool {
        !baseURL.isEmpty && (preset.keyless == true || preset.id == "custom" || !key.isEmpty) && !saving
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onCancel) {
                Label("All providers", systemImage: "chevron.left").font(.system(size: 12))
            }
            .buttonStyle(.plain).foregroundStyle(Theme.secondary).padding(.bottom, 14)

            PageHeader(title: "Add \(preset.label)", subtitle: providerSubtitle(preset), icon: presetSymbol(preset.id))
            ConnectionCard(preset: preset, label: $label, baseURL: $baseURL, key: $key)
            HStack {
                Spacer()
                PillButton(title: saving ? "Adding…" : "Add provider", systemImage: "plus", prominent: true) {
                    saving = true
                    Task {
                        if let id = await brain.addProvider(preset: preset.id, label: label, baseURL: baseURL, apiKey: key) {
                            onAdded(id)
                        }
                        saving = false
                    }
                }
                .disabled(!canAdd)
            }
        }
        .onAppear {
            label = preset.label
            baseURL = preset.baseURL
        }
    }
}

/// An added provider: connection details, test, removal.
struct ProviderPage: View {
    @ObservedObject var brain: Brain
    let preset: Brain.ProviderStatus.Preset?
    let entry: Brain.ProviderStatus.Entry
    let onRemoved: () -> Void

    @State private var label = ""
    @State private var baseURL = ""
    @State private var key = ""
    @State private var testing = false
    @State private var test: Brain.TestResult?
    @State private var saving = false
    @State private var confirmRemove = false

    private var dirty: Bool { label != entry.label || baseURL != entry.baseURL || !key.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(title: entry.label, subtitle: preset.map(providerSubtitle) ?? "",
                       icon: presetSymbol(entry.preset),
                       badge: entry.configured ? ("Ready", Theme.live) : ("Needs a key", Theme.warn))

            ConnectionCard(
                preset: preset, label: $label, baseURL: $baseURL, key: $key,
                saved: entry.keyHint.map { SavedKey(hint: $0, source: entry.keySource ?? "keychain") },
                onRemoveKey: {
                    Task {
                        await brain.updateProvider(entry.id, label: entry.label, baseURL: entry.baseURL, apiKey: "")
                        runTest()
                    }
                }
            )

            if dirty {
                HStack(spacing: 8) {
                    Text("Unsaved changes").font(.system(size: 11)).foregroundStyle(Theme.secondary)
                    Spacer()
                    PillButton(title: "Revert", systemImage: "arrow.uturn.backward") { load() }
                    PillButton(title: saving ? "Saving…" : "Save", systemImage: "checkmark", prominent: true) { save() }
                        .disabled(saving)
                }
                .padding(.top, -8).padding(.bottom, 20)
                .transition(.opacity)
            }

            Card(title: "Status") {
                SettingRow(label: "Connection", detail: testDetail) {
                    HStack(spacing: 8) {
                        if testing { ProgressView().controlSize(.small) }
                        PillButton(title: "Test", systemImage: "bolt.horizontal") { runTest() }.disabled(testing)
                    }
                }
            }

            Card {
                SettingRow(label: "Remove provider", detail: "Bots using it will need another provider. Your key is forgotten.") {
                    DestructiveButton(title: "Remove") { confirmRemove = true }
                }
            }
        }
        .animation(.easeInOut(duration: 0.15), value: dirty)
        .onAppear { load(); runTest() }
        .confirmationDialog("Remove \(entry.label)?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) {
                Task { await brain.removeProvider(entry.id); onRemoved() }
            }
        } message: {
            Text("Bots using this provider will need another one.")
        }
    }

    private var testDetail: String {
        if testing { return "Checking…" }
        guard let test else { return "Not checked yet" }
        return test.ok ? "Connected · \(test.models ?? 0) models available" : (test.error ?? "Failed")
    }

    private func load() {
        label = entry.label
        baseURL = entry.baseURL
        key = ""
    }

    private func runTest() {
        testing = true
        Task {
            test = await brain.testProvider(entry.id)
            testing = false
        }
    }

    private func save() {
        saving = true
        Task {
            await brain.updateProvider(entry.id, label: label, baseURL: baseURL, apiKey: key.isEmpty ? nil : key)
            key = ""
            saving = false
            runTest()
        }
    }
}

/// A cloud account devices are created on: connect it with a token, or forget it.
struct DeviceAccountPage: View {
    @ObservedObject var brain: Brain
    let account: Brain.DeviceAccount

    @State private var token = ""
    @State private var replacing = false
    @State private var saving = false
    @State private var error: String?
    @State private var confirmDisconnect = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PageHeader(title: account.label, subtitle: account.detail, icon: account.id == "railway" ? "railway" : "cloud",
                       badge: account.connected ? ("Connected", Theme.live) : ("Not connected", Theme.tertiary))

            Card(title: "Connection") {
                SettingRow(label: account.tokenLabel, detail: error ?? "Stored securely in your Mac’s Keychain") {
                    VStack(alignment: .trailing, spacing: 6) {
                        if let hint = account.tokenHint, !replacing {
                            HStack(spacing: 8) {
                                SavedKeyPill(saved: SavedKey(hint: hint, source: "keychain"))
                                PillButton(title: "Replace", systemImage: "arrow.triangle.2.circlepath") { replacing = true }
                            }
                        } else {
                            HStack(spacing: 6) {
                                InlineField(text: $token, placeholder: "Paste your \(account.label) token", secure: true, width: 200)
                                PillButton(title: saving ? "Checking…" : "Connect", systemImage: "checkmark", prominent: true) { connect() }
                                    .fixedSize()
                                    .disabled(saving || token.trimmingCharacters(in: .whitespaces).isEmpty)
                                if account.connected {
                                    IconButton(systemImage: "xmark", help: "Keep the current token") { token = ""; replacing = false; error = nil }
                                }
                            }
                        }
                        if let url = account.tokenURL.flatMap(URL.init(string:)) {
                            Link(destination: url) {
                                Label("Get a token", systemImage: "arrow.up.right").font(.system(size: 11))
                            }
                            .foregroundStyle(Theme.secondary)
                        }
                    }
                }
            }

            if account.connected && account.id == "railway" {
                CloudBrainCard(brain: brain)
            }

            if account.connected {
                Card(title: "Status") {
                    SettingRow(label: "Devices", detail: "Add more from the sidebar’s “Add device”.") {
                        Text("\(account.devices)").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.secondary)
                    }
                }
                Card {
                    SettingRow(label: "Disconnect", detail: "Forgets the token. Devices stay on \(account.label) and come back when you connect again.") {
                        DestructiveButton(title: "Disconnect") { confirmDisconnect = true }
                    }
                }
            }
        }
        .confirmationDialog("Disconnect \(account.label)?", isPresented: $confirmDisconnect) {
            Button("Disconnect", role: .destructive) { Task { await brain.disconnectDeviceAccount(account.id) } }
        } message: {
            Text("Its devices are hidden until you connect again. Nothing is deleted on \(account.label).")
        }
    }

    private func connect() {
        saving = true
        error = nil
        Task {
            error = await brain.connectDeviceAccount(account.id, token: token.trimmingCharacters(in: .whitespaces))
            if error == nil { token = ""; replacing = false }
            saving = false
        }
    }
}

/// The brain in the cloud: bots moved there keep working with the app closed.
struct CloudBrainCard: View {
    @ObservedObject var brain: Brain
    @State private var working = false
    @State private var error: String?
    @State private var confirmRemove = false

    private var status: Brain.CloudStatus? { brain.cloudStatus }

    var body: some View {
        Card(title: "Cloud brain") {
            if let status, status.connected {
                SettingRow(label: status.healthy ? "Running" : "Not reachable",
                           detail: "\(status.bots) bot\(status.bots == 1 ? "" : "s") in the cloud. Move a bot with its “⋯” menu.") {
                    Circle().fill(status.healthy ? Theme.live : Theme.warn).frame(width: 8, height: 8)
                }
                SettingRow(label: "Remove cloud brain",
                           detail: error ?? (status.bots > 0 ? "Move its bots back to this Mac first." : "Deletes the service on Railway.")) {
                    DestructiveButton(title: working ? "Removing…" : "Remove") { confirmRemove = true }
                        .disabled(working || status.bots > 0)
                }
            } else {
                SettingRow(label: "Keep bots working with the app closed",
                           detail: error ?? "Creates a brain service with its own storage on your Railway account. Bots you move there chat, run routines and learn 24/7.") {
                    HStack(spacing: 8) {
                        if working { ProgressView().controlSize(.small) }
                        PillButton(title: working ? "Setting up… (a few minutes)" : "Set up", systemImage: "cloud", prominent: true) { setup() }
                            .disabled(working)
                    }
                }
            }
        }
        .task { await brain.refreshCloud() }
        .confirmationDialog("Remove the cloud brain?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive) { remove() }
        } message: {
            Text("The brain service and its storage are deleted from Railway.")
        }
    }

    private func setup() {
        working = true
        error = nil
        Task {
            error = await brain.setupCloudBrain()
            working = false
        }
    }

    private func remove() {
        working = true
        error = nil
        Task {
            error = await brain.disconnectCloud(deleteBrain: true)
            working = false
        }
    }
}

/// A key that's already stored: where it lives and its last four characters.
struct SavedKey {
    let hint: String      // "…3059"
    let source: String    // "keychain" | "env"
}

/// Name, URL and key rows shared by "add" and "edit".
struct ConnectionCard: View {
    let preset: Brain.ProviderStatus.Preset?
    @Binding var label: String
    @Binding var baseURL: String
    /// A new key typed by the user ("" = keep what's stored).
    @Binding var key: String
    var saved: SavedKey?
    var onRemoveKey: (() -> Void)?

    @State private var replacing = false

    var body: some View {
        Card(title: "Connection") {
            SettingRow(label: "Name") { InlineField(text: $label, placeholder: preset?.label ?? "") }
            SettingRow(label: "Base URL", detail: preset?.editableURL == true ? "OpenAI-compatible endpoint" : nil) {
                if preset?.editableURL == true {
                    InlineField(text: $baseURL, placeholder: "https://…/v1", monospaced: true)
                } else {
                    Text(baseURL).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondary)
                        .textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: 300, alignment: .trailing)
                }
            }
            if preset?.keyless != true {
                SettingRow(label: "API key", detail: keyDetail) {
                    VStack(alignment: .trailing, spacing: 6) {
                        if let saved, !replacing {
                            HStack(spacing: 8) {
                                SavedKeyPill(saved: saved)
                                PillButton(title: "Replace", systemImage: "arrow.triangle.2.circlepath") { replacing = true }
                                if let onRemoveKey, saved.source == "keychain" {
                                    IconButton(systemImage: "trash", help: "Remove key") { onRemoveKey() }
                                }
                            }
                        } else {
                            HStack(spacing: 6) {
                                InlineField(text: $key, placeholder: saved == nil ? "Paste your API key" : "Paste the new key", secure: true)
                                if saved != nil {
                                    IconButton(systemImage: "xmark", help: "Keep the current key") { key = ""; replacing = false }
                                }
                            }
                        }
                        if let url = preset?.keyURL.flatMap(URL.init(string:)) {
                            Link(destination: url) {
                                Label("Get a key", systemImage: "arrow.up.right").font(.system(size: 11))
                            }
                            .foregroundStyle(Theme.secondary)
                        }
                    }
                }
            }
        }
        .onChange(of: saved?.hint) { replacing = false }
    }

    private var keyDetail: String? {
        if preset?.id == "custom" { return "Optional" }
        return "Stored securely in your Mac’s Keychain"
    }
}

/// A stored key, shown only as dots.
struct SavedKeyPill: View {
    let saved: SavedKey

    var body: some View {
        Text("••••••••••••")
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Capsule().fill(Theme.window))
            .overlay(Capsule().stroke(Theme.border))
            .accessibilityLabel("Saved API key")
    }
}

/// Outlined red button for irreversible actions.
struct DestructiveButton: View {
    let title: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.danger)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Capsule().fill(Theme.danger.opacity(hovering ? 0.14 : 0.06)))
                .overlay(Capsule().stroke(Theme.danger.opacity(0.45)))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

func providerSubtitle(_ preset: Brain.ProviderStatus.Preset) -> String {
    if preset.keyless == true { return "Runs on your Mac. No key needed." }
    if preset.id == "custom" { return "Any service compatible with the OpenAI API." }
    return "Connect with your \(preset.label) API key."
}
