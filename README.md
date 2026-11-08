# csm — AI Session Manager

Claude Code doesn't let you delete a single session from its picker.
**csm** is a small terminal UI that does: list, resume, rename, pin, and safely
delete coding-AI sessions — one project folder at a time. It works with
**Claude Code** and **Codex**: at startup it detects which AIs have sessions
in the current folder, shows a chooser when there are several, and opens the
only one directly when there is just one.

<!-- After recording a short demo clip, save it as demo.gif next to this
     file and uncomment the next line — a demo GIF is the single biggest
     driver of stars.
![demo](demo.gif)
-->

## Install

```bash
npm install -g csm-claude-sessions
```

Then run `csm` from any project folder. (Node ≥ 18 required.)

Local development instead:

```bash
git clone https://github.com/YuiSGese/csm.git
cd csm
chmod +x bin/csm.js
npm link
```

## Use

`csm` manages the sessions of the folder it runs in — each project has its own
list. (Claude Code stores sessions in `~/.claude/projects`, or in
`$CLAUDE_CONFIG_DIR/projects` when that variable is set; Codex stores them in
`~/.codex/sessions`, or `$CODEX_HOME/sessions`. csm reads the same locations.)
When several AIs have sessions in the folder, a chooser appears first; press
`b` inside a list to go back to it.

| Key | Action |
| --- | ------ |
| Enter | Resume the selected session |
| `r` | Rename |
| `p` | Pin / unpin — pinned sessions (★) always stay on top |
| `s` | Select / unselect a session (✓). Multi-select is only for deleting |
| `d` | Delete. With sessions selected, deletes all of them at once |
| `e` | Empty the trash (permanent, asks for confirmation) |
| `n` | New session (asks for a name, then runs `claude -n <name>`) |
| `/` | Search (Enter / Esc to finish) |
| `t` | Theme picker — Default, Neon Cyber, Dracula, Mono Pro, Amber CRT |
| `Esc` | Clear selection, or quit when nothing is selected |
| `b` | Back to the AI chooser (when several AIs were detected) |
| `q` | Quit |

- **Mouse** works too (terminals with mouse reporting): click a row to
  select it, double-click to open it, scroll with the wheel — in the session
  lists, the AI chooser, and the theme picker.
- **Themes**: press `t` to preview and pick one of five looks (the original
  plain look stays available as *Default*). The choice is saved in
  `~/.csm/state.json` and can also be set with `csm theme <name>`. Colors use
  the 256-color palette, so they work in macOS Terminal.app as well.
- **Rename** (Claude) appends a `{"type":"custom-title",...}` line to the
  session file — the same record Claude Code itself writes for `/rename`.
  For Codex it updates the thread's line in `~/.codex/session_index.jsonl`.
- **Pins** are stored in `~/.csm/state.json`; the AIs' files are not touched.
- **Delete never hard-deletes** (Claude): sessions move to
  `~/.csm/trash/<timestamp>/<project>/` (the `.jsonl` plus its side folder),
  so you can move a file back to `~/.claude/projects/<project>/` to restore it.
  `e` empties that trash folder permanently — it is csm's own trash, not the
  macOS Trash, and csm never empties it by itself.
  Codex sessions are deleted through the official `codex delete` command,
  which csm runs for you (it keeps Codex's own index consistent).

## CLI

The subcommands below manage Claude Code sessions (the interactive UI
covers both Claude Code and Codex).

```bash
csm list [--all] [--json]   # sessions of the current folder (--all: every project)
csm rename <id-or-prefix> <new name>
csm pin <id-or-prefix>
csm unpin <id-or-prefix>
csm delete <id-or-prefix>   # moves to ~/.csm/trash (recoverable)
csm trash                   # how many sessions and how much disk the trash uses
csm empty-trash             # permanently deletes the whole trash (asks first)
csm theme [name]            # show or set the UI theme (default|neon|dracula|mono|amber)
```

## Why

`claude --resume` shows old sessions but gives no way to delete one, and no
way to keep the important ones on top. csm fills exactly that gap: rename,
pin, delete (to trash), and multi-select delete — per project, with zero
dependencies.

## License

MIT — see [LICENSE](LICENSE).
