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

export function mcpTransportFetch(serverUrl: URL, oauth: boolean): FetchLike | undefined {
  if (!oauth) return undefined
  return loginRedirectDiscoveryFetch(serverUrl)
}
