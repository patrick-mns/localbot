import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { avatarOptions, avatarSVG, randomAvatar } from "./bots/avatar.ts";
import { Bots } from "./bots/bots.ts";
import { Conversations } from "./chat/conversations.ts";
import { addProvider, exportProvider, findProvider, initProviders, provider, providerStatus, removeProvider, resetProviders, setDefault, settings, testProvider, updateProvider } from "./chat/providers.ts";
import { DockerProvider } from "./computers/docker.ts";
import { AppleProvider } from "./computers/apple.ts";
import { LumeProvider } from "./computers/lume.ts";
import { RailwayProvider } from "./computers/railway.ts";
import { RemoteProvider } from "./computers/remote.ts";
import { Routines, type Routine, type RunOutcome } from "./routines/routines.ts";
import { MemoryService } from "./memory/memory.ts";
import { Collection } from "./store.ts";
import { CloudLink } from "./cloud/link.ts";
import { McpServers } from "./mcp/servers.ts";
import { CONNECTORS } from "./mcp/connectors.ts";
import type { ComputerProvider } from "./computers/types.ts";

/**
 * The brain: bots, chats, devices, memory, routines, and the methods a shell
 * calls. Transports wrap it: stdio for the local app (index.ts), HTTP for a
 * brain running in the cloud (server.ts).
 *   request  {method, params}  ->  result | error
 *   event    {event, data}      (brain -> shell, unsolicited)
 * Logs go to stderr.
 */
/** macOS VMs (Lume) aren't part of the first release yet; LOCALBOT_EXPERIMENTAL_MACOS=1 turns them on. */
const macOSDevices = process.env.LOCALBOT_EXPERIMENTAL_MACOS === "1";
const docker = new DockerProvider();
/** Linux devices without Docker (macOS 26, Apple silicon): Local Bot's own runtime. */
const apple = new AppleProvider();
const lume = macOSDevices ? new LumeProvider() : null;
const railway = new RailwayProvider();
const remoteDevices = new RemoteProvider();
const computerProviders: ComputerProvider[] = [apple, docker, ...(lume ? [lume] : []), railway, remoteDevices];

/**
 * Which engine runs a new Linux desktop: Local Bot's runtime where it can
 * (no Docker needed), else Docker. "docker" is what older apps ask for.
 */
async function linuxProvider(kind: string) {
  if (kind !== "linux" && kind !== "docker") return null;
  if (await apple.available()) return kind === "docker" && (await docker.available()) ? docker : apple;
  return docker;
}

/** Every event for the shell; each transport subscribes to "event". */
export const events = new EventEmitter();
events.setMaxListeners(0);

function emit(event: string, data: unknown) {
  events.emit("event", event, data);
}

export const log = (...args: unknown[]) => console.error("[brain]", ...args);

function computerProvider(id: string) {
  const p = computerProviders.find((x) => id.startsWith(`${x.name}:`));
  if (!p) throw new Error(`Unknown device: ${id}`);
  return p;
}

const bots = new Bots();

/** The brain in the cloud, if any: bots hosted there run while the Mac is off. */
const cloud = new CloudLink((event, data) => emit(event, data), log);

/**
 * Display names chosen by the user. Kept here rather than on the device:
 * Docker labels can't change after a container is created, and Lume names
 * are folder names.
 */
const deviceNames = new Collection<{ id: string; name: string }>("device-names.json");
const named = <T extends { id: string; name: string }>(c: T): T => ({ ...c, name: deviceNames.get(c.id)?.name ?? c.name });

/**
 * Shows the device's name instead of "cua" in its desktop (the panel shows the
 * user's full name). Best effort: needs the device running and passwordless
 * sudo, which Local Bot's Linux devices have. Restarts the panel only on change.
 */
/**
 * Restarts the XFCE panel so it shows the new name. It has to talk to the
 * desktop session's D-Bus, so the address is taken from the running panel;
 * without one it doesn't try (xfce4-panel would pop up "Failed to restart").
 */
const RESTART_PANEL = [
  "P=$(pgrep -u \"$(id -u)\" -x xfce4-panel | head -1)",
  'B=$([ -n "$P" ] && tr "\\0" "\\n" < /proc/$P/environ | sed -n "s/^DBUS_SESSION_BUS_ADDRESS=//p")',
  '[ -n "$B" ] && (DISPLAY=${DISPLAY:-:1} DBUS_SESSION_BUS_ADDRESS="$B" setsid xfce4-panel -r >/dev/null 2>&1 &)',
  "true",
].join("; ");

async function labelDevice(id: string) {
  try {
    const p = computerProvider(id);
    const device = (await p.list()).find((c) => c.id === id);
    if (!device || device.os !== "linux") return;
    const name = named(device).name.replace(/[:\n]/g, " ").slice(0, 40);
    const hands = await p.hands?.(id, "app");
    if (!hands) return;
    const q = `'${name.replace(/'/g, `'\\''`)}'`;
    await hands.shell(
      `[ "$(getent passwd "$(id -un)" | cut -d: -f5)" = ${q} ] || ` +
      `{ sudo -n usermod -c ${q} "$(id -un)" && ${RESTART_PANEL}; }`,
      20_000,
    );
  } catch (err) {
    log("device label failed:", err instanceof Error ? err.message : String(err));
  }
}

/** A bot works on its own computer first, then on any computer it was granted. */
const conversations = new Conversations(emit, async (bot) => {
  const view = bots.list().find((b) => b.id === bot.id);
  const accesses = [...(view?.computers ?? [])].sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : 0));
  for (const access of accesses) {
    const p = computerProvider(access.computerId);
    const hands = await p.hands?.(access.computerId, `bot-${bot.id.slice(0, 8)}`);
    if (!hands) continue;
    const computer = (await p.list()).find((c) => c.id === access.computerId);
    return { hands, computerName: computer ? named(computer).name : access.computerId };
  }
  return null;
}, () => bots.list());

const botsChanged = () => emit("bots", null);

/** Scheduled tasks: each run is a turn in the bot's chat. */
const routines = new Routines(
  (routine) => conversations.runRoutine(bots.get(routine.botId), routine),
  (botId) => conversations.isBusy(botId),
  () => emit("routines", null),
  (routine, outcome) => routineFinished(routine, outcome),
);

/**
 * Who is listening: the transport counts connected apps. With an app open it
 * shows notifications itself; with none (the background service alone), the
 * brain asks the app's executable to post one.
 */
export const presence = { clients: 0, service: false };

function routineFinished(routine: Routine, outcome: RunOutcome) {
  const bot = bots.list().find((b) => b.id === routine.botId);
  const note = {
    routineId: routine.id,
    botId: routine.botId,
    title: `${bot?.name ?? "Bot"} · ${routine.name}`,
    body: outcome.ok
      ? (outcome.reply ?? "Done.").replace(/\s+/g, " ").slice(0, 180)
      : `Didn’t finish: ${outcome.error ?? "something went wrong"}`,
    ok: outcome.ok,
  };
  emit("routine.finished", note);
  if (presence.clients === 0) notifyWithApp(note);
}

/** The app's executable in "notify" mode posts one notification and quits. */
function notifyWithApp(note: object) {
  const app = process.env.LOCALBOT_APP_EXECUTABLE;
  if (!app) return;
  try {
    spawn(app, ["--notify", JSON.stringify(note)], { detached: true, stdio: "ignore" }).unref();
  } catch (err) {
    log("notification failed:", err instanceof Error ? err.message : String(err));
  }
}
conversations.attachRoutines(routines);

/** Long-term memory; consolidation and summaries use each bot's own model. */
const memory = new MemoryService(
  async (bot, messages) =>
    (await provider(bot.provider).chat({ model: bot.model, messages, onDelta: () => {} })).text,
  (botId) => emit("memory", { botId }),
);
conversations.attachMemory(memory);

/** MCP servers from Settings; their tools go to the bots that enable them. */
const mcp = new McpServers(
  () => emit("mcp", null),
  // A connector got signed in: bots waiting on it in the chat continue.
  (connector) => conversations.connectorReady(connector),
);
conversations.attachMcp(mcp);
// Local servers are child processes: stop them with the brain.
process.on("exit", () => mcp.stopAll());
// Started once keys are loaded (see `ready` below).

export type Handler = (params: any) => unknown | Promise<unknown>;

export const methods: Record<string, Handler> = {
  // Connectors: services in one click (each is an MCP server with a sign-in)
  "connectors.list": () => {
    const servers = mcp.list();
    return CONNECTORS.map((c) => ({ ...c, server: servers.find((s) => s.connector === c.id) ?? null }));
  },
  /** Starts the sign-in; returns the page for the app to open in the browser. */
  "connectors.connect": async ({ id }) => {
    const entry = CONNECTORS.find((c) => c.id === id);
    if (!entry) throw new Error("Unknown connector");
    const server = mcp.connector(entry);
    return { url: await mcp.signIn(server.id), serverId: server.id };
  },
  /** "Allow" on a chat card: the bot may use a connected app; it continues. */
  "connectors.allow": ({ botId, id }) => {
    const server = mcp.list().find((s) => s.connector === id);
    if (!server) throw new Error("That app isn’t connected");
    const bot = bots.get(String(botId));
    if (!server.allBots) bots.update(bot.id, { mcpServers: [...(bot.mcpServers ?? []), server.id] });
    botsChanged();
    conversations.connectorReady(String(id), bot.id);
  },
  "connectors.dismiss": ({ messageId }) => conversations.dismissConnect(String(messageId)),
  // MCP servers (Settings → MCP Servers)
  "mcp.list": () => mcp.list(),
  "mcp.add": (input) => mcp.add(input),
  "mcp.update": ({ id, ...input }) => mcp.update(String(id), input),
  "mcp.remove": async ({ id }) => {
    await mcp.remove(String(id));
    // Bots stop offering its tools.
    for (const b of bots.list()) {
      if (b.mcpServers?.includes(id)) bots.update(b.id, { mcpServers: b.mcpServers.filter((x) => x !== id) });
    }
    botsChanged();
  },
  "mcp.test": ({ id }) => mcp.test(String(id)),
  /** Which brain the app is talking to (it restarts an outdated service). */
  "app.info": () => ({ version: process.env.LOCALBOT_VERSION ?? "dev", service: presence.service, pid: process.pid }),
  // Computers
  "computers.list": async () => {
    const usable = await Promise.all(computerProviders.map(async (p) => ((await p.available()) ? p : null)));
    const lists = await Promise.all(usable.filter((p): p is ComputerProvider => !!p).map((p) => p.list()));
    return lists.flat().map((c) => ({ ...named(c), bots: bots.botsOn(c.id) }));
  },
  /** What kinds of device can be added on this host (and what is coming). */
  "computers.kinds": async () => {
    const [dockerUp, lumeUp, appleUp] = await Promise.all([docker.available(), lume?.available() ?? false, apple.available()]);
    // Built in first when this Mac can run it; Docker stays an option for
    // whoever has it installed (it isn't offered to install otherwise).
    const dockerInstalled = dockerUp || (appleUp && (await docker.requirements()).docker !== "missing");
    const linux = appleUp
      ? [
          { id: "linux", label: "Linux desktop", detail: "Debian + XFCE + Firefox, built into Local Bot (no Docker). Starts in seconds, ~1 GB.", available: true, reason: null },
          ...(dockerInstalled
            ? [{ id: "docker", label: "Linux in Docker", detail: "The same desktop in a Docker container, if you’d rather use your Docker.", available: dockerUp, reason: dockerUp ? null : "Docker isn’t running" }]
            : []),
        ]
      : [{ id: "docker", label: "Linux desktop", detail: "Debian + XFCE + Firefox in a container. Starts in seconds, ~1 GB.", available: dockerUp, reason: dockerUp ? null : "Docker isn’t running" }];
    return [
      ...linux,
      { id: "lume", label: "macOS virtual machine", detail: "Full macOS via Apple Virtualization. ~17 GB download, 8 GB RAM; up to 2 running per Mac.", available: lumeUp, reason: lumeUp ? null : "Coming soon" },
      {
        id: "railway", label: "Linux in the cloud", detail: "The same desktop on your Railway account. Keeps working while your Mac sleeps; billed by Railway.",
        available: railway.configured, reason: railway.configured ? null : "Connect Railway in Settings",
      },
      {
        id: "remote", label: "Connect a machine", detail: "Paste the share code of a device someone shared, or of your own server running the device image.",
        available: true, reason: null,
        fields: [
          { id: "code", label: "Share code", placeholder: "localbot-device:…", secure: true },
        ],
      },
      { id: "ios-simulator", label: "iOS Simulator", detail: "Drive iPhone and iPad apps.", available: false, reason: "Coming soon" },
      { id: "android-emulator", label: "Android Emulator", detail: "Drive Android apps.", available: false, reason: "Coming soon" },
    ];
  },
  /** What a Linux device needs on this Mac (Docker, the image, disk). */
  /**
   * With Local Bot's runtime there's no Docker to install: `engine` says which
   * one runs new devices, and `docker` reads "running" so older apps don't ask.
   */
  "computers.requirements": async () =>
    (await apple.available())
      ? { engine: "apple", docker: "running", ...(await apple.requirements()) }
      : { engine: "docker", ...(await docker.requirements()) },
  "computers.create": async ({ kind, name, options, setupId }) => {
    const p = (await linuxProvider(String(kind))) ?? computerProviders.find((x) => x.name === kind);
    if (!p?.create) throw new Error(`Can’t create ${kind} devices yet`);
    if (!String(name ?? "").trim()) throw new Error("The device needs a name");
    // The app follows the steps (download, start, controls, screen) by setupId.
    const progress = setupId
      ? (step: string, status: string, detail?: object) => emit("device.setup", { setupId, step, status, ...detail })
      : undefined;
    const id = await p.create(String(name).trim(), options ?? {}, progress);
    emit("computers", null);
    return { id };
  },
  /** A string another Local Bot pastes into "Connect a machine". */
  "computers.share": async ({ id }) => {
    const p = computerProvider(id);
    if (!p.share) throw new Error("Only remote and cloud devices can be shared; this one lives on your Mac");
    return { code: await p.share(id) };
  },
  // Accounts of cloud device providers (Settings → Device providers)
  "deviceProviders.status": () => [railway.account],
  "deviceProviders.connect": async ({ id, token }) => {
    if (id !== railway.name) throw new Error(`Unknown device provider: ${id}`);
    await railway.setToken(String(token ?? ""));
    emit("computers", null);
    return [railway.account];
  },
  "deviceProviders.disconnect": async ({ id }) => {
    if (id !== railway.name) throw new Error(`Unknown device provider: ${id}`);
    await railway.disconnect();
    emit("computers", null);
    return [railway.account];
  },
  "computers.rename": ({ id, name }) => {
    const clean = String(name ?? "").trim();
    if (!clean) throw new Error("The device needs a name");
    if (clean.length > 40) throw new Error("Keep the name under 40 characters");
    computerProvider(id);
    deviceNames.upsert({ id, name: clean });
    emit("computers", null);
    void labelDevice(id);
  },
  "computers.remove": async ({ id }) => {
    deviceNames.remove((d) => d.id === id);
    const p = computerProvider(id);
    if (!p.remove) throw new Error(`${p.name} devices can’t be removed from here`);
    await p.remove(id);
    for (const bot of bots.list()) bots.revoke(bot.id, id);
    emit("computers", null);
    botsChanged();
  },
  /**
   * Hides the device's own pointer while the user only watches, so the screen
   * shows just the bot's cursor; it comes back for Take control. Uses XFixes
   * from a small helper that keeps the hide while it runs.
   */
  "computers.pointer": async ({ id, hidden }) => {
    const hands = await computerProvider(String(id)).hands?.(String(id), "app").catch(() => null);
    if (!hands) return;
    await hands.shell(hidden ? HIDE_POINTER : SHOW_POINTER, 15_000);
    // Also when the screen is first shown: covers devices made before labels.
    if (hidden) void labelDevice(String(id));
  },
  "computers.start": async ({ id }) => {
    const p = computerProvider(id);
    if (!p.start) throw new Error(`${p.name} devices are started by the app`);
    await p.start(id);
    emit("computers", null);
    void labelDevice(id);
  },
  "computers.stop": async ({ id }) => {
    const p = computerProvider(id);
    if (!p.stop) throw new Error(`${p.name} devices are stopped by the app`);
    await p.stop(id);
    emit("computers", null);
  },

  // Bots
  "bots.list": () => bots.list().map((b) => ({ ...b, status: conversations.isBusy(b.id) ? "thinking" : "idle" })),
  "bots.create": (p) => {
    const bot = bots.create({
      ...p,
      provider: p.provider || settings.value.defaultProvider,
      model: p.model || settings.value.defaultModel,
    });
    botsChanged();
    return bot;
  },
  "bots.update": ({ id, ...patch }) => {
    const bot = bots.update(id, patch);
    botsChanged();
    return bot;
  },
  "bots.previewAvatar": ({ seed }) => avatarSVG(String(seed)),
  /** Every catalog option rendered on top of the given face (for the picker). */
  "bots.avatarOptions": ({ value }) => avatarOptions(String(value || randomAvatar())),
  "bots.randomAvatar": () => randomAvatar(),
  "bots.regenerateAvatar": ({ id }) => {
    const bot = bots.regenerateAvatar(id);
    botsChanged();
    return bot;
  },
  "bots.delete": ({ id }) => {
    conversations.clear(id);
    routines.deleteForBot(id);
    memory.store.deleteForBot(id);
    bots.delete(id);
    botsChanged();
  },

  // Access between bots and computers
  "access.grant": (p) => {
    const access = bots.grant({ grantedBy: "user", ...p });
    botsChanged();
    return access;
  },
  "access.revoke": ({ botId, computerId }) => {
    bots.revoke(botId, computerId);
    botsChanged();
  },

  // Memory
  "memory.list": ({ botId, history }) => memory.store.list(botId, !!history),
  "memory.add": ({ botId, kind, text, topic, scope }) => {
    bots.get(botId);
    const m = memory.store.add({ botId: scope === "team" ? null : botId, kind: kind ?? "fact", text, topic, source: "user" });
    emit("memory", { botId });
    return m;
  },
  "memory.edit": ({ id, botId, ...patch }) => {
    const m = memory.store.edit(id, patch);
    emit("memory", { botId });
    return m;
  },
  "memory.forget": ({ id, botId }) => {
    memory.store.forget(id);
    emit("memory", { botId });
  },
  "memory.delete": ({ id, botId }) => {
    memory.store.delete(id);
    emit("memory", { botId });
  },
  "memory.summary": ({ botId }) => memory.store.chatSummary(botId) ?? null,

  // Routines
  "routines.list": ({ botId }) => routines.list(botId),
  "routines.create": (p) => {
    bots.get(p.botId);
    return routines.create(p);
  },
  "routines.update": ({ id, ...patch }) => routines.update(id, patch),
  "routines.delete": ({ id }) => routines.delete(id),
  "routines.runNow": ({ id }) => routines.runNow(id),

  // Chat
  "chat.history": ({ botId }) => conversations.history(botId),
  /** A page of a chat (the app loads the latest, then older ones on scroll). */
  "chat.page": ({ botId, limit, before }) => conversations.page(String(botId), Number(limit) || 100, before ? String(before) : undefined),
  /**
   * A message, optionally with files: `{name, path}` when the app shares this
   * disk, `{name, data}` (base64) otherwise. Up to 10 files, 50 MB each.
   */
  "chat.send": async ({ botId, text, files }) => {
    const bot = bots.get(botId);
    const list = Array.isArray(files) ? files.slice(0, 10) : [];
    const saved = list.map((f: { name?: string; path?: string; data?: string }) => {
      const data = f.path ? readFileSync(String(f.path)) : Buffer.from(String(f.data ?? ""), "base64");
      if (data.length > 50 * 1024 * 1024) throw new Error(`${f.name} is over 50 MB`);
      return conversations.files.save(bot.id, String(f.name || "file"), data);
    });
    return conversations.send(bot, String(text ?? ""), saved);
  },
  "chat.stop": ({ botId }) => conversations.stop(botId),
  "chat.clear": ({ botId }) => conversations.clear(botId),
  /** A file a bot shared, base64-encoded, for the app to save or preview. */
  "chat.file": ({ botId, fileId, inline }) => conversations.readFile(String(botId), String(fileId), inline !== false),

  // Conversation providers (keys never leave the brain)
  "providers.status": () => providerStatus(),
  "providers.add": async (p) => {
    const id = await addProvider(p);
    emit("providers", null);
    return { id, ...providerStatus() };
  },
  "providers.update": async ({ id, ...patch }) => {
    await updateProvider(id, patch);
    emit("providers", null);
    return providerStatus();
  },
  "providers.remove": async ({ id }) => {
    await removeProvider(id);
    emit("providers", null);
    return providerStatus();
  },
  "providers.test": ({ id }) => testProvider(id),
  "providers.models": ({ provider: id }) => provider(id ?? settings.value.defaultProvider).models(),
  "providers.setDefault": ({ provider: id, model }) => {
    setDefault(id, model);
    emit("providers", null);
    return providerStatus();
  },

  /**
   * Back to a fresh install: bots, chats, memory, routines, providers and their
   * Keychain keys. Linux devices (containers) are removed only if asked.
   */
  "app.reset": async ({ removeDevices }) => {
    conversations.reset();
    routines.reset();
    memory.store.reset();
    bots.reset();
    await resetProviders();
    await mcp.clear();
    deviceNames.remove(() => true);
    if (removeDevices) {
      for (const p of computerProviders) {
        if (!p.remove || !(await p.available())) continue;
        for (const c of await p.list()) await p.remove(c.id).catch((err) => log("couldn’t remove", c.id, err?.message));
      }
    }
    emit("bots", null);
    emit("computers", null);
    emit("providers", null);
    emit("routines", null);
  },

  ping: () => "pong",
};


// ---------------------------------------------------------------- moving bots

/** Everything a bot is, to move it to another brain: config, grants, chat, routines, memory. */
function exportBundle(id: string) {
  const { bot, accesses } = bots.exportBot(id);
  return {
    version: 1,
    bot,
    accesses,
    messages: conversations.history(id),
    routines: routines.list(id).map(({ scheduleText, ...r }) => r),
    memory: memory.store.exportForBot(id),
  };
}
type Bundle = ReturnType<typeof exportBundle>;

function importBundle(b: Bundle) {
  if (b?.version !== 1 || !b.bot?.id) throw new Error("That bot export is from a different Local Bot");
  const view = bots.importBot(b.bot, b.accesses ?? []);
  conversations.importHistory(b.bot.id, b.messages ?? []);
  routines.importForBot(b.bot.id, b.routines ?? []);
  memory.store.importForBot(b.bot.id, b.memory ?? { rows: [], summary: null });
  botsChanged();
  emit("memory", { botId: b.bot.id });
  return view;
}

/** Drops a bot's data here (after it moved elsewhere); its devices stay. */
function forgetBot(id: string) {
  conversations.clear(id);
  routines.deleteForBot(id);
  memory.store.deleteForBot(id);
  bots.delete(id);
}

/** Registers a local device with the cloud brain (as a remote device) and returns its id there. */
async function cloudDeviceFor(localId: string) {
  const known = cloud.cloudDevice(localId);
  if (known) return known;
  const p = computerProvider(localId);
  if (!p.share) {
    const name = (await p.list()).find((c) => c.id === localId)?.name ?? localId;
    throw new Error(`“${named({ id: localId, name }).name}” runs on this Mac, so the cloud can’t reach it. Give the bot a cloud device first.`);
  }
  const name = named({ id: localId, name: (await p.list()).find((c) => c.id === localId)?.name ?? "Device" }).name;
  const { id } = (await cloud.call("computers.create", { kind: "remote", name, options: { code: await p.share(localId) } })) as { id: string };
  cloud.mapDevice(localId, id);
  return id;
}

/** The cloud brain's provider matching this one, set up there (with its key) if missing. */
async function cloudProviderFor(localId: string) {
  const config = exportProvider(localId);
  const status = (await cloud.call("providers.status")) as { providers: { id: string; preset: string; baseURL: string }[] };
  const same = status.providers.find((p) => p.preset === config.preset && p.baseURL === config.baseURL);
  if (same) return same.id;
  return ((await cloud.call("providers.add", config)) as { id: string }).id;
}

async function moveToCloud(botId: string) {
  if (!cloud.connected) throw new Error("Set up a cloud brain first (Settings → Device Providers)");
  if (conversations.isBusy(botId)) throw new Error("The bot is working; try again when it’s done");
  const bundle = exportBundle(botId);
  const accesses = [];
  for (const a of bundle.accesses) accesses.push({ ...a, computerId: await cloudDeviceFor(a.computerId) });
  const providerId = await cloudProviderFor(bundle.bot.provider);
  await cloud.call("bots.import", { bundle: { ...bundle, bot: { ...bundle.bot, provider: providerId }, accesses } });
  cloud.markHosted(botId, true);
  forgetBot(botId);
  botsChanged();
  emit("routines", null);
}

async function moveToMac(botId: string) {
  const bundle = (await cloud.call("bots.export", { id: botId })) as Bundle;
  const accesses = bundle.accesses
    .map((a) => cloud.toLocalAccess(a))
    .filter((a) => computerProviders.some((p) => a.computerId.startsWith(`${p.name}:`)));
  // Same service and URL here, or the default provider.
  const remoteProvider = (((await cloud.call("providers.status")) as any).providers as any[]).find((p) => p.id === bundle.bot.provider);
  const providerId = (remoteProvider && findProvider(remoteProvider.preset, remoteProvider.baseURL)) || settings.value.defaultProvider;
  importBundle({ ...bundle, bot: { ...bundle.bot, provider: providerId }, accesses });
  await cloud.call("bots.delete", { id: botId });
  cloud.markHosted(botId, false);
  botsChanged();
  emit("routines", null);
}

Object.assign(methods, {
  "bots.export": ({ id }) => exportBundle(id),
  "bots.import": ({ bundle }) => importBundle(bundle),

  "cloud.status": async () => ({
    connected: cloud.connected,
    url: cloud.url ?? null,
    managed: cloud.railwayServiceId ? "railway" : null,
    healthy: cloud.connected ? await cloud.health() : false,
    bots: cloud.hostedCount(),
  }),
  /** Creates a brain service on the connected Railway account and links it. */
  "cloud.setupRailway": async () => {
    if (cloud.connected) throw new Error("A cloud brain is already connected");
    const brain = await railway.createBrain();
    // The service takes a minute or two to come up; wait for it before linking.
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      try {
        await cloud.connect(brain.url, brain.token, brain.serviceId);
        emit("cloud", null);
        return { url: brain.url };
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    throw new Error("The cloud brain didn’t start in time; check the Local Bot project on Railway");
  },
  /** Links a brain someone runs elsewhere (brain/Dockerfile on any host). */
  "cloud.connect": async ({ url, token }) => {
    await cloud.connect(String(url ?? ""), String(token ?? ""));
    emit("cloud", null);
    botsChanged();
  },
  "cloud.disconnect": async ({ deleteBrain }) => {
    if (cloud.hostedCount()) throw new Error("Move the cloud bots back to this Mac first");
    const serviceId = cloud.railwayServiceId;
    if (deleteBrain && serviceId) await railway.deleteService(serviceId);
    await cloud.disconnect();
    emit("cloud", null);
  },
  "cloud.moveBot": async ({ botId, to }) => (to === "mac" ? moveToMac(botId) : moveToCloud(botId)),
} satisfies Record<string, Handler>);

// ---------------------------------------------------------------- forwarding

/**
 * Methods about a hosted bot go to the cloud brain. `key` names the param
 * that holds the bot id; device ids in params and results are translated.
 */
const POINTER_HELPER = `import ctypes, time
x = ctypes.CDLL("libX11.so.6"); xf = ctypes.CDLL("libXfixes.so.3")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]; x.XDefaultRootWindow.restype = ctypes.c_ulong
xf.XFixesHideCursor.argtypes = [ctypes.c_void_p, ctypes.c_ulong]; x.XFlush.argtypes = [ctypes.c_void_p]
d = x.XOpenDisplay(None)
xf.XFixesHideCursor(d, x.XDefaultRootWindow(d)); x.XFlush(d)
while True: time.sleep(3600)
`;
// A pidfile, not pgrep: the command line itself contains the helper's name.
const POINTER_PID = "/tmp/localbot-pointer.pid";
const HIDE_POINTER = [
  `kill -0 "$(cat ${POINTER_PID} 2>/dev/null)" 2>/dev/null && exit 0`,
  `printf '%s' ${JSON.stringify(Buffer.from(POINTER_HELPER).toString("base64"))} | base64 -d > /tmp/localbot-pointer.py`,
  `DISPLAY=\${DISPLAY:-:1} setsid nohup python3 /tmp/localbot-pointer.py >/dev/null 2>&1 & echo $! > ${POINTER_PID}`,
].join("; ");
// The X server shows the pointer again once the helper's connection closes.
const SHOW_POINTER = `kill "$(cat ${POINTER_PID} 2>/dev/null)" 2>/dev/null; rm -f ${POINTER_PID}; true`;

const botScoped: Record<string, string> = {
  "bots.update": "id", "bots.regenerateAvatar": "id",
  "memory.list": "botId", "memory.add": "botId", "memory.edit": "botId", "memory.forget": "botId",
  "memory.delete": "botId", "memory.summary": "botId",
  "routines.list": "botId", "routines.create": "botId",
  "chat.history": "botId", "chat.page": "botId", "chat.send": "botId", "chat.stop": "botId", "chat.clear": "botId", "chat.file": "botId",
  "access.grant": "botId", "access.revoke": "botId",
};

for (const [method, key] of Object.entries(botScoped)) {
  const local = methods[method];
  methods[method] = async (params: any) => {
    if (!cloud.isHosted(params?.[key])) return local(params);
    const p = { ...params };
    if (p.computerId) p.computerId = await cloudDeviceFor(p.computerId);
    // The cloud can't read this Mac's disk: files the app passed by path go as bytes.
    if (method === "chat.send" && Array.isArray(p.files)) {
      p.files = p.files.map((f: any) => (f.path ? { name: f.name, data: readFileSync(String(f.path)).toString("base64") } : f));
    }
    const result: any = await cloud.call(method, p);
    return result?.computers ? { ...result, host: "cloud", computers: result.computers.map((a: any) => cloud.toLocalAccess(a)) } : result;
  };
}

// Routine methods name only the routine: try here, then the cloud.
for (const method of ["routines.update", "routines.delete", "routines.runNow"]) {
  const local = methods[method];
  methods[method] = async (params: any) => {
    try {
      return await local(params);
    } catch (err) {
      if (!cloud.connected || !/Routine not found/.test(err instanceof Error ? err.message : "")) throw err;
      return cloud.call(method, params);
    }
  };
}

{
  const localList = methods["bots.list"];
  methods["bots.list"] = async (params) => [...((await localList(params)) as any[]), ...(await cloud.bots())];
  // All routines (no bot named): this Mac's, then the hosted bots' from the cloud.
  const routinesList = methods["routines.list"];
  methods["routines.list"] = async (params: any) => {
    const here = (await routinesList(params)) as any[];
    if (params?.botId || !cloud.connected || !cloud.hostedCount()) return here;
    try {
      const there = (await cloud.call("routines.list")) as any[];
      return [...here, ...there.filter((r) => cloud.isHosted(r.botId))];
    } catch (err) {
      log("cloud routines unavailable:", err instanceof Error ? err.message : err);
      return here;
    }
  };
  const localDelete = methods["bots.delete"];
  methods["bots.delete"] = async (params: any) => {
    if (!cloud.isHosted(params?.id)) return localDelete(params);
    await cloud.call("bots.delete", params);
    cloud.markHosted(params.id, false);
    botsChanged();
  };
  // A hosted bot's devices also have ids in the cloud; drop that link when one goes away.
  const localRemove = methods["computers.remove"];
  methods["computers.remove"] = async (params: any) => {
    const cloudId = cloud.cloudDevice(params?.id);
    if (cloudId) {
      await cloud.call("computers.remove", { id: cloudId }).catch((err) => log("cloud device removal failed:", err.message));
      cloud.unmapDevice(params.id);
    }
    return localRemove(params);
  };
}

/** Keys load from the Keychain before the first request is served. */
export const ready = Promise.all([initProviders(), railway.load(), remoteDevices.load(), cloud.load(), mcp.init()])
  .catch((err) => log("couldn’t load keys:", err instanceof Error ? err.message : err))
  .then(() => routines.start());

/** Runs one method once the brain is ready. */
export async function invoke(method: string, params: unknown) {
  await ready;
  const handler = methods[method];
  if (!handler) throw new Error(`Unknown method: ${method}`);
  return (await handler(params ?? {})) ?? null;
}
