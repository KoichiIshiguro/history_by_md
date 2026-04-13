"use client";

import { useState } from "react";

interface Tag {
  id: string;
  name: string;
  parent_id: string | null;
  block_count: number;
}

interface Props {
  user: { name?: string | null; email?: string | null; image?: string | null };
  isAdmin: boolean;
  tags: Tag[];
  dates: string[];
  selectedDate: string;
  selectedTagId: string | null;
  viewMode: string;
  onSelectDate: (date: string) => void;
  onSelectTag: (tagId: string, tagName: string) => void;
  onSelectAdmin: () => void;
  onSignOut: () => void;
  onTagsChange: () => void;
  onCloseMobile: () => void;
}

function buildTagTree(tags: Tag[]): (Tag & { children: Tag[] })[] {
  const map = new Map<string, Tag & { children: Tag[] }>();
  const roots: (Tag & { children: Tag[] })[] = [];

  for (const tag of tags) {
    map.set(tag.id, { ...tag, children: [] });
  }
  for (const tag of tags) {
    const node = map.get(tag.id)!;
    if (tag.parent_id && map.has(tag.parent_id)) {
      map.get(tag.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export default function Sidebar({
  user,
  isAdmin,
  tags,
  dates,
  selectedDate,
  selectedTagId,
  viewMode,
  onSelectDate,
  onSelectTag,
  onSelectAdmin,
  onSignOut,
  onTagsChange,
  onCloseMobile,
}: Props) {
  const [newTagName, setNewTagName] = useState("");
  const [newTagParent, setNewTagParent] = useState<string | null>(null);
  const [showTagForm, setShowTagForm] = useState(false);
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());

  const tagTree = buildTagTree(tags);

  const toggleExpand = (tagId: string) => {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };

  const createTag = async () => {
    if (!newTagName.trim()) return;
    const res = await fetch("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTagName.trim(), parent_id: newTagParent }),
    });
    if (res.ok) {
      setNewTagName("");
      setNewTagParent(null);
      setShowTagForm(false);
      onTagsChange();
    }
  };

  const handleItemClick = (action: () => void) => {
    action();
    onCloseMobile();
  };

  return (
    <div className="flex h-full flex-col">
      {/* User info */}
      <div className="border-b border-gray-200 p-3">
        <div className="flex items-center gap-2">
          {user.image && (
            <img src={user.image} alt="" className="h-8 w-8 rounded-full" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-800">{user.name}</p>
            <p className="truncate text-xs text-gray-500">{user.email}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {/* Admin link */}
        {isAdmin && (
          <div className="border-b border-gray-200 p-2">
            <button
              onClick={() => handleItemClick(onSelectAdmin)}
              className={`w-full rounded px-3 py-1.5 text-left text-sm ${
                viewMode === "admin" ? "bg-blue-100 text-blue-700" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              ⚙ ユーザー管理
            </button>
          </div>
        )}

        {/* Dates */}
        <div className="p-2">
          <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            日付
          </h3>
          <button
            onClick={() => handleItemClick(() => onSelectDate(new Date().toISOString().split("T")[0]))}
            className={`w-full rounded px-3 py-1.5 text-left text-sm ${
              viewMode === "date" && selectedDate === new Date().toISOString().split("T")[0]
                ? "bg-orange-100 text-orange-700"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            今日
          </button>
          {dates.map((date) => (
            <button
              key={date}
              onClick={() => handleItemClick(() => onSelectDate(date))}
              className={`w-full rounded px-3 py-1.5 text-left text-sm ${
                viewMode === "date" && selectedDate === date
                  ? "bg-orange-100 text-orange-700"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {date}
            </button>
          ))}
        </div>

        {/* Tags */}
        <div className="p-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              タグ / ページ
            </h3>
            <button
              onClick={() => setShowTagForm(!showTagForm)}
              className="text-xs text-blue-500 hover:text-blue-700"
            >
              + 新規
            </button>
          </div>

          {/* Tag creation form */}
          {showTagForm && (
            <div className="mb-2 rounded border border-gray-200 bg-white p-2">
              <input
                type="text"
                placeholder="タグ名"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) createTag();
                }}
                className="mb-1 w-full rounded border border-gray-200 px-2 py-1 text-sm"
                autoFocus
              />
              <select
                value={newTagParent || ""}
                onChange={(e) => setNewTagParent(e.target.value || null)}
                className="mb-1 w-full rounded border border-gray-200 px-2 py-1 text-xs text-gray-600"
              >
                <option value="">親タグなし (ルート)</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <div className="flex gap-1">
                <button
                  onClick={createTag}
                  className="rounded bg-blue-500 px-2 py-1 text-xs text-white hover:bg-blue-600"
                >
                  作成
                </button>
                <button
                  onClick={() => { setShowTagForm(false); setNewTagName(""); }}
                  className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
                >
                  キャンセル
                </button>
              </div>
            </div>
          )}

          {tags.length === 0 && !showTagForm && (
            <p className="px-3 text-xs text-gray-400">タグなし</p>
          )}

          {/* Tag tree */}
          {tagTree.map((tag) => (
            <TagNode
              key={tag.id}
              tag={tag}
              depth={0}
              selectedTagId={selectedTagId}
              viewMode={viewMode}
              expandedTags={expandedTags}
              onToggleExpand={toggleExpand}
              onSelectTag={(id, name) => handleItemClick(() => onSelectTag(id, name))}
            />
          ))}
        </div>
      </div>

      {/* Sign out */}
      <div className="border-t border-gray-200 p-2">
        <button
          onClick={onSignOut}
          className="w-full rounded px-3 py-1.5 text-left text-sm text-gray-500 hover:bg-gray-100"
        >
          ログアウト
        </button>
      </div>
    </div>
  );
}

function TagNode({
  tag,
  depth,
  selectedTagId,
  viewMode,
  expandedTags,
  onToggleExpand,
  onSelectTag,
}: {
  tag: { id: string; name: string; block_count: number; children: any[] };
  depth: number;
  selectedTagId: string | null;
  viewMode: string;
  expandedTags: Set<string>;
  onToggleExpand: (id: string) => void;
  onSelectTag: (id: string, name: string) => void;
}) {
  const hasChildren = tag.children.length > 0;
  const isExpanded = expandedTags.has(tag.id);
  const isSelected = viewMode === "tag" && selectedTagId === tag.id;

  return (
    <div>
      <div
        className={`flex items-center rounded py-1 text-sm ${
          isSelected ? "bg-blue-100 text-blue-700" : "text-gray-600 hover:bg-gray-100"
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {hasChildren ? (
          <button
            onClick={() => onToggleExpand(tag.id)}
            className="mr-1 flex h-4 w-4 flex-shrink-0 items-center justify-center text-xs text-gray-400"
          >
            {isExpanded ? "▼" : "▶"}
          </button>
        ) : (
          <span className="mr-1 inline-block h-4 w-4 flex-shrink-0" />
        )}
        <button
          onClick={() => onSelectTag(tag.id, tag.name)}
          className="flex-1 text-left truncate"
        >
          <span className="tag-inline text-xs">{tag.name}</span>
          <span className="ml-1 text-xs text-gray-400">{tag.block_count}</span>
        </button>
      </div>
      {hasChildren && isExpanded && (
        <div>
          {tag.children.map((child: any) => (
            <TagNode
              key={child.id}
              tag={child}
              depth={depth + 1}
              selectedTagId={selectedTagId}
              viewMode={viewMode}
              expandedTags={expandedTags}
              onToggleExpand={onToggleExpand}
              onSelectTag={onSelectTag}
            />
          ))}
        </div>
      )}
    </div>
  );
}
