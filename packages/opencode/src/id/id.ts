import { randomBytes } from "crypto"

const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
} as const

const LENGTH = 26

// ── Wide time encoding (2026-08 migration) ──────────────────────────────────
//
// The original encoding packed `ms * 0x1000 + counter` into 6 bytes (48 bits).
// That value needs ~53 bits today, so the stored prefix was really
// `value mod 2^48` — i.e. the time component wrapped every 2^36 ms (~2.18
// years), and the then-current era ended on 2026-08-14T11:19:55Z. Past that
// boundary, freshly minted ids would have sorted lexicographically *before*
// every existing id, breaking message ordering, latest-message detection and
// revert comparisons.
//
// Wide ids carry a `g` sentinel (sorts after every legacy hex digit `0-9a-f`
// under byte order, JS string compare, SQLite BINARY and ICU collation alike)
// followed by the full 56-bit value as 14 hex chars (good until year 2527).
// Legacy ids remain valid and always sort before wide ids — which is correct,
// because they were minted earlier.
//
// Descending ids invert the value inside the 56-bit space, so among wide ids
// newer still sorts first. Against *legacy* descending ids a wide id sorts
// after (`g` > any hex), which is only ever consumed as a same-millisecond
// tie-breaker (session listings order by time columns first) — acceptable.
const WIDE_SENTINEL = "g"
const WIDE_HEX_CHARS = 14
const WIDE_MAX = (1n << 56n) - 1n
const LEGACY_HEX_CHARS = 12

// State for monotonic ID generation
let lastTimestamp = 0
let counter = 0

export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62]
  }
  return result
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++

  let value = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  value = direction === "descending" ? WIDE_MAX - value : value

  const hex = value.toString(16).padStart(WIDE_HEX_CHARS, "0")

  return prefix + "_" + WIDE_SENTINEL + hex + randomBase62(LENGTH - 1 - WIDE_HEX_CHARS)
}

function idBody(id: string): string {
  const prefix = id.split("_")[0]
  return id.slice(prefix.length + 1)
}

/**
 * Extract the mint timestamp (ms) from an ascending ID. Does not work with
 * descending IDs.
 *
 * Wide ids (`g` sentinel) decode to the true epoch milliseconds. Legacy ids
 * only ever stored `ms mod 2^36`, so their decoded value is era-relative —
 * consistent *among* legacy ids of the same era, and always smaller than any
 * wide decode (so relative ordering across the two formats still holds).
 */
export function timestamp(id: string): number {
  const body = idBody(id)
  if (body.startsWith(WIDE_SENTINEL)) {
    return Number(BigInt("0x" + body.slice(1, 1 + WIDE_HEX_CHARS)) / BigInt(0x1000))
  }
  const encoded = BigInt("0x" + body.slice(0, LEGACY_HEX_CHARS))
  return Number(encoded / BigInt(0x1000))
}

export * as Identifier from "./id"
