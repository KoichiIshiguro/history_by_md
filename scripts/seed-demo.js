#!/usr/bin/env node
/**
 * Seed a demo account with realistic sales/pitch content.
 *
 * Idempotent: fully wipes the demo user and reinserts. Safe to re-run.
 *
 * Usage:
 *   node scripts/seed-demo.js              # uses default email
 *   DEMO_EMAIL=foo@bar.com node scripts/seed-demo.js
 *
 * After seeding, sign in with the demo Google account that matches the email.
 * (Auth itself is handled by NextAuth; the seed does not set any password.)
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const DB_PATH = path.join(process.cwd(), "data", "weblogseq.db");
const EMAIL = process.env.DEMO_EMAIL || "demo@saltybullet.com";
const NAME = process.env.DEMO_NAME || "営業デモ";

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Ensure schema is migrated — mirrors src/lib/db.ts initDb().
// We only add the columns/tables the seed touches; pre-existing columns are
// left alone via PRAGMA-based gating so this is safe on both fresh DBs and
// production DBs already started by the app.
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, image TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    date TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
    indent_level INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(name, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS block_tags (
    block_id TEXT NOT NULL, tag_id TEXT NOT NULL,
    PRIMARY KEY (block_id, tag_id),
    FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL,
    parent_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(name, user_id, parent_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS block_pages (
    block_id TEXT NOT NULL, page_id TEXT NOT NULL,
    PRIMARY KEY (block_id, page_id),
    FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(name, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, page_id TEXT,
    title TEXT NOT NULL DEFAULT '', meeting_date TEXT NOT NULL DEFAULT '',
    audio_filename TEXT, audio_mime TEXT, audio_size INTEGER, duration_sec INTEGER,
    language TEXT NOT NULL DEFAULT 'ja',
    status TEXT NOT NULL DEFAULT 'uploaded',
    error_message TEXT, raw_transcript TEXT, polished_transcript TEXT,
    remove_fillers INTEGER NOT NULL DEFAULT 0, attendees TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS busy_slots (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    start_at TEXT NOT NULL, end_at TEXT NOT NULL,
    recurrence TEXT NOT NULL DEFAULT 'none',
    weekdays TEXT, recur_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS action_slots (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action_block_id TEXT NOT NULL,
    start_at TEXT NOT NULL, end_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (action_block_id) REFERENCES blocks(id) ON DELETE CASCADE
  );
`);
ensureColumn("blocks", "page_id", "TEXT");
ensureColumn("blocks", "meeting_id", "TEXT");
ensureColumn("blocks", "due_start", "TEXT");
ensureColumn("blocks", "due_end", "TEXT");
ensureColumn("blocks", "vector_synced_at", "TEXT");

const uuid = () => crypto.randomUUID();
const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
const today = new Date();
const todayYmd = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const addDays = (d, n) => {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
};
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const iso = (d, h, m) => `${ymd(d)}T${pad(h)}:${pad(m)}:00`;
const fullActionSpec = (startYmd, endYmd) => {
  const s = startYmd.replace(/-/g, "/");
  const e = endYmd.replace(/-/g, "/");
  return `${s}-${e}`;
};

// ─── 1. Reset the demo user ─────────────────────────────
let user = db.prepare("SELECT id FROM users WHERE email = ?").get(EMAIL);
if (user) {
  console.log(`Wiping existing demo user ${EMAIL} (id=${user.id})...`);
  // ON DELETE CASCADE handles blocks/pages/tags/meetings/slots/etc.
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
}
const userId = uuid();
db.prepare(
  "INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'user')"
).run(userId, EMAIL, NAME);
console.log(`Created demo user ${EMAIL} (id=${userId})`);

// ─── 2. Pages (customers, projects, people) ────────────
const insertPage = db.prepare(
  "INSERT INTO pages (id, name, user_id, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)"
);

function makePage(name, parentId, sortOrder = 0) {
  const id = uuid();
  insertPage.run(id, name, userId, parentId, sortOrder);
  return id;
}

const pCustomers = makePage("顧客", null, 0);
const pProjects = makePage("プロジェクト", null, 1);
const pPeople = makePage("メンバー", null, 2);
const pProduct = makePage("プロダクト戦略", null, 3);
const pKPI = makePage("KPIダッシュボード", null, 4);

const pABC = makePage("株式会社ABC商事", pCustomers, 0);
const pXYZ = makePage("XYZホールディングス", pCustomers, 1);
const pDEF = makePage("株式会社DEFテック", pCustomers, 2);
const pGHI = makePage("GHIフーズ", pCustomers, 3);

const pProjAlpha = makePage("Alphaプロジェクト", pProjects, 0);
const pProjBeta = makePage("Betaプロジェクト", pProjects, 1);
const pProjRebrand = makePage("リブランディング施策", pProjects, 2);

const pYamada = makePage("山田太郎", pPeople, 0);
const pSuzuki = makePage("鈴木一郎", pPeople, 1);
const pTanaka = makePage("田中花子", pPeople, 2);
const pSato = makePage("佐藤健", pPeople, 3);

// ─── 3. Templates ──────────────────────────────────────
const insertTemplate = db.prepare(
  "INSERT INTO templates (id, name, content, user_id) VALUES (?, ?, ?, ?)"
);
insertTemplate.run(
  uuid(),
  "日報",
  "## やったこと\n  - \n## 課題\n  - \n## 明日やること\n  - ",
  userId,
);
insertTemplate.run(
  uuid(),
  "議事録",
  "## 参加者\n  - \n## アジェンダ\n  - \n## 決定事項\n  - \n## ToDo\n  - !action@ ",
  userId,
);
insertTemplate.run(
  uuid(),
  "1on1",
  "## 最近の振り返り\n  - \n## 課題・困りごと\n  - \n## 今後のチャレンジ\n  - \n## フォローアップ\n  - !action@ ",
  userId,
);
insertTemplate.run(
  uuid(),
  "商談メモ",
  "## 顧客名\n  - {{顧客/}}\n## 議題\n  - \n## 先方要望\n  - \n## 次のアクション\n  - !action@ ",
  userId,
);

// ─── 4. Tags (will be auto-created via #tag parsing, but pre-seed popular ones) ─
const insertTag = db.prepare(
  "INSERT OR IGNORE INTO tags (id, name, user_id) VALUES (?, ?, ?)"
);
for (const t of ["商談", "バグ", "リリース", "重要", "見積もり", "要確認", "アイデア", "ブロッカー"]) {
  insertTag.run(uuid(), t, userId);
}
const insertBlockTag = db.prepare(
  "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)"
);
const insertBlockPage = db.prepare(
  "INSERT OR IGNORE INTO block_pages (block_id, page_id) VALUES (?, ?)"
);
const findTag = db.prepare("SELECT id FROM tags WHERE name = ? AND user_id = ?");
function tagId(name) {
  const row = findTag.get(name, userId);
  if (row) return row.id;
  const id = uuid();
  insertTag.run(id, name, userId);
  return id;
}

// ─── 5. Blocks helper ──────────────────────────────────
const insertBlock = db.prepare(
  `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, page_id, due_start, due_end)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

function addBlocks(scope, items) {
  // scope: { date?: string, pageId?: string }
  const dateStr = scope.date || "";
  const pageId = scope.pageId || null;
  items.forEach((b, i) => {
    const id = b.id || uuid();
    const indent = b.indent || 0;
    const due = b.dueStart && b.dueEnd ? [b.dueStart, b.dueEnd] : [null, null];
    insertBlock.run(id, userId, dateStr, b.content, indent, i, pageId, due[0], due[1]);
    // tags
    const tagMatches = b.content.match(/#([^\s#{}]+)/g) || [];
    for (const t of tagMatches) insertBlockTag.run(id, tagId(t.slice(1)));
    // page refs {{Page/Sub}}
    const pageMatches = b.content.match(/\{\{([^}]+)\}\}/g) || [];
    for (const p of pageMatches) {
      const full = p.slice(2, -2).trim();
      // best-effort lookup: leaf name match under user
      const leaf = full.split("/").pop();
      const row = db
        .prepare("SELECT id FROM pages WHERE name = ? AND user_id = ? LIMIT 1")
        .get(leaf, userId);
      if (row) insertBlockPage.run(id, row.id);
    }
  });
}

// ─── 6. Date pages (last 2 weeks + today + next week) ──
const dailyTemplates = [
  { morning: "朝会メモ", focus: "新機能リリース準備 #リリース" },
  { morning: "週次定例", focus: "顧客フォローアップ" },
  { morning: "1on1 {{鈴木一郎}}", focus: "Betaプロジェクト進捗確認" },
  { morning: "チームシンク", focus: "バックログ整理 #アイデア" },
  { morning: "四半期レビュー準備", focus: "KPI集計と分析 {{KPIダッシュボード}}" },
];

for (let offset = -12; offset <= 7; offset++) {
  const d = addDays(today, offset);
  // skip weekends for realism
  const wd = d.getDay();
  if (wd === 0 || wd === 6) continue;
  const dStr = ymd(d);
  const tmpl = dailyTemplates[Math.abs(offset) % dailyTemplates.length];
  const items = [
    { content: `## ${dStr.replace(/-/g, "/")}（${["日", "月", "火", "水", "木", "金", "土"][wd]}）`, indent: 0 },
    { content: tmpl.morning, indent: 0 },
    { content: tmpl.focus, indent: 1 },
  ];

  // Sprinkle some actions on specific offsets
  if (offset === 0) {
    // today
    items.push(
      { content: `!action@${fullActionSpec(ymd(addDays(today, 0)), ymd(addDays(today, 2)))} {{株式会社ABC商事}} に提案書を提出 #商談 #重要`, indent: 0, dueStart: ymd(today), dueEnd: ymd(addDays(today, 2)) },
      { content: `!action@${fullActionSpec(ymd(addDays(today, 1)), ymd(addDays(today, 5)))} Alpha機能のE2Eテスト整備 #リリース`, indent: 0, dueStart: ymd(addDays(today, 1)), dueEnd: ymd(addDays(today, 5)) },
      { content: `!action@${fullActionSpec(ymd(today), ymd(today))} 田中さんへ1on1フィードバック送付`, indent: 0, dueStart: ymd(today), dueEnd: ymd(today) },
    );
  }
  if (offset === -5) {
    items.push(
      { content: `!done@${fullActionSpec(ymd(addDays(today, -5)), ymd(addDays(today, -3)))} 営業資料Rev2作成`, indent: 0, dueStart: ymd(addDays(today, -5)), dueEnd: ymd(addDays(today, -3)) },
    );
  }
  if (offset === 3) {
    items.push(
      { content: `!action@${fullActionSpec(ymd(addDays(today, 3)), ymd(addDays(today, 10)))} リリースノート下書き #リリース`, indent: 0, dueStart: ymd(addDays(today, 3)), dueEnd: ymd(addDays(today, 10)) },
    );
  }
  if (offset === -3) {
    items.push(
      { content: `!done@${fullActionSpec(ymd(addDays(today, -3)), ymd(addDays(today, -3)))} XYZHD 見積もり送付 #見積もり`, indent: 0, dueStart: ymd(addDays(today, -3)), dueEnd: ymd(addDays(today, -3)) },
    );
  }

  addBlocks({ date: dStr }, items);
}

// ─── 7. Page content blocks (customer / project pages) ─
addBlocks({ pageId: pABC }, [
  { content: "## 顧客情報", indent: 0 },
  { content: "業界: 総合商社", indent: 1 },
  { content: "主要担当: {{山田太郎}}（営業）、{{鈴木一郎}}（技術）", indent: 1 },
  { content: "## 商談履歴", indent: 0 },
  { content: `!done@${fullActionSpec(ymd(addDays(today, -10)), ymd(addDays(today, -10)))} 初回訪問 #商談`, indent: 1, dueStart: ymd(addDays(today, -10)), dueEnd: ymd(addDays(today, -10)) },
  { content: `!done@${fullActionSpec(ymd(addDays(today, -4)), ymd(addDays(today, -4)))} 提案資料送付 #商談`, indent: 1, dueStart: ymd(addDays(today, -4)), dueEnd: ymd(addDays(today, -4)) },
  { content: `!action@${fullActionSpec(ymd(today), ymd(addDays(today, 2)))} 提案書レビュー会 #商談 #重要`, indent: 1, dueStart: ymd(today), dueEnd: ymd(addDays(today, 2)) },
  { content: "## 注意点", indent: 0 },
  { content: "金曜午後は先方と連絡取りにくい", indent: 1 },
  { content: "値引き交渉はNG、付加価値で勝負 #重要", indent: 1 },
]);

addBlocks({ pageId: pXYZ }, [
  { content: "## 概要", indent: 0 },
  { content: "複数事業部を持つホールディングス。関連会社が多い #要確認", indent: 1 },
  { content: "## 進行中案件", indent: 0 },
  { content: "- 物流DX / AIチャットボット導入 / KPI可視化", indent: 1 },
  { content: `!action@${fullActionSpec(ymd(addDays(today, 4)), ymd(addDays(today, 8)))} 見積もり3案作成 #見積もり`, indent: 1, dueStart: ymd(addDays(today, 4)), dueEnd: ymd(addDays(today, 8)) },
]);

addBlocks({ pageId: pProjAlpha }, [
  { content: "## ゴール", indent: 0 },
  { content: "Q2末までにリリース、ARR +10%寄与を目指す", indent: 1 },
  { content: "## マイルストーン", indent: 0 },
  { content: `!done@${fullActionSpec(ymd(addDays(today, -14)), ymd(addDays(today, -7)))} 要件定義`, indent: 1, dueStart: ymd(addDays(today, -14)), dueEnd: ymd(addDays(today, -7)) },
  { content: `!action@${fullActionSpec(ymd(addDays(today, -6)), ymd(addDays(today, 4)))} 実装フェーズ1`, indent: 1, dueStart: ymd(addDays(today, -6)), dueEnd: ymd(addDays(today, 4)) },
  { content: `!action@${fullActionSpec(ymd(addDays(today, 5)), ymd(addDays(today, 12)))} 実装フェーズ2`, indent: 1, dueStart: ymd(addDays(today, 5)), dueEnd: ymd(addDays(today, 12)) },
  { content: `!action@${fullActionSpec(ymd(addDays(today, 13)), ymd(addDays(today, 16)))} QA + リリース準備 #リリース`, indent: 1, dueStart: ymd(addDays(today, 13)), dueEnd: ymd(addDays(today, 16)) },
  { content: "## リスク", indent: 0 },
  { content: "外部API仕様変更の可能性 #ブロッカー", indent: 1 },
]);

addBlocks({ pageId: pProjBeta }, [
  { content: "## 目的", indent: 0 },
  { content: "既存機能の安定化とパフォーマンス改善", indent: 1 },
  { content: `!action@${fullActionSpec(ymd(addDays(today, 2)), ymd(addDays(today, 9)))} ボトルネック調査 #バグ`, indent: 0, dueStart: ymd(addDays(today, 2)), dueEnd: ymd(addDays(today, 9)) },
  { content: `!action@${fullActionSpec(ymd(addDays(today, 10)), ymd(addDays(today, 20)))} パフォーマンス改善リリース #リリース`, indent: 0, dueStart: ymd(addDays(today, 10)), dueEnd: ymd(addDays(today, 20)) },
]);

addBlocks({ pageId: pKPI }, [
  { content: "## 今月のKPI", indent: 0 },
  { content: "- MRR: ¥12.4M（前月比 +8%）", indent: 1 },
  { content: "- 有効アカウント数: 217", indent: 1 },
  { content: "- NRR: 112%", indent: 1 },
  { content: "## 要改善", indent: 0 },
  { content: "- 解約率がやや上昇 #要確認", indent: 1 },
]);

// ─── 8. Actions — pick the unfinished ones and add action_slots ─
const insertSlot = db.prepare(
  `INSERT INTO action_slots (id, user_id, action_block_id, start_at, end_at)
   VALUES (?, ?, ?, ?, ?)`
);
const actionRows = db
  .prepare(
    "SELECT id, content FROM blocks WHERE user_id = ? AND content LIKE '!action%' LIMIT 30"
  )
  .all(userId);
// Schedule a handful of them across this/next week
const slotPlan = [
  { offset: 0, startH: 10, endH: 12 },
  { offset: 0, startH: 14, endH: 15 },
  { offset: 1, startH: 9, endH: 11 },
  { offset: 2, startH: 13, endH: 15 },
  { offset: 3, startH: 10, endH: 12 },
  { offset: 4, startH: 15, endH: 17 },
  { offset: 7, startH: 9, endH: 11 },
  { offset: 8, startH: 14, endH: 16 },
];
actionRows.slice(0, slotPlan.length).forEach((row, i) => {
  const p = slotPlan[i];
  const d = addDays(today, p.offset);
  insertSlot.run(uuid(), userId, row.id, iso(d, p.startH, 0), iso(d, p.endH, 0));
});

// ─── 9. Busy slots (recurring meetings, off-limits) ────
const insertBusy = db.prepare(
  `INSERT INTO busy_slots (id, user_id, title, start_at, end_at, recurrence, weekdays, recur_until)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
// Daily stand-up 9:30-10:00 weekdays
insertBusy.run(
  uuid(), userId, "朝会",
  iso(today, 9, 30), iso(today, 10, 0),
  "weekly", JSON.stringify([1, 2, 3, 4, 5]), null,
);
// Weekly all-hands Friday 16:00-17:00
insertBusy.run(
  uuid(), userId, "全社定例",
  iso(today, 16, 0), iso(today, 17, 0),
  "weekly", JSON.stringify([5]), null,
);
// One-off: customer visit tomorrow 13:00-15:00
insertBusy.run(
  uuid(), userId, "ABC商事訪問",
  iso(addDays(today, 1), 13, 0), iso(addDays(today, 1), 15, 0),
  "none", null, null,
);

// ─── 10. Meetings (with polished transcript content) ───
const insertMeeting = db.prepare(
  `INSERT INTO meetings (id, user_id, title, meeting_date, language, status,
     raw_transcript, polished_transcript, attendees)
   VALUES (?, ?, ?, ?, 'ja', 'ready', ?, ?, ?)`
);
const m1Id = uuid();
insertMeeting.run(
  m1Id, userId, "ABC商事 提案レビュー",
  ymd(addDays(today, -4)),
  "鈴木さんからは価格面の指摘があり提案資料の修正が必要。先方は月内に結論を出す意向。",
  "- 鈴木さん: 価格面の懸念あり、オプションでの整理を希望\n- 先方担当: 月内に社内結論を出す方針\n- 当方TODO: 修正版を翌週頭に送付",
  JSON.stringify(["山田太郎", "鈴木一郎", "ABC商事 担当"]),
);
// Attach some blocks to the meeting
const insertMeetingBlock = db.prepare(
  `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, meeting_id)
   VALUES (?, ?, '', ?, ?, ?, ?)`
);
const mBlocks = [
  { c: "## 参加者", i: 0 },
  { c: "{{山田太郎}}、{{鈴木一郎}}、ABC商事 担当", i: 1 },
  { c: "## 議題", i: 0 },
  { c: "- 提案資料のブラッシュアップ", i: 1 },
  { c: "- 価格プランの選択肢提示", i: 1 },
  { c: "## 決定事項", i: 0 },
  { c: "- 月内決定を目指して再提案を出す", i: 1 },
  { c: "## ToDo", i: 0 },
  { c: `!action@${fullActionSpec(ymd(addDays(today, -2)), ymd(today))} 修正版提案書送付 #商談 #重要`, i: 1 },
];
mBlocks.forEach((b, i) => {
  insertMeetingBlock.run(uuid(), userId, b.c, b.i, i, m1Id);
});

const m2Id = uuid();
insertMeeting.run(
  m2Id, userId, "Alphaプロジェクト 進捗会",
  ymd(addDays(today, -1)),
  "実装フェーズ1は順調。外部API連携で少し時間がかかるかも。QA週のリソース確保が課題。",
  "- 実装フェーズ1: 予定通り進行中\n- 外部API: 仕様確認で+2日ほど見込み\n- QA: 人員確保の調整が必要",
  JSON.stringify(["山田太郎", "田中花子", "佐藤健"]),
);
const m2Blocks = [
  { c: "## 参加者", i: 0 },
  { c: "{{山田太郎}}、{{田中花子}}、{{佐藤健}}", i: 1 },
  { c: "## 進捗", i: 0 },
  { c: "- フェーズ1: 70%完了", i: 1 },
  { c: "- 外部API連携: 調査中 #要確認", i: 1 },
  { c: "## ToDo", i: 0 },
  { c: `!action@${fullActionSpec(ymd(today), ymd(addDays(today, 3)))} QA体制の詰め #リリース`, i: 1 },
];
m2Blocks.forEach((b, i) => {
  insertMeetingBlock.run(uuid(), userId, b.c, b.i, i, m2Id);
});

console.log("Demo seeding complete.");
console.log(`  pages:        ${db.prepare("SELECT COUNT(*) AS c FROM pages WHERE user_id = ?").get(userId).c}`);
console.log(`  blocks:       ${db.prepare("SELECT COUNT(*) AS c FROM blocks WHERE user_id = ?").get(userId).c}`);
console.log(`  action_slots: ${db.prepare("SELECT COUNT(*) AS c FROM action_slots WHERE user_id = ?").get(userId).c}`);
console.log(`  busy_slots:   ${db.prepare("SELECT COUNT(*) AS c FROM busy_slots WHERE user_id = ?").get(userId).c}`);
console.log(`  meetings:     ${db.prepare("SELECT COUNT(*) AS c FROM meetings WHERE user_id = ?").get(userId).c}`);
console.log(`  tags:         ${db.prepare("SELECT COUNT(*) AS c FROM tags WHERE user_id = ?").get(userId).c}`);
console.log(`  templates:    ${db.prepare("SELECT COUNT(*) AS c FROM templates WHERE user_id = ?").get(userId).c}`);
console.log(`\nLog in as: ${EMAIL}`);
