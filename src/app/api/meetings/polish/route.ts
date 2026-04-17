import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Post-edit a raw transcript to fix transcription errors (NOT summarize).
 *
 * Body: { meetingId: string, removeFillers?: boolean }
 * Returns: { polishedTranscript: string }
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as any;
  const db = getDb();

  const { meetingId, removeFillers } = (await request.json()) as {
    meetingId: string;
    removeFillers?: boolean;
  };

  const meeting = db
    .prepare("SELECT * FROM meetings WHERE id = ? AND user_id = ?")
    .get(meetingId, user.id) as { raw_transcript: string | null } | undefined;
  if (!meeting || !meeting.raw_transcript) {
    return Response.json({ error: "No raw transcript to polish" }, { status: 404 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return Response.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });

  // Build vocabulary hint from existing tags + pages
  const tags = db.prepare("SELECT name FROM tags WHERE user_id = ? LIMIT 100").all(user.id) as { name: string }[];
  const pages = db.prepare("SELECT name FROM pages WHERE user_id = ? LIMIT 150").all(user.id) as { name: string }[];
  const vocabulary = [...new Set([...tags.map((t) => `#${t.name}`), ...pages.map((p) => p.name)])].join("、");

  const systemPrompt = buildPolishPrompt(!!removeFillers, vocabulary);

  db.prepare("UPDATE meetings SET status = 'polishing', updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(meetingId, user.id);

  try {
    const polished = await geminiPolish(apiKey, systemPrompt, meeting.raw_transcript);
    db.prepare(
      `UPDATE meetings SET polished_transcript = ?, remove_fillers = ?, status = 'ready', error_message = NULL,
                            updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
    ).run(polished, removeFillers ? 1 : 0, meetingId, user.id);
    return Response.json({ polishedTranscript: polished });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE meetings SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(message, meetingId, user.id);
    return Response.json({ error: message }, { status: 500 });
  }
}

function buildPolishPrompt(removeFillers: boolean, vocabulary: string): string {
  return `あなたは日本語音声の文字起こしをポストエディットする専門家です。
入力は音声認識 (Whisper) の生出力で、以下のような典型的な誤りを含みます：
- 同音異義語の誤選択
- 固有名詞・専門用語の誤認識
- 句読点の欠落または不自然な位置
- 半角/全角・漢字/カナの表記揺れ

【厳守事項】
1. 発言内容は一切改変しない（要約・短縮・省略・意訳すべて禁止）
2. 発言順序は元のまま保つ
3. 発言者が言っていない情報を追加しない
4. 推測による補完をしない（判断に迷う箇所は元のまま残す）

【行うべきこと】
- 明らかな文字起こしエラー（同音異義語、固有名詞の誤認識）を文脈から推定して修正
- 句読点を補い、読みやすい自然な文にする
- 漢字・カナ・数字の表記を統一する
- 以下の語彙はユーザーの既存の固有名詞・技術用語です。発音が近い箇所があれば優先的にこの綴りを採用してください：
${vocabulary || "（なし）"}

${removeFillers ? "【フィラー除去: ON】\n- 「えーと」「あのー」「えっと」「まあ」などの意味のないフィラー・感嘆表現を除去\n- 言い直しがある場合、最終的な表現を残す" : "【フィラー除去: OFF】\n- フィラー（「えーと」「あのー」等）はそのまま残す"}

【出力形式】
- 修正後のテキストのみを出力（前置き・後置き・解説は禁止）
- 段落分けは自然な区切りで行う（話題が変わったら空行）
- メタ情報やMarkdown記号は追加しない`;
}

async function geminiPolish(apiKey: string, systemPrompt: string, rawTranscript: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: rawTranscript }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.1, // low for accuracy
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");
  return text.trim();
}
