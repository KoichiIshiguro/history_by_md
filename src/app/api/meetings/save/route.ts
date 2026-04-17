import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

/**
 * Commit a polished meeting transcript as a set of blocks under a new page:
 *   会議録/YYYY-MM-DD/<title>
 *
 * Body: {
 *   meetingId: string,
 *   title?: string,            // override meeting title
 *   meetingDate?: string,       // override meeting date
 *   polishedTranscript: string, // user-edited text from the preview
 *   attendees?: string[]        // array of page names
 * }
 * Returns: { pageId: string }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();
  const body = await request.json();
  const { meetingId, title: titleIn, meetingDate: dateIn, polishedTranscript, attendees } = body as {
    meetingId: string;
    title?: string;
    meetingDate?: string;
    polishedTranscript: string;
    attendees?: string[];
  };

  const meeting = db.prepare("SELECT * FROM meetings WHERE id = ? AND user_id = ?").get(meetingId, user.id) as any;
  if (!meeting) return Response.json({ error: "Meeting not found" }, { status: 404 });

  const title = (titleIn || meeting.title || "無題の会議").trim();
  const meetingDate = dateIn || meeting.meeting_date || new Date().toISOString().slice(0, 10);
  const content = (polishedTranscript || "").trim();
  if (!content) return Response.json({ error: "Empty transcript" }, { status: 400 });

  const tx = db.transaction(() => {
    // 1. Ensure parent pages: 会議録 / YYYY-MM-DD
    const rootPageId = ensurePage(db, user.id, "会議録", null);
    const datePageId = ensurePage(db, user.id, meetingDate, rootPageId);
    const meetingPageId = ensurePage(db, user.id, title, datePageId);

    // 2. Clear any existing blocks on this page (re-save scenario)
    const existing = db.prepare("SELECT id FROM blocks WHERE user_id = ? AND page_id = ?").all(user.id, meetingPageId) as { id: string }[];
    for (const b of existing) {
      db.prepare("DELETE FROM block_tags WHERE block_id = ?").run(b.id);
      db.prepare("DELETE FROM block_pages WHERE block_id = ?").run(b.id);
    }
    db.prepare("DELETE FROM blocks WHERE user_id = ? AND page_id = ?").run(user.id, meetingPageId);

    // 3. Build blocks: header meta + body paragraphs
    const blocks: { id: string; content: string; indent: number }[] = [];
    const push = (text: string, indent = 0) => {
      if (!text.trim()) return;
      blocks.push({ id: crypto.randomUUID(), content: text, indent });
    };

    // Meta block: date + duration + attendees
    const metaParts: string[] = [];
    metaParts.push(`📅 ${meetingDate}`);
    if (meeting.duration_sec) metaParts.push(`⏱ ${formatDuration(meeting.duration_sec)}`);
    push(metaParts.join("  "));

    if (attendees && attendees.length > 0) {
      push(`👥 ${attendees.map((n) => `{{${n}}}`).join(" ")}`);
    }

    // Body: split polished transcript into paragraphs (blank line = new block)
    const paragraphs = content.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    for (const p of paragraphs) push(p);

    // 4. Insert blocks
    const insertBlock = db.prepare(
      `INSERT INTO blocks (id, user_id, date, content, indent_level, sort_order, page_id)
       VALUES (?, ?, '', ?, ?, ?, ?)`
    );
    for (let i = 0; i < blocks.length; i++) {
      insertBlock.run(blocks[i].id, user.id, blocks[i].content, blocks[i].indent, i, meetingPageId);
    }

    // 5. Link attendees pages via block_pages (for backlinks)
    if (attendees && attendees.length > 0) {
      const attendeePageIds: string[] = [];
      for (const name of attendees) {
        attendeePageIds.push(ensurePage(db, user.id, name, null));
      }
      // Attach attendee links to the attendees block (blocks[1] if present)
      const attendeeBlockIdx = blocks.findIndex((b) => b.content.startsWith("👥"));
      if (attendeeBlockIdx >= 0) {
        const attendeeBlockId = blocks[attendeeBlockIdx].id;
        for (const pid of attendeePageIds) {
          db.prepare("INSERT OR IGNORE INTO block_pages (block_id, page_id) VALUES (?, ?)").run(attendeeBlockId, pid);
        }
      }
    }

    // 6. Update meeting row
    db.prepare(
      `UPDATE meetings SET page_id = ?, title = ?, meeting_date = ?, polished_transcript = ?,
                            attendees = ?, status = 'saved', updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(meetingPageId, title, meetingDate, content, JSON.stringify(attendees || []), meetingId, user.id);

    return meetingPageId;
  });
  const pageId = tx();
  return Response.json({ pageId });
}

function ensurePage(db: any, userId: string, name: string, parentId: string | null): string {
  const found = parentId === null
    ? db.prepare("SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id IS NULL").get(name, userId)
    : db.prepare("SELECT id FROM pages WHERE name = ? AND user_id = ? AND parent_id = ?").get(name, userId, parentId);
  if (found) return found.id;
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO pages (id, name, user_id, parent_id, sort_order) VALUES (?, ?, ?, ?, 0)")
    .run(id, name, userId, parentId);
  return id;
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}時間${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}
