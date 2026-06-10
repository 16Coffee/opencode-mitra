import { Context, Effect, Layer, Schema } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { ToolRegistry } from "@/tool/registry"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { classify, createMachine, type Hit, type ReloadEvent, type RequestResult } from "./hotreload-core"

export { classify, createMachine } from "./hotreload-core"
export type { Hit, ReloadEvent, RequestResult } from "./hotreload-core"

const log = Log.create({ service: "project.hotreload" })

const EventProperties = Schema.Struct({
  file: Schema.String,
  event: Schema.Literals(["add", "change", "unlink"]),
})

export const Event = {
  Changed: BusEvent.define("opencode.hotreload.changed", EventProperties),
  Applied: BusEvent.define("opencode.hotreload.applied", EventProperties),
}

export interface Interface {
  readonly request: (input?: {
    file?: string
    event?: ReloadEvent
  }) => Effect.Effect<RequestResult & { enabled: boolean }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/HotReload") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const mcp = yield* MCP.Service
    const registry = yield* ToolRegistry.Service
    const skill = yield* Skill.Service
    const agent = yield* Agent.Service
    const command = yield* Command.Service

    const cooldown = Flag.OPENCODE_EXPERIMENTAL_HOT_RELOAD_COOLDOWN_MS ?? 1500

    // Same chain and order as PR #13409: Config first so the derived modules
    // rebuild from freshly merged config + agent/command markdown.
    const reload = Effect.gen(function* () {
      yield* config.reset()
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
        // Machine callbacks fire from timers/bus dispatch, outside any request
        // fiber — the bridge re-attaches this directory's instance context.
        const bridge = yield* EffectBridge.make()

        const machine = createMachine({
          cooldown,
          active: () => bridge.promise(active),
          reload: async () => {
            log.info("hot reload triggered", { directory: ctx.directory })
            await bridge.promise(reload)
          },
          onApplied: (hit) =>
            bridge.promise(bus.publish(Event.Applied, hit)).catch((error: unknown) =>
              log.error("hot reload applied event failed", { error, directory: ctx.directory }),
            ),
          onError: (error, hit) =>
            log.error("hot reload failed", { error, directory: ctx.directory, file: hit.file, event: hit.event }),
        })

        const unsub = yield* bus.subscribeCallback(SessionStatus.Event.Status, () => machine.poke())

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsub()
            machine.clear()
          }),
        )

        log.info("hot reload enabled", { directory: ctx.directory, cooldown, mode: "manual" })
        return { machine }
      }),
    )

    const request: Interface["request"] = Effect.fn("HotReload.request")(function* (input) {
      if (!Flag.OPENCODE_EXPERIMENTAL_HOT_RELOAD) {
        return { ok: false, enabled: false, queued: false, sessions: 0 }
      }
      const { machine } = yield* InstanceState.get(state)
      const hit: Hit = { file: input?.file?.trim() || "api", event: input?.event ?? "change" }
      yield* bus.publish(Event.Changed, hit)
      const result = yield* Effect.promise(() => machine.request(hit))
      return { ...result, enabled: true }
    })

    return Service.of({ request })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Command.defaultLayer),
  ),
)

export * as HotReload from "./hotreload"
