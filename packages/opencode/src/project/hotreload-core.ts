import path from "path"

export type ReloadEvent = "add" | "change" | "unlink"

export interface Hit {
  file: string
  event: ReloadEvent
}

export interface RequestResult {
  ok: boolean
  queued: boolean
  sessions: number
  wait?: number
}

function normalize(file: string) {
  return file.split(path.sep).join("/")
}

function temp(file: string) {
  const base = file.split("/").at(-1) ?? file
  if (!base) return true
  if (base === ".DS_Store" || base === "Thumbs.db") return true
  if (base.startsWith(".#")) return true
  if (base.endsWith("~")) return true
  if (base.endsWith(".tmp")) return true
  if (base.endsWith(".swp")) return true
  if (base.endsWith(".swo")) return true
  if (base.endsWith(".swx")) return true
  if (base.endsWith(".bak")) return true
  if (base.endsWith(".orig")) return true
  if (base.endsWith(".rej")) return true
  if (base.endsWith(".crdownload")) return true
  return false
}

function rel(root: string, file: string) {
  const roots = new Set([normalize(root).replace(/\/+$/, "")])
  const files = new Set([normalize(file)])

  if (process.platform === "darwin") {
    for (const item of [...roots]) {
      if (item.startsWith("/private/")) roots.add(item.slice("/private".length))
      if (item.startsWith("/var/")) roots.add(`/private${item}`)
    }
    for (const item of [...files]) {
      if (item.startsWith("/private/")) files.add(item.slice("/private".length))
      if (item.startsWith("/var/")) files.add(`/private${item}`)
    }
  }

  for (const rootItem of roots) {
    for (const fileItem of files) {
      if (fileItem.includes("/.git/")) continue
      if (fileItem === rootItem) continue
      if (!fileItem.startsWith(`${rootItem}/`)) continue
      return fileItem.slice(rootItem.length + 1)
    }
  }
}

const watched = new Set([
  "agent",
  "agents",
  "command",
  "commands",
  "mode",
  "modes",
  "plugin",
  "plugins",
  "skill",
  "skills",
  "tool",
  "tools",
])

// Ported from upstream PR #13409. Not in the manual-trigger path (the
// endpoint reloads unconditionally); kept so a future watcher-driven trigger
// classifies files identically to upstream.
export function classify(root: string, file: string) {
  const relFile = rel(root, file)
  if (!relFile) return
  if (temp(relFile)) return
  if (relFile === "opencode.json") return relFile
  if (relFile === "opencode.jsonc") return relFile
  if (relFile === "AGENTS.md") return relFile
  if (relFile === ".opencode/opencode.json") return relFile
  if (relFile === ".opencode/opencode.jsonc") return relFile
  if (!relFile.startsWith(".opencode/")) return
  if (relFile.startsWith(".opencode/openwork/")) return

  const parts = relFile.split("/")
  if (parts.length < 3) return
  if (!watched.has(parts[1])) return

  const base = parts.at(-1) ?? ""
  if (!base.includes(".")) return
  return relFile
}

/**
 * Session-aware reload state machine, semantics ported from PR #13409:
 * - while a reload is in flight (`busy`), new requests just record `latest`
 * - while sessions are busy/retrying, the request is queued (`queued: true`)
 *   and drained automatically when `poke()` observes idle
 * - **but a queued hit is never allowed to wait forever**: once it has been
 *   waiting longer than `maxQueue`, it applies even with busy sessions.
 *   Deferring is an optimisation (avoid resetting registries mid-turn), not a
 *   correctness requirement — `reload()` resets in place and deliberately does
 *   NOT dispose the instance, so running sessions survive it. A single session
 *   stuck in `busy` used to pin the queue permanently, which turned that
 *   optimisation into "this reload never happens" (2026-07-28: freshly
 *   distilled Mitra personas stayed invisible to the agent list for hours;
 *   @-mentioning one returned BadRequest because the agent did not exist).
 * - back-to-back reloads are spaced by `cooldown` (timer re-runs the flush)
 * - only the most recent hit is kept; intermediate ones collapse
 */
export function createMachine(opts: {
  cooldown: number
  /** Upper bound on how long a queued hit may wait for idle. 0 disables the cap. */
  maxQueue?: number
  active: () => Promise<number> | number
  reload: () => Promise<void>
  onApplied?: (hit: Hit) => unknown
  onError?: (error: unknown, hit: Hit) => unknown
  now?: () => number
}) {
  const now = opts.now ?? (() => Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  // Why the pending timer exists. A "queue" timer is only a deadline re-check
  // for the maxQueue cap; poke() must be able to pre-empt it the moment
  // sessions actually go idle. A "cooldown" timer is real spacing between
  // reloads and must not be shortened.
  let timerKind: "cooldown" | "queue" | undefined
  let busy = false
  let queued = false
  let last = Number.NEGATIVE_INFINITY
  let latest: Hit | undefined
  // When the oldest still-unapplied hit was first deferred for busy sessions.
  let queuedSince: number | undefined
  // Serializes flushes so an async active() probe can't interleave two state
  // transitions.
  let chain: Promise<unknown> = Promise.resolve()

  const flush = async (): Promise<RequestResult> => {
    timer = undefined
    const sessions = await Promise.resolve(opts.active())
    if (busy) return { ok: true, queued, sessions }
    const hit = latest
    if (!hit) return { ok: true, queued, sessions }

    const maxQueue = opts.maxQueue ?? 0
    if (sessions > 0) {
      if (queuedSince === undefined) queuedSince = now()
      const waited = now() - queuedSince
      if (maxQueue <= 0 || waited < maxQueue) {
        queued = true
        // Re-check on a timer instead of relying solely on poke(): a session
        // that never returns to idle emits no status event, so poke() never
        // fires and nothing would ever revisit this decision.
        if (maxQueue > 0) schedule(maxQueue - waited, "queue")
        return { ok: true, queued: true, sessions }
      }
      // Waited long enough — apply anyway rather than never.
    }

    const wait = opts.cooldown - (now() - last)
    if (wait > 0) {
      schedule(wait, "cooldown")
      return { ok: true, queued: false, sessions, wait }
    }

    busy = true
    queued = false
    queuedSince = undefined
    latest = undefined
    last = now()
    void Promise.resolve()
      .then(() => opts.reload())
      .then(() => opts.onApplied?.(hit))
      .catch((error) => opts.onError?.(error, hit))
      .finally(() => {
        busy = false
        if (latest) schedule(0, "cooldown")
      })
    return { ok: true, queued: false, sessions }
  }

  const enqueue = () => {
    const next = chain.then(flush)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const schedule = (delay: number, kind: "cooldown" | "queue") => {
    if (timer) clearTimeout(timer)
    timerKind = kind
    timer = setTimeout(() => {
      timerKind = undefined
      void enqueue()
    }, delay)
  }

  return {
    request(hit: Hit) {
      latest = hit
      return enqueue()
    },
    poke() {
      if (!queued) return
      // A pending maxQueue deadline must not stop us from draining right now —
      // that timer is a worst-case fallback, poke() is the fast path.
      if (timer && timerKind !== "queue") return
      schedule(0, "queue")
    },
    clear() {
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
      timerKind = undefined
    },
  }
}

export type Machine = ReturnType<typeof createMachine>
