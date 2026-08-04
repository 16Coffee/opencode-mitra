// Wide time encoding (2026-08 migration) — keep in sync with
// packages/opencode/src/id/id.ts, which documents the full rationale.
//
// The original 6-byte packing truncated `ms * 0x1000 + counter` to 48 bits,
// so the time prefix was really `value mod 2^48` and wrapped on
// 2026-08-14T11:19:55Z — new ids would then sort before every existing id.
// Wide ids start with a `g` sentinel (sorts after every legacy hex digit in
// byte order and ICU collation alike) followed by the full 56-bit value as
// 14 hex chars (good until year 2527). Legacy ids stay valid and sort before
// wide ids, which matches their true mint order.
const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const WIDE_SENTINEL = "g"
const WIDE_HEX_CHARS = 14
const WIDE_MAX = (1n << 56n) - 1n
let lastTimestamp = 0
let counter = 0

export function ascending() {
  return create(false)
}

export function descending() {
  return create(true)
}

export function create(descending: boolean, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? WIDE_MAX - current : current
  const time = WIDE_SENTINEL + value.toString(16).padStart(WIDE_HEX_CHARS, "0")
  const bytes = crypto.getRandomValues(new Uint8Array(length - time.length))
  return time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
}
