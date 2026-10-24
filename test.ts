import pause from "./index.ts"

type Hook = (input: Record<string, unknown>) => Promise<void> | void
type Handler = (input: unknown) => Promise<unknown>

const sessions = new Map<string, { id: string; parentID?: string }>([
  ["root", { id: "root" }],
  ["child", { id: "child", parentID: "root" }],
  ["other", { id: "other" }],
])

const hooks = new Map<string, Hook>()
const handlers = new Map<string, Handler>()
const storage = new Map<string, unknown>()

let queue: any[] = []
let notify: (() => void) | undefined

function emit(event: any) {
  queue.push(event)
  notify?.()
  notify = undefined
}

async function* events(signal: AbortSignal): AsyncIterable<any> {
  while (!signal.aborted) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        notify = resolve
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
      if (signal.aborted) return
      continue
    }
    yield queue.shift()
  }
}

const context = {
  location: { directory: "/tmp/pause-lab" },
  session: {
    get: async ({ sessionID }: { sessionID: string }) => {
      const info = sessions.get(sessionID)
      if (!info) throw new Error("not found")
      return info
    },
    hook: async (name: string, callback: Hook) => {
      hooks.set(name, callback)
      return { dispose: async () => hooks.delete(name) }
    },
  },
  rpc: {
    register: async (_definition: unknown, value: Record<string, Handler>) => {
      for (const [name, handler] of Object.entries(value)) handlers.set(name, handler)
      return {
        dispose: async () => {
          for (const name of Object.keys(value)) handlers.delete(name)
        },
      }
    },
  },
  storage: {
    get: async (key: string) => storage.get(key),
    set: async (key: string, value: unknown) => storage.set(key, value),
    remove: async (key: string) => storage.delete(key),
  },
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => events(options?.signal ?? new AbortController().signal),
  },
}

const cleanup = await (pause as any).setup(context)
await Bun.sleep(20)

const call = async (method: string, input: unknown = {}) => handlers.get(method)!(input)
const status = async (sessionID = "root") => (await call("status", { sessionID })) as any

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
  console.log("ok -", message)
}

assert(hooks.has("context") && hooks.has("compaction"), "context and compaction gates registered")

emit({
  type: "session.text.started",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "root", assistantMessageID: "m1", ordinal: 0 },
})
emit({
  type: "session.execution.started",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "root" },
})
emit({
  type: "session.execution.started",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "child" },
})
await Bun.sleep(30)

const armed = (await call("pause", {})) as any
assert(armed.active === true, "pause arms")
assert(armed.phase === "pausing", "phase is pausing while a stream is live")
assert(armed.streams.length === 1, "live stream is captured")
assert(armed.busy.length === 2, "all active sessions are busy")

let childReleased = false
const childGate = Promise.resolve(hooks.get("context")!({ sessionID: "child" })).then(() => {
  childReleased = true
})
await Bun.sleep(10)
let snapshot = await status()
assert(snapshot.phase === "pausing", "subagent park does not flip phase while stream is live")
assert(snapshot.parked.includes("child"), "subagent parks at the gate")
assert(!childReleased, "subagent request is held")

let otherReleased = false
const otherGate = Promise.resolve(hooks.get("context")!({ sessionID: "other" })).then(() => {
  otherReleased = true
})
await Bun.sleep(10)
snapshot = await status("other")
assert(snapshot.parked.includes("other"), "unrelated session parks at the gate")
assert(!otherReleased, "unrelated request is held")

emit({
  type: "session.text.ended",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "root", assistantMessageID: "m1", ordinal: 0, text: "hi" },
})
await Bun.sleep(30)
snapshot = await status()
assert(snapshot.phase === "paused", "phase becomes paused after the last stream ends")

let rootReleased = false
const rootGate = Promise.resolve(hooks.get("context")!({ sessionID: "root" })).then(() => {
  rootReleased = true
})
await Bun.sleep(10)
snapshot = await status()
assert(snapshot.parked.length === 3, "all requests wait at the gate")
assert(!rootReleased, "main request is held")

await call("resume", {})
await Promise.all([childGate, rootGate, otherGate])
await Bun.sleep(10)
assert(childReleased && rootReleased && otherReleased, "resume releases every parked request")
snapshot = await status()
assert(snapshot.active === false, "pause clears after resume")
assert(((await call("list")) as any).pauses.length === 0, "list is empty after resume")

const armed2 = (await call("pause", {})) as any
assert(armed2.active === true && armed2.phase === "paused", "idle pause starts paused")
emit({
  type: "session.tool.input.started",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "other", assistantMessageID: "m2", id: "t1", name: "bash" },
})
emit({
  type: "session.tool.input.ended",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "other", assistantMessageID: "m2", id: "t1", text: "{}" },
})
emit({
  type: "session.tool.called",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "other", assistantMessageID: "m2", id: "t1", input: {}, executed: false },
})
await Bun.sleep(20)
snapshot = await status("other")
assert(snapshot.tools.length === 1 && snapshot.tools[0].name === "bash", "running tool is captured")
emit({
  type: "session.tool.success",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "other", assistantMessageID: "m2", id: "t1", content: [], executed: false },
})
await Bun.sleep(20)
snapshot = await status("other")
assert(snapshot.tools.length === 0, "settled tool is removed")

emit({
  type: "session.retry.scheduled",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "other", assistantMessageID: "m2", attempt: 2, at: Date.now() + 4000, error: { message: "429" } },
})
await Bun.sleep(10)
snapshot = await status("other")
assert(snapshot.retry && snapshot.retry.attempt === 2, "scheduled retry is visible")
emit({
  type: "session.step.started",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "other", assistantMessageID: "m2" },
})
await Bun.sleep(10)
snapshot = await status("other")
assert(!snapshot.retry, "retry clears when the next step starts")

let interruptGateDone = false
const interruptGate = Promise.resolve(hooks.get("context")!({ sessionID: "other" })).then(() => {
  interruptGateDone = true
})
await Bun.sleep(10)
assert(!interruptGateDone, "request is held before interrupt")
emit({
  type: "session.execution.interrupted",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "other", reason: "user" },
})
await Bun.sleep(20)
assert(!interruptGateDone, "interrupted request is abandoned, not released")
assert((await status("other")).active === true, "user interrupt keeps the pause armed")
const afterInterrupt = await status("other")
assert(!afterInterrupt.parked.includes("other"), "interrupted request is no longer listed as parked")

let afterGateDone = false
const afterGate = Promise.resolve(hooks.get("context")!({ sessionID: "other" })).then(() => {
  afterGateDone = true
})
await Bun.sleep(10)
assert(!afterGateDone, "next request parks again after the interrupt")
await call("resume", {})
await afterGate
assert((await status()).active === false, "resume clears the pause after an interrupt")

await call("pause", {})
emit({
  type: "session.execution.interrupted",
  location: { directory: "/tmp/pause-lab" },
  data: { sessionID: "root", reason: "shutdown" },
})
await Bun.sleep(20)
assert((await status()).active === true, "shutdown keeps the pause armed")
await call("resume", { sessionID: "root" })

await call("pause", {})
await cleanup()
const hooks2 = new Map<string, Hook>()
const handlers2 = new Map<string, Handler>()
let queue2: any[] = []
const context2 = {
  ...context,
  session: {
    ...context.session,
    hook: async (name: string, callback: Hook) => {
      hooks2.set(name, callback)
      return { dispose: async () => hooks2.delete(name) }
    },
  },
  rpc: {
    register: async (_definition: unknown, value: Record<string, Handler>) => {
      for (const [name, handler] of Object.entries(value)) handlers2.set(name, handler)
      return { dispose: async () => undefined }
    },
  },
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => {
      const signal = options?.signal ?? new AbortController().signal
      return (async function* () {
        while (!signal.aborted) {
          if (!queue2.length) {
            await Bun.sleep(5)
            continue
          }
          yield queue2.shift()
        }
      })()
    },
  },
}
const cleanup2 = await (pause as any).setup(context2)
await Bun.sleep(20)
const restored = (await handlers2.get("status")!({ sessionID: "root" })) as any
assert(restored.active === true, "pause restores from storage")
assert(restored.since > 0, "restored since is kept")
assert((await handlers2.get("status")!({}) as any).active === true, "status works without a session")
await cleanup2()

console.log("\nall checks passed")
