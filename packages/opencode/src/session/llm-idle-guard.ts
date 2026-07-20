import { ProviderError } from "@/provider/error"

/**
 * Event-level idle watchdog for the AI SDK fullStream (mitra patch, 2026-07-20).
 *
 * Why byte-level timeouts are not enough: an upstream provider under load can
 * hang a stream while the gateway (or the provider itself) keeps feeding
 * keep-alive bytes or trickles meaningless chunks — byte-level read timeouts
 * (`chunkTimeout`/wrapSSE) and the gateway's own chunk-interval watchdog both
 * reset on every byte, so the session hangs until some outer, much coarser
 * timeout aborts the whole subagent (2026-07-20: a clip tool-call parameter
 * stream produced ZERO deltas for 6m04s before a ~7min abort killed the
 * session; the parent agent then reported the never-submitted work as done).
 *
 * This guard times the gap between *stream events* instead. Tool execution
 * happens inside the AI SDK multi-step loop (tools carry execute), so the
 * stream is legitimately silent between `tool-call` and `tool-result`/
 * `tool-error` — the timer is suspended while any call is in flight and only
 * runs while we are waiting on the model to produce something. On timeout the
 * generator throws ProviderError.ResponseStreamError, which MessageV2.fromError
 * already maps to a retryable APIError, so the session's bounded retry kicks in
 * (fast self-heal + deployment shuffle) instead of a silent multi-minute hang.
 */
export const LLM_EVENT_IDLE_TIMEOUT_MS = 120_000

type EventLike = { type?: string }

export function guardEventIdle<T extends EventLike>(
  source: AsyncIterable<T>,
  opts: { idleMs?: number; label?: string } = {},
): AsyncIterable<T> {
  const idleMs = opts.idleMs ?? LLM_EVENT_IDLE_TIMEOUT_MS
  if (!(idleMs > 0)) return source
  return {
    [Symbol.asyncIterator]() {
      const it = source[Symbol.asyncIterator]()
      // The losing branch of a race keeps running; cache the in-flight pull so
      // a timed-out wait never spawns a second concurrent next().
      let inFlight: Promise<IteratorResult<T>> | null = null
      const pull = () => {
        inFlight ??= Promise.resolve(it.next()).finally(() => {
          inFlight = null
        })
        return inFlight
      }
      let pendingToolCalls = 0
      return {
        async next() {
          const result =
            pendingToolCalls > 0
              ? await pull() // tool executing: stream silence is legitimate, no timer
              : await new Promise<IteratorResult<T>>((resolve, reject) => {
                  const timer = setTimeout(() => {
                    const err = new ProviderError.ResponseStreamError(
                      `LLM event stream stalled: no events for ${Math.round(idleMs / 1000)}s${opts.label ? ` (${opts.label})` : ""}`,
                    )
                    // Stop the underlying request; the stream scope's abort
                    // controller also fires when the failed stream unwinds.
                    void it.return?.(undefined as never).catch(() => {})
                    reject(err)
                  }, idleMs)
                  pull().then(
                    (value) => {
                      clearTimeout(timer)
                      resolve(value)
                    },
                    (error) => {
                      clearTimeout(timer)
                      reject(error)
                    },
                  )
                })
          if (result.done) return result
          const type = result.value?.type
          if (type === "tool-call") pendingToolCalls++
          else if (type === "tool-result" || type === "tool-error") pendingToolCalls = Math.max(0, pendingToolCalls - 1)
          return result
        },
        return(value?: unknown) {
          return Promise.resolve(it.return ? it.return(value as never) : { done: true as const, value: undefined as never })
        },
        throw(error?: unknown) {
          if (it.throw) return Promise.resolve(it.throw(error))
          return Promise.reject(error)
        },
      }
    },
  }
}
