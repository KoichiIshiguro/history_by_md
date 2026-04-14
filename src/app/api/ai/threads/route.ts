import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

// GET: list threads or get thread messages
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  const db = getDb();

  const threadId = request.nextUrl.searchParams.get("threadId");

  if (threadId) {
    // Get messages for a thread
    const thread = db.prepare(
      "SELECT * FROM ai_threads WHERE id = ? AND user_id = ?"
    ).get(threadId, userId);
    if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });

    const messages = db.prepare(
      "SELECT id, role, content, created_at FROM ai_messages WHERE thread_id = ? ORDER BY created_at ASC"
    ).all(threadId);

    return Response.json({ thread, messages });
  }

  // List all threads
  const threads = db.prepare(
    "SELECT t.*, (SELECT COUNT(*) FROM ai_messages WHERE thread_id = t.id) as message_count FROM ai_threads t WHERE t.user_id = ? ORDER BY t.updated_at DESC"
  ).all(userId);

  return Response.json(threads);
}

// POST: create thread or add message
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  const db = getDb();

  const { threadId, role, content, title } = await request.json();

  if (!threadId) {
    // Create new thread
    const id = crypto.randomUUID();
    const threadTitle = title || content?.slice(0, 50) || "新しいチャット";
    db.prepare(
      "INSERT INTO ai_threads (id, user_id, title) VALUES (?, ?, ?)"
    ).run(id, userId, threadTitle);
    return Response.json({ id, title: threadTitle });
  }

  // Add message to thread
  if (!role || !content) {
    return Response.json({ error: "role and content required" }, { status: 400 });
  }

  const thread = db.prepare(
    "SELECT id FROM ai_threads WHERE id = ? AND user_id = ?"
  ).get(threadId, userId);
  if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });

  const msgId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO ai_messages (id, thread_id, role, content) VALUES (?, ?, ?, ?)"
  ).run(msgId, threadId, role, content);

  // Update thread timestamp and title if first message
  const msgCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM ai_messages WHERE thread_id = ?"
  ).get(threadId) as { cnt: number }).cnt;

  if (msgCount === 1 && role === "user") {
    db.prepare(
      "UPDATE ai_threads SET title = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(content.slice(0, 50), threadId);
  } else {
    db.prepare(
      "UPDATE ai_threads SET updated_at = datetime('now') WHERE id = ?"
    ).run(threadId);
  }

  return Response.json({ id: msgId });
}

// DELETE: delete a thread
export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  const db = getDb();

  const { threadId } = await request.json();
  if (!threadId) return Response.json({ error: "threadId required" }, { status: 400 });

  db.prepare("DELETE FROM ai_threads WHERE id = ? AND user_id = ?").run(threadId, userId);
  return Response.json({ ok: true });
}
