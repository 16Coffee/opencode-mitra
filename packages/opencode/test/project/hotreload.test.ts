import { expect, test } from "bun:test"
import { classify, createMachine, type Hit } from "../../src/project/hotreload-core"

const root = "/tmp/openwork-hotreload"

// --- classify, ported from upstream PR #13409 ---

test("matches project config files", () => {
  expect(classify(root, `${root}/opencode.json`)).toBe("opencode.json")
  expect(classify(root, `${root}/opencode.jsonc`)).toBe("opencode.jsonc")
  expect(classify(root, `${root}/AGENTS.md`)).toBe("AGENTS.md")
})

test("matches opencode directories", () => {
  expect(classify(root, `${root}/.opencode/skills/new-skill/SKILL.md`)).toBe(".opencode/skills/new-skill/SKILL.md")
  expect(classify(root, `${root}/.opencode/commands/fix.md`)).toBe(".opencode/commands/fix.md")
  expect(classify(root, `${root}/.opencode/plugins/example.ts`)).toBe(".opencode/plugins/example.ts")
})

test("ignores metadata, temp files, and unrelated files", () => {
  expect(classify(root, `${root}/README.md`)).toBeUndefined()
  expect(classify(root, `${root}/.opencode/openwork/openwork.json`)).toBeUndefined()
  expect(classify(root, `${root}/.opencode/skills/new-skill/SKILL.md.swp`)).toBeUndefined()
  expect(classify(root, `${root}/.git/HEAD`)).toBeUndefined()
  expect(classify(root, `/tmp/other/opencode.json`)).toBeUndefined()
})

test("matches darwin /private path aliases", () => {
  if (process.platform !== "darwin") return
  const privateRoot = "/private/tmp/openwork-hotreload"
  expect(classify(privateRoot, "/tmp/openwork-hotreload/.opencode/commands/fix.md")).toBe(".opencode/commands/fix.md")
})

// --- session-aware reload state machine ---

const hit: Hit = { file: "agents/probe-agent.md", event: "change" }

async function waitFor(cond: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await Bun.sleep(10)
  }
}

test("returns queued=true and defers the reload while sessions are busy", async () => {
  let activeCount = 1
  let reloads = 0
  const machine = createMachine({
    cooldown: 0,
    active: () => activeCount,
    reload: async () => {
      reloads++
    },
  })

  const result = await machine.request(hit)
  expect(result.ok).toBe(true)
  expect(result.queued).toBe(true)
  expect(result.sessions).toBe(1)

  await Bun.sleep(30)
  expect(reloads).toBe(0)
  machine.clear()
})

test("drains the queued reload automatically once sessions go idle", async () => {
  let activeCount = 1
  let reloads = 0
  let applied: Hit | undefined
  const machine = createMachine({
    cooldown: 0,
    active: () => activeCount,
    reload: async () => {
      reloads++
    },
    onApplied: (h) => {
      applied = h
    },
  })

  const queued = await machine.request(hit)
  expect(queued.queued).toBe(true)
  expect(reloads).toBe(0)

  activeCount = 0
  machine.poke()
  await waitFor(() => reloads === 1)
  expect(applied).toEqual(hit)
  machine.clear()
})

test("collapses bursts and respects the cooldown between reloads", async () => {
  let reloads = 0
  const machine = createMachine({
    cooldown: 80,
    active: () => 0,
    reload: async () => {
      reloads++
    },
  })

  const first = await machine.request(hit)
  expect(first.queued).toBe(false)
  await waitFor(() => reloads === 1)
  // Let the in-flight reload chain settle (busy flag clears in a finally).
  await Bun.sleep(5)

  const second = await machine.request({ file: "agents/probe-agent.md", event: "add" })
  expect(second.queued).toBe(false)
  expect(second.wait).toBeGreaterThan(0)

  await waitFor(() => reloads === 2)
  machine.clear()
})
