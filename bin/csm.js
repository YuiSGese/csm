#!/usr/bin/env node
/*
 * csm — AI Session Manager
 * Source: https://github.com/YuiSGese/csm
 * (c) 2026 Yui Le — MIT License
 *
 * Manages the coding-AI sessions of ONE project folder at a time (the folder
 * csm is started in): list, resume, rename, delete, pin to top.
 *
 * Providers: Claude Code (~/.claude/projects, or $CLAUDE_CONFIG_DIR) and
 * Codex (~/.codex/sessions, or $CODEX_HOME). At startup csm detects which
 * providers have sessions in the current folder: with only one it opens it
 * directly, with several it shows a chooser first.
 *
 * Claude rename appends a {"type":"custom-title",...} line (same record
 * Claude Code itself writes); Claude delete never erases — files move to
 * ~/.csm/trash/<timestamp>/. Codex rename updates ~/.codex/session_index.jsonl;
 * Codex delete delegates to the official `codex delete` command.
 * Pins live in ~/.csm/state.json (the AIs' files are not touched for pins).
 *
 * No dependencies. Node >= 18.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

// Claude Code keeps its data in ~/.claude by default, or in the folder named
// by the CLAUDE_CONFIG_DIR environment variable when the user sets one.
const CLAUDE_DIR =
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const CODEX_INDEX = path.join(CODEX_DIR, 'session_index.jsonl');
const TRASH_DIR = path.join(os.homedir(), '.csm', 'trash');
const STATE_FILE = path.join(os.homedir(), '.csm', 'state.json');
const ACTIVE_MS = 60 * 1000; // a file written <60s ago may belong to a running session

// ---------------------------------------------------------------------------
// Session discovery / parsing
// ---------------------------------------------------------------------------

function cleanText(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Stream-parse one .jsonl transcript. Only lines that can carry the fields
 *  we need are JSON.parsed, so multi-hundred-MB files stay cheap. */
async function parseSessionFile(projectDir, filePath) {
  const stat = fs.statSync(filePath);
  const sessionId = path.basename(filePath, '.jsonl');
  const s = {
    sessionId,
    projectDir,
    filePath,
    size: stat.size,
    mtime: stat.mtimeMs,
    cwd: null,
    gitBranch: null,
    customTitle: null,
    aiTitle: null,
    firstPrompt: null,
    firstTs: null,
    lastTs: null,
  };
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const isUser = line.includes('"type":"user"') || line.includes('"type": "user"');
    const isTitle = line.includes('"ai-title"') || line.includes('"custom-title"');
    const needMeta = s.cwd === null && line.includes('"cwd"');
    if (!isUser && !isTitle && !needMeta) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.timestamp) {
      if (!s.firstTs) s.firstTs = e.timestamp;
      s.lastTs = e.timestamp;
    }
    if (needMeta && e.cwd) {
      s.cwd = e.cwd;
      if (e.gitBranch) s.gitBranch = e.gitBranch;
    }
    if (e.type === 'ai-title' && e.aiTitle) s.aiTitle = e.aiTitle;
    if (e.type === 'custom-title' && e.customTitle) s.customTitle = e.customTitle;
    if (isUser && !s.firstPrompt && !e.isMeta && e.message) {
      const c = e.message.content;
      if (typeof c === 'string' && c.trim() && !c.trimStart().startsWith('<')) {
        s.firstPrompt = cleanText(c, 90);
      }
    }
  }
  s.name = s.customTitle || s.aiTitle || s.firstPrompt || sessionId.slice(0, 8);
  return s;
}

async function loadSessions() {
  const out = [];
  if (!fs.existsSync(PROJECTS_DIR)) return out;
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, proj);
    let entries;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        out.push(await parseSessionFile(proj, path.join(dir, name)));
      } catch {
        /* skip unreadable / mid-write files */
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ---------------------------------------------------------------------------
// Codex sessions (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl)
// First line of each rollout is {"type":"session_meta","payload":{id, cwd,
// git:{branch}}}; display names come from ~/.codex/session_index.jsonl.
// ---------------------------------------------------------------------------

function readCodexIndex() {
  const names = new Map();
  try {
    for (const line of fs.readFileSync(CODEX_INDEX, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.id && o.thread_name) names.set(o.id, o.thread_name); // latest wins
      } catch { /* skip bad lines */ }
    }
  } catch { /* no index yet */ }
  return names;
}

async function parseCodexFile(filePath, stat, names) {
  let meta = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    try {
      const o = JSON.parse(line);
      if (o && o.type === 'session_meta') meta = o.payload || null;
    } catch { /* not JSON — fall through to filename id */ }
    break; // session_meta is always the first line
  }
  const m = path
    .basename(filePath)
    .match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  const id = (meta && (meta.id || meta.session_id)) || (m && m[1]);
  if (!id) return null;
  return {
    provider: 'codex',
    sessionId: id,
    name: names.get(id) || id.slice(0, 8),
    cwd: meta ? meta.cwd || null : null,
    gitBranch: meta && meta.git ? meta.git.branch || null : null,
    size: stat.size,
    mtime: stat.mtimeMs,
    filePath,
    projectDir: null,
  };
}

async function loadCodexSessions() {
  const out = [];
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return out;
  const names = readCodexIndex();
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(CODEX_SESSIONS_DIR);
  for (const f of files) {
    try {
      const s = await parseCodexFile(f, fs.statSync(f), names);
      if (s) out.push(s);
    } catch { /* skip unreadable files */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Codex keeps thread names in session_index.jsonl — update (or add) the
 *  line for this session, in the same {id, thread_name, updated_at} shape. */
function doCodexRename(s, name) {
  let lines = [];
  try {
    lines = fs.readFileSync(CODEX_INDEX, 'utf8').split('\n').filter((l) => l.trim());
  } catch { /* index will be created */ }
  const now = new Date().toISOString();
  let found = false;
  lines = lines.map((l) => {
    try {
      const o = JSON.parse(l);
      if (o.id === s.sessionId) {
        found = true;
        return JSON.stringify({ id: o.id, thread_name: name, updated_at: now });
      }
    } catch { /* keep line as-is */ }
    return l;
  });
  if (!found) {
    lines.push(JSON.stringify({ id: s.sessionId, thread_name: name, updated_at: now }));
  }
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  fs.writeFileSync(CODEX_INDEX, lines.join('\n') + '\n');
  s.name = name;
}

// ---------------------------------------------------------------------------
// Pins (stored in ~/.csm/state.json, outside the AIs' own files)
// ---------------------------------------------------------------------------

function readState() {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function writeStateField(patch) {
  const d = readState();
  Object.assign(d, patch);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(d, null, 2) + '\n');
}

function readPins() {
  const d = readState();
  return new Set(Array.isArray(d.pins) ? d.pins : []);
}

function writePins(pins) {
  writeStateField({ pins: [...pins] });
}

/** Mark pinned sessions and sort them first (newest first inside each group). */
function applyPins(sessions) {
  const pins = readPins();
  for (const s of sessions) s.pinned = pins.has(s.sessionId);
  sessions.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.mtime - a.mtime;
  });
  return sessions;
}

function togglePin(s) {
  const pins = readPins();
  if (pins.has(s.sessionId)) {
    pins.delete(s.sessionId);
    s.pinned = false;
  } else {
    pins.add(s.sessionId);
    s.pinned = true;
  }
  writePins(pins);
  return s.pinned;
}

// ---------------------------------------------------------------------------
// Themes (256-color ANSI so they also work in macOS Terminal.app).
// `default` is the original plain look — no color codes at all.
// The chosen theme is persisted in ~/.csm/state.json next to the pins.
// ---------------------------------------------------------------------------

const THEMES = {
  default: null,
  neon:    { label: 'Neon Cyber', title: 51,  dim: 66,  text: 159, accent: 201, star: 220, check: 48,  selBg: 17,  warn: 203 },
  dracula: { label: 'Dracula',    title: 212, dim: 103, text: 255, accent: 141, star: 228, check: 84,  selBg: 60,  warn: 203 },
  mono:    { label: 'Mono Pro',   title: 231, dim: 243, text: 255, accent: 75,  star: 231, check: 255, selBg: 236, warn: 203 },
  amber:   { label: 'Amber CRT',  title: 220, dim: 94,  text: 214, accent: 208, star: 226, check: 220, selBg: 58,  warn: 203 },
};
const THEME_ORDER = ['default', 'neon', 'dracula', 'mono', 'amber'];

function themeLabel(id) {
  return id === 'default' ? 'Default (original)' : THEMES[id].label;
}

function readTheme() {
  const t = readState().theme;
  return THEME_ORDER.includes(t) ? t : 'default';
}

function writeTheme(t) {
  writeStateField({ theme: t });
}

/** Style helpers for a theme; for `default` every helper is the identity. */
function paint(th) {
  if (!th) {
    const id = (s) => s;
    return { on: false, title: id, dim: id, text: id, accent: id, star: id, check: id, warn: id, key: id, cursorRow: null };
  }
  const fg = (code, s) => '\x1b[38;5;' + code + 'm' + s + '\x1b[39m';
  const bold = (code, s) => '\x1b[1;38;5;' + code + 'm' + s + '\x1b[0m';
  return {
    on: true,
    title: (s) => bold(th.title, s),
    dim: (s) => fg(th.dim, s),
    text: (s) => fg(th.text, s),
    accent: (s) => fg(th.accent, s),
    star: (s) => fg(th.star, s),
    check: (s) => fg(th.check, s),
    warn: (s) => bold(th.warn, s),
    key: (s) => bold(th.title, s),
    cursorRow: (line) => '\x1b[48;5;' + th.selBg + 'm' + line + '\x1b[0m',
  };
}


// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtSize(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'KB';
  return n + 'B';
}

function fmtAge(ms) {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
}

function projectLabel(s) {
  if (s.cwd) return path.basename(s.cwd) || s.cwd;
  if (!s.projectDir) return '-';
  return s.projectDir.replace(/^-/, '').split('-').slice(-1)[0] || s.projectDir;
}

/** Terminal display width: CJK/fullwidth chars take 2 cells, combining
 *  marks (Vietnamese tone marks in decomposed form) take 0. */
function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp === 0) continue;
    if (
      (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
      (cp >= 0x1ab0 && cp <= 0x1aff) ||
      (cp >= 0x20d0 && cp <= 0x20ff) ||
      cp === 0x200b // zero-width space
    ) {
      continue;
    }
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals, kana, kanji, hangul syllables…
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) || // emoji blocks
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** Truncate to display width w (adding … when cut), then pad with spaces
 *  so the result occupies exactly w terminal cells. */
function pad(s, w) {
  s = String(s);
  if (strWidth(s) > w) {
    let out = '';
    let used = 0;
    for (const ch of s) {
      const cw = strWidth(ch);
      if (used + cw > w - 1) break;
      out += ch;
      used += cw;
    }
    s = out + '…';
  }
  return s + ' '.repeat(Math.max(0, w - strWidth(s)));
}

// ---------------------------------------------------------------------------
// Actions shared by CLI + TUI
// ---------------------------------------------------------------------------

function doRename(s, name) {
  const rec = { type: 'custom-title', customTitle: name, sessionId: s.sessionId };
  fs.appendFileSync(s.filePath, JSON.stringify(rec) + '\n');
  s.customTitle = name;
  s.name = name;
}

function doTrash(s, sharedStamp) {
  const pins = readPins();
  if (pins.delete(s.sessionId)) writePins(pins);
  const stamp = sharedStamp || new Date().toISOString().replace(/[:.]/g, '-');
  const destDir = path.join(TRASH_DIR, stamp, s.projectDir);
  fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(s.filePath, path.join(destDir, path.basename(s.filePath)));
  // Claude keeps per-session side data in a sibling folder named by session id
  const sideDir = path.join(path.dirname(s.filePath), s.sessionId);
  if (fs.existsSync(sideDir) && fs.statSync(sideDir).isDirectory()) {
    fs.renameSync(sideDir, path.join(destDir, s.sessionId));
  }
  return path.join(TRASH_DIR, stamp);
}

function isActive(s) {
  return Date.now() - s.mtime < ACTIVE_MS;
}

/** Count trashed sessions (.jsonl files) and their total size on disk. */
function scanTrash() {
  let count = 0;
  let bytes = 0;
  if (!fs.existsSync(TRASH_DIR)) return { count, bytes };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try { bytes += fs.statSync(p).size; } catch { /* ignore */ }
        if (e.name.endsWith('.jsonl')) count += 1;
      }
    }
  };
  walk(TRASH_DIR);
  return { count, bytes };
}

/** Permanently delete everything in the trash folder. Irreversible. */
function emptyTrash() {
  fs.rmSync(TRASH_DIR, { recursive: true, force: true });
}

function findSession(sessions, idOrPrefix) {
  const q = String(idOrPrefix || '');
  const byId = sessions.filter(
    (s) => s.sessionId === q || s.sessionId.startsWith(q)
  );
  if (byId.length) return byId;
  return sessions.filter((s) => s.name === q);
}

// ---------------------------------------------------------------------------
// Non-interactive subcommands
// ---------------------------------------------------------------------------

/** csm manages one project at a time: only sessions whose cwd is the folder
 *  csm runs in. `--all` (CLI only) lists everything. */
function scopeSessions(sessions, all) {
  if (all) return sessions;
  return sessions.filter((s) => s.cwd === process.cwd());
}

function displayName(s) {
  return (s.pinned ? '★ ' : '') + s.name;
}

function printList(sessions, asJson, all) {
  const scoped = scopeSessions(sessions, all);
  if (asJson) {
    const rows = scoped.map((s) => ({
      id: s.sessionId,
      name: s.name,
      pinned: !!s.pinned,
      cwd: s.cwd,
      branch: s.gitBranch,
      sizeBytes: s.size,
      modified: new Date(s.mtime).toISOString(),
    }));
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!scoped.length) {
    console.log('No sessions for this folder: ' + process.cwd());
    return;
  }
  for (const s of scoped) {
    console.log(
      pad(s.sessionId.slice(0, 8), 9) +
        pad(displayName(s), 45) +
        pad(projectLabel(s), 22) +
        pad(fmtAge(s.mtime), 9) +
        fmtSize(s.size)
    );
  }
  console.log(scoped.length + ' sessions');
}

async function cli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'theme') {
    const name = rest[0];
    if (!name) {
      console.log('Theme: ' + readTheme());
      for (const id of THEME_ORDER) console.log('  ' + id + ' — ' + themeLabel(id));
      return 0;
    }
    if (!THEME_ORDER.includes(name)) {
      console.error('Unknown theme: ' + name + ' (choose: ' + THEME_ORDER.join(', ') + ')');
      return 1;
    }
    writeTheme(name);
    console.log('Theme set: ' + name + ' (' + themeLabel(name) + ')');
    return 0;
  }
  const sessions = applyPins(await loadSessions());

  if (cmd === 'list') {
    printList(sessions, rest.includes('--json'), rest.includes('--all'));
    return 0;
  }
  if (cmd === 'rename') {
    const [id, ...nameParts] = rest;
    const name = nameParts.join(' ').trim();
    if (!id || !name) {
      console.error('Usage: csm rename <id-or-prefix> <new name>');
      return 1;
    }
    const m = findSession(sessions, id);
    if (m.length !== 1) {
      console.error('Expected exactly 1 match, got ' + m.length);
      return 1;
    }
    doRename(m[0], name);
    console.log('Renamed: ' + m[0].sessionId + ' -> ' + name);
    return 0;
  }
  if (cmd === 'pin' || cmd === 'unpin') {
    const m = findSession(sessions, rest[0]);
    if (m.length !== 1) {
      console.error('Expected exactly 1 match, got ' + m.length);
      return 1;
    }
    const pins = readPins();
    if (cmd === 'pin') pins.add(m[0].sessionId);
    else pins.delete(m[0].sessionId);
    writePins(pins);
    console.log((cmd === 'pin' ? 'Pinned: ' : 'Unpinned: ') + m[0].sessionId);
    return 0;
  }
  if (cmd === 'trash') {
    const t = scanTrash();
    console.log(
      t.count
        ? 'Trash: ' + t.count + ' sessions, ' + fmtSize(t.bytes) + ' (' + TRASH_DIR + ')'
        : 'Trash is empty (' + TRASH_DIR + ')'
    );
    return 0;
  }
  if (cmd === 'empty-trash') {
    const t = scanTrash();
    if (!t.count) {
      console.log('Trash is already empty');
      return 0;
    }
    const rl = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise((resolve) =>
      rl.question(
        'Permanently delete ' + t.count + ' trashed sessions (' +
          fmtSize(t.bytes) + ')? This cannot be undone [y/N] ',
        resolve
      )
    );
    rl.close();
    if (String(answer).trim().toLowerCase() === 'y') {
      emptyTrash();
      console.log('Trash emptied');
    } else {
      console.log('Cancelled');
    }
    return 0;
  }
  if (cmd === 'delete') {
    const m = findSession(sessions, rest[0]);
    if (m.length !== 1) {
      console.error('Expected exactly 1 match, got ' + m.length);
      return 1;
    }
    const dest = doTrash(m[0]);
    console.log('Moved to trash folder: ' + dest + ' (session ' + m[0].sessionId + ')');
    return 0;
  }
  console.error('Unknown command: ' + cmd);
  console.error('Usage: csm | csm list [--all] [--json] | csm rename <id> <name> | csm pin <id> | csm unpin <id> | csm delete <id> | csm trash | csm empty-trash | csm theme [name]');
  return 1;
}

// ---------------------------------------------------------------------------
// Interactive TUI
// ---------------------------------------------------------------------------

function runCli(bin, args, cwd) {
  const where = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const r = spawnSync(bin, args, { stdio: 'inherit', cwd: where });
  if (r.error) {
    console.error(bin + ' not found — is it installed?');
    return 1;
  }
  return r.status == null ? 0 : r.status;
}

function runClaude(args, cwd) {
  return runCli('claude', args, cwd);
}

async function tui(provider, opts) {
  const out = process.stdout;
  const hereCwd = process.cwd();
  const sessions = applyPins(provider.sessions.slice());
  let themeId = readTheme();
  let lastClick = { y: 0, t: 0 };
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const st = {
    sessions,
    filter: '',
    sel: 0,
    mode: 'list', // list | search | input | confirm
    inputPurpose: null, // rename | new
    inputBuf: '',
    confirmTarget: null,
    confirmList: null, // sessions pending multi-delete confirmation
    confirmEmptyTrash: null, // {count, bytes} pending permanent empty-trash
    selected: new Set(), // sessionIds marked with `s` — used ONLY for delete
    themeSel: 0, // cursor in the theme picker
    status: '',
  };

  const filtered = () => {
    let rows = st.sessions.filter((s) => s.cwd === hereCwd);
    if (!st.filter) return rows;
    const q = st.filter.toLowerCase();
    return rows.filter(
      (s) =>
        s.name.toLowerCase().includes(q) || s.sessionId.startsWith(q)
    );
  };
  const current = () => filtered()[st.sel] || null;

  function render() {
    const P = paint(THEMES[themeId]);
    if (st.mode === 'theme') return renderTheme(P);
    const rows = filtered();
    const h = out.rows || 24;
    const w = out.columns || 100;
    // The frame must fit the screen exactly: a taller frame scrolls the
    // terminal and old header lines pile up in the scrollback. Lines used:
    // title, project, separator, rows, blank, footer line(s), status line.
    const footerLines = st.mode === 'list' && st.selected.size ? 2 : 1;
    const statusLines = st.status ? 1 : 0;
    const pageSize = Math.max(3, h - 4 - footerLines - statusLines);
    let start = 0;
    if (st.sel >= pageSize) start = st.sel - pageSize + 1;
    let buf = '\x1b[H\x1b[2J';
    buf += P.title('csm — ' + provider.label + ' sessions (' + rows.length + ')') + '\n';
    buf += st.filter
      ? P.accent('Search: ' + st.filter) + '\n'
      : P.dim('Project: ' + hereCwd) + '\n';
    buf += P.dim((themeId === 'default' ? '-' : '─').repeat(Math.min(w, 110))) + '\n';
    const page = rows.slice(start, start + pageSize);
    st._start = start; // for mouse hit-testing
    st._pageLen = page.length;
    page.forEach((s, i) => {
      const isCur = start + i === st.sel;
      const mark = isCur ? '>' : ' ';
      const check = st.selected.has(s.sessionId) ? '✓' : ' ';
      let nameCell = pad(displayName(s), 45);
      if (s.pinned && P.on) nameCell = nameCell.replace('★', P.star('★'));
      const line =
        (P.on && isCur ? P.accent(mark) : mark) +
        ' ' +
        (P.on && check === '✓' ? P.check(check) : check) +
        ' ' +
        P.text(nameCell) +
        P.dim(pad(projectLabel(s), 22)) +
        P.dim(pad(fmtAge(s.mtime), 9)) +
        P.text(fmtSize(s.size));
      buf += (isCur ? (P.cursorRow ? P.cursorRow(line) : '\x1b[7m' + line + '\x1b[0m') : line) + '\n';
    });
    if (!rows.length) {
      buf += P.dim(st.filter ? '  (no sessions match)' : '  (no sessions for this folder)') + '\n';
    }
    buf += '\n';
    if (st.mode === 'search') {
      buf += P.dim('Searching… Enter/Esc to finish, Backspace deletes a character') + '\n';
    } else if (st.mode === 'input') {
      const label = st.inputPurpose === 'rename' ? 'New name: ' : 'Name for new session: ';
      buf += P.accent(label) + P.text(st.inputBuf) + '\n';
    } else if (st.mode === 'confirm') {
      let msg;
      if (st.confirmEmptyTrash) {
        const t = st.confirmEmptyTrash;
        msg =
          'PERMANENTLY delete ' + t.count + ' trashed sessions (' +
          fmtSize(t.bytes) + ')? This cannot be undone! [y/N]';
      } else if (st.confirmList) {
        const list = st.confirmList;
        const total = list.reduce((a, x) => a + x.size, 0);
        const activeCount = list.filter(isActive).length;
        msg = provider.id === 'codex'
          ? 'Delete ' + list.length + ' selected sessions (' + fmtSize(total) +
            ') with `codex delete`? [y/N]' +
            (activeCount
              ? '  WARNING: ' + activeCount + ' written <60s ago — may be running!'
              : '')
          : 'Move ' + list.length + ' selected sessions (' + fmtSize(total) +
            ') to trash folder? [y/N]' +
            (activeCount
              ? '  WARNING: ' + activeCount + ' written <60s ago — may be running!'
              : '');
      } else {
        const s = st.confirmTarget;
        msg = provider.id === 'codex'
          ? 'Delete "' + cleanText(s.name, 40) + '" (' + fmtSize(s.size) +
            ') with `codex delete`? [y/N]' +
            (isActive(s) ? '  WARNING: written <60s ago — may be running!' : '')
          : 'Move "' + cleanText(s.name, 40) + '" (' + fmtSize(s.size) +
            ') to trash folder? [y/N]' +
            (isActive(s) ? '  WARNING: written <60s ago — may be running!' : '');
      }
      buf += (P.on ? P.warn(msg) : msg) + '\n';
    } else {
      if (!P.on) {
        buf += 'Enter resume · r rename · p pin/unpin · s select · d delete · e empty trash · n new · / search · t theme · q quit' + (opts.canGoBack ? ' · b back' : '') + '\n';
      } else {
        const keys = [['Enter', 'resume'], ['r', 'rename'], ['p', 'pin/unpin'], ['s', 'select'], ['d', 'delete'], ['e', 'empty trash'], ['n', 'new'], ['/', 'search'], ['t', 'theme'], ['q', 'quit']];
        if (opts.canGoBack) keys.push(['b', 'back']);
        buf += keys.map(([k, l]) => P.key(k) + ' ' + P.dim(l)).join(P.dim(' · ')) + '\n';
      }
      if (st.selected.size) {
        buf += P.accent(st.selected.size + ' selected — d deletes ALL selected · Esc clears selection') + '\n';
      }
    }
    if (st.status) buf += (P.on ? P.accent(st.status) : st.status) + '\n';
    out.write(buf);
  }

  function renderTheme(P) {
    let buf = '\x1b[H\x1b[2J';
    buf += P.title('csm — Choose theme') + '\n';
    buf += P.dim('Applies instantly and is saved for next time') + '\n';
    buf += P.dim((themeId === 'default' ? '-' : '─').repeat(40)) + '\n';
    THEME_ORDER.forEach((id, i) => {
      const cp = paint(THEMES[id]);
      const isSel = i === st.themeSel;
      const label = themeLabel(id) + (id === themeId ? '  (current)' : '');
      if (isSel) {
        const plain = '> ' + pad(label, 40);
        buf += (cp.cursorRow ? cp.cursorRow(plain) : '\x1b[7m' + plain + '\x1b[0m') + '\n';
      } else {
        buf += '  ' + cp.title(label) + '\n';
      }
    });
    buf += '\n';
    buf += P.dim('Up/Down choose · Enter apply · Esc cancel · click a theme, double-click applies') + '\n';
    out.write(buf);
  }

  function detach() {
    process.stdin.off('data', onKey);
    out.off('resize', render);
  }

  /** Finish the TUI: hand a result back to interactiveMain, which owns the
   *  alternate screen / raw mode and runs any follow-up CLI. */
  function leave(code, cliArgs, cwd) {
    detach();
    finish({
      action: cliArgs ? 'run' : 'exit',
      code,
      bin: provider.id === 'codex' ? 'codex' : 'claude',
      args: cliArgs,
      cwd,
    });
  }

  function goBack() {
    detach();
    finish({ action: 'back' });
  }

  /** Temporarily hand the terminal to a child CLI (e.g. `codex delete`,
   *  which may ask its own confirmation), then take it back. */
  function runInteractive(bin, args, cwd) {
    process.stdin.setRawMode(false);
    out.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l');
    const where = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
    const r = spawnSync(bin, args, { stdio: 'inherit', cwd: where });
    out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    if (r.error) return -1;
    return r.status == null ? 1 : r.status;
  }

  async function codexDeleteFlow(targets) {
    let ok = 0;
    for (const t of targets) {
      if (runInteractive('codex', ['delete', t.sessionId], t.cwd) === 0) ok += 1;
    }
    st.sessions = applyPins(await loadCodexSessions());
    for (const t of targets) st.selected.delete(t.sessionId);
    st.sel = Math.max(0, Math.min(st.sel, filtered().length - 1));
    st.status = 'codex delete: ' + ok + '/' + targets.length + ' removed';
    render();
  }

  function applyTheme() {
    themeId = THEME_ORDER[st.themeSel];
    writeTheme(themeId);
    st.mode = 'list';
    st.status = 'Theme: ' + themeLabel(themeId);
    render();
  }

  /** SGR mouse (1006): click selects a row, double-click opens it,
   *  the wheel scrolls. Rows start at terminal line 4 in both the list
   *  (render records _start/_pageLen) and the theme picker. */
  function onMouse(b, x, y, press) {
    if (b === 64 || b === 65) {
      const d = b === 64 ? -1 : 1;
      if (st.mode === 'theme') {
        st.themeSel = Math.max(0, Math.min(THEME_ORDER.length - 1, st.themeSel + d));
        render();
      } else if (st.mode === 'list') {
        const n = filtered().length;
        st.sel = Math.max(0, Math.min(n - 1, st.sel + d * 3));
        render();
      }
      return;
    }
    if (!press || b !== 0) return;
    const now = Date.now();
    if (st.mode === 'theme') {
      const idx = y - 4;
      if (idx < 0 || idx >= THEME_ORDER.length) return;
      const dbl = lastClick.y === y && now - lastClick.t < 650 && st.themeSel === idx;
      lastClick = { y, t: now };
      st.themeSel = idx;
      if (dbl) return applyTheme();
      return render();
    }
    if (st.mode !== 'list') return;
    const idx = y - 4;
    if (idx < 0 || idx >= (st._pageLen || 0)) return;
    const target = (st._start || 0) + idx;
    const dbl = lastClick.y === y && now - lastClick.t < 650 && st.sel === target;
    lastClick = { y, t: now };
    st.sel = target;
    if (dbl) return handleKey('\r');
    render();
  }

  let pendingMouse = '';
  function onKey(data) {
    let s = pendingMouse + data.toString('utf8');
    pendingMouse = '';
    const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      const before = s.slice(last, m.index);
      if (before) handleKey(before);
      onMouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === 'M');
      last = m.index + m[0].length;
    }
    const rest = s.slice(last);
    if (rest) {
      // a mouse sequence split across two chunks: hold the partial prefix
      if (/^\x1b\[<[0-9;]*$/.test(rest) && rest.length < 24) { pendingMouse = rest; return; }
      handleKey(rest);
    }
  }

  function handleKey(data) {
    const key = data.toString('utf8');
    const rows = filtered();

    if (key === '\x03') return leave(0); // Ctrl+C

    if (st.mode === 'input') {
      if (key === '\x1b') { st.mode = 'list'; st.inputBuf = ''; return render(); }
      if (key === '\r' || key === '\n') {
        const val = st.inputBuf.trim();
        const purpose = st.inputPurpose;
        st.inputBuf = '';
        st.mode = 'list';
        if (!val) return render();
        if (purpose === 'rename') {
          const s = current();
          if (s) {
            if (provider.id === 'codex') doCodexRename(s, val);
            else doRename(s, val);
            st.status = 'Renamed to: ' + val;
          }
          return render();
        }
        return leave(0, ['-n', val], process.cwd());
      }
      if (key === '\x7f' || key === '\b') {
        st.inputBuf = st.inputBuf.slice(0, -1);
        return render();
      }
      if (!key.includes('\x1b') && [...key].every((c) => c >= ' ')) {
        st.inputBuf += key;
        return render();
      }
      return render();
    }

    if (st.mode === 'confirm') {
      const s = st.confirmTarget;
      const list = st.confirmList;
      const et = st.confirmEmptyTrash;
      st.mode = 'list';
      st.confirmTarget = null;
      st.confirmList = null;
      st.confirmEmptyTrash = null;
      if (key === 'y' || key === 'Y') {
        if (et) {
          emptyTrash();
          st.status =
            'Trash emptied: ' + et.count + ' sessions, ' + fmtSize(et.bytes) + ' freed';
          return render();
        }
        if (provider.id === 'codex' && (list || s)) {
          const targets = list && list.length ? list : [s];
          st.status = 'Running codex delete…';
          render();
          codexDeleteFlow(targets);
          return;
        }
        if (list && list.length) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          let dest = '';
          for (const t of list) dest = doTrash(t, stamp);
          const gone = new Set(list);
          st.sessions = st.sessions.filter((x) => !gone.has(x));
          for (const t of list) st.selected.delete(t.sessionId);
          st.sel = Math.max(0, Math.min(st.sel, filtered().length - 1));
          st.status = 'Moved ' + list.length + ' sessions to trash folder: ' + dest;
        } else if (s) {
          doTrash(s);
          st.sessions = st.sessions.filter((x) => x !== s);
          st.selected.delete(s.sessionId);
          if (st.sel > 0) st.sel -= 1;
          st.status = 'Moved to trash folder: ' + s.sessionId;
        }
      } else {
        st.status = 'Delete cancelled';
      }
      return render();
    }

    if (st.mode === 'theme') {
      if (key === '\x1b' || key === 'q') { st.mode = 'list'; }
      else if (key === '\x1b[A' || key === 'k') st.themeSel = Math.max(0, st.themeSel - 1);
      else if (key === '\x1b[B' || key === 'j') st.themeSel = Math.min(THEME_ORDER.length - 1, st.themeSel + 1);
      else if (key === '\r' || key === '\n') { applyTheme(); return; }
      else if (key >= '1' && key <= String(THEME_ORDER.length)) st.themeSel = Number(key) - 1;
      return render();
    }

    if (st.mode === 'search') {
      if (key === '\x1b' || key === '\r' || key === '\n') { st.mode = 'list'; return render(); }
      if (key === '\x7f' || key === '\b') { st.filter = st.filter.slice(0, -1); st.sel = 0; return render(); }
      if (key === '\x1b[A') { st.sel = Math.max(0, st.sel - 1); return render(); }
      if (key === '\x1b[B') { st.sel = Math.min(rows.length - 1, st.sel + 1); return render(); }
      if (!key.includes('\x1b') && [...key].every((c) => c >= ' ')) {
        st.filter += key;
        st.sel = 0;
        return render();
      }
      return render();
    }

    // list mode
    if (key === '\x1b[A' || key === 'k') st.sel = Math.max(0, st.sel - 1);
    else if (key === '\x1b[B' || key === 'j') st.sel = Math.min(rows.length - 1, st.sel + 1);
    else if (key === 'q') return leave(0);
    else if (key === '\x1b') {
      if (st.selected.size) { st.selected.clear(); st.status = 'Selection cleared'; }
      else return leave(0);
    }
    else if (key === '/') { st.mode = 'search'; }
    else if (key === '\r' || key === '\n') {
      const s = current();
      if (s) {
        return provider.id === 'codex'
          ? leave(0, ['resume', s.sessionId], s.cwd)
          : leave(0, ['--resume', s.sessionId], s.cwd);
      }
    } else if (key === 'r') {
      if (current()) { st.mode = 'input'; st.inputPurpose = 'rename'; st.inputBuf = ''; }
    } else if (key === 'p') {
      const s = current();
      if (s) {
        const nowPinned = togglePin(s);
        applyPins(st.sessions);
        const rowsNow = filtered();
        const idx = rowsNow.indexOf(s);
        if (idx >= 0) st.sel = idx;
        st.status = (nowPinned ? '★ Pinned: ' : 'Unpinned: ') + cleanText(s.name, 40);
      }
    } else if (key === 's') {
      const s = current();
      if (s) {
        if (st.selected.has(s.sessionId)) st.selected.delete(s.sessionId);
        else st.selected.add(s.sessionId);
        if (st.sel < rows.length - 1) st.sel += 1;
        st.status = st.selected.size + ' selected';
      }
    } else if (key === 'd') {
      if (st.selected.size) {
        const targets = st.sessions.filter((x) => st.selected.has(x.sessionId));
        if (targets.length) { st.mode = 'confirm'; st.confirmList = targets; }
      } else {
        const s = current();
        if (s) { st.mode = 'confirm'; st.confirmTarget = s; }
      }
    } else if (key === 'e') {
      const t = scanTrash();
      if (!t.count) st.status = 'Trash is already empty';
      else { st.mode = 'confirm'; st.confirmEmptyTrash = t; }
    } else if (key === 'n') {
      if (provider.id === 'codex') return leave(0, [], process.cwd());
      st.mode = 'input'; st.inputPurpose = 'new'; st.inputBuf = '';
    } else if (key === 't') {
      st.mode = 'theme'; st.themeSel = THEME_ORDER.indexOf(themeId);
    } else if (key === 'b' && opts.canGoBack) {
      return goBack();
    }
    render();
  }

  process.stdin.on('data', onKey);
  out.on('resize', render);
  render();
  return done;
}

// ---------------------------------------------------------------------------
// Provider chooser + interactive entry
// ---------------------------------------------------------------------------

function chooseProvider(providers, here) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const themeId = readTheme();
    const P = paint(THEMES[themeId]);
    let sel = 0;
    let lastPick = 0;
    const render = () => {
      let buf = '\x1b[H\x1b[2J';
      buf += P.title('csm — Choose AI') + '\n';
      buf += P.dim('Project: ' + here) + '\n';
      buf += P.dim((themeId === 'default' ? '-' : '─').repeat(40)) + '\n';
      providers.forEach((p, i) => {
        const line =
          (i === sel ? '> ' : '  ') +
          p.label +
          '  (' + p.countHere + ' sessions in this project)';
        buf += (i === sel ? (P.cursorRow ? P.cursorRow(line) : '\x1b[7m' + line + '\x1b[0m') : line) + '\n';
      });
      buf += '\n' + P.dim('Up/Down or j/k · Enter select · q quit · click works too') + '\n';
      out.write(buf);
    };
    const done = (v) => {
      process.stdin.off('data', onData);
      resolve(v);
    };
    const onData = (data) => {
      const key = data.toString('utf8');
      const mm = key.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (mm) {
        const b = Number(mm[1]);
        const y = Number(mm[3]);
        const press = mm[4] === 'M';
        if (b === 64) { sel = Math.max(0, sel - 1); render(); }
        else if (b === 65) { sel = Math.min(providers.length - 1, sel + 1); render(); }
        else if (press && b === 0) {
          const idx = y - 4;
          if (idx >= 0 && idx < providers.length) {
            const now = Date.now();
            if (idx === sel && now - lastPick < 650) return done(providers[idx]);
            sel = idx;
            lastPick = now;
            render();
          }
        }
        return;
      }
      if (key === '\x03' || key === 'q' || key === '\x1b') {
        done(null);
      } else if (key === '\x1b[A' || key === 'k') {
        sel = Math.max(0, sel - 1);
        render();
      } else if (key === '\x1b[B' || key === 'j') {
        sel = Math.min(providers.length - 1, sel + 1);
        render();
      } else if (key === '\r' || key === '\n') {
        done(providers[sel]);
      } else if (key >= '1' && key <= String(providers.length)) {
        done(providers[Number(key) - 1]);
      }
    };
    process.stdin.on('data', onData);
    render();
  });
}

async function interactiveMain() {
  const out = process.stdout;
  const here = process.cwd();
  const [claudeSessions, codexSessions] = await Promise.all([
    loadSessions(),
    loadCodexSessions(),
  ]);
  const mk = (id, label, sessions) => ({
    id,
    label,
    sessions,
    countHere: sessions.filter((s) => s.cwd === here).length,
  });
  const claudeP = mk('claude', 'Claude Code', claudeSessions);
  const codexP = mk('codex', 'Codex', codexSessions);
  let providers = [claudeP, codexP].filter((p) => p.countHere > 0);
  if (!providers.length) providers = [claudeP]; // empty view, as before

  out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h'); // alternate screen + hide cursor + mouse
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let result = { action: 'exit', code: 0 };
  try {
    while (true) {
      const pick =
        providers.length === 1
          ? providers[0]
          : await chooseProvider(providers, here);
      if (!pick) break;
      result = await tui(pick, { canGoBack: providers.length > 1 });
      if (!result || result.action !== 'back') break;
    }
  } finally {
    out.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l'); // mouse off + leave alternate screen
    try { process.stdin.setRawMode(false); } catch { /* not raw */ }
    process.stdin.pause();
  }
  if (result && result.action === 'run') {
    process.exit(runCli(result.bin, result.args, result.cwd));
  }
  process.exit((result && result.code) || 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const argv = process.argv.slice(2);
  if (argv.length) {
    process.exit(await cli(argv));
  } else if (process.stdin.isTTY) {
    await interactiveMain();
  } else {
    printList(await loadSessions(), false, false);
  }
})().catch((err) => {
  console.error('csm error: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
