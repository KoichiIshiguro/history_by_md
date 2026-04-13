"use client";

import { useState, useRef, useEffect } from "react";

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

type TagTreeNode = Tag & { children: TagTreeNode[] };

function buildTagTree(tags: Tag[]): TagTreeNode[] {
  const map = new Map<string, TagTreeNode>();
  const roots: TagTreeNode[] = [];

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
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [addingChildOf, setAddingChildOf] = useState<string | null>(null); // null = root, tag id = child

  const tagTree = buildTagTree(tags);

  const requestDeleteTag = (tagId: string, tagName: string) => {
    setDeleteTarget({ id: tagId, name: tagName });
  };

  const confirmDeleteTag = async () => {
    if (!deleteTarget) return;
    const res = await fetch("/api/tags", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: deleteTarget.id }),
    });
    if (res.ok) onTagsChange();
    setDeleteTarget(null);
  };

  const toggleExpand = (tagId: string) => {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };

  const createTag = async (name: string, parentId: string | null) => {
    if (!name.trim()) return;
    const res = await fetch("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), parent_id: parentId }),
    });
    if (res.ok) {
      // Auto-expand parent
      if (parentId) {
        setExpandedTags((prev) => new Set(prev).add(parentId));
      }
      onTagsChange();
    }
    setAddingChildOf(null);
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

        {/* Pages (Tags) */}
        <div className="p-2">
          <div className="mb-1 flex items-center justify-between px-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              ページ
            </h3>
            <button
              onClick={() => setAddingChildOf(addingChildOf === "__root__" ? null : "__root__")}
              className="text-gray-400 hover:text-gray-600"
              title="新しいページ"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          {/* Inline add at root */}
          {addingChildOf === "__root__" && (
            <InlineTagInput
              depth={0}
              onSubmit={(name) => createTag(name, null)}
              onCancel={() => setAddingChildOf(null)}
            />
          )}

          {tags.length === 0 && addingChildOf !== "__root__" && (
            <p className="px-3 py-2 text-xs text-gray-400">ページなし</p>
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
              addingChildOf={addingChildOf}
              onToggleExpand={toggleExpand}
              onSelectTag={(id, name) => handleItemClick(() => onSelectTag(id, name))}
              onDeleteTag={requestDeleteTag}
              onAddChild={(parentId) => setAddingChildOf(addingChildOf === parentId ? null : parentId)}
              onCreateTag={createTag}
              onCancelAdd={() => setAddingChildOf(null)}
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

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDeleteTarget(null)}
          />
          <div className="relative mx-4 w-full max-w-xs animate-modal-in rounded-xl bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-50">
                <svg className="h-5 w-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900">ページを削除</h3>
                <p className="text-xs text-gray-500">この操作は取り消せません</p>
              </div>
            </div>
            <p className="mb-5 text-sm text-gray-600">
              <span className="tag-inline">{deleteTarget.name}</span> を削除しますか？
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                キャンセル
              </button>
              <button
                onClick={confirmDeleteTag}
                className="flex-1 rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-600"
              >
                削除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineTagInput({
  depth,
  onSubmit,
  onCancel,
}: {
  depth: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="flex items-center py-0.5"
      style={{ paddingLeft: `${8 + depth * 16}px` }}
    >
      <span className="mr-1 inline-block h-4 w-4 flex-shrink-0 text-center text-xs text-gray-300">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit(value);
          }
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          if (value.trim()) onSubmit(value);
          else onCancel();
        }}
        placeholder="ページ名..."
        className="flex-1 rounded border border-blue-300 bg-white px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-blue-400"
      />
    </div>
  );
}

function TagNode({
  tag,
  depth,
  selectedTagId,
  viewMode,
  expandedTags,
  addingChildOf,
  onToggleExpand,
  onSelectTag,
  onDeleteTag,
  onAddChild,
  onCreateTag,
  onCancelAdd,
}: {
  tag: TagTreeNode;
  depth: number;
  selectedTagId: string | null;
  viewMode: string;
  expandedTags: Set<string>;
  addingChildOf: string | null;
  onToggleExpand: (id: string) => void;
  onSelectTag: (id: string, name: string) => void;
  onDeleteTag: (id: string, name: string) => void;
  onAddChild: (parentId: string) => void;
  onCreateTag: (name: string, parentId: string | null) => void;
  onCancelAdd: () => void;
}) {
  const hasChildren = tag.children.length > 0;
  const isExpanded = expandedTags.has(tag.id);
  const isSelected = viewMode === "tag" && selectedTagId === tag.id;
  const isAddingHere = addingChildOf === tag.id;

  return (
    <div>
      <div
        className={`group/tag flex items-center rounded py-1 pr-1 text-sm ${
          isSelected ? "bg-blue-100 text-blue-700" : "text-gray-600 hover:bg-gray-100"
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {/* Expand/collapse toggle */}
        <button
          onClick={() => {
            if (hasChildren) onToggleExpand(tag.id);
          }}
          className={`mr-1 flex h-4 w-4 flex-shrink-0 items-center justify-center text-xs ${
            hasChildren ? "text-gray-400 hover:text-gray-600" : "text-transparent"
          }`}
        >
          {hasChildren ? (
            <svg
              className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`}
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg className="h-3.5 w-3.5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          )}
        </button>

        {/* Page name */}
        <button
          onClick={() => onSelectTag(tag.id, tag.name)}
          className="flex-1 text-left truncate"
        >
          {tag.name}
        </button>

        {/* Hover actions */}
        <div className="hidden items-center gap-0.5 group-hover/tag:flex">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAddChild(tag.id);
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600"
            title="サブページ追加"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeleteTag(tag.id, tag.name);
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-500"
            title="削除"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Children + inline add */}
      {(hasChildren && isExpanded || isAddingHere) && (
        <div>
          {hasChildren && isExpanded && tag.children.map((child) => (
            <TagNode
              key={child.id}
              tag={child}
              depth={depth + 1}
              selectedTagId={selectedTagId}
              viewMode={viewMode}
              expandedTags={expandedTags}
              addingChildOf={addingChildOf}
              onToggleExpand={onToggleExpand}
              onSelectTag={onSelectTag}
              onDeleteTag={onDeleteTag}
              onAddChild={onAddChild}
              onCreateTag={onCreateTag}
              onCancelAdd={onCancelAdd}
            />
          ))}
          {isAddingHere && (
            <InlineTagInput
              depth={depth + 1}
              onSubmit={(name) => onCreateTag(name, tag.id)}
              onCancel={onCancelAdd}
            />
          )}
        </div>
      )}
    </div>
  );
}
