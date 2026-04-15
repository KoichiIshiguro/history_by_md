"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
}

interface Thread {
  id: string;
  title: string;
  message_count: number;
  updated_at: string;
}

export default function AiChat() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showThreadList, setShowThreadList] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load threads on mount
  useEffect(() => {
    fetchThreads();
  }, []);

  const fetchThreads = async () => {
    const res = await fetch("/api/ai/threads");
    if (res.ok) setThreads(await res.json());
  };

  const loadThread = async (threadId: string) => {
    const res = await fetch(`/api/ai/threads?threadId=${threadId}`);
    if (res.ok) {
      const data = await res.json();
      setMessages(data.messages.map((m: any) => ({ id: m.id, role: m.role, content: m.content })));
      setActiveThreadId(threadId);
      setShowThreadList(false);
    }
  };

  const startNewThread = () => {
    setActiveThreadId(null);
    setMessages([]);
    setShowThreadList(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const deleteThread = async (threadId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch("/api/ai/threads", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId }),
    });
    if (activeThreadId === threadId) {
      setActiveThreadId(null);
      setMessages([]);
    }
    fetchThreads();
  };

  const saveMessage = async (threadId: string, role: string, content: string) => {
    await fetch("/api/ai/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, role, content }),
    });
  };

  const handleSync = useCallback(async () => {
    setIsSyncing(true);
    setSyncStatus("ベクトル同期中...");
    try {
      const res = await fetch("/api/ai/sync", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        setSyncStatus(`エラー: ${err.error}`);
        return;
      }
      const data = await res.json();
      const parts = [];
      if (data.embedded > 0) parts.push(`${data.embedded}チャンク埋め込み`);
      if (data.deleted > 0) parts.push(`${data.deleted}ブロック削除`);
      if (data.errors?.length > 0) parts.push(`${data.errors.length}件エラー`);
      if (data.errors?.length > 0) console.error("AI sync errors:", data.errors);
      setSyncStatus(parts.length > 0 ? `完了: ${parts.join(", ")}` : "変更なし");
    } catch (e: any) {
      setSyncStatus(`エラー: ${e.message}`);
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncStatus(null), 5000);
    }
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    // Create thread if new
    let threadId = activeThreadId;
    if (!threadId) {
      const res = await fetch("/api/ai/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: text.slice(0, 50) }),
      });
      if (!res.ok) return;
      const data = await res.json();
      threadId = data.id;
      setActiveThreadId(threadId);
    }

    // Save user message
    await saveMessage(threadId!, "user", text);

    const userMessage: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    const assistantMessage: Message = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMessage]);

    let accumulated = "";
    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: messages.slice(-6),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        const errMsg = `エラー: ${err.error}`;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: errMsg };
          return updated;
        });
        await saveMessage(threadId!, "assistant", errMsg);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: accumulated };
          return updated;
        });
      }

      // Save assistant response
      if (accumulated) {
        await saveMessage(threadId!, "assistant", accumulated);
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
        const content = accumulated || "（キャンセルされました）";
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content };
          return updated;
        });
        if (accumulated) await saveMessage(threadId!, "assistant", accumulated);
      } else {
        const errMsg = `エラー: ${e.message}`;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: errMsg };
          return updated;
        });
        await saveMessage(threadId!, "assistant", errMsg);
      }
    } finally {
      setIsLoading(false);
      abortRef.current = null;
      fetchThreads();
    }
  }, [input, isLoading, messages, activeThreadId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  // Format relative time
  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr + "Z");
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "今";
    if (diffMin < 60) return `${diffMin}分前`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour}時間前`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 7) return `${diffDay}日前`;
    return d.toLocaleDateString("ja-JP", { month: "short", day: "numeric" });
  };

  // Thread list view
  if (showThreadList) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-theme-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            <h2 className="text-lg font-semibold text-gray-800">AIチャット</h2>
          </div>
          <div className="flex items-center gap-2">
            {syncStatus && (
              <span className={`text-xs px-2 py-1 rounded ${isSyncing ? "bg-yellow-100 text-yellow-700" : syncStatus.startsWith("エラー") ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                {syncStatus}
              </span>
            )}
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg bg-theme-100 text-theme-700 hover:bg-theme-200 disabled:opacity-50 transition"
              title="ノートのベクトル同期を実行"
            >
              <svg className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              AI同期
            </button>
          </div>
        </div>

        <button
          onClick={startNewThread}
          className="w-full mb-4 flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-theme-300 text-theme-600 hover:bg-theme-50 transition text-sm font-medium"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          新しいチャット
        </button>

        {threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 gap-3">
            <svg className="h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <p className="text-sm">まだチャット履歴がありません</p>
            <p className="text-xs text-gray-300">「新しいチャット」で会話を始めましょう</p>
          </div>
        ) : (
          <div className="space-y-2">
            {threads.map((thread) => (
              <div
                key={thread.id}
                onClick={() => loadThread(thread.id)}
                className="flex items-center justify-between p-3 rounded-xl border border-gray-200 hover:border-theme-300 hover:bg-theme-50/50 cursor-pointer transition group"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{thread.title || "無題"}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {thread.message_count}メッセージ &middot; {formatTime(thread.updated_at)}
                  </p>
                </div>
                <button
                  onClick={(e) => deleteThread(thread.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Chat view
  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowThreadList(true); fetchThreads(); }}
            className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition"
            title="スレッド一覧に戻る"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h2 className="text-sm font-medium text-gray-600 truncate">
            {activeThreadId ? threads.find(t => t.id === activeThreadId)?.title || "チャット" : "新しいチャット"}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {syncStatus && (
            <span className={`text-xs px-2 py-1 rounded ${isSyncing ? "bg-yellow-100 text-yellow-700" : syncStatus.startsWith("エラー") ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
              {syncStatus}
            </span>
          )}
          <button
            onClick={handleSync}
            disabled={isSyncing}
            className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg bg-theme-100 text-theme-700 hover:bg-theme-200 disabled:opacity-50 transition"
            title="ノートのベクトル同期を実行"
          >
            <svg className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            AI同期
          </button>
          <button
            onClick={startNewThread}
            className="px-3 py-1.5 text-sm rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition"
          >
            新規
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto space-y-4 mb-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
            <svg className="h-12 w-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <p className="text-sm">ノートについて質問してみましょう</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-theme-100 flex items-center justify-center mr-2 mt-1">
                <svg className="h-4 w-4 text-theme-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
            )}
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                msg.role === "user"
                  ? "bg-theme-500 text-white"
                  : "bg-gray-100 text-gray-800"
              }`}
            >
              {msg.content ? (
                msg.role === "assistant" ? (
                  <div className="ai-response prose prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <span className="whitespace-pre-wrap">{msg.content}</span>
                )
              ) : (
                <span className="inline-flex gap-1">
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 pt-3">
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ノートについて質問..."
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:border-theme-400 focus:ring-1 focus:ring-theme-400"
            style={{ minHeight: "42px", maxHeight: "120px" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = Math.min(el.scrollHeight, 120) + "px";
            }}
          />
          {isLoading ? (
            <button
              onClick={() => abortRef.current?.abort()}
              className="px-4 py-2 rounded-xl bg-red-500 text-white text-sm hover:bg-red-600 transition flex-shrink-0"
            >
              停止
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="px-4 py-2 rounded-xl bg-theme-500 text-white text-sm hover:bg-theme-600 disabled:opacity-50 transition flex-shrink-0"
            >
              送信
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
