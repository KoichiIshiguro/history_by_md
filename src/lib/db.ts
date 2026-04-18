import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "weblogseq.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const fs = require("fs");
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initDb(db);
  }
  return db;
}

function initDb(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      image TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      indent_level INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES blocks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS block_tags (
      block_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (block_id, tag_id),
      FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      parent_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, user_id, parent_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES pages(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS block_pages (
      block_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      PRIMARY KEY (block_id, page_id),
      FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_blocks_user_date ON blocks(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_id);
    CREATE INDEX IF NOT EXISTS idx_block_tags_tag ON block_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_pages_user ON pages(user_id);
    CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);
    CREATE INDEX IF NOT EXISTS idx_block_pages_page ON block_pages(page_id);

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);
  `);

  // Migration: add page_id to blocks (for page-owned content blocks)
  const blockCols = db.prepare("PRAGMA table_info(blocks)").all() as { name: string }[];
  const blockColNames = blockCols.map((c) => c.name);
  if (!blockColNames.includes("page_id")) {
    db.exec("ALTER TABLE blocks ADD COLUMN page_id TEXT REFERENCES pages(id) ON DELETE CASCADE");
    db.exec("CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id)");
  }

  // Migration: add parent_id/sort_order to tags if they exist from old schema (keep for compat)
  const tagCols = db.prepare("PRAGMA table_info(tags)").all() as { name: string }[];
  const tagColNames = tagCols.map((c) => c.name);
  if (!tagColNames.includes("parent_id")) {
    // Old schema without parent_id - fine, tags are flat now
  }

  // Migration: add vector_synced_at to blocks (for AI vector sync tracking)
  if (!blockColNames.includes("vector_synced_at")) {
    db.exec("ALTER TABLE blocks ADD COLUMN vector_synced_at TEXT");
  }

  // Migration: add due_start/due_end for action date ranges (Gantt support)
  if (!blockColNames.includes("due_start")) {
    db.exec("ALTER TABLE blocks ADD COLUMN due_start TEXT");
  }
  if (!blockColNames.includes("due_end")) {
    db.exec("ALTER TABLE blocks ADD COLUMN due_end TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_blocks_due ON blocks(user_id, due_start, due_end)");

  // Backfill: action/done blocks without due dates get their creation date as single-day
  db.exec(`
    UPDATE blocks
       SET due_start = COALESCE(NULLIF(date, ''), date(created_at)),
           due_end   = COALESCE(NULLIF(date, ''), date(created_at))
     WHERE due_start IS NULL
       AND (content LIKE '!action %'  OR content LIKE '!action@%'
         OR content LIKE '!ACTION %'  OR content LIKE '!ACTION@%'
         OR content LIKE '!done %'    OR content LIKE '!done@%'
         OR content LIKE '!DONE %'    OR content LIKE '!DONE@%')
  `);

  // Migration: create ai_usage table for daily API call limits
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, date, endpoint),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date ON ai_usage(user_id, date);
  `);

  // Migration: create meetings table for meeting transcripts
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      page_id TEXT,                         -- saved page (NULL until committed)
      title TEXT NOT NULL DEFAULT '',
      meeting_date TEXT NOT NULL DEFAULT '', -- YYYY-MM-DD, user-chosen or today
      audio_filename TEXT,
      audio_mime TEXT,
      audio_size INTEGER,
      duration_sec INTEGER,
      language TEXT NOT NULL DEFAULT 'ja',
      status TEXT NOT NULL DEFAULT 'uploaded',
        -- 'uploaded' | 'transcribing' | 'transcribed' | 'polishing' | 'ready' | 'saved' | 'error'
      error_message TEXT,
      raw_transcript TEXT,                  -- Whisper output
      polished_transcript TEXT,             -- Claude-polished
      remove_fillers INTEGER NOT NULL DEFAULT 0,
      attendees TEXT,                       -- JSON array of page names
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id, created_at DESC);
  `);

  // Migration: ensure meetings.audio_tmp_path exists (persisted audio for re-polish, 24h)
  const meetingCols = db.prepare("PRAGMA table_info(meetings)").all() as { name: string }[];
  if (!meetingCols.some((c) => c.name === "audio_tmp_path")) {
    db.exec("ALTER TABLE meetings ADD COLUMN audio_tmp_path TEXT");
  }

  // Migration: blocks.meeting_id — meetings now own blocks directly (no separate page)
  const blockColsForMeeting = db.prepare("PRAGMA table_info(blocks)").all() as { name: string }[];
  if (!blockColsForMeeting.some((c) => c.name === "meeting_id")) {
    db.exec("ALTER TABLE blocks ADD COLUMN meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE");
    db.exec("CREATE INDEX IF NOT EXISTS idx_blocks_meeting ON blocks(meeting_id)");
  }

  // Migration: api_usage_log for billing / usage dashboard
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_usage_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,        -- 'groq' | 'gemini' | 'voyage' | 'pinecone'
      operation TEXT NOT NULL,       -- 'transcribe' | 'polish' | 'chat' | 'generate' | 'embed' | 'query'
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      audio_seconds INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      meta TEXT,                     -- JSON: extra context (file name, meeting id, etc.)
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON api_usage_log(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_provider ON api_usage_log(user_id, provider, created_at DESC);
  `);

  // Migration: create ai_threads and ai_messages tables for chat history
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_threads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_threads_user ON ai_threads(user_id);

    CREATE TABLE IF NOT EXISTS ai_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES ai_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_messages_thread ON ai_messages(thread_id);
  `);

  // Migration: relax unique constraint on pages from UNIQUE(name, user_id) to UNIQUE(name, user_id, parent_id)
  // SQLite can't ALTER constraints, so we check and recreate the table if needed
  const idxInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pages'").get() as { sql: string } | undefined;
  if (idxInfo && idxInfo.sql.includes("UNIQUE(name, user_id)") && !idxInfo.sql.includes("UNIQUE(name, user_id, parent_id)")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pages_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        parent_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, user_id, parent_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES pages(id) ON DELETE SET NULL
      );
      INSERT INTO pages_new SELECT * FROM pages;
      DROP TABLE pages;
      ALTER TABLE pages_new RENAME TO pages;
      CREATE INDEX IF NOT EXISTS idx_pages_user ON pages(user_id);
      CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);
    `);
  }
}
