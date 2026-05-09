// One-shot end-to-end smoke test for swirlock-context-fragmenter.
// Assumes the fragmenter is already running on 127.0.0.1:3215 and has
// access to the shared SQLite file. Inserts a synthetic session into
// the orchestrator-owned tables, sends `session.observed`, waits for
// `consolidation.updated`, prints the summary the fragmenter wrote.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const cfg = require("../service.config.cjs").env;

const dbFile = cfg.database.file;
const wsUrl = `ws://${cfg.host}:${cfg.port}/v5/fragmenter`;
const bearer = cfg.bearerToken;

const db = new Database(dbFile);
db.pragma("foreign_keys = ON");

const sessionId = randomUUID();
const turnId = randomUUID();
const now = new Date().toISOString();

console.log(`[smoke] inserting test session ${sessionId} into ${dbFile}`);

db.prepare(
  `INSERT INTO sessions (id, user_id, app_id, persona_id, channel, client_version, status, created_at, updated_at)
   VALUES (?, 'dev-user', 'smoke-test', 'gigi-the-robot', NULL, NULL, 'active', ?, ?)`,
).run(sessionId, now, now);

const messages = [
  {
    role: "user",
    content:
      "Salut! Ma cheama Andrei si lucrez la o aplicatie de chatbot. As vrea sa imi spui pe scurt cum functioneaza memoria pe termen lung intr-un chatbot bun.",
  },
  {
    role: "assistant",
    content:
      "Salut, Andrei! Memoria pe termen lung la un chatbot bine proiectat e separata de fereastra de context. De obicei, conversatia trecuta este sumarizata, faptele importante despre utilizator sunt extrase si stocate intr-o memorie persistenta, iar la fiecare tura noua sistemul reasambleaza un context relevant din aceste fragmente, fara sa reciteasca toata istoria.",
  },
  {
    role: "user",
    content:
      "Mersi, e clar. Lucrez deja cu Postgres pentru date. Ce baza de date imi recomanzi pentru memoria pe termen lung daca vreau ceva simplu de pus in productie?",
  },
];

const insertMsg = db.prepare(
  `INSERT INTO messages (id, session_id, turn_id, role, content, parts_json, created_at, seq)
   VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
);
messages.forEach((m, i) => {
  insertMsg.run(
    randomUUID(),
    sessionId,
    turnId,
    m.role,
    m.content,
    now,
    i + 1,
  );
});
const lastSeq = messages.length;

console.log(`[smoke] connecting to ${wsUrl}`);
const ws = new WebSocket(wsUrl, {
  headers: { Authorization: `Bearer ${bearer}` },
});

let resolved = false;
const start = Date.now();
const TIMEOUT_MS = 90_000;

function cleanup(exitCode) {
  try {
    db.prepare(`DELETE FROM fragmenter_session_summaries WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM fragmenter_consolidation_runs WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  } catch (err) {
    console.error("[smoke] cleanup failed:", err.message);
  }
  try {
    ws.close();
  } catch {}
  db.close();
  process.exit(exitCode);
}

ws.on("open", () => {
  console.log("[smoke] connected, sending session.observed");
  ws.send(
    JSON.stringify({
      type: "session.observed",
      correlationId: `smoke-${sessionId}`,
      payload: {
        sessionId,
        lastTurnId: turnId,
        lastSeq,
        observedAt: new Date().toISOString(),
      },
    }),
  );
});

ws.on("message", (raw) => {
  let env;
  try {
    env = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  console.log(`[smoke] <- ${env.type} ${env.correlationId}`);
  if (env.type === "consolidation.updated" && env.payload?.sessionId === sessionId) {
    resolved = true;
    setTimeout(() => readResultAndExit(), 100);
  }
  if (env.type === "error") {
    console.error("[smoke] error envelope:", env.error);
    cleanup(1);
  }
});

ws.on("error", (err) => {
  console.error("[smoke] ws error:", err.message);
  cleanup(1);
});

(async () => {
  while (!resolved && Date.now() - start < TIMEOUT_MS) {
    await delay(500);
  }
  if (!resolved) {
    console.error(`[smoke] no consolidation.updated in ${TIMEOUT_MS}ms`);
    readResultAndExit(1);
  }
})();

function readResultAndExit(forceExit = 0) {
  const row = db
    .prepare(
      `SELECT summary, through_seq, generated_at FROM fragmenter_session_summaries WHERE session_id = ?`,
    )
    .get(sessionId);
  if (!row) {
    console.error("[smoke] no row in fragmenter_session_summaries");
    cleanup(forceExit || 1);
    return;
  }
  console.log("\n[smoke] fragmenter_session_summaries row:");
  console.log(`  through_seq:  ${row.through_seq}`);
  console.log(`  generated_at: ${row.generated_at}`);
  console.log(`  summary:`);
  console.log(`    ${row.summary.split("\n").join("\n    ")}`);
  console.log("\n[smoke] OK");
  cleanup(0);
}
