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
 * - back-to-back reloads are spaced by `cooldown` (timer re-runs the flush)
 * - only the most recent hit is kept; intermediate ones collapse
 */
export function createMachine(opts: {
  cooldown: number
  active: () => Promise<number> | number
  reload: () => Promise<void>
  onApplied?: (hit: Hit) => unknown
  onError?: (error: unknown, hit: Hit) => unknown
  now?: () => number
}) {
  const now = opts.now ?? (() => Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  let busy = false
  let queued = false
  let last = Number.NEGATIVE_INFINITY
  let latest: Hit | undefined
  // Serializes flushes so an async active() probe can't interleave two state
  // transitions.
  let chain: Promise<unknown> = Promise.resolve()

  const flush = async (): Promise<RequestResult> => {
    timer = undefined
    const sessions = await Promise.resolve(opts.active())
    if (busy) return { ok: true, queued, sessions }
    const hit = latest
    if (!hit) return { ok: true, queued, sessions }

    if (sessions > 0) {
      queued = true
      return { ok: true, queued: true, sessions }
    }

    const wait = opts.cooldown - (now() - last)
    if (wait > 0) {
      schedule(wait)
      return { ok: true, queued: false, sessions, wait }
    }

    busy = true
    queued = false
    latest = undefined
    last = now()
    void Promise.resolve()
      .then(() => opts.reload())
      .then(() => opts.onApplied?.(hit))
      .catch((error) => opts.onError?.(error, hit))
      .finally(() => {
        busy = false
        if (latest) schedule(0)
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

  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void enqueue(), delay)
  }

  return {
    request(hit: Hit) {
      latest = hit
      return enqueue()
    },
    poke() {
      if (!queued) return
      if (timer) return
      schedule(0)
    },
    clear() {
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
    },
  }
}

export type Machine = ReturnType<typeof createMachine>
