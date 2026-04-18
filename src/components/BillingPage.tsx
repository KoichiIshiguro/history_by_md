"use client";

import { useEffect, useState } from "react";

interface ProviderBucket {
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
}
interface MonthData {
  month: string;
  totalUsd: number;
  totalCalls: number;
  byProvider: Record<string, ProviderBucket>;
  byOperation: Record<string, { cost: number; calls: number }>;
}
interface BillingData {
  monthly: MonthData[];
  today: { totalUsd: number; calls: number };
  currentMonth: MonthData;
  lifetime: { totalUsd: number; calls: number };
  pinecone: {
    indexName: string;
    dimension: number;
    vectorCount: number;
    indexSizeBytes: number;
    estimatedMonthlyUsd: number;
    note: string;
  } | null;
  recentCalls: Array<{
    created_at: string;
    provider: string;
    operation: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    audio_seconds: number;
    cost_usd: number;
  }>;
}

function usd(n: number): string {
  return `$${n.toFixed(n < 0.01 ? 4 : 2)}`;
}
function jpy(usdValue: number, rate = 150): string {
  return `¥${Math.round(usdValue * rate).toLocaleString()}`;
}
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec % 60}s`;
  return `${sec}s`;
}

const PROVIDER_LABEL: Record<string, string> = {
  groq: "Groq (Whisper)",
  gemini: "Google Gemini",
  voyage: "Voyage AI (埋め込み)",
  pinecone: "Pinecone (ベクターDB)",
};
const OP_LABEL: Record<string, string> = {
  "groq:transcribe": "音声文字起こし",
  "gemini:polish": "会議録 清書",
  "gemini:chat": "AI チャット",
  "gemini:generate": "AI 生成 (!ai)",
  "voyage:embed": "ノート埋め込み",
};

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/billing?months=6");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData(await res.json());
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="mx-auto max-w-5xl p-4 text-gray-500">読み込み中...</div>;
  if (error) return <div className="mx-auto max-w-5xl p-4 text-red-600">エラー: {error}</div>;
  if (!data) return null;

  const cm = data.currentMonth;
  const lastMonth = data.monthly.find((m) => m.month !== cm.month);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-800">課金状況</h1>
        <p className="text-xs text-gray-500 mt-1">
          API プロバイダ別の使用量と概算コストを表示します。実際の請求額は各プロバイダのダッシュボードをご確認ください。
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card title="今日" primary={usd(data.today.totalUsd)} sub={`${data.today.calls} 件のAPIコール`} />
        <Card title="今月" primary={usd(cm.totalUsd)} sub={`${jpy(cm.totalUsd)} / ${cm.totalCalls} 件`} highlight />
        <Card title="累計" primary={usd(data.lifetime.totalUsd)} sub={`${data.lifetime.calls} 件`} />
      </div>

      {/* Current month provider breakdown */}
      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">今月の内訳（プロバイダ別）</h2>
        {Object.keys(cm.byProvider).length === 0 ? (
          <div className="text-xs text-gray-400 py-4">まだ使用履歴がありません</div>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">プロバイダ</th>
                  <th className="text-right px-3 py-2">コスト</th>
                  <th className="text-right px-3 py-2">コール</th>
                  <th className="text-right px-3 py-2">入力トークン</th>
                  <th className="text-right px-3 py-2">出力トークン</th>
                  <th className="text-right px-3 py-2">音声時間</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(cm.byProvider).map(([provider, b]) => (
                  <tr key={provider} className="border-t border-gray-100">
                    <td className="px-3 py-2">{PROVIDER_LABEL[provider] || provider}</td>
                    <td className="text-right px-3 py-2 font-medium">{usd(b.cost)}</td>
                    <td className="text-right px-3 py-2 text-gray-600">{b.calls}</td>
                    <td className="text-right px-3 py-2 text-gray-500">{b.inputTokens.toLocaleString()}</td>
                    <td className="text-right px-3 py-2 text-gray-500">{b.outputTokens.toLocaleString()}</td>
                    <td className="text-right px-3 py-2 text-gray-500">{b.audioSeconds > 0 ? fmtDuration(b.audioSeconds) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Operation breakdown */}
      {Object.keys(cm.byOperation).length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-gray-700 mb-2">今月の内訳（機能別）</h2>
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">機能</th>
                  <th className="text-right px-3 py-2">コスト</th>
                  <th className="text-right px-3 py-2">コール数</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(cm.byOperation)
                  .sort(([, a], [, b]) => b.cost - a.cost)
                  .map(([op, b]) => (
                    <tr key={op} className="border-t border-gray-100">
                      <td className="px-3 py-2">{OP_LABEL[op] || op}</td>
                      <td className="text-right px-3 py-2">{usd(b.cost)}</td>
                      <td className="text-right px-3 py-2 text-gray-600">{b.calls}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Monthly trend */}
      {data.monthly.length > 1 && (
        <section>
          <h2 className="text-sm font-medium text-gray-700 mb-2">月別推移</h2>
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">月</th>
                  <th className="text-right px-3 py-2">合計</th>
                  <th className="text-right px-3 py-2">コール数</th>
                  <th className="text-right px-3 py-2">前月比</th>
                </tr>
              </thead>
              <tbody>
                {data.monthly.map((m, i) => {
                  const prev = data.monthly[i + 1];
                  const delta = prev ? m.totalUsd - prev.totalUsd : 0;
                  const pct = prev && prev.totalUsd > 0 ? (delta / prev.totalUsd) * 100 : 0;
                  return (
                    <tr key={m.month} className="border-t border-gray-100">
                      <td className="px-3 py-2">{m.month}</td>
                      <td className="text-right px-3 py-2 font-medium">{usd(m.totalUsd)}</td>
                      <td className="text-right px-3 py-2 text-gray-600">{m.totalCalls}</td>
                      <td className={`text-right px-3 py-2 text-xs ${delta > 0 ? "text-red-500" : delta < 0 ? "text-green-600" : "text-gray-400"}`}>
                        {prev ? `${delta > 0 ? "+" : ""}${usd(delta)} (${pct > 0 ? "+" : ""}${pct.toFixed(0)}%)` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Pinecone */}
      <section>
        <h2 className="text-sm font-medium text-gray-700 mb-2">Pinecone（ベクターDB）</h2>
        {data.pinecone ? (
          <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-gray-500">インデックス名:</span> <span className="font-mono text-xs">{data.pinecone.indexName}</span></div>
              <div><span className="text-gray-500">ベクター次元:</span> {data.pinecone.dimension}</div>
              <div><span className="text-gray-500">ベクター数:</span> {data.pinecone.vectorCount.toLocaleString()}</div>
              <div><span className="text-gray-500">インデックスサイズ(概算):</span> {fmtBytes(data.pinecone.indexSizeBytes)}</div>
              <div className="col-span-2">
                <span className="text-gray-500">月額概算(storageのみ):</span>{" "}
                <span className="font-medium">{usd(data.pinecone.estimatedMonthlyUsd)}</span>
                <span className="text-xs text-gray-400 ml-2">/ {jpy(data.pinecone.estimatedMonthlyUsd)}</span>
              </div>
            </div>
            <div className="text-[10px] text-gray-400 mt-2">{data.pinecone.note}</div>
          </div>
        ) : (
          <div className="text-xs text-gray-400 py-2">Pinecone 未設定 or 接続エラー</div>
        )}
      </section>

      {/* Recent calls */}
      {data.recentCalls.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-gray-700 mb-2">最近のAPIコール (最新20件)</h2>
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden text-xs">
            <table className="w-full">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-3 py-1.5">日時</th>
                  <th className="text-left px-3 py-1.5">機能</th>
                  <th className="text-left px-3 py-1.5">モデル</th>
                  <th className="text-right px-3 py-1.5">入力</th>
                  <th className="text-right px-3 py-1.5">出力</th>
                  <th className="text-right px-3 py-1.5">音声</th>
                  <th className="text-right px-3 py-1.5">コスト</th>
                </tr>
              </thead>
              <tbody>
                {data.recentCalls.map((c, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-3 py-1 text-gray-500">{c.created_at.slice(5, 16).replace("T", " ")}</td>
                    <td className="px-3 py-1">{OP_LABEL[`${c.provider}:${c.operation}`] || `${c.provider}/${c.operation}`}</td>
                    <td className="px-3 py-1 text-gray-500 font-mono text-[10px]">{c.model || "—"}</td>
                    <td className="text-right px-3 py-1 text-gray-500">{c.input_tokens || "—"}</td>
                    <td className="text-right px-3 py-1 text-gray-500">{c.output_tokens || "—"}</td>
                    <td className="text-right px-3 py-1 text-gray-500">{c.audio_seconds > 0 ? fmtDuration(c.audio_seconds) : "—"}</td>
                    <td className="text-right px-3 py-1 font-medium">{usd(c.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="text-[10px] text-gray-400 border-t border-gray-100 pt-3">
        <div>※ 表示は概算値です。JPY換算は 1 USD ≒ ¥150 で計算しています。</div>
        <div>※ Gemini のプレビュー版は価格変動の可能性があります。正確な請求額は Google Cloud Console で確認してください。</div>
        <div>※ Pinecone のストレージ料金は概算値で、実際のサブスクプランによって変動します。</div>
      </div>
    </div>
  );
}

function Card({ title, primary, sub, highlight }: { title: string; primary: string; sub: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? "border-theme-300 bg-theme-50" : "border-gray-200 bg-white"}`}>
      <div className="text-xs text-gray-500">{title}</div>
      <div className={`text-2xl font-semibold mt-0.5 ${highlight ? "text-theme-700" : "text-gray-800"}`}>{primary}</div>
      <div className="text-[11px] text-gray-500 mt-1">{sub}</div>
    </div>
  );
}
