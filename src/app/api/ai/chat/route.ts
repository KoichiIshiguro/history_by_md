import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  embedTexts,
  queryVectors,
  geminiStream,
  checkDailyLimit,
  incrementUsage,
} from "@/lib/ai";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;

  if (!checkDailyLimit(userId, "chat")) {
    return Response.json({ error: "日次チャット上限に達しました" }, { status: 429 });
  }

  const { message, history } = await req.json();
  if (!message || typeof message !== "string") {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  try {
    incrementUsage(userId, "chat");

    // 1. Embed the user query
    const [queryEmbedding] = await embedTexts([message], userId);

    // 2. Semantic search in Pinecone
    const matches = await queryVectors(queryEmbedding, userId, 8);

    // 3. Fetch full block content from SQLite for matched blocks
    const db = getDb();
    const blockIds = [...new Set(matches.map((m: any) => m.metadata?.block_id).filter(Boolean))];

    const contextBlocks: { content: string; date: string; page_path: string }[] = [];
    for (const blockId of blockIds) {
      const block = db.prepare(
        "SELECT content, date, page_id FROM blocks WHERE id = ?"
      ).get(blockId) as { content: string; date: string; page_id: string | null } | undefined;
      if (block) {
        let pagePath = "";
        if (block.page_id) {
          // Resolve page path
          const parts: string[] = [];
          let currentPageId: string | null = block.page_id;
          while (currentPageId) {
            const page = db.prepare("SELECT name, parent_id FROM pages WHERE id = ?").get(currentPageId) as { name: string; parent_id: string | null } | undefined;
            if (!page) break;
            parts.unshift(page.name);
            currentPageId = page.parent_id;
          }
          pagePath = parts.join("/");
        }
        contextBlocks.push({ content: block.content, date: block.date, page_path: pagePath });
      }
    }

    // 4. Build RAG context
    const contextText = contextBlocks.map((b, i) => {
      const loc = [b.date, b.page_path].filter(Boolean).join(" | ");
      return `[${i + 1}] ${loc ? `(${loc}) ` : ""}${b.content}`;
    }).join("\n\n");

    // 5. Build conversation history for multi-turn
    const historyText = (history || [])
      .slice(-6) // Keep last 6 messages for context
      .map((h: { role: string; content: string }) => `${h.role === "user" ? "ユーザー" : "アシスタント"}: ${h.content}`)
      .join("\n");

    const systemPrompt = `あなたはユーザーのノート管理システム「History MD」のAIアシスタントです。
ユーザーが過去に書いたノートの内容をもとに、質問に正確に答えてください。

【重要なルール】
- ノートに書かれている情報のみを根拠に回答してください
- ノートに該当する情報がない場合は「該当する記録が見つかりませんでした」と正直に答えてください
- 回答には、どのノートを参照したか（日付やページパス）を示してください
- 簡潔で分かりやすい日本語で回答してください

${contextText ? `【参照ノート】\n${contextText}` : "【参照ノート】\n該当するノートが見つかりませんでした。"}

${historyText ? `【直近の会話】\n${historyText}` : ""}`;

    // 6. Stream response from Gemini
    const stream = await geminiStream(systemPrompt, message, { userId });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e: any) {
    console.error("AI chat error:", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
