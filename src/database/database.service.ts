import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { SERVICE_CONFIG } from "../config/config";
import type { ServiceConfig } from "../config/config";

export type Db = Database.Database;

/**
 * Owns the shared SQLite connection and the fragmenter's own migrations.
 *
 * The fragmenter NEVER creates or alters orchestrator-owned tables. Per
 * v5 contract `apps/context-fragmenter.md`, table-level ownership is:
 *
 * - Orchestrator-owned: `sessions`, `messages`, `agent_events`,
 *   `agent_plans`, `agent_plan_steps`, `personas`, `persona_*`,
 *   `identity_mutation_candidates`. The fragmenter may read these.
 * - Fragmenter-owned: every table prefixed `fragmenter_*`. The
 *   fragmenter is the only writer for these.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DatabaseService.name);
  private db?: Db;

  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  onModuleInit(): void {
    const file = this.cfg.database.file;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(file)) {
      this.log.warn(
        `SQLite file ${file} does not exist yet. Creating it; the orchestrator will populate its tables on first run.`,
      );
    }

    this.db = new Database(file);
    // WAL mode is set by the orchestrator. We pragma it for safety in case
    // the fragmenter is the first process to open the file.
    this.db.pragma("journal_mode = WAL");
    // Foreign keys are deliberately NOT enabled for this connection. The
    // fragmenter's tables hold opaque sessionIds; cleanup of fragmenter
    // rows is driven by the explicit `session.invalidate` notification,
    // not by SQLite cascade from the orchestrator's `sessions` table.
    this.migrate();
    this.log.log(`SQLite ready at ${file}`);
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  get connection(): Db {
    if (!this.db) throw new Error("Database not initialized");
    return this.db;
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS fragmenter_session_summaries (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        through_seq INTEGER NOT NULL,
        through_message_id TEXT,
        generated_at TEXT NOT NULL,
        fragmenter_correlation_id TEXT
      );

      CREATE TABLE IF NOT EXISTS fragmenter_consolidation_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        through_seq INTEGER,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_fragmenter_runs_session
        ON fragmenter_consolidation_runs(session_id, started_at);

      -- Durable facts the conversation has established about the user,
      -- scoped per user_id (matches orchestrator's sessions.user_id).
      -- Importance: 'core' (identity-defining), 'important' (recurring),
      -- 'incidental' (one-off mention worth remembering). Sleep can
      -- supersede old rows with merged/re-tiered ones; superseded rows
      -- stay in the table for traceability.
      CREATE TABLE IF NOT EXISTS fragmenter_user_identities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        importance TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_session_id TEXT,
        generated_at TEXT NOT NULL,
        last_confirmed_at TEXT,
        superseded_at TEXT,
        superseded_by_id TEXT,
        fragmenter_correlation_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_user_identities_user
        ON fragmenter_user_identities(user_id, superseded_at);

      -- Durable facts the persona has established about itself across
      -- sessions, scoped per persona_name. Same shape as user identities.
      CREATE TABLE IF NOT EXISTS fragmenter_app_identities (
        id TEXT PRIMARY KEY,
        persona_name TEXT NOT NULL,
        content TEXT NOT NULL,
        importance TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_session_id TEXT,
        generated_at TEXT NOT NULL,
        last_confirmed_at TEXT,
        superseded_at TEXT,
        superseded_by_id TEXT,
        fragmenter_correlation_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_app_identities_persona
        ON fragmenter_app_identities(persona_name, superseded_at);
    `);

    // Unit B (repeatability-driven decay): each identity row tracks
    // how many times an extraction has matched it. Reinforcement
    // bumps the counter and `last_confirmed_at`; sleep uses both
    // signals to demote, retire, or promote rows. Idempotent ALTER
    // — runs once on the first boot after this change ships and is
    // a no-op afterwards.
    this.ensureColumn(
      "fragmenter_user_identities",
      "reinforcement_count",
      "INTEGER NOT NULL DEFAULT 1",
    );
    this.ensureColumn(
      "fragmenter_app_identities",
      "reinforcement_count",
      "INTEGER NOT NULL DEFAULT 1",
    );

    // Unit K: per-cutoff session summaries. The original schema had
    // session_id as the sole PK, so only one summary per session
    // could exist — every new run overwrote the prior one and the
    // orchestrator had no way to fetch a summary that ends BEFORE
    // its raw hot-zone starts (which created overlap). The new
    // schema uses a composite PK (session_id, through_seq) so
    // multiple cutoffs accumulate over time; the orchestrator picks
    // the largest through_seq strictly less than its hot-zone-start
    // seq.
    this.migrateSummariesToCompositeKey();
  }

  /**
   * Migrates fragmenter_session_summaries from a single-row-per-session
   * shape (session_id PK) to a multi-cutoff shape (session_id + through_seq
   * composite PK). Idempotent — runs once, detected by checking whether
   * session_id is currently UNIQUE on the existing table.
   *
   * SQLite doesn't support DROP PRIMARY KEY on an existing table, so the
   * migration uses the standard table-swap pattern: create the new
   * table, copy rows, drop the old table, rename. Safe because the
   * fragmenter holds an exclusive WAL connection during onModuleInit.
   */
  private migrateSummariesToCompositeKey(): void {
    const tableExists = this.connection
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fragmenter_session_summaries'`,
      )
      .get() as { name: string } | undefined;
    if (!tableExists) return;

    // Detect whether the table is already on the new shape by
    // counting how many PK columns it has. If pk > 1, we're on the
    // composite PK already — nothing to do.
    const cols = this.connection
      .prepare(`PRAGMA table_info(fragmenter_session_summaries)`)
      .all() as Array<{ name: string; pk: number }>;
    const pkCount = cols.filter((c) => c.pk > 0).length;
    if (pkCount >= 2) return;

    this.log.log(
      "Migrating fragmenter_session_summaries to composite PK (session_id, through_seq)",
    );

    this.connection.exec(`
      CREATE TABLE fragmenter_session_summaries_new (
        session_id TEXT NOT NULL,
        through_seq INTEGER NOT NULL,
        summary TEXT NOT NULL,
        through_message_id TEXT,
        generated_at TEXT NOT NULL,
        fragmenter_correlation_id TEXT,
        PRIMARY KEY (session_id, through_seq)
      );

      INSERT INTO fragmenter_session_summaries_new
        (session_id, through_seq, summary, through_message_id, generated_at, fragmenter_correlation_id)
      SELECT session_id, through_seq, summary, through_message_id, generated_at, fragmenter_correlation_id
        FROM fragmenter_session_summaries;

      DROP TABLE fragmenter_session_summaries;

      ALTER TABLE fragmenter_session_summaries_new
        RENAME TO fragmenter_session_summaries;

      CREATE INDEX IF NOT EXISTS idx_fragmenter_summaries_session_seq
        ON fragmenter_session_summaries(session_id, through_seq);
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.connection
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.connection.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
    );
    this.log.log(`Added column ${table}.${column}`);
  }
}
