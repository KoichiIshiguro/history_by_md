"use client";

interface Tag {
  id: string;
  name: string;
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
}: Props) {
  return (
    <div className="flex h-full flex-col">
      {/* User info */}
      <div className="border-b border-gray-200 p-3">
        <div className="flex items-center gap-2">
          {user.image && (
            <img
              src={user.image}
              alt=""
              className="h-8 w-8 rounded-full"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-800">
              {user.name}
            </p>
            <p className="truncate text-xs text-gray-500">{user.email}</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {/* Admin link */}
        {isAdmin && (
          <div className="border-b border-gray-200 p-2">
            <button
              onClick={onSelectAdmin}
              className={`w-full rounded px-3 py-1.5 text-left text-sm ${
                viewMode === "admin"
                  ? "bg-blue-100 text-blue-700"
                  : "text-gray-600 hover:bg-gray-100"
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
            onClick={() => onSelectDate(new Date().toISOString().split("T")[0])}
            className={`w-full rounded px-3 py-1.5 text-left text-sm ${
              viewMode === "date" &&
              selectedDate === new Date().toISOString().split("T")[0]
                ? "bg-orange-100 text-orange-700"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            今日
          </button>
          {dates.map((date) => (
            <button
              key={date}
              onClick={() => onSelectDate(date)}
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
          <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            タグ
          </h3>
          {tags.length === 0 && (
            <p className="px-3 text-xs text-gray-400">タグなし</p>
          )}
          {tags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => onSelectTag(tag.id, tag.name)}
              className={`w-full rounded px-3 py-1.5 text-left text-sm ${
                viewMode === "tag" && selectedTagId === tag.id
                  ? "bg-blue-100 text-blue-700"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              <span className="tag-inline">{tag.name}</span>
              <span className="ml-2 text-xs text-gray-400">
                {tag.block_count}
              </span>
            </button>
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
