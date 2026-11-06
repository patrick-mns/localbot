import SwiftUI

/// Ready-made bots to start from. Picking one opens the new-bot form filled in,
/// so the model and device are still the user's choice.
struct LibrarySheet: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    @Environment(\.dismiss) private var dismiss

    @State private var entries: [Brain.LibraryBot] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Library").font(.system(size: 17, weight: .semibold))
                    Text("Add a ready-made bot to your team, or create your own.")
                        .font(.system(size: 12)).foregroundStyle(Theme.secondary)
                }
                Spacer()
                IconButton(systemImage: "xmark", help: "Close") { dismiss() }
            }

            ScrollView {
                VStack(spacing: 6) {
                    NewBotRow(subtitle: "Start from a blank bot") { model.sheet = .newBot }
                    ForEach(entries) { entry in
                        LibraryRow(entry: entry) {
                            model.newBotTemplate = entry
                            model.sheet = .newBot
                        }
                    }
                }
            }
            .frame(height: 440)
        }
        .padding(24)
        .frame(width: 560)
        .background(Theme.sidebar)
        .task { entries = await brain.libraryBots() }
    }
}

struct LibraryRow: View {
    let entry: Brain.LibraryBot
    let add: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            AnimatedFace(face: entry.face, size: 36, seed: entry.id)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name).font(.system(size: 13, weight: .medium))
                Text(entry.summary).font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            PillButton(title: "Add to team", systemImage: "plus", action: add)
        }
        .padding(10)
    }
}
