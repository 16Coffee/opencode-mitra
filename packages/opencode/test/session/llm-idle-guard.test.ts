import { describe, expect, test } from "bun:test"
import { guardEventIdle } from "../../src/session/llm-idle-guard"
import { ProviderError } from "../../src/provider/error"

type Ev = { type: string; n?: number }

function streamOf(script: Array<{ delayMs: number; event?: Ev; done?: boolean }>): AsyncIterable<Ev> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const step of script) {
        await new Promise((resolve) => setTimeout(resolve, step.delayMs))
        if (step.done) return
        yield step.event!
      }
    },
  }
}

async function collect(source: AsyncIterable<Ev>): Promise<Ev[]> {
  const out: Ev[] = []
  for await (const event of source) out.push(event)
  return out
}

describe("guardEventIdle", () => {
  test("passes a normal stream through untouched", async () => {
    const events = await collect(
      guardEventIdle(
        streamOf([
          { delayMs: 5, event: { type: "text-delta", n: 1 } },
          { delayMs: 5, event: { type: "text-delta", n: 2 } },
          { delayMs: 5, done: true },
        ]),
        { idleMs: 200 },
      ),
    )
    expect(events.map((e) => e.n)).toEqual([1, 2])
  })

  test("throws a retryable ResponseStreamError when the model stalls between events", async () => {
    const guarded = guardEventIdle(
      streamOf([
        { delayMs: 5, event: { type: "text-delta", n: 1 } },
        { delayMs: 10_000, event: { type: "text-delta", n: 2 } }, // stall (e.g. tool-param stream hang)
      ]),
      { idleMs: 120, label: "test/model" },
    )
    const error = await collect(guarded).then(
      () => null,
      (e) => e,
    )
    expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
    expect(String((error as Error).message)).toContain("stalled")
  })

  test("suspends the timer while a tool call is executing (silence between tool-call and tool-result is legitimate)", async () => {
    const events = await collect(
      guardEventIdle(
        streamOf([
          { delayMs: 5, event: { type: "tool-call", n: 1 } },
          { delayMs: 400, event: { type: "tool-result", n: 2 } }, // long tool run ≫ idleMs
          { delayMs: 5, event: { type: "text-delta", n: 3 } },
          { delayMs: 5, done: true },
        ]),
        { idleMs: 120 },
      ),
    )
    expect(events.map((e) => e.n)).toEqual([1, 2, 3])
  })

  test("resumes the timer after the tool result arrives", async () => {
    const guarded = guardEventIdle(
      streamOf([
        { delayMs: 5, event: { type: "tool-call", n: 1 } },
        { delayMs: 300, event: { type: "tool-result", n: 2 } },
        { delayMs: 10_000, event: { type: "text-delta", n: 3 } }, // stall after tool window closes
      ]),
      { idleMs: 120 },
    )
    const error = await collect(guarded).then(
      () => null,
      (e) => e,
    )
    expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
  })

  test("nested/parallel tool calls keep the timer suspended until all return", async () => {
    const events = await collect(
      guardEventIdle(
        streamOf([
          { delayMs: 5, event: { type: "tool-call", n: 1 } },
          { delayMs: 5, event: { type: "tool-call", n: 2 } },
          { delayMs: 300, event: { type: "tool-result", n: 3 } },
          { delayMs: 300, event: { type: "tool-error", n: 4 } }, // second call fails — still closes the window
          { delayMs: 5, done: true },
        ]),
        { idleMs: 120 },
      ),
    )
    expect(events.map((e) => e.n)).toEqual([1, 2, 3, 4])
  })

  test("waiting for the first event is also guarded (prefill hang)", async () => {
    const guarded = guardEventIdle(streamOf([{ delayMs: 10_000, event: { type: "text-delta", n: 1 } }]), {
      idleMs: 120,
    })
    const error = await collect(guarded).then(
      () => null,
      (e) => e,
    )
    expect(error).toBeInstanceOf(ProviderError.ResponseStreamError)
  })
})
