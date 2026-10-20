import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Sign-in for remote MCP servers (the MCP authorization spec: OAuth 2.1 with
 * PKCE). The server's 401 points to its protected-resource metadata, which
 * names the authorization server; Local Bot registers itself there (dynamic
 * client registration) or, where the server reads client metadata documents
 * instead, names itself by the URL of its published one. It opens the sign-in
 * page in the browser and takes the code on a one-off loopback address. Tokens go to the Keychain (the caller
 * stores them) and are refreshed when they expire.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** ms since epoch */
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  resource: string;
}

interface AuthServer {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
  scopes_supported?: string[];
}

/**
 * Local Bot's client metadata document (assets/oauth-client.json, served from
 * the repo): its URL is the client id for servers without registration. Its
 * redirect URIs are fixed, so the loopback uses one of these ports.
 */
const CLIENT_METADATA_URL = "https://raw.githubusercontent.com/patrick-mns/localbot/elevenlabs-connector/assets/oauth-client.json";
const METADATA_PORTS = [47821, 47822, 47823];

const UA = { "user-agent": "LocalBot (MCP client)" };
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

async function getJSON(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...UA }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Where to sign in for this MCP server, or null if it doesn't need it. */
export async function discover(serverUrl: string): Promise<{ authServer: AuthServer; scopes?: string[] } | null> {
  const res = await fetch(serverUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "localbot-brain", version: "0.1.0" } } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 401) return null;
  const u = new URL(serverUrl);
  const www = res.headers.get("www-authenticate") ?? "";
  const pointed = /resource_metadata="([^"]+)"/.exec(www)?.[1];
  const path = u.pathname.replace(/\/$/, "");
  let resource: any = null;
  for (const url of [pointed, `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`]) {
    if (url && (resource = await getJSON(url))) break;
  }
  const issuer = new URL(resource?.authorization_servers?.[0] ?? u.origin);
  const ipath = issuer.pathname.replace(/\/$/, "");
  let meta: AuthServer | null = null;
  for (const url of [
    `${issuer.origin}/.well-known/oauth-authorization-server${ipath}`,
    `${issuer.origin}/.well-known/openid-configuration${ipath}`,
    `${issuer.origin}${ipath}/.well-known/oauth-authorization-server`,
    `${issuer.origin}${ipath}/.well-known/openid-configuration`,
  ]) {
    meta = await getJSON(url);
    if (meta?.authorization_endpoint && meta?.token_endpoint) break;
  }
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new Error("This server asks to sign in but doesn’t say where");
  return { authServer: meta, scopes: resource?.scopes_supported };
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** A sign-in in progress: open `url` in the browser; `done` settles with the tokens. */
export interface SignIn {
  url: string;
  done: Promise<OAuthTokens>;
  cancel(): void;
}

export async function startSignIn(serverUrl: string, clientName = "Local Bot"): Promise<SignIn> {
  const found = await discover(serverUrl);
  if (!found) throw new Error("This server doesn’t need a sign-in");
  const { authServer, scopes } = found;
  const byMetadata = !authServer.registration_endpoint && authServer.client_id_metadata_document_supported;
  if (!authServer.registration_endpoint && !byMetadata) {
    throw new Error("This service needs Local Bot to be registered with it first; it isn’t supported yet");
  }

  // One-off loopback address for the browser to come back to.
  const { server, port } = await listen(byMetadata ? METADATA_PORTS : [0]);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let client: { client_id: string; client_secret?: string } = { client_id: CLIENT_METADATA_URL };
  if (!byMetadata) {
    try {
      client = await register(authServer.registration_endpoint!, clientName, redirectUri);
    } catch (err) {
      server.close();
      throw err;
    }
  }

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const auth = new URL(authServer.authorization_endpoint);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", client.client_id);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  auth.searchParams.set("state", state);
  auth.searchParams.set("resource", serverUrl);
  if (scopes?.length) auth.searchParams.set("scope", scopes.join(" "));

  let cancel = () => {};
  const done = new Promise<OAuthTokens>((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error("The sign-in wasn’t finished in time")); }, SIGN_IN_TIMEOUT_MS);
    cancel = () => { clearTimeout(timer); server.close(); reject(new Error("Sign-in cancelled")); };
    server.on("request", async (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const page = (title: string, text: string) =>
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
          `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px -apple-system,sans-serif;display:grid;place-items:center;height:90vh;color:#222"><div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p style="color:#666">${text}</p></div>`);
      const finish = (err?: Error, tokens?: OAuthTokens) => {
        clearTimeout(timer);
        setTimeout(() => server.close(), 500);
        err ? reject(err) : resolve(tokens!);
      };
      if (url.searchParams.get("state") !== state) {
        page("Sign-in failed", "This link doesn’t match the sign-in Local Bot started. Try again from the app.");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        page("Sign-in cancelled", "You can close this tab and try again from Local Bot.");
        return finish(new Error(error === "access_denied" ? "Access wasn’t allowed" : `Sign-in failed: ${error ?? "no code"}`));
      }
      try {
        const tokens = await exchange(authServer.token_endpoint, {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: client.client_id,
          code_verifier: verifier,
          resource: serverUrl,
        }, client.client_secret);
        page("Connected to Local Bot", "You can close this tab and go back to the app.");
        finish(undefined, { ...tokens, clientId: client.client_id, clientSecret: client.client_secret, tokenEndpoint: authServer.token_endpoint, resource: serverUrl });
      } catch (err) {
        page("Sign-in failed", "Local Bot couldn’t finish the sign-in. Try again from the app.");
        finish(err as Error);
      }
    });
  });
  return { url: auth.toString(), done, cancel: () => cancel() };
}

/** Dynamic client registration: a client id of Local Bot's own on this server. */
async function register(endpoint: string, clientName: string, redirectUri: string) {
  const reg = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...UA },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!reg.ok) throw new Error(`The service refused to register Local Bot (HTTP ${reg.status})`);
  return (await reg.json()) as { client_id: string; client_secret?: string };
}

/** A loopback server on the first of `ports` that's free (0: any port). */
async function listen(ports: number[]): Promise<{ server: Server; port: number }> {
  for (const [i, wanted] of ports.entries()) {
    try {
      return await new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(wanted, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
      });
    } catch (err) {
      if (i === ports.length - 1) throw new Error("Couldn’t open a local address for the sign-in; try again");
    }
  }
  throw new Error("No port to listen on");
}

/** A fresh access token from the refresh token. */
export async function refresh(t: OAuthTokens): Promise<OAuthTokens> {
  if (!t.refreshToken) throw new Error("The sign-in expired; connect again");
  const next = await exchange(t.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: t.refreshToken,
    client_id: t.clientId,
    resource: t.resource,
  }, t.clientSecret);
  return { ...t, ...next, refreshToken: next.refreshToken ?? t.refreshToken };
}

async function exchange(endpoint: string, form: Record<string, string>, secret?: string) {
  const body = new URLSearchParams(form);
  if (secret) body.set("client_secret", secret);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...UA },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(json.error_description ?? json.error ?? `Token request failed (HTTP ${res.status})`);
  return {
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    expiresAt: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : undefined,
  };
}
