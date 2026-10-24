import { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { PauseRpc, type Snapshot, type Status } from "./rpc"

function elapsed(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, "0")
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") return error.message
    if ("type" in error && typeof error.type === "string") {
      return error.type === "rpc.unavailable" ? "The pause plugin is not loaded on the server" : error.type
    }
  }
  return "Pause server unavailable"
}

function locationFor(context: Plugin.Context, sessionID: string | undefined) {
  return (
    (sessionID ? context.data.session.get(sessionID)?.location : undefined) ??
    context.location ??
    context.data.location.default()
  )
}

// Bumped after this client arms or releases a pause, so every badge refetches
// right away. The interval below still catches changes made by other clients.
const [pauseRevision, setPauseRevision] = createSignal(0)
const pauseChanged = () => setPauseRevision((value) => value + 1)

function usePause(
  context: Plugin.Context,
  sessionID: () => string | undefined,
  interval: number,
  options: { initial?: Snapshot; sync?: () => unknown } = {},
) {
  const [status, setStatus] = createSignal<Status>(options.initial ?? { active: false })
  const [loaded, setLoaded] = createSignal(options.initial !== undefined)
  const [error, setError] = createSignal<string>()

  createEffect(() => {
    const id = sessionID()
    options.sync?.()
    let disposed = false
    setLoaded(options.initial !== undefined)
    const tick = async () => {
      try {
        const result = await context.client
          .rpc(PauseRpc)
          .status(id ? { sessionID: id } : {}, { location: locationFor(context, id) })
        if (disposed) return
        setError(undefined)
        setStatus(result as Status)
        setLoaded(true)
      } catch (cause) {
        if (disposed) return
        setError(messageOf(cause))
      }
    }
    void tick()
    const timer = setInterval(tick, interval)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })

  return { status, loaded, error }
}

export default Plugin.define({
  id: "pause.tui",
  setup(context) {
    const open = (sessionID: string | undefined, initial: Snapshot) => {
      context.ui.dialog.show(() => <PauseDialog context={context} sessionID={sessionID} initial={initial} />)
      context.ui.dialog.set({ size: "large", centered: true })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "pause.work",
          title: "Pause work",
          description: "Finish live output, then hold every model request",
          group: "Session",
          palette: true,
          slash: { name: "pause" },
          async run() {
            const route = context.ui.router.current()
            const sessionID = route.type === "session" ? route.sessionID : undefined
            try {
              const result = (await context.client
                .rpc(PauseRpc)
                .pause(sessionID ? { sessionID } : {}, { location: locationFor(context, sessionID) })) as Snapshot
              pauseChanged()
              open(sessionID, result)
            } catch (cause) {
              context.ui.toast.show({ title: "Pause", message: messageOf(cause), variant: "error" })
            }
          },
        },
      ],
    }))

    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <PauseBadge context={context} sessionID={input.sessionID} />,
    })
  },
})

function PauseBadge(props: { context: Plugin.Context; sessionID?: string }) {
  const { status } = usePause(props.context, () => props.sessionID, 2000, { sync: pauseRevision })
  const snapshot = createMemo(() => (status().active ? (status() as Snapshot) : undefined))
  return (
    <Show when={snapshot()}>
      {(value) => (
        <box flexShrink={0}>
          <text fg={props.context.theme.text.feedback.warning.base}>{badgeLabel(value())}</text>
        </box>
      )}
    </Show>
  )
}

function badgeLabel(snapshot: Snapshot) {
  const state =
    snapshot.phase === "pausing"
      ? `pausing ${snapshot.streams.length}`
      : snapshot.parked.length > 0
        ? `paused ${snapshot.parked.length}`
        : "paused"
  return `${state} · /pause`
}

function PauseDialog(props: { context: Plugin.Context; sessionID?: string; initial: Snapshot }) {
  const { status, loaded, error } = usePause(props.context, () => props.sessionID, 800, {
    initial: props.initial,
    sync: pauseRevision,
  })
  const [now, setNow] = createSignal(Date.now())
  const [confirming, setConfirming] = createSignal(false)
  const [resuming, setResuming] = createSignal(false)
  const dimensions = useTerminalDimensions()
  const theme = createMemo(() => props.context.theme.surface("dialog"))
  let closed = false

  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const close = () => {
    if (closed) return
    closed = true
    props.context.ui.dialog.clear()
  }

  createEffect(() => {
    if (loaded() && !status().active) close()
  })

  const resume = async () => {
    if (resuming()) return
    setResuming(true)
    try {
      await props.context.client
        .rpc(PauseRpc)
        .resume(
          props.sessionID ? { sessionID: props.sessionID } : {},
          { location: locationFor(props.context, props.sessionID) },
        )
      pauseChanged()
      props.context.ui.toast.show({ title: "Resume", message: "Work resumed", variant: "success" })
      close()
    } catch (cause) {
      setResuming(false)
      props.context.ui.toast.show({ title: "Resume", message: messageOf(cause), variant: "error" })
    }
  }

  const askResume = () => {
    if (!resuming()) setConfirming(true)
  }

  const keepPaused = () => {
    setConfirming(false)
    props.context.ui.toast.show({
      title: "Pause",
      message: "Still paused · requests stay held",
      variant: "info",
    })
    close()
  }

  const askOrKeep = () => {
    if (confirming()) keepPaused()
    else askResume()
  }

  const resumeIfConfirmed = () => {
    if (!confirming() || resuming()) return false
    void resume()
  }

  const keepIfConfirmed = () => {
    if (!confirming() || resuming()) return false
    keepPaused()
  }

  const askIfPaused = () => {
    if (confirming() || resuming()) return false
    askResume()
  }

  // Outranks the dialog provider's own escape binding, which would close the
  // overlay and leave the pause running.
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 100,
    commands: [
      { title: "Ask to resume", bind: "escape", run: askOrKeep },
      { title: "Ask to resume", bind: "ctrl+c", run: askOrKeep },
      { title: "Ask to resume", bind: "r", run: askIfPaused },
      { title: "Resume work", bind: "y", run: resumeIfConfirmed },
      { title: "Resume work", bind: "return", run: resumeIfConfirmed },
      { title: "Keep paused", bind: "n", run: keepIfConfirmed },
    ],
  }))

  const snapshot = createMemo(() => (status().active ? (status() as Snapshot) : props.initial))
  const pausing = createMemo(() => snapshot().phase === "pausing")
  const title = createMemo(() => (pausing() ? "PAUSING" : "PAUSED"))
  const font = createMemo<"block" | "slick" | "tiny">(() => {
    const width = dimensions().width
    return width >= 70 ? "block" : width >= 50 ? "slick" : "tiny"
  })

  const headline = createMemo(() => {
    const value = snapshot()
    if (value.phase === "pausing") {
      return `waiting for ${plural(value.streams.length, "stream")} to finish`
    }
    if (value.parked.length > 0) return `${plural(value.parked.length, "request")} waiting at the gate`
    return "every model request will wait"
  })

  const details = createMemo(() => {
    const value = snapshot()
    const lines: string[] = []
    if (value.tools.length > 0) {
      const names = [...new Set(value.tools.map((tool) => tool.name))].slice(0, 3).join(", ")
      lines.push(`finishing ${plural(value.tools.length, "tool call")} · ${names}`)
    }
    if (value.retry) {
      const seconds = Math.max(0, Math.ceil((value.retry.at - now()) / 1000))
      lines.push(
        seconds > 0
          ? `retrying in ${seconds}s · attempt ${value.retry.attempt}`
          : `waiting to retry · attempt ${value.retry.attempt}`,
      )
    }
    if (value.busy.length > 0) lines.push(plural(value.busy.length, "session") + " active")
    return lines
  })

  const confirmBody = createMemo(() => {
    const value = snapshot()
    if (value.phase === "pausing") return "live output is still finishing · release the pause now?"
    if (value.parked.length > 0) {
      return `release ${plural(value.parked.length, "held request")} and let every session continue?`
    }
    return "every model request is held · let every session continue?"
  })

  return (
    <box flexDirection="column" paddingLeft={3} paddingRight={3} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
          pause <span style={{ fg: theme().text.muted }}>· all sessions</span>
        </text>
        <text fg={theme().text.muted}>{elapsed(now() - snapshot().since)}</text>
      </box>
      <box marginTop={1}>
        <ascii_font
          text={title()}
          font={font()}
          color={[theme().text.base, theme().text.muted]}
          selectable={false}
        />
      </box>
      <box marginTop={1} flexDirection="column">
        <Show
          when={confirming()}
          fallback={
            <>
              <text fg={theme().text.base}>{headline()}</text>
              <Show when={details().length > 0}>
                <Show when={error()} fallback={<text fg={theme().text.muted}>{details().join(" · ")}</text>}>
                  <text fg={theme().text.feedback.error.base}>{error()}</text>
                </Show>
              </Show>
              <Show when={details().length === 0 && error()}>
                <text fg={theme().text.feedback.error.base}>{error()}</text>
              </Show>
              <Show when={pausing()}>
                <text fg={theme().text.faint}>
                  live streams finish, then every session is held at its next request
                </text>
              </Show>
            </>
          }
        >
          <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
            Resume work?
          </text>
          <text fg={theme().text.muted}>{confirmBody()}</text>
          <Show when={resuming()}>
            <text fg={theme().text.faint}>resuming…</text>
          </Show>
        </Show>
      </box>
      <box marginTop={1} flexDirection="row" gap={2}>
        <Show
          when={confirming()}
          fallback={
            <>
              <text fg={theme().text.muted}>
                <span style={{ fg: theme().text.base }}>r</span> or{" "}
                <span style={{ fg: theme().text.base }}>esc</span> resume
              </text>
            </>
          }
        >
          <text fg={theme().text.muted}>
            <span style={{ fg: theme().text.base }}>y</span> resume
          </text>
          <text fg={theme().text.faint}>·</text>
          <text fg={theme().text.muted}>
            <span style={{ fg: theme().text.base }}>n</span> keep paused
          </text>
        </Show>
      </box>
    </box>
  )
}
