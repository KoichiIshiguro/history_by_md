import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  embedTexts,
  queryVectors,
  geminiChat,
  checkDailyLimit,
  incrementUsage,
} from "@/lib/ai";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;

  if (!checkDailyLimit(userId, "generate")) {
    return Response.json({ error: "日次生成上限に達しました" }, { status: 429 });
  }

  const { prompt, context } = await req.json();
  if (!prompt || typeof prompt !== "string") {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  try {
    incrementUsage(userId, "generate");

    // Optionally search for related notes to provide context
    let relatedContext = "";
    try {
      const [queryEmbedding] = await embedTexts([prompt]);
      const matches = await queryVectors(queryEmbedding, userId, 5);
      const db = getDb();
      const contextParts: string[] = [];
      for (const match of matches) {
        const blockId = (match.metadata as any)?.block_id;
        if (!blockId) continue;
        const block = db.prepare("SELECT content, date FROM blocks WHERE id = ?").get(blockId) as { content: string; date: string } | undefined;
        if (block) contextParts.push(`[${block.date}] ${block.content}`);
      }
      if (contextParts.length > 0) {
        relatedContext = `\n\n【関連ノート】\n${contextParts.join("\n")}`;
      }
    } catch {
      // If vector search fails, proceed without context
    }

    const systemPrompt = `あなたはノート管理システム「History MD」のAI文章生成アシスタントです。
ユーザーの指示に従って、ノートに挿入するための文章を生成してください。

【ルール】
- Markdown形式で出力してください
- 簡潔で実用的な文章を心がけてください
- 余計な説明や前置きは不要です。生成した文章のみ出力してください
${context ? `\n【現在の編集コンテキスト】\n${context}` : ""}${relatedContext}`;

    const result = await geminiChat(systemPrompt, prompt);
    return Response.json({ text: result });
  } catch (e: any) {
    console.error("AI generate error:", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
