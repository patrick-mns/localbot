import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { oneTimeToken } from "better-auth/plugins/one-time-token";
import { retrying } from "./d1-retry";

/**
 * Local Bot accounts: sign in with GitHub, nothing else. The app works fully
 * without an account; signing in only gives other people and services a way
 * to know who you are. Bots, chats, keys and memory never come here.
 *
 * Desktop sign-in: the app opens /desktop/start in the browser with a port it
 * listens on (127.0.0.1) and a random state. GitHub sends the browser back to
 * /desktop/done, which hands the app a one-time token on that port; the app
 * trades it for a session (POST /api/auth/one-time-token/verify) and then
 * calls the API with `Authorization: Bearer <session token>`.
 */
interface Env {
  DB: D1Database;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

const DAY = 60 * 60 * 24;
const NO_TOKENS = { accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null };

/** Made per request: a Worker can't carry one request's I/O into another. */
const authFor = (env: Env) =>
  betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: retrying(env.DB),
    trustedOrigins: [env.BETTER_AUTH_URL],
    telemetry: { enabled: false },
    // The schema comes from migrations/. Checking it on every request ran on
    // after the response, got cancelled and left sign-ins hanging.
    advanced: { database: { validateSchema: false } },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        // The GitHub username, shown in the app as @login; kept current.
        mapProfileToUser: (profile) => ({ login: profile.login }),
        overrideUserInfoOnSignIn: true,
      },
    },
    user: {
      // Settable from the GitHub profile only: the hook below refuses it from users.
      additionalFields: { login: { type: "string", required: false } },
      deleteUser: { enabled: true },
    },
    // GitHub is only asked who you are; its tokens aren't kept.
    databaseHooks: {
      account: {
        create: { before: async (account) => ({ data: { ...account, ...NO_TOKENS } }) },
        update: { before: async (account) => ({ data: { ...account, ...NO_TOKENS } }) },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/update-user" && ctx.body && "login" in ctx.body) {
          throw new APIError("BAD_REQUEST", { message: "login comes from GitHub" });
        }
      }),
    },
    // A desktop app stays signed in; each use pushes the expiry forward.
    session: { expiresIn: 60 * DAY, updateAge: DAY },
    plugins: [bearer(), oneTimeToken({ expiresIn: 3, storeToken: "hashed" })],
  });

const app = new Hono<{ Bindings: Env }>();

app.on(["GET", "POST"], "/api/auth/*", (c) => authFor(c.env).handler(c.req.raw));

/** Starts a desktop sign-in: straight on to GitHub. */
app.get("/desktop/start", async (c) => {
  const port = Number(c.req.query("port"));
  const state = c.req.query("state") ?? "";
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[\w-]{16,128}$/.test(state)) {
    return c.html(page("Sign-in link is broken", "Start again from Local Bot."), 400);
  }
  const res = await authFor(c.env).api.signInSocial({
    body: {
      provider: "github",
      callbackURL: `/desktop/done?port=${port}&state=${state}`,
      errorCallbackURL: "/desktop/error",
    },
    asResponse: true,
  });
  const { url } = (await res.json()) as { url?: string };
  if (!url) return c.html(page("Couldn’t reach GitHub", "Try again in a moment."), 502);
  const out = new Response(null, { status: 302, headers: { location: url } });
  // Better Auth's sign-in state travels in a cookie.
  for (const cookie of res.headers.getSetCookie()) out.headers.append("set-cookie", cookie);
  return out;
});

/** Back from GitHub: hand the app a one-time token on its local port. */
app.get("/desktop/done", async (c) => {
  const port = Number(c.req.query("port"));
  const state = c.req.query("state") ?? "";
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[\w-]{16,128}$/.test(state)) {
    return c.html(page("Sign-in link is broken", "Start again from Local Bot."), 400);
  }
  const auth = authFor(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.html(page("Sign-in didn’t finish", "Start again from Local Bot."), 401);
  const { token } = await auth.api.generateOneTimeToken({ headers: c.req.raw.headers });
  const back = new URL(`http://127.0.0.1:${port}/callback`);
  back.searchParams.set("token", token);
  back.searchParams.set("state", state);
  return c.redirect(back.toString(), 302);
});

app.get("/desktop/error", (c) =>
  c.html(page("Sign-in cancelled", "You can close this tab and try again from Local Bot.")));

app.get("/", (c) =>
  c.html(page("Local Bot accounts", "Sign in from the Local Bot app (Settings → Account). Source: github.com/patrick-mns/localbot")));

function page(title: string, text: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
    `<body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#222">` +
    `<div style="text-align:center;padding:0 16px"><h2 style="font-weight:600">${title}</h2><p style="color:#666">${text}</p></div>`;
}

export default app;
