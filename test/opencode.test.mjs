import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const AGTOP = fileURLToPath(new URL("../index.js", import.meta.url));
const T0 = Date.now() - 3600_000;
// Node prints warnings on a later tick, after `agtop -j` has already exited,
// so report every emitWarning call synchronously instead.
const WARNING_PROBE = "data:text/javascript," + encodeURIComponent(
  "const emit = process.emitWarning;" +
  "process.emitWarning = (w, ...rest) => { process.stderr.write('emitWarning: ' + (w && w.message || w) + '\\n'); return emit.call(process, w, ...rest); };");

const V1_SCHEMA = `
  CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
    summary_additions INTEGER, summary_deletions INTEGER,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);`;

const V2_SCHEMA = `
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT, agent TEXT,
    summary_additions INTEGER, summary_deletions INTEGER,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, data TEXT NOT NULL);`;

const tokens = (input, output, read, write) => ({ input, output, reasoning: 0, cache: { read, write } });

function writeV1(db, s) {
  const created = s.created ?? T0;
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    s.id, s.parent || null, "/work/proj", s.title, s.additions || 0, s.deletions || 0, created, created + 1000);
  s.turns.forEach((t, i) => {
    const ts = t.ts ?? created + i * 100;
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(`${s.id}-m${i}`, s.id, ts, JSON.stringify({
      role: "assistant", modelID: t.model, providerID: "anthropic", cost: t.cost, tokens: t.tokens,
      time: { created: ts, completed: ts + 50 },
    }));
    for (const [j, [tool, input]] of (t.tools || []).entries()) {
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(`${s.id}-m${i}-p${j}`, `${s.id}-m${i}`, s.id, ts + j, JSON.stringify({
        type: "tool", tool, state: { status: "completed", input, time: { start: ts + j, end: ts + j + 1 } },
      }));
    }
  });
}

function writeV2(db, s) {
  const created = s.created ?? T0;
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    s.id, s.parent || null, "/work/proj", s.title, s.agent || null, s.additions || 0, s.deletions || 0, created, created + 1000);
  s.turns.forEach((t, i) => {
    const ts = t.ts ?? created + i * 100;
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)").run(`${s.id}-m${i}`, s.id, t.type || "assistant", i, ts, JSON.stringify({
      time: { created: ts, completed: ts + 50 }, model: { id: t.model, providerID: "amazon-bedrock" },
      cost: t.cost, tokens: t.tokens,
      content: [{ type: "text", text: "ok" }, ...(t.tools || []).map(([name, input, toolCalls], j) => ({
        type: "tool", id: `call-${i}-${j}`, name, state: { status: "completed", input, ...(toolCalls && { metadata: { toolCalls } }) },
        time: { created: ts + j },
      }))],
    }));
  });
}

// dbs: file name under the OpenCode data dir -> function filling that database.
// files: path under the fake home -> content.
function makeHome(dbs, files = {}) {
  const home = mkdtempSync(join(tmpdir(), "agtop-opencode-"));
  mkdirSync(join(home, ".cache", "agtop"), { recursive: true });
  writeFileSync(join(home, ".cache", "agtop", "litellm-pricing.json"), JSON.stringify({ _fetchedAt: Date.now(), data: {} }));
  mkdirSync(join(home, "data", "opencode"), { recursive: true });
  for (const [name, build] of Object.entries(dbs)) {
    const db = new DatabaseSync(join(home, "data", "opencode", name));
    build(db);
    db.close();
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), content, { mode: 0o755 });
  }
  const env = {
    ...process.env, OPENCODE_DB: "", OPENCODE_CONFIG_DIR: "", OPENCODE_CONFIG: "",
    HOME: home, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"),
  };
  return { home, env };
}

function runAgtop(dbs, env = {}, files = {}) {
  const fake = makeHome(dbs, files);
  try {
    const r = spawnSync(process.execPath, ["--import", WARNING_PROBE, AGTOP, "-j"], {
      env: { ...fake.env, ...env },
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /emitWarning: .*SQLite/);
    return JSON.parse(r.stdout).filter(s => s.provider === "opencode");
  } finally {
    rmSync(fake.home, { recursive: true, force: true });
  }
}

const ROOT = {
  id: "ses_root", title: "Fix the build", additions: 12, deletions: 3,
  turns: [
    { model: "claude-opus-5", cost: 0.5, tokens: tokens(10, 200, 1000, 300), tools: [["shell", { command: "make test" }], ["webfetch", { url: "https://example.com/a" }]] },
    { model: "claude-opus-5", cost: 0.25, tokens: tokens(5, 100, 1300, 0), tools: [["skill", { name: "tdd" }]] },
  ],
};

test("v2 schema: one session per root, subagent cost and tools folded in", () => {
  const sessions = runAgtop({ "opencode.db": (db) => {
    db.exec(V2_SCHEMA);
    writeV2(db, ROOT);
    writeV2(db, { id: "ses_child", parent: "ses_root", title: "Map code", agent: "explore",
      turns: [{ model: "claude-sonnet-5", cost: 0.1, tokens: tokens(1, 50, 400, 100), tools: [["read", { path: "/work/proj/x.c" }]] }] });
  } });
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.session_id, "ses_root");
  assert.equal(s.title, "Fix the build");
  assert.equal(s.project, "/work/proj");
  assert.equal(s.model, "claude-opus-5");
  assert.deepEqual(s.models, ["claude-opus-5", "claude-sonnet-5"]);
  assert.equal(s.cost.total, "0.850000");
  assert.deepEqual(s.tokens.detail, { input: 16, cache_read: 2700, cache_write: 400, output: 350, total: 3466 });
  assert.equal(s.tokens.input, 16 + 2700 + 400);
  assert.deepEqual(s.activity.tools, { shell: 1, webfetch: 1, skill: 1, read: 1 });
  assert.deepEqual(s.activity.web_fetches, ["https://example.com/a"]);
  assert.deepEqual(s.activity.skills, { tdd: 1 });
  assert.equal(s.subagents.length, 1);
  assert.equal(s.subagents[0].type, "explore");
  assert.equal(s.subagents[0].description, "Map code");
  assert.equal(s.subagents[0].cost, 0.1);
  assert.equal(s.subagents[0].tool_count, 1);
});

test("v1 schema: agent type comes from the title suffix", () => {
  const sessions = runAgtop({ "opencode.db": (db) => {
    db.exec(V1_SCHEMA);
    writeV1(db, ROOT);
    writeV1(db, { id: "ses_child", parent: "ses_root", title: "Map code (@explore subagent)",
      turns: [{ model: "claude-sonnet-5", cost: 0.1, tokens: tokens(1, 50, 400, 100), tools: [["read", { filePath: "/work/proj/x.c" }]] }] });
  } });
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.cost.total, "0.850000");
  assert.deepEqual(s.activity.tools, { shell: 1, webfetch: 1, skill: 1, read: 1 });
  assert.equal(s.subagents[0].type, "explore");
  assert.equal(s.subagents[0].description, "Map code");
});

test("v2 tables win over the frozen v1 tables after migration", () => {
  const sessions = runAgtop({ "opencode.db": (db) => {
    db.exec(V1_SCHEMA + V2_SCHEMA);
    writeV1(db, { ...ROOT, title: "stale v1 copy" });
    writeV2(db, ROOT);
  } });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "Fix the build");
});

const FORK_TURN = { model: "claude-opus-5", cost: 0.2, tokens: tokens(1, 10, 100, 0), tools: [["shell", { command: "ls" }]] };

test("a fork's copied history is not counted twice (v2)", () => {
  const sessions = runAgtop({ "opencode.db": (db) => {
    db.exec(V2_SCHEMA);
    writeV2(db, ROOT);
    writeV2(db, { id: "ses_fork", title: "Fix the build (fork #1)", created: T0 + 5000,
      turns: [...ROOT.turns.map((t, i) => ({ ...t, ts: T0 + i * 100 })), FORK_TURN] });
  } });
  const fork = sessions.find(s => s.session_id === "ses_fork");
  assert.equal(fork.cost.total, "0.200000");
  assert.deepEqual(fork.activity.tools, { shell: 1 });
  assert.equal(sessions.find(s => s.session_id === "ses_root").cost.total, "0.750000");
});

test("a fork's copied history is not counted twice (v1)", () => {
  const sessions = runAgtop({ "opencode.db": (db) => {
    db.exec(V1_SCHEMA);
    writeV1(db, ROOT);
    writeV1(db, { id: "ses_fork", title: "renamed fork", created: T0 + 5000,
      turns: [...ROOT.turns.map((t, i) => ({ ...t, ts: T0 + i * 100 })), FORK_TURN] });
  } });
  const fork = sessions.find(s => s.session_id === "ses_fork");
  assert.equal(fork.cost.total, "0.200000");
  assert.deepEqual(fork.activity.tools, { shell: 1 });
});

test("v2 compaction calls are billed", () => {
  const sessions = runAgtop({ "opencode.db": (db) => {
    db.exec(V2_SCHEMA);
    writeV2(db, { ...ROOT, turns: [...ROOT.turns, { type: "compaction", model: "claude-sonnet-5", cost: 0.05, tokens: tokens(0, 20, 500, 0) }] });
  } });
  assert.equal(sessions[0].cost.total, "0.800000");
});

test("channel databases are read, the imported opencode-next.db is not", () => {
  const fill = (id) => (db) => { db.exec(V2_SCHEMA); writeV2(db, { ...ROOT, id }); };
  const sessions = runAgtop({ "opencode.db": fill("ses_latest"), "opencode-local.db": fill("ses_local"), "opencode-next.db": fill("ses_next") });
  assert.deepEqual(sessions.map(s => s.session_id).sort(), ["ses_latest", "ses_local"]);
});

test("a database without OpenCode's tables is skipped, not fatal", () => {
  const sessions = runAgtop({
    "opencode.db": (db) => { db.exec(V2_SCHEMA); writeV2(db, ROOT); },
    "opencode-other.db": (db) => { db.exec("CREATE TABLE unrelated (x)"); },
  });
  assert.deepEqual(sessions.map(s => s.session_id), ["ses_root"]);
});

test("OPENCODE_DB selects one database, relative to the data dir", () => {
  const fill = (id) => (db) => { db.exec(V2_SCHEMA); writeV2(db, { ...ROOT, id }); };
  const sessions = runAgtop({ "opencode.db": fill("ses_default"), "custom.db": fill("ses_custom") }, { OPENCODE_DB: "custom.db" });
  assert.deepEqual(sessions.map(s => s.session_id), ["ses_custom"]);
});

test("MCP calls are counted, direct and through code mode", () => {
  const sessions = runAgtop({ "opencode.db": (db) => {
    db.exec(V2_SCHEMA);
    writeV2(db, { ...ROOT, turns: [{ model: "claude-opus-5", cost: 0.1, tokens: tokens(1, 1, 1, 1), tools: [
      ["my_github_pull_request_read", { owner: "o" }],
      ["github_lookalike", {}],
      ["execute", { code: "..." }, [{ tool: "search" }, { tool: "jenkins.get_build" }, { tool: "jenkins.get_log" }]],
    ] }] });
  } }, {}, { "config/opencode/opencode.jsonc": '{\n  // servers\n  "mcp": { "my.github": { "type": "local" } },\n}\n' });
  assert.equal(sessions[0].activity.mcp_tool_count, 3);
  assert.deepEqual(sessions[0].activity.mcp_tools, ["my_github_pull_request_read", "jenkins.get_build", "jenkins.get_log"]);
});

// The live view only exists in the TUI, so drive it through a pseudo-terminal.
test("TUI: busy sessions run on the shared server, models drop their prefix, delete calls opencode", { skip: process.platform !== "linux" }, () => {
  const now = Date.now();
  // busy: no idle marker yet, but quiet for minutes (a long tool run); done:
  // idle, though it changed seconds ago. Recency alone would get both wrong.
  const fake = makeHome({ "opencode.db": (db) => {
    db.exec(V2_SCHEMA);
    writeV2(db, { id: "ses_busy", title: "busy one", created: now - 300_000,
      turns: [{ model: "global.anthropic.claude-opus-5-5", cost: 0.1, tokens: tokens(1, 1, 1, 1) }] });
    writeV2(db, { id: "ses_done", title: "done one", created: now - 2000,
      turns: [{ model: "claude-opus-5", cost: 0.1, tokens: tokens(1, 1, 1, 1) }, { type: "idle" }] });
  } }, { "bin/opencode": '#!/bin/sh\necho "$@" >> "$HOME/opencode.log"\n' });
  symlinkSync(process.execPath, join(fake.home, "opencode"));
  const server = spawn(join(fake.home, "opencode"), ["-e", "setTimeout(() => {}, 60000)", "serve"], { stdio: "ignore" });
  try {
    const keys = "sleep 4; printf d; sleep 1; printf y; sleep 2; printf q";
    const r = spawnSync("sh", ["-c", `(${keys}) | script -qfec 'stty cols 200 rows 50; exec node ${AGTOP}' ${join(fake.home, "tui.log")}`], {
      env: { ...fake.env, PATH: `${join(fake.home, "bin")}:${process.env.PATH}` }, encoding: "utf-8", timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr);
    const screen = readFileSync(join(fake.home, "tui.log"), "utf-8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    const busyRow = screen.split(/\r?\n/).find(l => l.includes("busy one"));
    assert.match(busyRow, /●/);
    assert.match(busyRow, /\sopus-5-5\s/);
    assert.doesNotMatch(screen.split(/\r?\n/).find(l => l.includes("done one")), /●/);
    assert.equal(readFileSync(join(fake.home, "opencode.log"), "utf-8"), "session delete ses_done\n");
  } finally {
    server.kill();
    rmSync(fake.home, { recursive: true, force: true });
  }
});
