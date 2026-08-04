import { describe, expect, test } from "bun:test"

import { Identifier } from "@/id/id"
import * as SchemaIdentifier from "@opencode-ai/schema/identifier"

/**
 * The legacy encoder (pre 2026-08 migration), reproduced verbatim so tests can
 * assert ordering of real historical ids against wide ids. It truncated
 * `ms*0x1000+counter` to 48 bits, so its time prefix was `value mod 2^48` and
 * wrapped every 2^36 ms — the era in production ended 2026-08-14T11:19:55Z.
 */
function legacyCreate(prefix: string, direction: "ascending" | "descending", ms: number, counter = 1): string {
  let value = BigInt(ms) * BigInt(0x1000) + BigInt(counter)
  if (direction === "descending") value = ~value
  let hex = ""
  for (let i = 0; i < 6; i++) {
    hex += Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff))
      .toString(16)
      .padStart(2, "0")
  }
  return prefix + "_" + hex + "00000000000000"
}

/** Production era boundary the legacy encoding would have wrapped at. */
const ERA_BOUNDARY_MS = 26 * 2 ** 36 // 2026-08-14T11:19:55.136Z

describe("wide id encoding", () => {
  test("has the expected shape: prefix, g sentinel, 14 hex, 26 chars total", () => {
    const id = Identifier.create("msg", "ascending")
    expect(id.startsWith("msg_g")).toBe(true)
    expect(id.length).toBe("msg_".length + 26)
    expect(id.slice(5, 19)).toMatch(/^[0-9a-f]{14}$/)
  })

  test("ascending ids sort after every legacy id — including across the 2026-08-14 era boundary", () => {
    const legacyEarly = legacyCreate("msg", "ascending", Date.UTC(2025, 0, 1))
    const legacyLate = legacyCreate("msg", "ascending", ERA_BOUNDARY_MS - 1) // ffffffffffff…
    const widePre = Identifier.create("msg", "ascending", ERA_BOUNDARY_MS - 1)
    const widePost = Identifier.create("msg", "ascending", ERA_BOUNDARY_MS + 1)

    expect(legacyEarly < legacyLate).toBe(true)
    // The bug this migration kills: a legacy id minted after the boundary
    // would have sorted before everything. Wide ids must not.
    expect(legacyCreate("msg", "ascending", ERA_BOUNDARY_MS + 1) < legacyEarly).toBe(true) // the old failure mode
    expect(legacyLate < widePre).toBe(true)
    expect(widePre < widePost).toBe(true)
  })

  test("ascending ids stay monotonic for strictly increasing timestamps", () => {
    let previous = ""
    for (const ms of [Date.UTC(2026, 7, 1), ERA_BOUNDARY_MS - 1, ERA_BOUNDARY_MS, ERA_BOUNDARY_MS + 1, Date.UTC(2030, 0, 1), Date.UTC(2500, 0, 1)]) {
      const id = Identifier.create("msg", "ascending", ms)
      expect(previous < id).toBe(true)
      previous = id
    }
  })

  test("same-millisecond mints stay strictly ordered via the counter", () => {
    const ms = Date.UTC(2026, 7, 20)
    const first = Identifier.create("msg", "ascending", ms)
    const second = Identifier.create("msg", "ascending", ms)
    expect(first.slice(0, 19) < second.slice(0, 19)).toBe(true)
  })

  test("descending ids sort newest-first among wide ids", () => {
    const older = Identifier.create("ses", "descending", Date.UTC(2026, 7, 1))
    const newer = Identifier.create("ses", "descending", Date.UTC(2026, 8, 1))
    expect(newer < older).toBe(true)
  })

  test("timestamp() round-trips the mint time for wide ascending ids", () => {
    const ms = Date.UTC(2027, 3, 15, 6, 30, 0, 123)
    expect(Identifier.timestamp(Identifier.create("msg", "ascending", ms))).toBe(ms)
  })

  test("timestamp() still decodes legacy ids on their era-relative scale", () => {
    const ms = Date.UTC(2026, 6, 1)
    const legacy = legacyCreate("msg", "ascending", ms)
    expect(Identifier.timestamp(legacy)).toBe(ms % 2 ** 36)
    // Era-relative legacy decode is always below any wide decode, so relative
    // order across formats holds for consumers comparing timestamps.
    expect(Identifier.timestamp(legacy)).toBeLessThan(Identifier.timestamp(Identifier.create("msg", "ascending", ms)))
  })

  test("legacy bodies never collide with the sentinel", () => {
    // Legacy time prefixes are pure hex (0-9a-f); the sentinel deliberately
    // sits just above that range, so format detection is unambiguous.
    const legacy = legacyCreate("msg", "ascending", Date.now())
    expect(legacy.slice(4, 5)).toMatch(/^[0-9a-f]$/)
    expect("g" > "f").toBe(true)
  })
})

describe("schema package identifier (same wide encoding)", () => {
  test("bodies carry the sentinel and sort after legacy bodies", () => {
    const body = SchemaIdentifier.create(false, ERA_BOUNDARY_MS + 1)
    expect(body.startsWith("g")).toBe(true)
    expect(body.length).toBe(26)
    const legacyBody = legacyCreate("x", "ascending", ERA_BOUNDARY_MS - 1).slice(2)
    expect(legacyBody < body).toBe(true)
  })

  test("descending bodies sort newest-first", () => {
    const older = SchemaIdentifier.create(true, Date.UTC(2026, 7, 1))
    const newer = SchemaIdentifier.create(true, Date.UTC(2026, 8, 1))
    expect(newer < older).toBe(true)
  })
})
