import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { PRICES } from "@/lib/usageLog";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

/**
 * Billing / usage dashboard endpoint.
 *
 * GET /api/billing?months=6
 *   months (optional): how many recent months to include (default 6).
 *
 * Returns:
 *   {
 *     monthly: [
 *       { month: '2026-04', totalUsd, byProvider: {groq, gemini, voyage}, byOperation: {...} }
 *     ],
 *     today: { totalUsd, calls },
 *     currentMonth: { totalUsd, calls, byProvider, byOperation },
 *     lifetime: { totalUsd, calls },
 *     pinecone: { indexName, vectorCount, indexSizeBytes, estimatedMonthlyUsd } | null,
 *     recentCalls: [ { at, provider, operation, model, tokens, audio_sec, cost } x20 ]
 *   }
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as any;
  const db = getDb();

  const months = Math.min(24, Math.max(1, parseInt(request.nextUrl.searchParams.get("months") || "6", 10)));

  // Monthly aggregation
  const monthRows = db.prepare(
    `SELECT strftime('%Y-%m', created_at) as month,
            provider, operation,
            SUM(cost_usd) as cost,
            SUM(input_tokens) as in_tok,
            SUM(output_tokens) as out_tok,
            SUM(audio_seconds) as audio_sec,
            COUNT(*) as calls
       FROM api_usage_log
      WHERE user_id = ?
        AND created_at >= date('now', 'start of month', ?)
      GROUP BY month, provider, operation
      ORDER BY month DESC, provider`
  ).all(user.id, `-${months - 1} months`) as Array<{
    month: string; provider: string; operation: string;
    cost: number; in_tok: number; out_tok: number; audio_sec: number; calls: number;
  }>;

  // Shape monthly data
  type ProviderBucket = { cost: number; calls: number; inputTokens: number; outputTokens: number; audioSeconds: number };
  type MonthBucket = {
    month: string;
    totalUsd: number;
    totalCalls: number;
    byProvider: Record<string, ProviderBucket>;
    byOperation: Record<string, { cost: number; calls: number }>;
  };
  const monthMap = new Map<string, MonthBucket>();
  for (const r of monthRows) {
    let m = monthMap.get(r.month);
    if (!m) {
      m = { month: r.month, totalUsd: 0, totalCalls: 0, byProvider: {}, byOperation: {} };
      monthMap.set(r.month, m);
    }
    m.totalUsd += r.cost;
    m.totalCalls += r.calls;
    if (!m.byProvider[r.provider]) m.byProvider[r.provider] = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, audioSeconds: 0 };
    m.byProvider[r.provider].cost += r.cost;
    m.byProvider[r.provider].calls += r.calls;
    m.byProvider[r.provider].inputTokens += r.in_tok || 0;
    m.byProvider[r.provider].outputTokens += r.out_tok || 0;
    m.byProvider[r.provider].audioSeconds += r.audio_sec || 0;
    const opKey = `${r.provider}:${r.operation}`;
    if (!m.byOperation[opKey]) m.byOperation[opKey] = { cost: 0, calls: 0 };
    m.byOperation[opKey].cost += r.cost;
    m.byOperation[opKey].calls += r.calls;
  }
  const monthly = Array.from(monthMap.values()).sort((a, b) => b.month.localeCompare(a.month));

  // Current-month and today (already in monthly if present)
  const today = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as calls
       FROM api_usage_log WHERE user_id = ? AND created_at >= date('now')`
  ).get(user.id) as { cost: number; calls: number };

  const currentMonthRow = monthly.find((m) => m.month === new Date().toISOString().slice(0, 7));
  const currentMonth = currentMonthRow ?? { month: new Date().toISOString().slice(0, 7), totalUsd: 0, totalCalls: 0, byProvider: {}, byOperation: {} };

  const lifetime = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as calls
       FROM api_usage_log WHERE user_id = ?`
  ).get(user.id) as { cost: number; calls: number };

  // Recent calls (for activity log)
  const recentCalls = db.prepare(
    `SELECT created_at, provider, operation, model,
            input_tokens, output_tokens, audio_seconds, cost_usd
       FROM api_usage_log WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 20`
  ).all(user.id);

  // Pinecone stats (best-effort, skipped if not configured)
  let pinecone: any = null;
  try {
    pinecone = await fetchPineconeStats();
  } catch (e) {
    pinecone = null;
  }

  return Response.json({
    monthly,
    today: { totalUsd: today.cost, calls: today.calls },
    currentMonth,
    lifetime: { totalUsd: lifetime.cost, calls: lifetime.calls },
    pinecone,
    recentCalls,
    prices: PRICES, // expose the price table for display
  });
}

async function fetchPineconeStats(): Promise<any> {
  const apiKey = process.env.PINECONE_API_KEY;
  const indexName = process.env.PINECONE_INDEX;
  if (!apiKey || !indexName) return null;

  // Describe index to get host + dimension
  const descRes = await fetch(`https://api.pinecone.io/indexes/${indexName}`, {
    headers: { "Api-Key": apiKey, "X-Pinecone-API-Version": "2024-07" },
  });
  if (!descRes.ok) return null;
  const desc = await descRes.json();
  const host = desc.host;
  const dimension: number = desc.dimension;

  // Get vector stats
  const statsRes = await fetch(`https://${host}/describe_index_stats`, {
    method: "POST",
    headers: { "Api-Key": apiKey, "Content-Type": "application/json", "X-Pinecone-API-Version": "2024-07" },
    body: "{}",
  });
  if (!statsRes.ok) return null;
  const stats = await statsRes.json();
  const totalVectors: number = stats.totalVectorCount ?? 0;

  // Rough storage estimate: vectors * dimension * 4 bytes (float32) + metadata overhead (~200B/vec)
  const bytesPerVector = dimension * 4 + 200;
  const indexSizeBytes = totalVectors * bytesPerVector;
  const sizeGB = indexSizeBytes / 1024 / 1024 / 1024;
  const storageCost = sizeGB * PRICES.pinecone.storagePerGBMonth;

  return {
    indexName,
    host,
    dimension,
    vectorCount: totalVectors,
    indexSizeBytes,
    estimatedMonthlyUsd: storageCost,
    note: "storageのみの概算。read/write コストは api_usage_log を参照",
  };
}
