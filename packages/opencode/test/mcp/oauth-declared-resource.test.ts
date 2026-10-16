import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { mcpTransportFetch, tokenResourceFetch } from "../../src/mcp/oauth-discovery"
import { McpOAuthPendingProvider, McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { memoryAuth } from "../fixture/mcp-auth"

// Shaped after ElevenLabs as observed on 2026-10-17: the documented global host
// answers 401 and points at metadata on its US host, which declares itself.
const configured = new URL("https://api.elevenlabs.io/v1/mcp")
const declared = "https://api.us.elevenlabs.io/v1/mcp"
const issuer = "https://api.us.elevenlabs.io"
const declaredPathMetadata = "https://api.us.elevenlabs.io/.well-known/oauth-protected-resource/v1/mcp"
const declaredRootMetadata = "https://api.us.elevenlabs.io/.well-known/oauth-protected-resource"
const configuredMetadata = "https://api.elevenlabs.io/.well-known/oauth-protected-resource"
const redirectUri = "http://127.0.0.1:19876/mcp/oauth/callback"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

type Seen = { url: string; init?: RequestInit }
const bearerOf = (r: Seen) => new Headers(r.init?.headers).get("authorization")?.startsWith("Bearer ")

function provider(
  input: {
    resource?: string
    authorizationServers?: string[]
    metadata?: (href: string) => Response | undefined
    // When set, the configured host's 401 points at metadata it publishes itself.
    configuredMetadata?: { resource: string; authorization_servers: string[] }
  } = {},
) {
  const seen: Seen[] = []
  const metadataBody = { resource: input.resource ?? declared, authorization_servers: input.authorizationServers ?? [issuer] }
  const fetch: FetchLike = async (url, init) => {
    const href = String(url)
    seen.push({ url: href, init })
    const custom = input.metadata?.(href)
    if (custom) return custom
    if (href === configuredMetadata && input.configuredMetadata) return json(input.configuredMetadata)
    if (href === declaredPathMetadata || href === declaredRootMetadata) return json(metadataBody)
    if (href.endsWith("/.well-known/oauth-authorization-server")) {
      const origin = new URL(href).origin
      return json({
        issuer: origin,
        authorization_endpoint: origin === issuer ? "https://elevenlabs.io/app/oauth/authorize" : `${origin}/authorize`,
        token_endpoint: `${origin}/v1/oauth/token`,
        registration_endpoint: `${origin}/v1/oauth/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      })
    }
    if (href.endsWith("/v1/oauth/register")) return json({ ...JSON.parse(String(init?.body)), client_id: "client-1" }, 201)
    if (href === `${issuer}/v1/oauth/token`) {
      return json({ access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1" })
    }
    const target = new URL(href)
    if (target.pathname === configured.pathname && (target.origin === configured.origin || target.origin === new URL(declared).origin)) {
      if (!bearerOf({ url: href, init })) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${input.configuredMetadata ? configuredMetadata : declaredRootMetadata}"`,
          },
        })
      }
      // Only the declared host accepts the token; the configured host must never see it.
      if (target.origin !== new URL(declared).origin) return new Response("token sent to the wrong host", { status: 400 })
      if (init?.method === "GET") return new Response(null, { status: 405 })
      const message = JSON.parse(String(init?.body))
      if (message.id === undefined) return new Response(null, { status: 202 })
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "declared", version: "1.0.0" },
        },
      })
    }
    return json({ detail: "Not Found" }, 404)
  }
  return { fetch, seen }
}

function oauthProvider(fetch: FetchLike, authorizationServerUrl: string | null = issuer) {
  const p = new McpOAuthProvider("declared", configured.href, {}, { onRedirect: () => {} }, memoryAuth(), fetch)
  if (authorizationServerUrl) p.saveDiscoveryState({ authorizationServerUrl })
  return p
}

describe("McpOAuthProvider.validateResourceURL", () => {
  test("a same-origin resource keeps the SDK rule and fetches nothing", async () => {
    const mock = provider()
    const p = oauthProvider(mock.fetch)
    const resource = await p.validateResourceURL(configured, "https://api.elevenlabs.io/v1")
    expect(resource?.href).toBe("https://api.elevenlabs.io/v1")
    expect(mock.seen).toEqual([])
  })

  test("a resource on another host is accepted when its own metadata vouches for it", async () => {
    const mock = provider()
    const resource = await oauthProvider(mock.fetch).validateResourceURL(configured, declared)
    expect(resource?.href).toBe(declared)
    expect(mock.seen.map((r) => r.url)).toEqual([declaredPathMetadata])
    expect(mock.seen[0].init?.redirect).toBe("manual")
    expect(mock.seen[0].init?.credentials).toBe("omit")
  })

  const refused: Array<[string, () => Promise<unknown>]> = [
    [
      // The http resource vouches for itself; only the https rule may refuse it.
      "an http resource",
      () =>
        oauthProvider(
          provider({
            metadata: (href) =>
              href === "http://api.us.elevenlabs.io/.well-known/oauth-protected-resource/v1/mcp"
                ? json({ resource: "http://api.us.elevenlabs.io/v1/mcp", authorization_servers: [issuer] })
                : undefined,
          }).fetch,
        ).validateResourceURL(configured, "http://api.us.elevenlabs.io/v1/mcp"),
    ],
    [
      "an http configured server",
      () =>
        oauthProvider(provider().fetch).validateResourceURL(new URL("http://api.elevenlabs.io/v1/mcp"), declared),
    ],
    ["a different path", () => oauthProvider(provider({ resource: "https://api.us.elevenlabs.io/v2/mcp" }).fetch).validateResourceURL(configured, "https://api.us.elevenlabs.io/v2/mcp")],
    ["a query on the resource", () => oauthProvider(provider().fetch).validateResourceURL(configured, `${declared}?tenant=x`)],
    ["credentials in the resource", () => oauthProvider(provider().fetch).validateResourceURL(configured, "https://u:p@api.us.elevenlabs.io/v1/mcp")],
    ["no discovered authorization server", () => oauthProvider(provider().fetch, null).validateResourceURL(configured, declared)],
    [
      "metadata missing on the resource host",
      () => oauthProvider(provider({ metadata: () => json({ detail: "Not Found" }, 404) }).fetch).validateResourceURL(configured, declared),
    ],
    [
      "metadata only at the root of the resource host",
      () =>
        oauthProvider(
          provider({ metadata: (href) => (href === declaredPathMetadata ? json({}, 404) : undefined) }).fetch,
        ).validateResourceURL(configured, declared),
    ],
    [
      "resource metadata that redirects",
      () =>
        oauthProvider(
          provider({ metadata: () => new Response(null, { status: 302, headers: { location: declaredPathMetadata } }) }).fetch,
        ).validateResourceURL(configured, declared),
    ],
    [
      "resource metadata declaring something else",
      () => oauthProvider(provider({ resource: "https://api.us.elevenlabs.io/v1/other" }).fetch).validateResourceURL(configured, declared),
    ],
    [
      "resource metadata naming another authorization server",
      () => oauthProvider(provider({ authorizationServers: ["https://evil.example"] }).fetch).validateResourceURL(configured, declared),
    ],
  ]
  for (const [name, run] of refused) {
    test(`refuses ${name}`, async () => {
      await expect(run()).rejects.toThrow(/does not match expected/)
    })
  }

  test("a server cannot borrow another API's resource through an authorization server it controls", async () => {
    // evil.example claims the ElevenLabs resource but discovery picked its own AS.
    const mock = provider()
    const p = oauthProvider(mock.fetch, "https://auth.evil.example")
    await expect(p.validateResourceURL(new URL("https://evil.example/v1/mcp"), declared)).rejects.toThrow(
      /does not list the authorization server/,
    )
  })
})

describe("tokenResourceFetch", () => {
  const seenBy = () => {
    const seen: Seen[] = []
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url: String(url), init })
      return new Response(null, { status: 204 })
    }
    return { seen, fetch }
  }
  const bearer = { method: "POST", headers: { authorization: "Bearer at-1" } }

  test("bearer requests for the configured server go to the token's resource origin", async () => {
    const mock = seenBy()
    await tokenResourceFetch(configured, async () => declared, mock.fetch)(new URL(`${configured.href}?x=1`), bearer)
    expect(mock.seen.map((r) => r.url)).toEqual([`${declared}?x=1`])
  })

  test("requests without a bearer token are not rerouted (token endpoint with Basic auth)", async () => {
    const mock = seenBy()
    const reroute = tokenResourceFetch(configured, async () => declared, mock.fetch)
    await reroute(new URL("https://api.elevenlabs.io/oauth/token"), { method: "POST", headers: { authorization: "Basic abc" } })
    await reroute(configured, { method: "POST" })
    expect(mock.seen.map((r) => r.url)).toEqual(["https://api.elevenlabs.io/oauth/token", configured.href])
  })

  test("no recorded resource, a same-origin resource, or another origin leaves the request alone", async () => {
    const mock = seenBy()
    await tokenResourceFetch(configured, async () => undefined, mock.fetch)(configured, bearer)
    await tokenResourceFetch(configured, async () => "https://api.elevenlabs.io/v1", mock.fetch)(configured, bearer)
    await tokenResourceFetch(configured, async () => declared, mock.fetch)(new URL("https://other.example/v1/mcp"), bearer)
    expect(mock.seen.map((r) => r.url)).toEqual([configured.href, configured.href, "https://other.example/v1/mcp"])
  })
})

async function connect(transport: StreamableHTTPClientTransport) {
  const client = new Client({ name: "test", version: "1.0.0" })
  const error = await client.connect(transport).then(
    () => undefined,
    (e: unknown) => e,
  )
  await client.close().catch(() => {})
  return error
}

describe("MCP sign-in for a resource declared on another host (SDK transport end to end)", () => {
  test("signs in for the declared resource and only ever sends the token to it", async () => {
    const mock = provider()
    const auth = memoryAuth()
    let authorizeUrl: URL | undefined
    const pending = new McpOAuthPendingProvider(
      "declared",
      configured.href,
      { redirectUri },
      { onRedirect: (url) => void (authorizeUrl = url) },
      auth,
      mock.fetch,
    )
    const fetch = mcpTransportFetch(configured, pending, mock.fetch)
    const first = new StreamableHTTPClientTransport(configured, { authProvider: pending, fetch })
    expect(await connect(first)).toBeInstanceOf(UnauthorizedError)
    expect(authorizeUrl?.origin).toBe("https://elevenlabs.io")
    expect(authorizeUrl?.searchParams.get("resource")).toBe(declared)

    await first.finishAuth("code-1")
    expect(await connect(new StreamableHTTPClientTransport(configured, { authProvider: pending, fetch }))).toBeUndefined()
    await pending.commit()

    const stored = await Effect.runPromise(auth.get("declared"))
    expect(stored?.tokens?.accessToken).toBe("at-1")
    expect(stored?.tokens?.resource).toBe(declared)

    // After a restart the stored token keeps going to the declared host.
    const restarted = new McpOAuthProvider("declared", configured.href, {}, { onRedirect: () => {} }, auth, mock.fetch)
    const afterRestart = new StreamableHTTPClientTransport(configured, {
      authProvider: restarted,
      fetch: mcpTransportFetch(configured, restarted, mock.fetch),
    })
    expect(await connect(afterRestart)).toBeUndefined()

    const withToken = mock.seen.filter(bearerOf)
    expect(withToken.length).toBeGreaterThan(0)
    expect(withToken.every((r) => new URL(r.url).origin === issuer)).toBe(true)
    expect(mock.seen.some((r) => new URL(r.url).origin === configured.origin && bearerOf(r))).toBe(false)
  })

  test("a server naming its own authorization server for another host's resource stops before the browser opens", async () => {
    // The configured host claims the US resource but sends discovery to an AS it
    // controls; the US resource's own metadata only names the real issuer.
    const mock = provider({
      configuredMetadata: { resource: declared, authorization_servers: ["https://auth.evil.example"] },
    })
    let authorizeUrl: URL | undefined
    const pending = new McpOAuthPendingProvider(
      "declared",
      configured.href,
      { redirectUri },
      { onRedirect: (url) => void (authorizeUrl = url) },
      memoryAuth(),
      mock.fetch,
    )
    const transport = new StreamableHTTPClientTransport(configured, {
      authProvider: pending,
      fetch: mcpTransportFetch(configured, pending, mock.fetch),
    })
    const error = await connect(transport)
    expect(error).not.toBeInstanceOf(UnauthorizedError)
    expect(String(error)).toContain("does not list the authorization server https://auth.evil.example")
    expect(authorizeUrl).toBeUndefined()
    expect(mock.seen.some((r) => r.url.startsWith("https://auth.evil.example/v1/oauth/register"))).toBe(false)
  })
})
