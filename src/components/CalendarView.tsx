"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { ActionBlock, formatDuePill, dueColor } from "./ActionList";
import { PageInfo } from "./BlockEditor";

/**
 * Google Calendar-like weekly time-slot view.
 *
 * - 24-hour scrollable grid, Sunday-first week.
 * - 15-minute granularity on the slot grid.
 * - Slots are independent of Gantt due_start/due_end — a slot represents
 *   when the user plans to actually work on an action.
 * - Drag actions from the right sidebar onto a day column to create slots.
 * - Drag an existing slot body to move it; drag the top/bottom edge to resize.
 * - Overlap between slots is allowed (intentionally).
 * - Click a slot to navigate to its linked page (or its date page).
 */

export interface Slot {
  id: string;
  action_block_id: string;
  start_at: string; // ISO local, no tz suffix: "YYYY-MM-DDTHH:mm:ss"
  end_at: string;
  content?: string;
  page_id?: string | null;
  date?: string;
}

interface Props {
  slots: Slot[];
  latestByAction: Record<string, string>; // action_block_id → latest end_at
  actions: ActionBlock[]; // all unfinished actions for the sidebar
  allPages: PageInfo[];
  weekStart: Date; // the Sunday of the displayed week
  setWeekStart: (d: Date) => void;
  onSlotChange: () => void; // refetch trigger
  onToggleDone: (action: ActionBlock) => void;
  onOpenAction: (action: ActionBlock) => void; // navigate to linked page / date page
}

const HOUR_HEIGHT = 60; // px per hour
const MIN_STEP = 15;    // minute snap
const DAY_COUNT = 7;
const DEFAULT_DURATION_MIN = 60;

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseISO(s: string): Date {
  // "YYYY-MM-DDTHH:mm:ss" — treat as local
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return new Date(s);
  return new Date(
    parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
    parseInt(m[4], 10), parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : 0
  );
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function sundayOf(d: Date): Date {
  const r = startOfDay(d);
  const dow = r.getDay(); // 0 = Sun
  r.setDate(r.getDate() - dow);
  return r;
}

function fmtMonth(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}
function fmtDayHeader(d: Date): string {
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  return `${dayNames[d.getDay()]} ${d.getDate()}`;
}

function snapMinutes(m: number): number {
  return Math.round(m / MIN_STEP) * MIN_STEP;
}

function minutesFromTop(py: number): number {
  // py is px from the top of the day column body
  return snapMinutes(Math.max(0, Math.min(24 * 60 - MIN_STEP, py)));
}

type DragState =
  | null
  | { kind: "new"; actionBlockId: string; actionContent: string; ghostDay: number; ghostStartMin: number; ghostEndMin: number }
  | { kind: "move"; slotId: string; origStartMin: number; origEndMin: number; origDay: number; grabOffsetMin: number; curDay: number; curStartMin: number; curEndMin: number }
  | { kind: "resize"; slotId: string; edge: "top" | "bottom"; day: number; startMin: number; endMin: number };

export default function CalendarView({
  slots, latestByAction, actions, allPages, weekStart, setWeekStart,
  onSlotChange, onToggleDone, onOpenAction,
}: Props) {
  const weekEnd = useMemo(() => addDays(weekStart, DAY_COUNT), [weekStart]);
  const days = useMemo(() => {
    return Array.from({ length: DAY_COUNT }, (_, i) => addDays(weekStart, i));
  }, [weekStart]);

  // Slots in the current week only, bucketed by day index (0..6)
  const slotsByDay = useMemo(() => {
    const arr: Slot[][] = [[], [], [], [], [], [], []];
    for (const s of slots) {
      const d = parseISO(s.start_at);
      for (let i = 0; i < DAY_COUNT; i++) {
        const dayStart = days[i];
        const dayEnd = addDays(dayStart, 1);
        if (d >= dayStart && d < dayEnd) {
          arr[i].push(s);
          break;
        }
      }
    }
    return arr;
  }, [slots, days]);

  // ─── Sidebar classification ─────────────────────────────
  const now = new Date();
  const sidebarActions = useMemo(() => {
    // Only unfinished ("!action ..." or "!action@..."), not !done
    const unfinished = actions.filter((a) => !/^!done/i.test(a.content));
    const scheduled: ActionBlock[] = [];
    const unscheduled: ActionBlock[] = [];
    for (const a of unfinished) {
      const latest = latestByAction[a.id];
      if (latest && parseISO(latest) > now) scheduled.push(a);
      else unscheduled.push(a);
    }
    const byDueEnd = (x: ActionBlock, y: ActionBlock) => {
      const dx = x.due_end || "9999";
      const dy = y.due_end || "9999";
      return dx.localeCompare(dy);
    };
    scheduled.sort(byDueEnd);
    unscheduled.sort(byDueEnd);
    return { scheduled, unscheduled };
  }, [actions, latestByAction, now]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Scroll container; auto-scroll to 9:00 on mount ────
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 9 * HOUR_HEIGHT;
  }, []);

  // ─── Drag state ────────────────────────────────────────
  const [drag, setDrag] = useState<DragState>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Column x → day index, y → minutes from midnight
  const getMinutesFromPoint = (e: PointerEvent | React.PointerEvent): { day: number; minutes: number } | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const x = (e as PointerEvent).clientX - rect.left;
    const y = (e as PointerEvent).clientY - rect.top + grid.scrollTop;
    const colW = rect.width / DAY_COUNT;
    const day = Math.max(0, Math.min(DAY_COUNT - 1, Math.floor(x / colW)));
    const minutes = minutesFromTop((y / HOUR_HEIGHT) * 60);
    return { day, minutes };
  };

  // Global pointermove/pointerup for drag
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const pt = getMinutesFromPoint(e);
      if (!pt) return;
      if (drag.kind === "new") {
        const startMin = pt.minutes;
        setDrag({ ...drag, ghostDay: pt.day, ghostStartMin: startMin, ghostEndMin: Math.min(24 * 60, startMin + DEFAULT_DURATION_MIN) });
      } else if (drag.kind === "move") {
        const dur = drag.origEndMin - drag.origStartMin;
        const newStart = Math.max(0, Math.min(24 * 60 - dur, pt.minutes - drag.grabOffsetMin));
        setDrag({ ...drag, curDay: pt.day, curStartMin: snapMinutes(newStart), curEndMin: snapMinutes(newStart) + dur });
      } else if (drag.kind === "resize") {
        if (drag.edge === "top") {
          const newStart = Math.min(drag.endMin - MIN_STEP, Math.max(0, pt.minutes));
          setDrag({ ...drag, startMin: newStart });
        } else {
          const newEnd = Math.max(drag.startMin + MIN_STEP, Math.min(24 * 60, pt.minutes));
          setDrag({ ...drag, endMin: newEnd });
        }
      }
    };
    const onUp = async () => {
      if (!drag) return;
      try {
        if (drag.kind === "new") {
          if (drag.ghostEndMin > drag.ghostStartMin) {
            const dayDate = days[drag.ghostDay];
            const startAt = composeISO(dayDate, drag.ghostStartMin);
            const endAt = composeISO(dayDate, drag.ghostEndMin);
            await fetch("/api/action-slots", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action_block_id: drag.actionBlockId, start_at: startAt, end_at: endAt }),
            });
          }
        } else if (drag.kind === "move") {
          const dayDate = days[drag.curDay];
          const startAt = composeISO(dayDate, drag.curStartMin);
          const endAt = composeISO(dayDate, drag.curEndMin);
          await fetch(`/api/action-slots/${drag.slotId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ start_at: startAt, end_at: endAt }),
          });
        } else if (drag.kind === "resize") {
          const dayDate = days[drag.day];
          const startAt = composeISO(dayDate, drag.startMin);
          const endAt = composeISO(dayDate, drag.endMin);
          await fetch(`/api/action-slots/${drag.slotId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ start_at: startAt, end_at: endAt }),
          });
        }
      } catch { /* ignore */ }
      setDrag(null);
      onSlotChange();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  const handleSidebarPointerDown = (e: React.PointerEvent, action: ActionBlock) => {
    e.preventDefault();
    // Preview ghost starts at cursor over the first day column (arbitrary; will be replaced on first move)
    setDrag({
      kind: "new",
      actionBlockId: action.id,
      actionContent: action.content,
      ghostDay: 0, ghostStartMin: 9 * 60, ghostEndMin: 9 * 60 + DEFAULT_DURATION_MIN,
    });
  };

  const handleSlotPointerDown = (e: React.PointerEvent, slot: Slot, dayIdx: number) => {
    e.stopPropagation();
    const s = parseISO(slot.start_at);
    const en = parseISO(slot.end_at);
    const origStartMin = s.getHours() * 60 + s.getMinutes();
    const origEndMin = en.getHours() * 60 + en.getMinutes();
    const pt = getMinutesFromPoint(e);
    const grabOffsetMin = pt ? pt.minutes - origStartMin : 0;
    setDrag({
      kind: "move",
      slotId: slot.id,
      origStartMin, origEndMin, origDay: dayIdx,
      grabOffsetMin,
      curDay: dayIdx, curStartMin: origStartMin, curEndMin: origEndMin,
    });
  };

  const handleResizePointerDown = (e: React.PointerEvent, slot: Slot, dayIdx: number, edge: "top" | "bottom") => {
    e.stopPropagation();
    const s = parseISO(slot.start_at);
    const en = parseISO(slot.end_at);
    setDrag({
      kind: "resize",
      slotId: slot.id,
      edge,
      day: dayIdx,
      startMin: s.getHours() * 60 + s.getMinutes(),
      endMin: en.getHours() * 60 + en.getMinutes(),
    });
  };

  const handleDeleteSlot = async (slotId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/action-slots/${slotId}`, { method: "DELETE" });
    onSlotChange();
  };

  const handleSlotClick = (slot: Slot, e: React.MouseEvent) => {
    e.stopPropagation();
    const action = actions.find((a) => a.id === slot.action_block_id);
    if (action) onOpenAction(action);
  };

  // ─── Render ───────────────────────────────────────────
  return (
    <div className="flex gap-3 h-[calc(100vh-180px)]">
      {/* Main: calendar */}
      <div className="flex-1 flex flex-col min-w-0 rounded-lg border border-gray-200 bg-white overflow-hidden">
        {/* Header: nav + month/week range */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
          <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100">←</button>
          <button onClick={() => setWeekStart(sundayOf(new Date()))} className="rounded px-2 py-1 text-sm text-theme-600 hover:bg-theme-50 font-medium">今週</button>
          <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100">→</button>
          <span className="ml-3 text-sm font-medium text-gray-700">{fmtMonth(weekStart)}</span>
          <span className="ml-auto text-xs text-gray-500">
            {weekStart.getMonth() + 1}/{weekStart.getDate()} 〜 {addDays(weekStart, 6).getMonth() + 1}/{addDays(weekStart, 6).getDate()}
          </span>
        </div>

        {/* Day headers (sticky) */}
        <div className="flex border-b border-gray-200 bg-gray-50 flex-shrink-0">
          <div style={{ width: 56 }} className="flex-shrink-0" />
          {days.map((d, i) => {
            const isToday = d.toDateString() === new Date().toDateString();
            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
            return (
              <div key={i} className={`flex-1 text-center py-1.5 text-xs font-medium border-l border-gray-200 ${isToday ? "bg-theme-50 text-theme-700" : isWeekend ? "text-gray-500" : "text-gray-700"}`}>
                {fmtDayHeader(d)}
              </div>
            );
          })}
        </div>

        {/* Scrollable body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto relative">
          <div ref={gridRef} className="flex relative" style={{ height: 24 * HOUR_HEIGHT }}>
            {/* Hour labels */}
            <div style={{ width: 56 }} className="flex-shrink-0 relative">
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="text-[10px] text-gray-400 text-right pr-1" style={{ height: HOUR_HEIGHT, borderBottom: "1px solid #f3f4f6" }}>
                  {h > 0 ? `${h}:00` : ""}
                </div>
              ))}
            </div>
            {/* Day columns */}
            {days.map((d, dayIdx) => (
              <div key={dayIdx} className="flex-1 relative border-l border-gray-200" style={{ height: 24 * HOUR_HEIGHT }}>
                {/* Hour gridlines */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} style={{ position: "absolute", left: 0, right: 0, top: h * HOUR_HEIGHT, height: HOUR_HEIGHT, borderBottom: "1px solid #f3f4f6" }}>
                    {/* 30-min guide line */}
                    <div style={{ position: "absolute", left: 0, right: 0, top: HOUR_HEIGHT / 2, borderTop: "1px dotted #f3f4f6" }} />
                  </div>
                ))}
                {/* Existing slots */}
                {slotsByDay[dayIdx].map((slot) => {
                  // If this slot is currently being moved or resized, render the ghost instead
                  if (drag && drag.kind === "move" && drag.slotId === slot.id) return null;
                  if (drag && drag.kind === "resize" && drag.slotId === slot.id) {
                    return renderSlot(
                      slot,
                      drag.startMin,
                      drag.endMin,
                      dayIdx,
                      actions,
                      handleSlotPointerDown,
                      handleResizePointerDown,
                      handleSlotClick,
                      handleDeleteSlot,
                      onToggleDone,
                      true, // being dragged
                    );
                  }
                  const s = parseISO(slot.start_at);
                  const en = parseISO(slot.end_at);
                  const startMin = s.getHours() * 60 + s.getMinutes();
                  const endMin = en.getHours() * 60 + en.getMinutes();
                  return renderSlot(
                    slot, startMin, endMin, dayIdx,
                    actions,
                    handleSlotPointerDown,
                    handleResizePointerDown,
                    handleSlotClick,
                    handleDeleteSlot,
                    onToggleDone,
                    false,
                  );
                })}
                {/* Moving ghost for this day */}
                {drag && drag.kind === "move" && drag.curDay === dayIdx && (() => {
                  const slot = slots.find((s) => s.id === drag.slotId);
                  if (!slot) return null;
                  return renderSlot(slot, drag.curStartMin, drag.curEndMin, dayIdx, actions, () => {}, () => {}, () => {}, () => {}, () => {}, true);
                })()}
                {/* New-slot ghost */}
                {drag && drag.kind === "new" && drag.ghostDay === dayIdx && (
                  <div
                    style={{
                      position: "absolute",
                      left: 2, right: 2,
                      top: (drag.ghostStartMin / 60) * HOUR_HEIGHT,
                      height: ((drag.ghostEndMin - drag.ghostStartMin) / 60) * HOUR_HEIGHT,
                    }}
                    className="rounded border-2 border-dashed border-theme-400 bg-theme-50/70 px-1 py-0.5 text-xs text-theme-700 pointer-events-none"
                  >
                    {drag.actionContent.replace(/^!(action|done)(@\S+)?\s+/i, "").slice(0, 40)}
                  </div>
                )}
                {/* Full-column drop target */}
                <div className="absolute inset-0" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right sidebar: unfinished actions */}
      <div className="w-64 flex-shrink-0 rounded-lg border border-gray-200 bg-white flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-200 text-sm font-medium text-gray-700">
          未完了アクション
        </div>
        <div className="overflow-y-auto flex-1">
          {/* Unscheduled */}
          <div className="border-b border-gray-100">
            <div className="px-3 py-1 bg-amber-50 text-xs font-semibold text-amber-800">
              未設定 <span className="font-normal text-gray-500">({sidebarActions.unscheduled.length})</span>
            </div>
            {sidebarActions.unscheduled.length === 0 && (
              <div className="px-3 py-2 text-xs text-gray-400">すべて設定済み</div>
            )}
            {sidebarActions.unscheduled.map((a) => (
              <SidebarActionItem key={a.id} action={a} onPointerDown={handleSidebarPointerDown} onToggleDone={onToggleDone} />
            ))}
          </div>
          {/* Scheduled */}
          <div>
            <div className="px-3 py-1 bg-green-50 text-xs font-semibold text-green-800">
              設定済み <span className="font-normal text-gray-500">({sidebarActions.scheduled.length})</span>
            </div>
            {sidebarActions.scheduled.length === 0 && (
              <div className="px-3 py-2 text-xs text-gray-400">まだありません</div>
            )}
            {sidebarActions.scheduled.map((a) => (
              <SidebarActionItem key={a.id} action={a} onPointerDown={handleSidebarPointerDown} onToggleDone={onToggleDone} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function composeISO(day: Date, minutes: number): string {
  const d = new Date(day);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return isoLocal(d);
}

function renderSlot(
  slot: Slot,
  startMin: number,
  endMin: number,
  dayIdx: number,
  actions: ActionBlock[],
  onSlotPointerDown: (e: React.PointerEvent, s: Slot, di: number) => void,
  onResizePointerDown: (e: React.PointerEvent, s: Slot, di: number, edge: "top" | "bottom") => void,
  onClickSlot: (s: Slot, e: React.MouseEvent) => void,
  onDeleteSlot: (id: string, e: React.MouseEvent) => void,
  onToggleDone: (action: ActionBlock) => void,
  dragging: boolean,
) {
  const action = actions.find((a) => a.id === slot.action_block_id);
  const content = (slot.content ?? action?.content ?? "").replace(/^!(action|done)(@\S+)?\s+/i, "");
  const isDone = /^!done/i.test(slot.content ?? action?.content ?? "");
  const top = (startMin / 60) * HOUR_HEIGHT;
  const height = Math.max(18, ((endMin - startMin) / 60) * HOUR_HEIGHT);
  const label = `${Math.floor(startMin / 60)}:${pad(startMin % 60)} - ${Math.floor(endMin / 60)}:${pad(endMin % 60)}`;
  const tooltip = `${label}\n${content}`;

  return (
    <div
      key={`slot-${slot.id}-${dayIdx}`}
      style={{ position: "absolute", left: 2, right: 2, top, height, zIndex: dragging ? 10 : 1 }}
      className={`rounded shadow-sm border group select-none cursor-grab active:cursor-grabbing ${
        isDone ? "bg-green-100 border-green-300" : "bg-theme-100 border-theme-300"
      } ${dragging ? "opacity-80" : "hover:brightness-95"}`}
      onPointerDown={(e) => onSlotPointerDown(e, slot, dayIdx)}
      onClick={(e) => { if (!dragging) onClickSlot(slot, e); }}
      title={tooltip}
    >
      {/* Top resize handle */}
      <div
        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-black/10 rounded-t"
        onPointerDown={(e) => onResizePointerDown(e, slot, dayIdx, "top")}
      />
      {/* Bottom resize handle */}
      <div
        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-black/10 rounded-b"
        onPointerDown={(e) => onResizePointerDown(e, slot, dayIdx, "bottom")}
      />
      {/* Content */}
      <div className="flex items-start gap-1 px-1 pt-0.5 text-[11px] leading-tight h-full overflow-hidden">
        <input
          type="checkbox"
          checked={isDone}
          onChange={() => { if (action) onToggleDone(action); }}
          onClick={(e) => e.stopPropagation()}
          className="mt-0.5 flex-shrink-0 rounded border-gray-400 cursor-pointer"
        />
        <div className={`flex-1 min-w-0 ${isDone ? "line-through text-gray-500" : "text-gray-800"}`}>
          <div className="truncate font-medium">{content}</div>
          {height > 36 && <div className="text-[10px] text-gray-600 truncate">{label}</div>}
        </div>
        <button
          onClick={(e) => onDeleteSlot(slot.id, e)}
          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs leading-none px-0.5"
          title="削除"
        >×</button>
      </div>
    </div>
  );
}

function SidebarActionItem({
  action, onPointerDown, onToggleDone,
}: {
  action: ActionBlock;
  onPointerDown: (e: React.PointerEvent, a: ActionBlock) => void;
  onToggleDone: (a: ActionBlock) => void;
}) {
  const isDone = /^!done/i.test(action.content);
  const label = action.content.replace(/^!(action|done)(@\S+)?\s+/i, "");
  const pillText = formatDuePill(action.due_start, action.due_end);
  const pillColor = dueColor(action.due_end, isDone);
  return (
    <div
      className="px-3 py-1.5 border-b border-gray-50 hover:bg-theme-50 cursor-grab active:cursor-grabbing select-none"
      onPointerDown={(e) => onPointerDown(e, action)}
    >
      <div className="flex items-start gap-1.5">
        <input
          type="checkbox"
          checked={isDone}
          onChange={() => onToggleDone(action)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="mt-0.5 flex-shrink-0 rounded border-gray-300 cursor-pointer"
        />
        <div className="flex-1 min-w-0">
          <div className={`text-xs truncate ${isDone ? "line-through text-gray-400" : "text-gray-700"}`}>
            {label}
          </div>
          {pillText && (
            <div className={`text-[10px] mt-0.5 ${pillColor}`}>📅 {pillText}</div>
          )}
        </div>
      </div>
    </div>
  );
}
