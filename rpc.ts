import { Rpc } from "@opencode/plugin/rpc"

export type StreamKind = "text" | "reasoning" | "tool-input" | "compaction"

export type StreamInfo = {
  sessionID: string
  kind: StreamKind
  label?: string
}

export type ToolInfo = {
  sessionID: string
  name: string
}

export type RetryInfo = {
  sessionID: string
  attempt: number
  at: number
  message: string
}

export type Snapshot = {
  active: true
  since: number
  phase: "pausing" | "paused"
  streams: StreamInfo[]
  tools: ToolInfo[]
  retry?: RetryInfo
  parked: string[]
  busy: string[]
}

export type Status = Snapshot | { active: false }

const object = { type: "object", additionalProperties: true } as const

const sessionInput = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  additionalProperties: false,
} as const

export const PauseRpc = Rpc.define({
  id: "pause",
  methods: {
    pause: { input: sessionInput, output: object },
    resume: { input: sessionInput, output: object },
    status: { input: sessionInput, output: object },
    list: {
      input: { type: "object", additionalProperties: false },
      output: object,
    },
  },
  events: {},
})
