"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { MarkdownContent, PageInfo, TagInfo } from "./BlockEditor";
import GanttView from "./GanttView";
import CalendarView, { Slot, BusySlot, CalendarSidebar } from "./CalendarView";

export interface ActionBlock {
  id: string;
  content: string;
  indent_level: number;
  sort_order: number;
  date: string;
  page_id?: string | null;
  due_start?: string | null;
  due_end?: string | null;
  linkedPages?: { id: string; name: string }[];
  children: { id: string; content: string; indent_level: number; sort_order: number; date: string }[];
}

export interface ActionGroup {
  key: string;
  label: string;
  isPage: boolean;
  pageId: string;
  actions: ActionBlock[];
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
  /** Lifted tab state. If provided, controls which tab is shown and notifies on change. */
  activeTab?: "list" | "gantt" | "schedule";
  onTabChange?: (tab: "list" | "gantt" | "schedule") => void;
}

/**
 * Group actions: page_id or linkedPages → page group; else → date group.
 * Returns groups sorted: date groups (desc) first, then pages (alphabetical).
 */
export function groupActions(actions: ActionBlock[], allPages: PageInfo[]): ActionGroup[] {
  const grouped: Record<string, ActionGroup> = {};
  for (const action of actions) {
    let pid: string | null = null;
    let pname: string | null = null;
    if (action.page_id) {
      pid = action.page_id;
      const page = allPages.find((p) => p.id === pid);
      pname = page?.full_path || page?.name || "不明なページ";
    } else if (action.linkedPages && action.linkedPages.length > 0) {
      pid = action.linkedPages[0].id;
      const page = allPages.find((p) => p.id === pid);
      pname = page?.full_path || action.linkedPages[0].name;
    }
    if (pid) {
      const key = `page:${pid}`;
      if (!grouped[key]) grouped[key] = { key, label: pname!, isPage: true, pageId: pid, actions: [] };
      grouped[key].actions.push(action);
    } else {
      const key = action.date || "日付なし";
      if (!grouped[key]) grouped[key] = { key, label: key, isPage: false, pageId: "", actions: [] };
      grouped[key].actions.push(action);
    }
  }
  // Earliest unfinished due_end in a group. Groups with no unfinished
  // deadline (everything done, or no deadlines) sort to the bottom.
  const urgencyKey = (g: ActionGroup): string => {
    let best: string | null = null;
    for (const a of g.actions) {
      if (/^!done/i.test(a.content)) continue;
      if (!a.due_end) continue;
      if (best === null || a.due_end < best) best = a.due_end;
    }
    return best ?? "9999-12-31";
  };

  return Object.values(grouped).sort((a, b) => {
    const ka = urgencyKey(a), kb = urgencyKey(b);
    if (ka !== kb) return ka.localeCompare(kb);
    // Stable tie-break: date groups by date desc, pages alphabetical
    if (!a.isPage && !b.isPage) return b.label.localeCompare(a.label);
    if (a.isPage && b.isPage) return a.label.localeCompare(b.label);
    return 0;
  });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Return Tailwind color classes for a due date relative to today. */
export function dueColor(dueEnd: string | null | undefined, isDone: boolean): string {
  if (isDone) return "text-gray-400";
  if (!dueEnd) return "text-gray-500";
  const today = todayStr();
  if (dueEnd < today) return "text-red-600";
  if (dueEnd === today) return "text-orange-600";
  return "text-gray-500";
}

/** Format a due range as a compact pill string: "4/29" or "4/17-29" or "4/17-5/1" or "2026/12/28-2027/1/5" */
export function formatDuePill(dueStart: string | null | undefined, dueEnd: string | null | undefined): string {
  if (!dueStart || !dueEnd) return "";
  const [sy, sm, sd] = dueStart.split("-").map((n) => parseInt(n, 10));
  const [ey, em, ed] = dueEnd.split("-").map((n) => parseInt(n, 10));
  const thisYear = new Date().getFullYear();
  const omitStartYear = sy === thisYear;
  const startFmt = omitStartYear ? `${sm}/${sd}` : `${sy}/${sm}/${sd}`;
  if (dueStart === dueEnd) return startFmt;
  if (sy === ey && sm === em) return `${startFmt}-${ed}`;
  if (sy === ey) return `${startFmt}-${em}/${ed}`;
  const endFmt = `${ey}/${em}/${ed}`;
  return omitStartYear ? `${sy}/${sm}/${sd}-${endFmt}` : `${startFmt}-${endFmt}`;
}

export default function ActionList({ pageId, allPages, allTags, onPageClick, onTagClick, onDateClick, onActionChange, actionVersion, activeTab, onTabChange }: Props) {
  const [actions, setActions] = useState<ActionBlock[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [internalTab, setInternalTab] = useState<"list" | "gantt" | "schedule">("list");
  const tab = activeTab ?? internalTab;
  const setTab = (t: "list" | "gantt" | "schedule") => {
    setInternalTab(t);
    onTabChange?.(t);
  };
  const [busySlots, setBusySlots] = useState<BusySlot[]>([]);

  // Calendar-related state
  const sundayOf = (d: Date) => {
    const r = new Date(d); r.setHours(0, 0, 0, 0); r.setDate(r.getDate() - r.getDay()); return r;
  };
  const [weekStart, setWeekStart] = useState<Date>(() => sundayOf(new Date()));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [latestByAction, setLatestByAction] = useState<Record<string, string>>({});

  const fetchActions = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (pageId) params.set("pageId", pageId);
    if (showCompleted) params.set("includeCompleted", "true");
    const res = await fetch(`/api/actions?${params}`);
    if (res.ok) setActions(await res.json());
    setLoading(false);
  }, [pageId, showCompleted]);

  const fetchSlots = useCallback(async () => {
    try {
      const fromD = new Date(weekStart); fromD.setDate(fromD.getDate() - 7);
      const toD = new Date(weekStart); toD.setDate(toD.getDate() + 21);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const res = await fetch(`/api/action-slots?from=${iso(fromD)}&to=${iso(toD)}`);
      if (res.ok) {
        const data = await res.json() as { slots: Slot[]; latestByAction: Record<string, string> };
        setSlots(data.slots || []);
        setLatestByAction(data.latestByAction || {});
      }
    } catch { /* silent */ }
  }, [weekStart]);

  const fetchBusySlots = useCallback(async () => {
    try {
      const fromD = new Date(weekStart); fromD.setDate(fromD.getDate() - 7);
      const toD = new Date(weekStart); toD.setDate(toD.getDate() + 21);
      const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const res = await fetch(`/api/busy-slots?from=${iso(fromD)}&to=${iso(toD)}`);
      if (res.ok) {
        const data = await res.json() as { busySlots: BusySlot[] };
        setBusySlots(data.busySlots || []);
      }
    } catch { /* silent */ }
  }, [weekStart]);

  useEffect(() => { fetchActions(); }, [fetchActions, actionVersion]);
  useEffect(() => { fetchSlots(); }, [fetchSlots, actionVersion]);
  useEffect(() => { fetchBusySlots(); }, [fetchBusySlots, actionVersion]);

  useEffect(() => {
    const handler = () => { fetchActions(); fetchSlots(); fetchBusySlots(); };
    window.addEventListener("actions-changed", handler);
    return () => window.removeEventListener("actions-changed", handler);
  }, [fetchActions, fetchSlots, fetchBusySlots]);

  // Unscheduled set: unfinished + latest slot end is in the past or absent
  const unscheduledActionIds = useMemo(() => {
    const now = new Date();
    const s = new Set<string>();
    for (const a of actions) {
      if (/^!done/i.test(a.content)) continue;
      const latest = latestByAction[a.id];
      if (!latest || new Date(latest.replace(" ", "T")) <= now) s.add(a.id);
    }
    return s;
  }, [actions, latestByAction]);

  const toggleAction = async (action: ActionBlock) => {
    const isDone = /^!done/i.test(action.content);
    const newContent = isDone
      ? action.content.replace(/^!done/i, "!action")
      : action.content.replace(/^!action/i, "!done");
    await fetch("/api/actions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockId: action.id, content: newContent }),
    });
    // Refresh actions + slots; slots carry baked-in content via a JOIN
    // so they need a re-fetch to reflect the new !action ↔ !done state.
    fetchActions();
    fetchSlots();
    if (onActionChange) onActionChange();
  };

  const compact = !!pageId;
  const sortedGroups = groupActions(actions, allPages);

  // Strip "!action" / "!done" prefix and optional @-spec for display
  const displayContent = (content: string) => content.replace(/^!(action|done)(@\S+)?\s+/i, "");

  return (
    <div className={compact ? "" : "mx-auto max-w-5xl"}>
      {/* Tabs + filters */}
      <div className="flex items-center gap-3 mb-3 border-b border-gray-200">
        {!compact && (
          <div className="flex">
            <button
              onClick={() => setTab("list")}
              className={`px-3 py-1.5 text-sm border-b-2 transition ${tab === "list" ? "border-theme-500 text-theme-600 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"}`}
            >
              一覧
            </button>
            <button
              onClick={() => setTab("gantt")}
              className={`px-3 py-1.5 text-sm border-b-2 transition ${tab === "gantt" ? "border-theme-500 text-theme-600 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"}`}
            >
              ガント
            </button>
            <button
              onClick={() => setTab("schedule")}
              className={`px-3 py-1.5 text-sm border-b-2 transition ${tab === "schedule" ? "border-theme-500 text-theme-600 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"}`}
            >
              実施時間管理
            </button>
          </div>
        )}
        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none ml-auto pb-1">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            className="rounded border-gray-300"
          />
          完了済みも表示
        </label>
        <span className="text-xs text-gray-400 pb-1">{actions.length}件</span>
      </div>

      {loading ? (
        <div className="text-sm text-gray-400 py-4">読み込み中...</div>
      ) : tab === "schedule" && !compact ? (
        // Schedule tab renders the calendar even when there are no actions —
        // the sidebar will show "未完了のアクションはありません" instead.
        <>
          <CalendarView
            slots={(() => {
              if (showCompleted) return slots;
              const liveIds = new Set(actions.map((a) => a.id));
              return slots.filter((s) => liveIds.has(s.action_block_id));
            })()}
            busySlots={busySlots}
            actions={actions}
            weekStart={weekStart}
            setWeekStart={setWeekStart}
            onSlotChange={() => { fetchSlots(); fetchActions(); }}
            onBusyChange={() => { fetchBusySlots(); }}
            onToggleDone={toggleAction}
            onOpenAction={(action) => {
              if (action.page_id) {
                const p = allPages.find((pp) => pp.id === action.page_id);
                if (p) onPageClick(p.id, p.full_path || p.name);
              } else if (action.date) {
                onDateClick(action.date);
              }
            }}
          />
          <CalendarSidebarPortal
            actions={actions}
            latestByAction={latestByAction}
            onToggleDone={toggleAction}
          />
        </>
      ) : actions.length === 0 ? (
        <div className="text-sm text-gray-400 py-4">
          {showCompleted ? "アクションはありません" : "未完了のアクションはありません"}
        </div>
      ) : tab === "gantt" && !compact ? (
        <GanttView
          groups={sortedGroups}
          allPages={allPages}
          unscheduledActionIds={unscheduledActionIds}
          onPageClick={onPageClick}
          onDateClick={onDateClick}
          onActionChange={() => { fetchActions(); if (onActionChange) onActionChange(); }}
          onToggleDone={toggleAction}
        />
      ) : (
        sortedGroups.map((group) => (
          <div key={group.key} className="mb-4">
            <div
              className="text-xs font-medium text-gray-500 mb-1.5 cursor-pointer hover:text-blue-600"
              onClick={() => {
                if (group.isPage) onPageClick(group.pageId, group.label);
                else if (group.label !== "日付なし") onDateClick(group.label);
              }}
            >
              {group.isPage ? <span className="page-link">{group.label}</span> : group.label}
            </div>
            <div className="space-y-1">
              {group.actions.map((action) => {
                const isDone = /^!done/i.test(action.content);
                const pillText = formatDuePill(action.due_start, action.due_end);
                const pillColor = dueColor(action.due_end, isDone);
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
                        {pillText && (
                          <span className={`inline-flex items-center gap-1 mr-2 rounded bg-white/70 border border-current/20 px-1.5 py-0.5 text-xs font-medium ${pillColor}`}>
                            📅 {pillText}
                          </span>
                        )}
                        <MarkdownContent
                          content={displayContent(action.content)}
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

/**
 * Renders CalendarSidebar via a React Portal into the DOM node provided by
 * MainApp (id="calendar-sidebar-mount"). This lets the schedule-tab sidebar
 * appear in the app's right sidebar area — visually consistent with the
 * page-view ActionList sidebar — while keeping its data/state colocated
 * with this component.
 */
function CalendarSidebarPortal(props: { actions: ActionBlock[]; latestByAction: Record<string, string>; onToggleDone: (a: ActionBlock) => void }) {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => setMount(document.getElementById("calendar-sidebar-mount"));
    find();
    // In case the mount div is rendered asynchronously
    const id = setTimeout(find, 0);
    return () => clearTimeout(id);
  }, []);
  if (!mount) return null;
  return createPortal(<CalendarSidebar {...props} />, mount);
}
