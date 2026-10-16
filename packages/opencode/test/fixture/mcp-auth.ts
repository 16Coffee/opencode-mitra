import { Effect } from "effect"
import type { McpAuth } from "../../src/mcp/auth"

// In-memory McpAuth for OAuth flow tests (read state back through all()/get()).
export function memoryAuth(): McpAuth.Interface {
  const data: Record<string, McpAuth.Entry> = {}
  const update = (name: string, patch: Partial<McpAuth.Entry>, serverUrl?: string) =>
    Effect.sync(() => {
      data[name] = { ...data[name], ...patch, ...(serverUrl ? { serverUrl } : {}) }
    })
  const clear = (name: string, field: keyof McpAuth.Entry) =>
    Effect.sync(() => {
      if (data[name]) delete data[name][field]
    })
  return {
    all: () => Effect.succeed(data),
    get: (name) => Effect.succeed(data[name]),
    getForUrl: (name, url) => Effect.succeed(data[name]?.serverUrl === url ? data[name] : undefined),
    set: (name, entry, serverUrl) => update(name, entry, serverUrl),
    remove: (name) => Effect.sync(() => void delete data[name]),
    updateTokens: (name, tokens, serverUrl) => update(name, { tokens }, serverUrl),
    updateClientInfo: (name, clientInfo, serverUrl) => update(name, { clientInfo }, serverUrl),
    updateCodeVerifier: (name, codeVerifier) => update(name, { codeVerifier }),
    clearCodeVerifier: (name) => clear(name, "codeVerifier"),
    updateOAuthState: (name, oauthState) => update(name, { oauthState }),
    getOAuthState: (name) => Effect.succeed(data[name]?.oauthState),
    clearOAuthState: (name) => clear(name, "oauthState"),
  }
}
