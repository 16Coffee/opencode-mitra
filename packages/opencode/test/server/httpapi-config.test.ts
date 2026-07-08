import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Exit, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string, timeout?: number) {
  return waitGlobalBusEvent({
    timeout,
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "serves config update through the default server app without disposing the instance",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      // 🔴 mitra patch（fix(instance): config 变更走 hotreload 原地重载）把这里的
      // 语义反过来了：上游 PATCH /config 之后 dispose 实例，而 dispose 会连带取消
      // 这个工作区里每一个正在跑的会话——「改个 provider 设置就把对话打断」。
      // 补丁改成原地 hotReload.reload()，所以这条用例锁的是**不该发生 dispose**。
      const disposed = yield* waitDisposed(tmp.path, 2_000).pipe(
        Effect.exit,
        Effect.forkScoped({ startImmediately: true }),
      )

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      // 等窗口跑满：没等到 disposed 事件 → 超时失败，正是要的结果。
      expect(Exit.isFailure(yield* Fiber.join(disposed))).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      // 原地重载真的生效：同一个没被 dispose 的实例读出来就是新配置。
    }),
  )

  it.live(
    "picks up a project config change in place, without disposing the instance",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false, username: "before-reload" } })
      const headers = { "x-opencode-directory": tmp.path }
      const read = () =>
        Effect.promise(() => Promise.resolve(app().request("/config", { headers }))).pipe(
          Effect.flatMap((response) => Effect.promise(() => response.json() as Promise<{ username?: string }>)),
        )

      // 先把实例建起来并读一次，确认基线。
      expect(yield* read()).toMatchObject({ username: "before-reload" })

      const disposed = yield* waitDisposed(tmp.path, 6_000).pipe(
        Effect.exit,
        Effect.forkScoped({ startImmediately: true }),
      )

      // 项目目录真正被读的是 opencode.json（config.json 只在全局目录是候选）。
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", formatter: false, lsp: false, username: "after-reload" }),
        ),
      )

      // PATCH 走的就是补丁那条路：configSvc.update + hotReload.reload()。
      const patched = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ formatter: false, lsp: false }),
          }),
        ),
      )
      expect(patched.status).toBe(200)

      // 原地重载有 cooldown，轮询到生效为止。
      let seen: { username?: string } = {}
      for (let attempt = 0; attempt < 40; attempt++) {
        seen = yield* read()
        if (seen.username === "after-reload") break
        yield* Effect.sleep("250 millis")
      }
      expect(seen).toMatchObject({ username: "after-reload" })
      expect(Exit.isFailure(yield* Fiber.join(disposed))).toBe(true)
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})
