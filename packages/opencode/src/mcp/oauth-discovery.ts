import {
  OAuthProtectedResourceMetadataSchema,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js"

// Mitra patch (2026-10-17): OAuth discovery for MCP servers whose endpoint does not
// answer an unauthenticated request with the 401 the MCP spec expects.
//
// Some servers send the unauthenticated initialize POST to a login page instead:
// a 302 to an SSO screen, or a 200 HTML page. The default fetch follows the
// redirect, the transport gets HTML back and fails with a content-type error, so
// the server looks like it does not support OAuth at all. The SDK only starts
// discovery from a 401, so we turn the login response into one — but only after
// the server itself publishes valid RFC 9728 protected resource metadata for this
// exact endpoint. Without that, the request falls back to the old behaviour.

const defaultFetch: FetchLike = (url, init) => fetch(url, init)

function toURL(input: string | URL) {
  return new URL(typeof input === "string" ? input : input.href)
}

function normalizedResource(value: string | URL) {
  const url = new URL(typeof value === "string" ? value : value.href)
  url.hash = ""
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1)
  return url.href
}

// RFC 9728 §3.3: the advertised resource must be the identifier the metadata was looked up for.
export function sameResource(a: string | URL, b: string | URL) {
  return normalizedResource(a) === normalizedResource(b)
}

// RFC 9728 §3.1: the well-known segment goes between the host and the path. The
// root URL is only the identifier's own metadata URL when the path is empty, so it
// is a fallback the caller has to opt into.
export function protectedResourceMetadataUrls(resource: URL, opts: { rootFallback: boolean }) {
  const path = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "")
  const urls = [new URL(`/.well-known/oauth-protected-resource${path}`, resource.origin)]
  if (path && opts.rootFallback) urls.push(new URL("/.well-known/oauth-protected-resource", resource.origin))
  return urls
}

// Fetches one metadata document without credentials and without following redirects:
// a login page or a redirect is never metadata.
export async function fetchProtectedResourceMetadata(
  url: URL,
  fetchFn: FetchLike = defaultFetch,
): Promise<OAuthProtectedResourceMetadata | undefined> {
  const response = await fetchFn(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
    credentials: "omit",
  }).catch(() => undefined)
  if (!response) return undefined
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("json")) {
    await response.body?.cancel().catch(() => {})
    return undefined
  }
  const body = await response.json().catch(() => undefined)
  const parsed = OAuthProtectedResourceMetadataSchema.safeParse(body)
  if (!parsed.success) return undefined
  if (!parsed.data.authorization_servers?.length) return undefined
  return parsed.data
}

function isRedirect(response: Response) {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)
}

function isLoginInterstitial(response: Response) {
  if (isRedirect(response)) return true
  return response.ok && !!response.headers.get("content-type")?.includes("text/html")
}

/**
 * Wraps the transport fetch so an unauthenticated request to the MCP endpoint that
 * lands on a login redirect or HTML page becomes the 401 + resource_metadata
 * challenge the SDK needs to start OAuth. Requests that already carry credentials,
 * and requests to any other URL, pass through untouched.
 */
export function loginRedirectDiscoveryFetch(serverUrl: URL, inner: FetchLike = defaultFetch): FetchLike {
  return async (input, init) => {
    const url = toURL(input)
    if (!sameResource(url, serverUrl) || new Headers(init?.headers).has("authorization")) return inner(input, init)

    const response = await inner(input, { ...init, redirect: "manual" })
    if (!isLoginInterstitial(response)) return response

    for (const metadataUrl of protectedResourceMetadataUrls(serverUrl, { rootFallback: true })) {
      const metadata = await fetchProtectedResourceMetadata(metadataUrl, inner)
      if (!metadata || !sameResource(metadata.resource, serverUrl)) continue
      await response.body?.cancel().catch(() => {})
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${metadataUrl.href}"` },
      })
    }

    // No metadata for this endpoint: behave as before. A plain redirect (for
    // example a trailing-slash 307) is followed; a login page is handed back as is.
    if (!isRedirect(response)) return response
    await response.body?.cancel().catch(() => {})
    return inner(input, init)
  }
}

// Mitra patch (2026-10-17): a protected resource declared on another host.
//
// Some providers serve one MCP endpoint from several hosts and declare a single
// canonical resource elsewhere — ElevenLabs configures as api.elevenlabs.io/v1/mcp
// and declares https://api.us.elevenlabs.io/v1/mcp. The SDK's same-origin check
// refuses that and sign-in fails before the browser opens.
//
// Accepting it naively would let any server declare someone else's API, collect a
// token for it, and receive that token on every request. So a declared resource on
// another origin is accepted only when the resource itself vouches for it, and the
// token is then only ever sent to that resource:
//   - both URLs are https, the path is the same, the declared URL has no
//     credentials, query or fragment;
//   - the resource's own metadata (RFC 9728 §3.1 path-suffixed URL on its host,
//     no redirects) declares exactly that resource (§3.3);
//   - that metadata lists the authorization server discovery selected, so the
//     token is issued by an issuer the resource itself names;
//   - authenticated requests go to the resource's origin (tokenResourceFetch).
export async function verifyDeclaredResource(input: {
  serverUrl: URL
  declared: URL
  authorizationServer?: string
  fetch?: FetchLike
}) {
  const { serverUrl, declared } = input
  const refuse = (reason: string): never => {
    throw new Error(`Protected resource ${declared.href} does not match expected ${serverUrl.href}: ${reason}`)
  }
  if (serverUrl.protocol !== "https:" || declared.protocol !== "https:")
    refuse("a resource on another host is only accepted over https")
  if (declared.username || declared.password || declared.search || declared.hash)
    refuse("the declared resource must not carry credentials, a query or a fragment")
  if (!sameResource(new URL(declared.pathname, serverUrl.origin), new URL(serverUrl.pathname, serverUrl.origin)))
    refuse("a resource on another host must keep the same path")
  if (!input.authorizationServer) refuse("no authorization server was discovered")

  const [metadataUrl] = protectedResourceMetadataUrls(declared, { rootFallback: false })
  const metadata = await fetchProtectedResourceMetadata(metadataUrl, input.fetch)
  if (!metadata) refuse(`the resource publishes no valid metadata at ${metadataUrl.href}`)
  if (!sameResource(metadata!.resource, declared)) refuse(`its own metadata declares ${metadata!.resource}`)
  if (!metadata!.authorization_servers!.some((server) => sameResource(server, input.authorizationServer!)))
    refuse(`its own metadata does not list the authorization server ${input.authorizationServer}`)
}

/**
 * Sends bearer-authenticated requests for the configured server to the origin of
 * the resource the token was issued for, when that is another origin. Requests
 * without a bearer token (discovery, token and registration calls) are untouched.
 */
export function tokenResourceFetch(
  serverUrl: URL,
  tokenResource: () => Promise<string | undefined>,
  inner: FetchLike = defaultFetch,
): FetchLike {
  return async (input, init) => {
    const url = toURL(input)
    const authorization = new Headers(init?.headers).get("authorization")
    if (url.origin !== serverUrl.origin || !authorization?.toLowerCase().startsWith("bearer ")) return inner(input, init)
    const resource = await tokenResource()
    if (!resource) return inner(input, init)
    const target = new URL(resource)
    if (target.origin === serverUrl.origin) return inner(input, init)
    return inner(new URL(url.pathname + url.search, target.origin), init)
  }
}

export function mcpTransportFetch(
  serverUrl: URL,
  provider: { tokenResource(): Promise<string | undefined> } | undefined,
  inner: FetchLike = defaultFetch,
): FetchLike | undefined {
  if (!provider) return undefined
  return loginRedirectDiscoveryFetch(serverUrl, tokenResourceFetch(serverUrl, () => provider.tokenResource(), inner))
}
