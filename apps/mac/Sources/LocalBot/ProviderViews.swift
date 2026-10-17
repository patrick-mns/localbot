import SwiftUI

/// Provider + model, side by side. Changing the provider suggests its default model.
struct ProviderModelPicker: View {
    @ObservedObject var brain: Brain
    @Binding var provider: String
    @Binding var model: String

    private var entries: [Brain.ProviderStatus.Entry] { brain.providerStatus?.providers ?? [] }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Provider").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.secondary)
                Menu {
                    ForEach(entries) { e in
                        Button {
                            guard provider != e.id else { return }
                            provider = e.id
                            model = brain.providerStatus?.preset(e.preset)?.suggestedModel ?? ""
                        } label: {
                            Text(e.configured ? e.label : "\(e.label) (no key)")
                        }
                    }
                } label: {
                    FieldLabel(text: brain.providerStatus?.entry(provider)?.label ?? "Choose")
                }
                .menuStyle(.button).buttonStyle(.plain)
            }
            .frame(width: 170)

            ModelPicker(brain: brain, provider: provider, model: $model)
        }
    }
}

/// Searchable model list for one provider; free text works for providers without /models.
struct ModelPicker: View {
    @ObservedObject var brain: Brain
    let provider: String
    @Binding var model: String
    var label: String? = "Model"
    @State private var showing = false
    @State private var query = ""

    private var all: [Brain.Model] { brain.models[provider] ?? [] }

    private var results: [Brain.Model] {
        let q = query.lowercased()
        let list = q.isEmpty ? all : all.filter { $0.id.lowercased().contains(q) || $0.name.lowercased().contains(q) }
        return Array(list.prefix(80))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label {
                Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.secondary)
            }
            Button { showing = true } label: {
                FieldLabel(text: model.isEmpty ? "Choose model" : model)
            }
            .buttonStyle(.plain)
            .disabled(provider.isEmpty)
            .popover(isPresented: $showing, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Search or type a model id…", text: $query)
                        .textFieldStyle(.plain).font(.system(size: 13))
                        .padding(8).background(RoundedRectangle(cornerRadius: 7).fill(Theme.surface)).hairline(7)
                        .onSubmit {
                            // Accept a typed id even if the provider doesn't list it.
                            if !query.isEmpty { model = query; showing = false }
                        }
                    // Any model id works, listed or not (new models, private deployments).
                    let typed = query.trimmingCharacters(in: .whitespaces)
                    if !typed.isEmpty && !all.contains(where: { $0.id == typed }) {
                        Button {
                            model = typed
                            showing = false
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "plus.circle").font(.system(size: 12))
                                Text("Use “\(typed)”").font(.system(size: 12, weight: .medium)).lineLimit(1)
                                Spacer()
                                Text("Return").font(.system(size: 10)).foregroundStyle(Theme.tertiary)
                            }
                            .padding(.horizontal, 8).padding(.vertical, 7)
                            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    if all.isEmpty {
                        Text("This provider has no model list. Type the id and press Return.")
                            .font(.system(size: 11)).foregroundStyle(Theme.tertiary).padding(.vertical, 6)
                    }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 1) {
                            ForEach(results) { m in
                                Button {
                                    model = m.id
                                    showing = false
                                } label: {
                                    HStack {
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(m.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                            if m.name != m.id {
                                                Text(m.id).font(.system(size: 10)).foregroundStyle(Theme.secondary).lineLimit(1)
                                            }
                                        }
                                        Spacer()
                                        if m.id == model { Image(systemName: "checkmark").font(.system(size: 10)) }
                                    }
                                    .padding(.horizontal, 8).padding(.vertical, 6)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .frame(height: 280)
                }
                .padding(12)
                .frame(width: 420)
                .background(Theme.sidebar)
                .task(id: provider) { await brain.loadModels(provider) }
            }
        }
    }
}

/// Read-only field look used by menus and popover triggers.
struct FieldLabel: View {
    let text: String

    var body: some View {
        HStack {
            Text(text).font(.system(size: 13)).lineLimit(1)
            Spacer(minLength: 4)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 9)).foregroundStyle(Theme.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
        .hairline(8)
        .contentShape(Rectangle())
    }
}

/// Glyph per preset, so the provider list is scannable: the provider's own
/// logo where there is one (see ProviderLogos), an SF Symbol otherwise.
@MainActor
func presetSymbol(_ preset: String) -> String {
    if ProviderLogos.shapes.contains(preset) || ProviderLogos.image(preset) != nil { return "logo.\(preset)" }
    switch preset {
    case "openrouter": return "arrow.triangle.branch"
    case "openai": return "circle.hexagongrid"
    case "anthropic": return "asterisk"
    case "xai": return "xmark"
    case "gemini": return "sparkle"
    case "groq": return "bolt"
    case "ollama", "lmstudio": return "desktopcomputer"
    default: return "link"
    }
}
