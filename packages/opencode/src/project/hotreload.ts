import { Context, Effect, Layer, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { ToolRegistry } from "@/tool/registry"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { classify, createMachine, type Hit, type ReloadEvent, type RequestResult } from "./hotreload-core"

export { classify, createMachine } from "./hotreload-core"
export type { Hit, ReloadEvent, RequestResult } from "./hotreload-core"

export interface Interface {
  readonly request: (input?: {
    file?: string
    event?: ReloadEvent
  }) => Effect.Effect<RequestResult & { enabled: boolean }>
  // In-place reload NOT gated by OPENCODE_EXPERIMENTAL_HOT_RELOAD. For config
  // changes that must always take effect (provider add/remove, disabled_providers).
  readonly reload: () => Effect.Effect<RequestResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/HotReload") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const status = yield* SessionStatus.Service
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const mcp = yield* MCP.Service
    const registry = yield* ToolRegistry.Service
    const skill = yield* Skill.Service
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const provider = yield* Provider.Service

    const cooldown = Flag.OPENCODE_EXPERIMENTAL_HOT_RELOAD_COOLDOWN_MS ?? 1500

    // Same chain and order as PR #13409: Config first so the derived modules
    // rebuild from freshly merged config + agent/command markdown.
    const applyReload = Effect.gen(function* () {
      yield* config.reset()
      // Provider derives from config (provider list, disabled_providers,
      // enabled_providers). Refresh it in place right after config so a config
      // change takes effect without disposing the instance (which would cancel
      // every running session — the whole reason this reload path exists).
      yield* provider.reset()
      yield* plugin.reset()
      yield* mcp.reset()
      yield* registry.reset()
      yield* skill.reset()
      yield* agent.reset()
      yield* command.reset()
    })

    const active = Effect.gen(function* () {
      const map = yield* status.list()
      let count = 0
      for (const info of map.values()) {
        if (info.type === "busy" || info.type === "retry") count++
      }
      return count
    })

    const state = yield* InstanceState.make(
      Effect.fn("HotReload.state")(function* (ctx) {
        // Machine callbacks fire from timers/event dispatch, outside any request
        // fiber — the bridge re-attaches this directory's instance context and
        // routes logs back into the effect runtime.
        const bridge = yield* EffectBridge.make()

        const machine = createMachine({
          cooldown,
          active: () => bridge.promise(active),
          reload: async () => {
            await bridge.promise(Effect.logInfo(`hot reload triggered (${ctx.directory})`))
            await bridge.promise(applyReload)
          },
          // Mitra port note: upstream replaced the in-process Bus with EventV2.
          // The informational `opencode.hotreload.{changed,applied}` events from
          // PR #13409 have no consumers in the tree, so they are surfaced via the
          // effect logger rather than registering a new durable EventV2 definition.
          onApplied: (hit) => bridge.fork(Effect.logInfo(`hot reload applied: ${hit.file} ${hit.event}`)),
          onError: (error, hit) =>
            bridge.fork(Effect.logError(`hot reload failed: ${hit.file} ${hit.event}: ${String(error)}`)),
        })

        // Drain the queue when sessions return to idle: subscribe to
        // SessionStatus events and poke the machine. Forked into this
        // InstanceState entry's scope so the subscription is interrupted when
        // the entry is disposed.
        yield* Effect.forkScoped(
          Stream.runForEach(events.subscribe(SessionStatus.Event.Status), () => Effect.sync(() => machine.poke())),
        )

        yield* Effect.addFinalizer(() => Effect.sync(() => machine.clear()))

        yield* Effect.logInfo(`hot reload enabled (${ctx.directory}, cooldown=${cooldown}ms)`)
        return { machine }
      }),
    )

    const request: Interface["request"] = Effect.fn("HotReload.request")(function* (input) {
      if (!Flag.OPENCODE_EXPERIMENTAL_HOT_RELOAD) {
        return { ok: false, enabled: false, queued: false, sessions: 0 }
      }
      const { machine } = yield* InstanceState.get(state)
      const hit: Hit = { file: input?.file?.trim() || "api", event: input?.event ?? "change" }
      yield* Effect.logInfo(`hot reload requested: ${hit.file} ${hit.event}`)
      const result = yield* Effect.promise(() => machine.request(hit))
      return { ...result, enabled: true }
    })

    // Unconditional in-place reload — deliberately does NOT check
    // OPENCODE_EXPERIMENTAL_HOT_RELOAD. A config change (provider add/remove,
    // disabled_providers, …) is a "must take effect" action, not an
    // experimental toggle, so it always drains through the per-directory reload
    // machine: still queues behind busy sessions and never disposes the
    // instance, but is never silently no-op'd by the experimental flag.
    const reload: Interface["reload"] = Effect.fn("HotReload.reload")(function* () {
      const { machine } = yield* InstanceState.get(state)
      yield* Effect.logInfo("config reload requested (in-place)")
      return yield* Effect.promise(() => machine.request({ file: "config", event: "change" }))
    })

    return Service.of({ request, reload })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    EventV2Bridge.node,
    SessionStatus.node,
    Config.node,
    Plugin.node,
    Provider.node,
    MCP.node,
    ToolRegistry.node,
    Skill.node,
    Agent.node,
    Command.node,
  ],
})

export * as HotReload from "./hotreload"
