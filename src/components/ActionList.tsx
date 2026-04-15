"use client";

import { useState, useEffect, useCallback } from "react";
import { MarkdownContent, PageInfo, TagInfo } from "./BlockEditor";

interface ActionBlock {
  id: string;
  content: string;
  indent_level: number;
  sort_order: number;
  date: string;
  page_id?: string | null;
  linkedPages?: { id: string; name: string }[];
  children: { id: string; content: string; indent_level: number; sort_order: number; date: string }[];
}

interface Props {
  pageId?: string;
  allPages: PageInfo[];
  allTags: TagInfo[];
  onPageClick: (id: string, name: string) => void;
  onTagClick: (id: string, name: string) => void;
  onDateClick: (date: string) => void;
  onActionChange?: () => void;
  actionVersion?: number;
}

export default function ActionList({ pageId, allPages, allTags, onPageClick, onTagClick, onDateClick, onActionChange, actionVersion }: Props) {
  const [actions, setActions] = useState<ActionBlock[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(false);

  const fetchActions = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (pageId) params.set("pageId", pageId);
    if (showCompleted) params.set("includeCompleted", "true");
    const res = await fetch(`/api/actions?${params}`);
    if (res.ok) setActions(await res.json());
    setLoading(false);
  }, [pageId, showCompleted]);

  useEffect(() => { fetchActions(); }, [fetchActions, actionVersion]);

  // Listen for actions-changed event from BlockEditor
  useEffect(() => {
    const handler = () => fetchActions();
    window.addEventListener("actions-changed", handler);
    return () => window.removeEventListener("actions-changed", handler);
  }, [fetchActions]);

  const toggleAction = async (action: ActionBlock) => {
    const isDone = /^!done\s/i.test(action.content);
    const newContent = isDone
      ? action.content.replace(/^!done\s/i, "!action ")
      : action.content.replace(/^!action\s/i, "!done ");
    await fetch("/api/actions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockId: action.id, content: newContent }),
    });
    fetchActions();
    if (onActionChange) onActionChange();
  };

  // Group by date
  const grouped: Record<string, ActionBlock[]> = {};
  for (const action of actions) {
    const key = action.date || "日付なし";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(action);
  }

  const compact = !!pageId; // compact mode for sidebar

  return (
    <div className={compact ? "" : "mx-auto max-w-3xl"}>
      <div className="flex items-center gap-2 mb-3">
        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            className="rounded border-gray-300"
          />
          完了済みも表示
        </label>
        <span className="text-xs text-gray-400">{actions.length}件</span>
      </div>

      {loading ? (
        <div className="text-sm text-gray-400 py-4">読み込み中...</div>
      ) : actions.length === 0 ? (
        <div className="text-sm text-gray-400 py-4">
          {showCompleted ? "アクションはありません" : "未完了のアクションはありません"}
        </div>
      ) : (
        Object.entries(grouped).map(([date, dateActions]) => (
          <div key={date} className="mb-4">
            <div
              className="text-xs font-medium text-gray-500 mb-1.5 cursor-pointer hover:text-blue-600"
              onClick={() => date !== "日付なし" && onDateClick(date)}
            >
              {date}
            </div>
            <div className="space-y-1">
              {dateActions.map((action) => {
                const isDone = /^!done\s/i.test(action.content);
                const displayContent = action.content.replace(/^!(action|done)\s/i, "");
                return (
                  <div key={action.id} className={`rounded border ${isDone ? "border-green-200 bg-green-50/50" : "border-amber-200 bg-amber-50/50"} p-2`}>
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={isDone}
                        onChange={() => toggleAction(action)}
                        className="mt-0.5 rounded border-gray-300 cursor-pointer"
                      />
                      <div
                        className={`flex-1 text-sm cursor-pointer ${isDone ? "line-through text-gray-400" : ""}`}
                        onClick={() => {
                          if (action.page_id) {
                            const page = allPages.find((p) => p.id === action.page_id);
                            if (page) onPageClick(page.id, page.full_path || page.name);
                          } else if (action.date) {
                            onDateClick(action.date);
                          }
                        }}
                      >
                        <MarkdownContent
                          content={displayContent}
                          allPages={allPages}
                          allTags={allTags}
                          onPageClick={onPageClick}
                          onTagClick={onTagClick}
                          onDateClick={onDateClick}
                        />
                      </div>
                    </div>
                    {action.children.length > 0 && (
                      <div className="ml-6 mt-1 space-y-0.5">
                        {action.children.map((child) => (
                          <div key={child.id} className="text-xs text-gray-500">
                            <MarkdownContent
                              content={child.content}
                              allPages={allPages}
                              allTags={allTags}
                              onPageClick={onPageClick}
                              onTagClick={onTagClick}
                              onDateClick={onDateClick}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                    {action.linkedPages && action.linkedPages.length > 0 && (
                      <div className="ml-6 mt-1 flex flex-wrap gap-1">
                        {action.linkedPages.map((p) => (
                          <span
                            key={p.id}
                            className="page-link text-xs cursor-pointer"
                            onClick={() => onPageClick(p.id, p.name)}
                          >
                            {p.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
