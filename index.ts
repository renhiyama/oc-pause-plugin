import { Plugin } from "@opencode/plugin"
import { PauseRpc, type RetryInfo, type Snapshot, type Status, type StreamInfo, type ToolInfo } from "./rpc"

type Pause = {
  readonly since: number
  readonly parked: Map<string, () => void>
}

type Saved = {
  readonly version: 2
  readonly since?: number
}

const STORAGE_KEY = "pause.state"
const SAVE_VERSION = 2

type Activity = {
  readonly streams: Map<string, StreamInfo>
  readonly tools: Map<string, ToolInfo>
  readonly toolNames: Map<string, string>
  readonly busy: Set<string>
  readonly retries: Map<string, RetryInfo>
}

const streamKey = {
  text: (sessionID: string, messageID: string, ordinal: number) => `text:${sessionID}:${messageID}:${ordinal}`,
  reasoning: (sessionID: string, messageID: string, ordinal: number) =>
    `reasoning:${sessionID}:${messageID}:${ordinal}`,
  toolInput: (sessionID: string, toolID: string) => `tool-input:${sessionID}:${toolID}`,
  compaction: (sessionID: string) => `compaction:${sessionID}`,
}

const toolKey = (sessionID: string, toolID: string) => `${sessionID}:${toolID}`

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

function savedSince(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== SAVE_VERSION) return undefined
  return typeof record.since === "number" && Number.isFinite(record.since) ? record.since : undefined
}

export default Plugin.define({
  id: "pause",
  async setup(ctx) {
    const directory = ctx.location.directory
    let pause: Pause | undefined
    const activity: Activity = {
      streams: new Map(),
      tools: new Map(),
      toolNames: new Map(),
      busy: new Set(),
      retries: new Map(),
    }
    const registrations: Array<{ dispose: () => Promise<void> | void }> = []
    const controller = new AbortController()

    const persist = async () => {
      try {
        if (!pause) {
          await ctx.storage.remove(STORAGE_KEY)
          return
        }
        const saved: Saved = { version: SAVE_VERSION, since: pause.since }
        await ctx.storage.set(STORAGE_KEY, saved as unknown as Parameters<typeof ctx.storage.set>[1])
      } catch (error) {
        console.error("pause: failed to persist state", error)
      }
    }

    const release = async (target: Pause) => {
      if (pause !== target) return
      pause = undefined
      const parked = [...target.parked.values()]
      target.parked.clear()
      for (const resolve of parked) resolve()
      await persist()
    }

    const forgetParked = (sessionID: string) => {
      pause?.parked.delete(sessionID)
    }

    const clearActivity = (sessionID: string) => {
      activity.busy.delete(sessionID)
      activity.retries.delete(sessionID)
      for (const [key, stream] of activity.streams) if (stream.sessionID === sessionID) activity.streams.delete(key)
      for (const [key, tool] of activity.tools) {
        if (tool.sessionID !== sessionID) continue
        activity.tools.delete(key)
        activity.toolNames.delete(key)
      }
    }

    const gate = async (sessionID: string) => {
      const target = pause
      if (!target) return
      if (target.parked.has(sessionID)) return
      await new Promise<void>((resolve) => {
        // Release can land between the read above and this callback.
        if (pause !== target) {
          resolve()
          return
        }
        target.parked.set(sessionID, resolve)
      })
    }

    const snapshot = (target: Pause): Snapshot => {
      const liveStreams = [...activity.streams.values()]
      const retry = [...activity.retries.values()][0]
      return {
        active: true,
        since: target.since,
        phase: liveStreams.length > 0 ? "pausing" : "paused",
        streams: liveStreams,
        tools: [...activity.tools.values()],
        ...(retry ? { retry } : {}),
        parked: [...target.parked.keys()],
        busy: [...activity.busy].sort(),
      }
    }

    const apply = (event: {
      type: string
      location?: { directory?: string }
      data?: Record<string, unknown>
    }) => {
      if (event.location?.directory && event.location.directory !== directory) return
      const data = event.data
      if (!data) return
      switch (event.type) {
        case "session.deleted": {
          const sessionID = data.sessionID
          if (typeof sessionID !== "string") return
          clearActivity(sessionID)
          forgetParked(sessionID)
          return
        }
        case "session.execution.started": {
          const sessionID = data.sessionID
          if (typeof sessionID === "string") activity.busy.add(sessionID)
          return
        }
        case "session.execution.succeeded":
        case "session.execution.failed": {
          const sessionID = data.sessionID
          if (typeof sessionID === "string") clearActivity(sessionID)
          return
        }
        case "session.execution.interrupted": {
          const sessionID = data.sessionID
          if (typeof sessionID !== "string") return
          clearActivity(sessionID)
          // The held request, if any, is gone. Keep the pause armed: an
          // interrupt in one session must not release every other session.
          forgetParked(sessionID)
          return
        }
        case "session.text.started": {
          const sessionID = data.sessionID
          const messageID = data.assistantMessageID
          const ordinal = data.ordinal
          if (typeof sessionID !== "string" || typeof messageID !== "string" || typeof ordinal !== "number") return
          activity.streams.set(streamKey.text(sessionID, messageID, ordinal), {
            sessionID,
            kind: "text",
            label: "response",
          })
          return
        }
        case "session.text.ended": {
          const sessionID = data.sessionID
          const messageID = data.assistantMessageID
          const ordinal = data.ordinal
          if (typeof sessionID !== "string" || typeof messageID !== "string" || typeof ordinal !== "number") return
          activity.streams.delete(streamKey.text(sessionID, messageID, ordinal))
          return
        }
        case "session.reasoning.started": {
          const sessionID = data.sessionID
          const messageID = data.assistantMessageID
          const ordinal = data.ordinal
          if (typeof sessionID !== "string" || typeof messageID !== "string" || typeof ordinal !== "number") return
          activity.streams.set(streamKey.reasoning(sessionID, messageID, ordinal), {
            sessionID,
            kind: "reasoning",
            label: "thinking",
          })
          return
        }
        case "session.reasoning.ended": {
          const sessionID = data.sessionID
          const messageID = data.assistantMessageID
          const ordinal = data.ordinal
          if (typeof sessionID !== "string" || typeof messageID !== "string" || typeof ordinal !== "number") return
          activity.streams.delete(streamKey.reasoning(sessionID, messageID, ordinal))
          return
        }
        case "session.tool.input.started": {
          const sessionID = data.sessionID
          const toolID = data.id
          const name = data.name
          if (typeof sessionID !== "string" || typeof toolID !== "string") return
          const label = typeof name === "string" ? name : "tool"
          activity.toolNames.set(toolKey(sessionID, toolID), label)
          activity.streams.set(streamKey.toolInput(sessionID, toolID), {
            sessionID,
            kind: "tool-input",
            label,
          })
          return
        }
        case "session.tool.input.ended": {
          const sessionID = data.sessionID
          const toolID = data.id
          if (typeof sessionID !== "string" || typeof toolID !== "string") return
          activity.streams.delete(streamKey.toolInput(sessionID, toolID))
          return
        }
        case "session.tool.called": {
          const sessionID = data.sessionID
          const toolID = data.id
          // `executed` means the provider executed the call, not that a local
          // process ran, so local tools arrive with `executed: false`.
          if (typeof sessionID !== "string" || typeof toolID !== "string") return
          const key = toolKey(sessionID, toolID)
          activity.tools.set(key, {
            sessionID,
            name: activity.toolNames.get(key) ?? "tool",
          })
          return
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const sessionID = data.sessionID
          const toolID = data.id
          if (typeof sessionID !== "string" || typeof toolID !== "string") return
          const key = toolKey(sessionID, toolID)
          activity.tools.delete(key)
          activity.toolNames.delete(key)
          activity.streams.delete(streamKey.toolInput(sessionID, toolID))
          return
        }
        case "session.compaction.started": {
          const sessionID = data.sessionID
          if (typeof sessionID !== "string") return
          activity.streams.set(streamKey.compaction(sessionID), {
            sessionID,
            kind: "compaction",
            label: "compacting",
          })
          return
        }
        case "session.compaction.ended":
        case "session.compaction.failed": {
          const sessionID = data.sessionID
          if (typeof sessionID === "string") activity.streams.delete(streamKey.compaction(sessionID))
          return
        }
        case "session.step.started": {
          const sessionID = data.sessionID
          if (typeof sessionID === "string") activity.retries.delete(sessionID)
          return
        }
        case "session.retry.scheduled": {
          const sessionID = data.sessionID
          const attempt = data.attempt
          const at = data.at
          if (typeof sessionID !== "string" || typeof attempt !== "number" || typeof at !== "number") return
          const error = data.error
          const message =
            typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
              ? error.message
              : "request failed"
          activity.retries.set(sessionID, { sessionID, attempt, at, message })
          return
        }
        default:
          return
      }
    }

    const registration = await ctx.rpc.register(PauseRpc, {
      pause: async () => {
        if (pause) return snapshot(pause)
        const next: Pause = { since: Date.now(), parked: new Map() }
        pause = next
        await persist()
        return snapshot(next)
      },
      resume: async () => {
        if (pause) await release(pause)
        return { active: false }
      },
      status: async (): Promise<Status> => (pause ? snapshot(pause) : { active: false }),
      list: async () => ({ pauses: pause ? [snapshot(pause)] : [] }),
    })
    registrations.push(registration)

    // Compaction dispatches its own model request, so it needs the same gate.
    // Title and generate requests are intentionally not gated.
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        await gate(event.sessionID)
      }),
    )
    registrations.push(
      await ctx.session.hook("compaction", async (event) => {
        await gate(event.sessionID)
      }),
    )

    try {
      const stored = await ctx.storage.get(STORAGE_KEY)
      const since = savedSince(stored)
      if (since !== undefined) pause = { since, parked: new Map() }
      else if (stored !== undefined) await ctx.storage.remove(STORAGE_KEY)
    } catch (error) {
      console.error("pause: failed to restore state", error)
    }

    const task = (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (controller.signal.aborted) break
            apply(event as { type: string; location?: { directory?: string }; data?: Record<string, unknown> })
          }
        } catch (error) {
          if (controller.signal.aborted) break
          console.error("pause: event subscription failed", errorMessage(error))
        }
        if (controller.signal.aborted) break
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })()

    return async () => {
      controller.abort()
      await task.catch(() => undefined)
      for (const item of registrations.reverse()) await item.dispose()
      // Held requests must settle before the host tears the plugin down.
      if (pause) {
        const parked = [...pause.parked.values()]
        pause.parked.clear()
        for (const resolve of parked) resolve()
      }
    }
  },
})
