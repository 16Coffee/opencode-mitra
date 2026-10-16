import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"
import { loginRedirectDiscoveryFetch } from "../../src/mcp/oauth-discovery"
import { McpOAuthPendingProvider } from "../../src/mcp/oauth-provider"
import { memoryAuth } from "../fixture/mcp-auth"

const serverUrl = new URL("https://resource.example/mcp/team")
const pathMetadata = "https://resource.example/.well-known/oauth-protected-resource/mcp/team"
const rootMetadata = "https://resource.example/.well-known/oauth-protected-resource"
const issuer = "https://auth.example"
const post = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) }
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

type Seen = { url: string; init?: RequestInit }

// A server whose MCP endpoint sends unauthenticated requests to a login page.
// `follow` emulates what the default fetch does with the redirect.
function loginServer(
  input: {
    status?: number
    resource?: string
    authorizationServers?: string[] | null
    missing?: boolean
    rootOnly?: boolean
    metadataResponse?: () => Response
  } = {},
) {
  const seen: Seen[] = []
  const fetch: FetchLike = async (url, init) => {
    const href = String(url)
    seen.push({ url: href, init })
    if (href === serverUrl.href) {
      if (init?.redirect !== "manual") {
        seen.push({ url: "https://login.example/sso" })
        return new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } })
      }
      const status = input.status ?? 302
      return new Response(status === 200 ? "<html>Sign in</html>" : null, {
        status,
        headers: { location: "https://login.example/sso", "content-type": "text/html" },
      })
    }
    if (href.includes("/.well-known/oauth-protected-resource")) {
      if (input.metadataResponse) return input.metadataResponse()
      if (input.missing || (input.rootOnly && href === pathMetadata)) return json({ detail: "Not Found" }, 404)
      return json({
        resource: input.resource ?? serverUrl.href,
        ...(input.authorizationServers === null ? {} : { authorization_servers: input.authorizationServers ?? [issuer] }),
      })
    }
    if (href === `${issuer}/.well-known/oauth-authorization-server`) {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      })
    }
    if (href === `${issuer}/register`) {
      return json({ ...JSON.parse(String(init?.body)), client_id: "registered-client" }, 201)
    }
    return json({ detail: "Not Found" }, 404)
  }
  return { fetch, seen }
}

describe("loginRedirectDiscoveryFetch", () => {
  for (const status of [302, 303, 200]) {
    test(`${status} login response with valid path metadata becomes a 401 challenge`, async () => {
      const mock = loginServer({ status })
      const response = await loginRedirectDiscoveryFetch(serverUrl, mock.fetch)(serverUrl, post)
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${pathMetadata}"`)
      expect(mock.seen.map((r) => r.url)).toEqual([serverUrl.href, pathMetadata])
      expect(mock.seen[0].init?.redirect).toBe("manual")
    })
  }

  test("metadata is fetched without credentials and without following redirects", async () => {
    const mock = loginServer()
    await loginRedirectDiscoveryFetch(serverUrl, mock.fetch)(serverUrl, post)
    const metadataRequest = mock.seen[1].init
    expect(metadataRequest?.redirect).toBe("manual")
    expect(metadataRequest?.credentials).toBe("omit")
    expect(new Headers(metadataRequest?.headers).has("authorization")).toBe(false)
    expect(new Headers(metadataRequest?.headers).has("cookie")).toBe(false)
  })

  test("path-suffixed metadata is tried before root metadata", async () => {
    const mock = loginServer({ rootOnly: true })
    const response = await loginRedirectDiscoveryFetch(serverUrl, mock.fetch)(serverUrl, post)
    expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${rootMetadata}"`)
    expect(mock.seen.map((r) => r.url)).toEqual([serverUrl.href, pathMetadata, rootMetadata])
  })

  const invalid: Array<[string, Parameters<typeof loginServer>[0]]> = [
    ["no metadata", { missing: true }],
    ["metadata for another path", { resource: "https://resource.example/other" }],
    ["metadata for the bare origin", { resource: "https://resource.example" }],
    ["metadata for another host", { resource: "https://elsewhere.example/mcp/team" }],
    ["metadata without authorization servers", { authorizationServers: null }],
    ["metadata that redirects", { metadataResponse: () => new Response(null, { status: 302, headers: { location: "https://login.example/m" } }) }],
    ["metadata that is a login page", { metadataResponse: () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }) }],
    ["metadata that is not JSON", { metadataResponse: () => new Response("{", { headers: { "content-type": "application/json" } }) }],
    ["metadata with a non-200 status", { metadataResponse: () => json({ resource: serverUrl.href, authorization_servers: [issuer] }, 201) }],
  ]
  for (const [name, input] of invalid) {
    test(`${name}: a redirect falls back to the old follow behaviour, never a 401`, async () => {
      const mock = loginServer(input)
      const response = await loginRedirectDiscoveryFetch(serverUrl, mock.fetch)(serverUrl, post)
      expect(response.status).toBe(200)
      expect(response.headers.get("www-authenticate")).toBeNull()
      expect(mock.seen.map((r) => r.url)).toEqual([
        serverUrl.href,
        pathMetadata,
        rootMetadata,
        serverUrl.href,
        "https://login.example/sso",
      ])
      expect(mock.seen[3].init?.redirect).toBeUndefined()
    })
  }

  test("a 200 login page without metadata is handed back unchanged", async () => {
    const mock = loginServer({ status: 200, missing: true })
    const response = await loginRedirectDiscoveryFetch(serverUrl, mock.fetch)(serverUrl, post)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Sign in")
    expect(mock.seen.map((r) => r.url)).toEqual([serverUrl.href, pathMetadata, rootMetadata])
  })

  test("a real 401 is returned as is, with no metadata probe", async () => {
    const challenge = new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
    const seen: string[] = []
    const fetch = loginRedirectDiscoveryFetch(serverUrl, async (url) => {
      seen.push(String(url))
      return challenge
    })
    expect(await fetch(serverUrl, post)).toBe(challenge)
    expect(seen).toEqual([serverUrl.href])
  })

  test("requests that carry credentials are not touched", async () => {
    const mock = loginServer()
    const init = { ...post, headers: { authorization: "Bearer token" } }
    const response = await loginRedirectDiscoveryFetch(serverUrl, mock.fetch)(serverUrl, init)
    expect(response.status).toBe(200)
    expect(mock.seen[0].init).toBe(init)
    expect(mock.seen.some((r) => r.url.includes("oauth-protected-resource"))).toBe(false)
  })

  test("requests to other URLs are not touched", async () => {
    const mock = loginServer()
    const other = new URL("https://resource.example/other")
    await loginRedirectDiscoveryFetch(serverUrl, mock.fetch)(other, post)
    expect(mock.seen.map((r) => r.url)).toEqual([other.href])
    expect(mock.seen[0].init?.redirect).toBeUndefined()
  })
})

async function startSignIn(fetch: FetchLike) {
  let authorizeUrl: URL | undefined
  const provider = new McpOAuthPendingProvider(
    "login-redirect",
    serverUrl.href,
    { redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback" },
    { onRedirect: (url) => void (authorizeUrl = url) },
    memoryAuth(),
  )
  const transport = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider, fetch })
  const error = await new Client({ name: "test", version: "1.0.0" }).connect(transport).then(
    () => undefined,
    (e: unknown) => e,
  )
  await transport.close().catch(() => {})
  return { error, authorizeUrl }
}

describe("MCP sign-in behind a login redirect (SDK transport end to end)", () => {
  test("starts OAuth against the published authorization server, never the login page", async () => {
    const mock = loginServer()
    const { error, authorizeUrl } = await startSignIn(loginRedirectDiscoveryFetch(serverUrl, mock.fetch))
    expect(error).toBeInstanceOf(UnauthorizedError)
    expect(authorizeUrl?.origin).toBe(issuer)
    expect(authorizeUrl?.searchParams.get("resource")).toBe(serverUrl.href)
    expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256")
    expect(mock.seen.some((r) => new URL(r.url).origin === "https://login.example")).toBe(false)
  })

  test("without published metadata the connection fails as before and no OAuth starts", async () => {
    const mock = loginServer({ missing: true })
    const { error, authorizeUrl } = await startSignIn(loginRedirectDiscoveryFetch(serverUrl, mock.fetch))
    expect(error).not.toBeInstanceOf(UnauthorizedError)
    expect(authorizeUrl).toBeUndefined()
  })
})
