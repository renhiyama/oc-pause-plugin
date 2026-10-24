# pause

Gracefully pause OpenCode work at the next model-request boundary, then resume
exactly where it stopped. Every live response and running tool is allowed to
finish, but each session's next model request is held before it is sent. Useful
when closing the lid, switching networks, or stepping away mid-turn without
burning tokens.

```
████   ███  █   █  ████ █████ ████
█   █ █   █ █   █ █     █     █   █
████  █████ █   █  ███  ████  █   █
█     █   █ █   █     █ █     █   █
█     █   █  ███  ████  █████ ████
```

## Requirements

OpenCode 2.1.x and Bun.

## Install

Clone the plugin into the global plugin directory and install its dependencies:

```sh
git clone https://github.com/renhiyama/oc-pause-plugin ~/.config/opencode/plugins/pause
cd ~/.config/opencode/plugins/pause
bun install
```

If `XDG_CONFIG_HOME` is set, use `$XDG_CONFIG_HOME/opencode/plugins` instead.

To keep the checkout somewhere else, symlink it into the plugin directory:

```sh
ln -s /path/to/oc-pause-plugin ~/.config/opencode/plugins/pause
```

Or add the absolute path to the global `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/oc-pause-plugin"]
}
```

OpenCode loads both entrypoints from the directory: the server plugin (state,
request gate, RPC) and the TUI plugin (`/pause`, overlay, footer badge). It
watches configuration and reloads plugins automatically; run `/reload` if the
command does not appear. For a single project, use `.opencode/plugins/pause` or
add the same path to the project's `opencode.json`.

The directory needs `server.ts`, `tui.tsx`, and `rpc.ts`. `server.ts` re-exports
`index.ts` because directory discovery probes `server` before `index`; keep both
files.

## Usage

- `/pause` pauses every session in the current location and opens the overlay

`/pause` is location-wide: it covers the main session, every subagent, and every
other running or streaming session in the project. There is no separate "pause
all" mode.

The overlay shows `PAUSING` while live output is still finishing, then `PAUSED`
once all streams are captured. The timer counts from when the pause was armed.

| Key                    | Action                                |
| ---------------------- | ------------------------------------- |
| `r` or `esc`           | Ask whether to resume                 |
| `y` or `enter`         | Confirm: resume and close the overlay |
| `n` (while confirming) | Keep paused and close the overlay     |

Resuming is deliberate: `r` and `esc` both open a `Resume work?` confirmation
inside the overlay. There is no `/resume` command — the overlay is the only way
to release a pause. Choosing `n` keeps the pause active and closes the overlay;
run `/pause` again to reopen it.

A `pausing N · /pause` or `paused · /pause` badge appears in the prompt footer,
so the state stays visible while the overlay is closed. Running `/pause` again
while paused just reopens the current state.

## Semantics

- **Streams finish.** Text, reasoning, tool-input, and compaction streams are
  tracked globally. A pause armed mid-stream waits for them instead of cutting
  the response. When each stream ends, that session parks at its next model
  request.
- **The next request never leaves.** The `context` and `compaction` hooks run
  before every model request in every session, including retries, and hold
  until resume. Requests are parked rather than sent and aborted, so no tokens
  are spent while paused.
- **Tools are not frozen.** A running shell command or MCP call is allowed to
  complete (the OS process cannot be suspended portably); the pause takes
  effect at the following model request. The overlay lists tools that are
  finishing.
- **Whole location.** One pause covers every session and subagent in the
  project. Arming it from any session has the same effect.
- **Interrupts keep the pause.** A user interrupt (`esc` in the chat) stops that
  execution but does not release the location-wide pause; the next request from
  that session is held again. Release everything from the pause overlay.
- **Restart-safe.** An armed pause is persisted through `ctx.storage` and
  restored when the server starts. A request that arrives after a restart is
  still gated.

## Design

The server plugin tracks activity from the event feed (streams, tools, busy
sessions, retries) from the moment it loads, so arming a pause mid-turn still
sees what is in flight. The TUI polls the `status` RPC while visible instead of
depending only on live events, which keeps the overlay correct across
reconnects. After a local pause or resume, a revision signal makes the badge
refetch immediately; the poll remains as a fallback for changes made by another
client.

The overlay uses OpenTUI's built-in `block` font for `PAUSED` and `PAUSING`
(falling back to `slick` and then `tiny` on narrow terminals) and reads the
active UI theme at render time: the dialog surface plus the theme's base, muted,
and faint text and warning/error feedback tokens. Theme changes apply without
reloading.

State is a single location-wide record:

```json
{ "version": 2, "since": 0 }
```

## Development

```sh
bun install
bun run typecheck
bun run test
```

`test.ts` runs the server plugin against a fake host and covers arming
mid-stream, parking subagents and unrelated sessions, tool and retry tracking,
interrupts, resume, shutdown, and persistence across setup.

## License

MIT
