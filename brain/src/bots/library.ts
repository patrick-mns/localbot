import { faceOf } from "./avatar.ts";
import catalog from "./library.json" with { type: "json" };

/**
 * The Library: ready-made bots to start from instead of a blank one. An entry
 * only fills in the new-bot form; the user still picks the model and device,
 * and the bot they create is an ordinary one, with no tie back to its entry.
 */
export const libraryBots = () =>
  catalog.map((bot) => ({ ...bot, instructions: bot.instructions.join("\n"), face: faceOf(bot.avatarSeed) }));
