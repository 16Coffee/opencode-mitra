import { Config } from "@/config/config"
import { HotReload } from "@/project/hotreload"
import { Provider } from "@/provider/provider"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const hotReload = yield* HotReload.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      // Refresh config + provider in place via hot reload instead of disposing
      // the instance. Dispose would cancel every running session in this
      // workspace — the "changing provider settings kills the running chat"
      // bug. reload() is not gated by the experimental flag and queues behind
      // busy sessions, so the change lands without ever killing a live turn.
      yield* hotReload.reload()
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
