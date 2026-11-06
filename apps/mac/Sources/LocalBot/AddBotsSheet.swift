import SwiftUI

/// Choose which bots can use a device, and how: as owner (their main device)
/// or as guest (shared access). Also the shortcut to create a bot on it.
struct AddBotsSheet: View {
    @ObservedObject var model: AppModel
    @ObservedObject var brain: Brain
    let deviceID: String
    @Environment(\.dismiss) private var dismiss

    /// botId -> "owner" | "guest"; missing means no access.
    @State private var access: [String: String] = [:]
    @State private var saving = false

    private var device: Brain.Computer? { brain.computers.first { $0.id == deviceID } }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Bots on \(device?.name ?? "this device")").font(.system(size: 17, weight: .semibold))
                    Text("Owners use it as their main device. Guests share it and keep their own.")
                        .font(.system(size: 12)).foregroundStyle(Theme.secondary)
                }
                Spacer()
                IconButton(systemImage: "xmark", help: "Close") { dismiss() }
            }

            ScrollView {
                VStack(spacing: 6) {
                    NewBotRow {
                        model.newBotDevice = deviceID
                        model.sheet = .newBot
                    }
                    ForEach(brain.bots) { bot in
                        BotAccessRow(bot: bot, deviceName: deviceName(bot.ownedComputer),
                                     role: Binding(get: { access[bot.id] }, set: { access[bot.id] = $0 }),
                                     isOwnerHere: bot.ownedComputer == deviceID)
                    }
                }
            }
            .frame(maxHeight: 380)

            HStack {
                Text(summary).font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                Spacer()
                PillButton(title: "Cancel", systemImage: "xmark") { dismiss() }
                PillButton(title: saving ? "Saving…" : "Save", systemImage: "checkmark", prominent: true) { save() }
                    .disabled(!changed || saving)
            }
        }
        .padding(24)
        .frame(width: 560)
        .background(Theme.sidebar)
        .onAppear { access = current }
    }

    /// Access as stored in the brain right now.
    private var current: [String: String] {
        var map: [String: String] = [:]
        for bot in brain.bots {
            if let a = bot.computers.first(where: { $0.computerId == deviceID }) { map[bot.id] = a.role }
        }
        return map
    }

    private var changed: Bool { access != current }

    private var summary: String {
        let owners = access.values.filter { $0 == "owner" }.count
        let guests = access.values.filter { $0 == "guest" }.count
        return "\(owners) owner\(owners == 1 ? "" : "s") · \(guests) guest\(guests == 1 ? "" : "s")"
    }

    private func deviceName(_ id: String?) -> String? {
        id.flatMap { id in brain.computers.first { $0.id == id }?.name }
    }

    private func save() {
        saving = true
        let before = current
        Task {
            for bot in brain.bots {
                let old = before[bot.id], new = access[bot.id]
                guard old != new else { continue }
                if let new {
                    await brain.grantAccess(bot: bot.id, device: deviceID, role: new)
                } else {
                    await brain.revokeAccess(bot: bot.id, device: deviceID)
                }
            }
            await brain.refreshBots()
            await brain.refreshComputers()
            saving = false
            dismiss()
        }
    }
}

struct NewBotRow: View {
    var subtitle = "It will own this device"
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "plus").font(.system(size: 13, weight: .medium))
                    .frame(width: 36, height: 36)
                    .background(RoundedRectangle(cornerRadius: 9).stroke(Theme.border, style: .init(lineWidth: 1, dash: [3])))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Create a new bot").font(.system(size: 13, weight: .medium))
                    Text(subtitle).font(.system(size: 11)).foregroundStyle(Theme.tertiary)
                }
                Spacer()
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 11).fill(hovering ? Theme.surface : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

struct BotAccessRow: View {
    let bot: Brain.Bot
    /// The bot's current main device, if any.
    let deviceName: String?
    @Binding var role: String?
    let isOwnerHere: Bool

    var body: some View {
        HStack(spacing: 12) {
            AnimatedFace(face: bot.face, size: 36, seed: bot.id)
            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name).font(.system(size: 13, weight: .medium))
                Text(caption).font(.system(size: 11)).foregroundStyle(Theme.tertiary).lineLimit(1)
            }
            Spacer()
            Picker("", selection: Binding(get: { role ?? "none" }, set: { role = $0 == "none" ? nil : $0 })) {
                Text("None").tag("none")
                Text("Guest").tag("guest")
                Text("Owner").tag("owner")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 190)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 11).fill(role == nil ? Color.clear : Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(role == nil ? Color.clear : Theme.border))
    }

    private var caption: String {
        if role == "owner", let deviceName, !isOwnerHere { return "Moves from \(deviceName)" }
        if let deviceName { return "\(bot.role.isEmpty ? "Bot" : bot.role) · main device: \(deviceName)" }
        return bot.role.isEmpty ? "No device yet" : "\(bot.role) · no device yet"
    }
}
