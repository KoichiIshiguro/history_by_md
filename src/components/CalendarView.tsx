"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { ActionBlock, formatDuePill, dueColor } from "./ActionList";
import { PageInfo } from "./BlockEditor";

/**
 * Google Calendar-style weekly time grid.
 *
 *   - 24h scrollable, Sunday-first, 15-min snap, 60px / hour.
 *   - Action slots: drag from CalendarSidebar to create, drag to move,
 *     edge to resize, click to navigate to source page, checkbox to toggle done.
 *   - Busy slots (off-limit time — meetings, OOO, etc.): drag from the
 *     grey "設定不可" item at the top of the sidebar to create. Click an
 *     existing busy slot to edit title + recurrence in a modal.
 *   - Overlapping items render side-by-side via lane packing.
 *   - Sidebar lives on the window-dispatched "calendar-drag-begin" event
 *     so CalendarSidebar can be rendered elsewhere (e.g., portaled into
 *     the app's right sidebar).
 */

// ─── Types ──────────────────────────────────────────────

export interface Slot {
  id: string;
  action_block_id: string;
  start_at: string;
  end_at: string;
  content?: string;
  page_id?: string | null;
  date?: string;
}

export interface BusySlot {
  instance_id: string; // may be `${baseId}::${ymd}` for recurring, or just baseId
  id: string;           // base DB row id
  title: string;
  start_at: string;
  end_at: string;
  recurrence: string;   // 'none' | 'daily' | 'weekly'
}

export interface BusySlotFull extends BusySlot {
  weekdays?: number[];
  recur_until?: string | null;
}

interface Props {
  slots: Slot[];
  busySlots: BusySlot[];
  actions: ActionBlock[];
  weekStart: Date;
  setWeekStart: (d: Date) => void;
  onSlotChange: () => void;
  onBusyChange: () => void;
  onToggleDone: (action: ActionBlock) => void;
  onOpenAction: (action: ActionBlock) => void;
}

// ─── Constants ──────────────────────────────────────────

const HOUR_HEIGHT = 60;
const MIN_STEP = 15;
const DAY_COUNT = 7;
const DEFAULT_DURATION_MIN = 60;

// ─── Utilities ──────────────────────────────────────────

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isInDueRange(slotYmd: string, action: ActionBlock | undefined): boolean {
  if (!action) return true;
  const s = action.due_start;
  const e = action.due_end;
  if (!s && !e) return true; // no gantt range set, anything goes
  if (s && slotYmd < s) return false;
  if (e && slotYmd > e) return false;
  return true;
}

function minYmd(a: string | null | undefined, b: string): string {
  if (!a) return b;
  return a < b ? a : b;
}
function maxYmd(a: string | null | undefined, b: string): string {
  if (!a) return b;
  return a > b ? a : b;
}

function fmtDueRange(s?: string | null, e?: string | null): string {
  const fmt = (x: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x);
    if (!m) return x;
    return `${+m[2]}月${+m[3]}日`;
  };
  if (s && e) return s === e ? fmt(s) : `${fmt(s)} 〜 ${fmt(e)}`;
  if (s) return `${fmt(s)} 〜`;
  if (e) return `〜 ${fmt(e)}`;
  return "（未設定）";
}

function parseISO(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return new Date(s);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

function startOfDay(d: Date): Date { const r = new Date(d); r.setHours(0, 0, 0, 0); return r; }
function addDays(d: Date, days: number): Date { const r = new Date(d); r.setDate(r.getDate() + days); return r; }
function sundayOf(d: Date): Date { const r = startOfDay(d); r.setDate(r.getDate() - r.getDay()); return r; }
function fmtMonth(d: Date): string { return `${d.getFullYear()}年${d.getMonth() + 1}月`; }
function fmtDayHeader(d: Date): string {
  const n = ["日", "月", "火", "水", "木", "金", "土"];
  return `${n[d.getDay()]} ${d.getDate()}`;
}
function snapMinutes(m: number): number { return Math.round(m / MIN_STEP) * MIN_STEP; }
function minutesFromTop(py: number): number { return snapMinutes(Math.max(0, Math.min(24 * 60 - MIN_STEP, py))); }

function composeISO(day: Date, minutes: number): string {
  const d = new Date(day);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return isoLocal(d);
}

// ─── Lane packing (side-by-side overlapping items) ─────

interface Packable { start_at: string; end_at: string; __kind: "action" | "busy"; __id: string }

export function packLanes<T extends { start_at: string; end_at: string }>(items: T[]): Array<{ item: T; lane: number; laneCount: number }> {
  const withMin = items.map((it) => {
    const s = parseISO(it.start_at);
    const e = parseISO(it.end_at);
    return { it, startMin: s.getHours() * 60 + s.getMinutes(), endMin: e.getHours() * 60 + e.getMinutes() };
  }).sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const lanes: { startMin: number; endMin: number; lane: number }[] = [];
  const laneAssignments: number[] = [];
  for (const w of withMin) {
    const used = new Set<number>();
    for (const p of lanes) {
      if (p.startMin < w.endMin && p.endMin > w.startMin) used.add(p.lane);
    }
    let lane = 0;
    while (used.has(lane)) lane++;
    lanes.push({ startMin: w.startMin, endMin: w.endMin, lane });
    laneAssignments.push(lane);
  }
  const n = withMin.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (withMin[i].startMin < withMin[j].endMin && withMin[i].endMin > withMin[j].startMin) {
        const a = find(i), b = find(j);
        if (a !== b) parent[b] = a;
      }
    }
  }
  const clusterMaxLane: Record<number, number> = {};
  for (let i = 0; i < n; i++) {
    const r = find(i);
    clusterMaxLane[r] = Math.max(clusterMaxLane[r] ?? 0, laneAssignments[i]);
  }
  return withMin.map((w, i) => ({ item: w.it, lane: laneAssignments[i], laneCount: clusterMaxLane[find(i)] + 1 }));
}

// ─── Drag event payloads (window CustomEvent) ─────────

export type CalendarDragDetail =
  | { kind: "action"; actionBlockId: string; actionContent: string }
  | { kind: "busy" };

// ─── Drag state machine ────────────────────────────────

type DragState =
  | null
  | { mode: "new-action"; actionBlockId: string; actionContent: string; ghostDay: number; ghostStartMin: number; ghostEndMin: number; enteredGrid: boolean }
  | { mode: "new-busy"; ghostDay: number; ghostStartMin: number; ghostEndMin: number; enteredGrid: boolean }
  | { mode: "move-action"; slotId: string; origStartMin: number; origEndMin: number; origDay: number; grabOffsetMin: number; curDay: number; curStartMin: number; curEndMin: number }
  | { mode: "move-busy"; baseId: string; origStartMin: number; origEndMin: number; origDay: number; grabOffsetMin: number; curDay: number; curStartMin: number; curEndMin: number; origDate: string }
  | { mode: "resize-action"; slotId: string; edge: "top" | "bottom"; day: number; startMin: number; endMin: number }
  | { mode: "resize-busy"; baseId: string; origDate: string; edge: "top" | "bottom"; day: number; startMin: number; endMin: number };

// ─── Main component ────────────────────────────────────

export default function CalendarView({
  slots, busySlots, actions, weekStart, setWeekStart,
  onSlotChange, onBusyChange, onToggleDone, onOpenAction,
}: Props) {
  const days = useMemo(() => Array.from({ length: DAY_COUNT }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const slotsByDay = useMemo(() => {
    const arr: Slot[][] = [[], [], [], [], [], [], []];
    for (const s of slots) {
      const d = parseISO(s.start_at);
      for (let i = 0; i < DAY_COUNT; i++) {
        if (d >= days[i] && d < addDays(days[i], 1)) { arr[i].push(s); break; }
      }
    }
    return arr;
  }, [slots, days]);

  const busyByDay = useMemo(() => {
    const arr: BusySlot[][] = [[], [], [], [], [], [], []];
    for (const b of busySlots) {
      const d = parseISO(b.start_at);
      for (let i = 0; i < DAY_COUNT; i++) {
        if (d >= days[i] && d < addDays(days[i], 1)) { arr[i].push(b); break; }
      }
    }
    return arr;
  }, [busySlots, days]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 9 * HOUR_HEIGHT; }, []);

  // "Now" indicator — a red horizontal line on today's column, Google-Calendar style.
  // Recomputes every minute to keep the line moving.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60 * 1000);
    return () => clearInterval(id);
  }, []);
  const now = new Date(nowTick);
  const todayIdx = days.findIndex((d) => d.toDateString() === now.toDateString());
  const nowTopPx = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT;

  const [drag, setDrag] = useState<DragState>(null);
  const [editingBusy, setEditingBusy] = useState<string | null>(null); // base id being edited

  /**
   * Out-of-range confirmation.
   *
   * When the user drops a slot (new or move) on a day outside the action's
   * Gantt due range, instead of committing the slot immediately we stash
   * the commit as a closure here and show a modal. On confirm we expand the
   * action's due_start/due_end to cover the new day, then call `commit()`.
   */
  const [pendingOutOfRange, setPendingOutOfRange] = useState<{
    kind: "new" | "move";
    actionBlockId: string;
    actionLabel: string;
    dueStart: string | null;
    dueEnd: string | null;
    newDueStart: string;
    newDueEnd: string;
    slotYmd: string;
    commit: () => Promise<void>;
  } | null>(null);

  // Instant tooltip (portal-rendered so it's never clipped by the scroll container
  // or hidden behind sibling slots). Shown while the pointer is over a slot.
  const [tip, setTip] = useState<{ title: string; sub: string; x: number; y: number } | null>(null);

  const showTip = (e: React.PointerEvent | React.MouseEvent, title: string, sub: string) => {
    setTip({ title, sub, x: e.clientX, y: e.clientY });
  };
  const moveTip = (e: React.PointerEvent | React.MouseEvent) => {
    setTip((prev) => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev);
  };
  const hideTip = () => setTip(null);

  // Listen for sidebar-initiated drags (window event)
  useEffect(() => {
    const onBegin = (ev: Event) => {
      const e = ev as CustomEvent<CalendarDragDetail>;
      if (!e.detail) return;
      if (e.detail.kind === "action") {
        setDrag({
          mode: "new-action",
          actionBlockId: e.detail.actionBlockId,
          actionContent: e.detail.actionContent,
          ghostDay: 0, ghostStartMin: 9 * 60, ghostEndMin: 9 * 60 + DEFAULT_DURATION_MIN,
          enteredGrid: false,
        });
      } else if (e.detail.kind === "busy") {
        setDrag({
          mode: "new-busy",
          ghostDay: 0, ghostStartMin: 9 * 60, ghostEndMin: 9 * 60 + DEFAULT_DURATION_MIN,
          enteredGrid: false,
        });
      }
    };
    window.addEventListener("calendar-drag-begin", onBegin);
    return () => window.removeEventListener("calendar-drag-begin", onBegin);
  }, []);

  const getMinutesFromPoint = (e: PointerEvent | React.PointerEvent): { day: number; minutes: number; inside: boolean } | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const rawX = (e as PointerEvent).clientX - rect.left;
    const rawY = (e as PointerEvent).clientY - rect.top;
    const inside = rawX >= 0 && rawX < rect.width && rawY >= 0 && rawY < rect.height;
    const x = Math.max(0, Math.min(rect.width - 1, rawX));
    const y = Math.max(0, Math.min(rect.height - 1, rawY)) + grid.scrollTop;
    const colW = rect.width / DAY_COUNT;
    const day = Math.max(0, Math.min(DAY_COUNT - 1, Math.floor(x / colW)));
    const minutes = minutesFromTop((y / HOUR_HEIGHT) * 60);
    return { day, minutes, inside };
  };

  // ─── Pointer handlers (global while dragging) ─────
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const pt = getMinutesFromPoint(e);
      if (!pt) return;
      if (drag.mode === "new-action" || drag.mode === "new-busy") {
        if (!pt.inside) return;
        const startMin = pt.minutes;
        setDrag({ ...drag, ghostDay: pt.day, ghostStartMin: startMin, ghostEndMin: Math.min(24 * 60, startMin + DEFAULT_DURATION_MIN), enteredGrid: true });
      } else if (drag.mode === "move-action" || drag.mode === "move-busy") {
        const dur = drag.origEndMin - drag.origStartMin;
        const newStart = Math.max(0, Math.min(24 * 60 - dur, pt.minutes - drag.grabOffsetMin));
        setDrag({ ...drag, curDay: pt.day, curStartMin: snapMinutes(newStart), curEndMin: snapMinutes(newStart) + dur });
      } else if (drag.mode === "resize-action" || drag.mode === "resize-busy") {
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
        if (drag.mode === "new-action") {
          if (drag.enteredGrid && drag.ghostEndMin > drag.ghostStartMin) {
            const dayDate = days[drag.ghostDay];
            const slotYmd = ymdOf(dayDate);
            const action = actions.find((a) => a.id === drag.actionBlockId);
            const doCreate = async () => {
              await fetch("/api/action-slots", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action_block_id: drag.actionBlockId,
                  start_at: composeISO(dayDate, drag.ghostStartMin),
                  end_at: composeISO(dayDate, drag.ghostEndMin),
                }),
              });
              onSlotChange();
            };
            if (action && !isInDueRange(slotYmd, action)) {
              const label = action.content.replace(/^!(action|done)(@\S+)?\s+/i, "").slice(0, 60);
              setPendingOutOfRange({
                kind: "new",
                actionBlockId: drag.actionBlockId,
                actionLabel: label,
                dueStart: action.due_start ?? null,
                dueEnd: action.due_end ?? null,
                slotYmd,
                newDueStart: minYmd(action.due_start, slotYmd),
                newDueEnd: maxYmd(action.due_end, slotYmd),
                commit: doCreate,
              });
            } else {
              await doCreate();
            }
          }
        } else if (drag.mode === "new-busy") {
          if (drag.enteredGrid && drag.ghostEndMin > drag.ghostStartMin) {
            const dayDate = days[drag.ghostDay];
            await fetch("/api/busy-slots", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: "設定不可",
                start_at: composeISO(dayDate, drag.ghostStartMin),
                end_at: composeISO(dayDate, drag.ghostEndMin),
                recurrence: "none",
              }),
            });
            onBusyChange();
          }
        } else if (drag.mode === "move-action") {
          const dayDate = days[drag.curDay];
          const slotYmd = ymdOf(dayDate);
          const slot = slots.find((s) => s.id === drag.slotId);
          const action = slot ? actions.find((a) => a.id === slot.action_block_id) : undefined;
          const curStartMin = drag.curStartMin;
          const curEndMin = drag.curEndMin;
          const doMove = async () => {
            await fetch(`/api/action-slots/${drag.slotId}`, {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                start_at: composeISO(dayDate, curStartMin),
                end_at: composeISO(dayDate, curEndMin),
              }),
            });
            onSlotChange();
          };
          if (action && !isInDueRange(slotYmd, action)) {
            const label = action.content.replace(/^!(action|done)(@\S+)?\s+/i, "").slice(0, 60);
            setPendingOutOfRange({
              kind: "move",
              actionBlockId: action.id,
              actionLabel: label,
              dueStart: action.due_start ?? null,
              dueEnd: action.due_end ?? null,
              slotYmd,
              newDueStart: minYmd(action.due_start, slotYmd),
              newDueEnd: maxYmd(action.due_end, slotYmd),
              commit: doMove,
            });
          } else {
            await doMove();
          }
        } else if (drag.mode === "move-busy") {
          // Shifts the base definition. For recurring slots this shifts all future instances.
          const dayDate = days[drag.curDay];
          await fetch(`/api/busy-slots/${drag.baseId}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              start_at: composeISO(dayDate, drag.curStartMin),
              end_at: composeISO(dayDate, drag.curEndMin),
            }),
          });
          onBusyChange();
        } else if (drag.mode === "resize-action") {
          const dayDate = days[drag.day];
          await fetch(`/api/action-slots/${drag.slotId}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              start_at: composeISO(dayDate, drag.startMin),
              end_at: composeISO(dayDate, drag.endMin),
            }),
          });
          onSlotChange();
        } else if (drag.mode === "resize-busy") {
          const dayDate = days[drag.day];
          await fetch(`/api/busy-slots/${drag.baseId}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              start_at: composeISO(dayDate, drag.startMin),
              end_at: composeISO(dayDate, drag.endMin),
            }),
          });
          onBusyChange();
        }
      } catch { /* ignore */ }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  /**
   * Threshold-based drag promoter. Pointerdown on a slot body doesn't
   * immediately set drag state (that would unmount the slot and swallow
   * the browser's click/dblclick events). Instead we attach scoped
   * listeners that promote to a real drag only after the pointer moves
   * past CLICK_THRESHOLD_PX. If the user releases without moving, the
   * click/dblclick events fire naturally on the still-mounted element.
   */
  const CLICK_THRESHOLD_PX = 5;
  const armPendingMove = (e: React.PointerEvent, promote: () => void) => {
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: PointerEvent) => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (dx + dy > CLICK_THRESHOLD_PX) {
        cleanup();
        promote(); // now sets the real `drag` state; main useEffect takes over
      }
    };
    const onUp = () => { cleanup(); };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const handleActionSlotPointerDown = (e: React.PointerEvent, slot: Slot, dayIdx: number) => {
    const s = parseISO(slot.start_at);
    const en = parseISO(slot.end_at);
    const origStartMin = s.getHours() * 60 + s.getMinutes();
    const origEndMin = en.getHours() * 60 + en.getMinutes();
    const pt = getMinutesFromPoint(e);
    const grabOffsetMin = pt ? pt.minutes - origStartMin : 0;
    armPendingMove(e, () => {
      setDrag({ mode: "move-action", slotId: slot.id, origStartMin, origEndMin, origDay: dayIdx, grabOffsetMin, curDay: dayIdx, curStartMin: origStartMin, curEndMin: origEndMin });
    });
  };
  const handleActionResizePointerDown = (e: React.PointerEvent, slot: Slot, dayIdx: number, edge: "top" | "bottom") => {
    e.stopPropagation();
    const s = parseISO(slot.start_at);
    const en = parseISO(slot.end_at);
    setDrag({ mode: "resize-action", slotId: slot.id, edge, day: dayIdx, startMin: s.getHours() * 60 + s.getMinutes(), endMin: en.getHours() * 60 + en.getMinutes() });
  };

  const handleBusySlotPointerDown = (e: React.PointerEvent, bs: BusySlot, dayIdx: number) => {
    const s = parseISO(bs.start_at);
    const en = parseISO(bs.end_at);
    const origStartMin = s.getHours() * 60 + s.getMinutes();
    const origEndMin = en.getHours() * 60 + en.getMinutes();
    const pt = getMinutesFromPoint(e);
    const grabOffsetMin = pt ? pt.minutes - origStartMin : 0;
    const origDate = bs.start_at.slice(0, 10);
    armPendingMove(e, () => {
      setDrag({ mode: "move-busy", baseId: bs.id, origStartMin, origEndMin, origDay: dayIdx, grabOffsetMin, curDay: dayIdx, curStartMin: origStartMin, curEndMin: origEndMin, origDate });
    });
  };
  const handleBusyResizePointerDown = (e: React.PointerEvent, bs: BusySlot, dayIdx: number, edge: "top" | "bottom") => {
    e.stopPropagation();
    const s = parseISO(bs.start_at);
    const en = parseISO(bs.end_at);
    setDrag({ mode: "resize-busy", baseId: bs.id, origDate: bs.start_at.slice(0, 10), edge, day: dayIdx, startMin: s.getHours() * 60 + s.getMinutes(), endMin: en.getHours() * 60 + en.getMinutes() });
  };

  const handleDeleteSlot = async (slotId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/action-slots/${slotId}`, { method: "DELETE" });
    onSlotChange();
  };

  const handleActionClick = (slot: Slot, e: React.MouseEvent) => {
    e.stopPropagation();
    const action = actions.find((a) => a.id === slot.action_block_id);
    if (action) onOpenAction(action);
  };
  const handleBusyClick = (bs: BusySlot, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingBusy(bs.id);
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden flex flex-col h-[calc(100vh-180px)]">
      {/* Header: nav */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 flex-shrink-0">
        <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100">←</button>
        <button onClick={() => setWeekStart(sundayOf(new Date()))} className="rounded px-2 py-1 text-sm text-theme-600 hover:bg-theme-50 font-medium">今週</button>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100">→</button>
        <span className="ml-3 text-sm font-medium text-gray-700">{fmtMonth(weekStart)}</span>
        <span className="ml-auto text-xs text-gray-500">
          {weekStart.getMonth() + 1}/{weekStart.getDate()} 〜 {addDays(weekStart, 6).getMonth() + 1}/{addDays(weekStart, 6).getDate()}
        </span>
      </div>

      {/* Day headers */}
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
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
                  <div style={{ position: "absolute", left: 0, right: 0, top: HOUR_HEIGHT / 2, borderTop: "1px dotted #f3f4f6" }} />
                </div>
              ))}
              {/* "Now" indicator on today's column */}
              {todayIdx === dayIdx && (
                <>
                  <div
                    className="absolute left-0 right-0 pointer-events-none"
                    style={{ top: nowTopPx, height: 2, backgroundColor: "#ef4444", zIndex: 20 }}
                  />
                  <div
                    className="absolute pointer-events-none rounded-full"
                    style={{ top: nowTopPx - 5, left: -5, width: 10, height: 10, backgroundColor: "#ef4444", zIndex: 21 }}
                  />
                </>
              )}
              {/* Action + Busy slots, lane-packed together */}
              {(() => {
                // Combine with kind markers for packing
                const combined = [
                  ...slotsByDay[dayIdx].map((s) => ({ ...s, __kind: "action" as const })),
                  ...busyByDay[dayIdx].map((b) => ({ ...b, __kind: "busy" as const })),
                ];
                const packed = packLanes(combined);
                return packed.map(({ item, lane, laneCount }) => {
                  const isAction = item.__kind === "action";
                  if (isAction) {
                    const slot = item as Slot & { __kind: "action" };
                    if (drag && drag.mode === "move-action" && drag.slotId === slot.id) return null;
                    if (drag && drag.mode === "resize-action" && drag.slotId === slot.id) {
                      return renderActionSlot(slot, drag.startMin, drag.endMin, dayIdx, lane, laneCount, actions, handleActionSlotPointerDown, handleActionResizePointerDown, handleActionClick, handleDeleteSlot, onToggleDone, true, showTip, moveTip, hideTip);
                    }
                    const s = parseISO(slot.start_at), en = parseISO(slot.end_at);
                    return renderActionSlot(slot, s.getHours() * 60 + s.getMinutes(), en.getHours() * 60 + en.getMinutes(), dayIdx, lane, laneCount, actions, handleActionSlotPointerDown, handleActionResizePointerDown, handleActionClick, handleDeleteSlot, onToggleDone, false, showTip, moveTip, hideTip);
                  } else {
                    const bs = item as BusySlot & { __kind: "busy" };
                    if (drag && drag.mode === "move-busy" && drag.baseId === bs.id && drag.origDate === bs.start_at.slice(0, 10)) return null;
                    if (drag && drag.mode === "resize-busy" && drag.baseId === bs.id && drag.origDate === bs.start_at.slice(0, 10)) {
                      return renderBusySlot(bs, drag.startMin, drag.endMin, dayIdx, lane, laneCount, handleBusySlotPointerDown, handleBusyResizePointerDown, handleBusyClick, true, showTip, moveTip, hideTip);
                    }
                    const s = parseISO(bs.start_at), en = parseISO(bs.end_at);
                    return renderBusySlot(bs, s.getHours() * 60 + s.getMinutes(), en.getHours() * 60 + en.getMinutes(), dayIdx, lane, laneCount, handleBusySlotPointerDown, handleBusyResizePointerDown, handleBusyClick, false, showTip, moveTip, hideTip);
                  }
                });
              })()}
              {/* Moving ghost for action */}
              {drag && drag.mode === "move-action" && drag.curDay === dayIdx && (() => {
                const slot = slots.find((s) => s.id === drag.slotId);
                if (!slot) return null;
                return renderActionSlot(slot, drag.curStartMin, drag.curEndMin, dayIdx, 0, 1, actions, () => {}, () => {}, () => {}, () => {}, () => {}, true, () => {}, () => {}, () => {});
              })()}
              {/* Moving ghost for busy */}
              {drag && drag.mode === "move-busy" && drag.curDay === dayIdx && (() => {
                const bs = busySlots.find((b) => b.id === drag.baseId);
                if (!bs) return null;
                return renderBusySlot(bs, drag.curStartMin, drag.curEndMin, dayIdx, 0, 1, () => {}, () => {}, () => {}, true, () => {}, () => {}, () => {});
              })()}
              {/* New-slot ghost */}
              {drag && (drag.mode === "new-action" || drag.mode === "new-busy") && drag.enteredGrid && drag.ghostDay === dayIdx && (
                <div
                  style={{
                    position: "absolute", left: 2, right: 2,
                    top: (drag.ghostStartMin / 60) * HOUR_HEIGHT,
                    height: ((drag.ghostEndMin - drag.ghostStartMin) / 60) * HOUR_HEIGHT,
                  }}
                  className={`rounded border-2 border-dashed px-1 py-0.5 text-xs pointer-events-none ${
                    drag.mode === "new-busy"
                      ? "border-gray-400 bg-gray-100/80 text-gray-700"
                      : "border-theme-400 bg-theme-50/70 text-theme-700"
                  }`}
                >
                  {drag.mode === "new-busy" ? "設定不可" : drag.actionContent.replace(/^!(action|done)(@\S+)?\s+/i, "").slice(0, 40)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Out-of-range confirmation modal */}
      {pendingOutOfRange && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPendingOutOfRange(null)}>
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-800 mb-2">期限範囲外への配置</h3>
            <div className="space-y-2 text-sm text-gray-700">
              <div>
                <span className="font-medium">アクション:</span>{" "}
                <span className="text-gray-600">{pendingOutOfRange.actionLabel || "（内容なし）"}</span>
              </div>
              <div>
                <span className="font-medium">現在の期限:</span>{" "}
                <span className="text-gray-600">{fmtDueRange(pendingOutOfRange.dueStart, pendingOutOfRange.dueEnd)}</span>
              </div>
              <div>
                <span className="font-medium">配置日:</span>{" "}
                <span className="text-gray-600">{pendingOutOfRange.slotYmd}</span>
              </div>
              <div className="rounded bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                このアクションのガント期限範囲の外です。配置を続ける場合、ガントの期限を{" "}
                <span className="font-semibold">
                  {fmtDueRange(pendingOutOfRange.newDueStart, pendingOutOfRange.newDueEnd)}
                </span>
                {" "}に拡張します。
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-5 pt-3 border-t border-gray-100">
              <button
                onClick={() => setPendingOutOfRange(null)}
                className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
              >キャンセル</button>
              <button
                onClick={async () => {
                  const p = pendingOutOfRange;
                  setPendingOutOfRange(null);
                  try {
                    await fetch("/api/actions/resize", {
                      method: "PUT", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        blockId: p.actionBlockId,
                        dueStart: p.newDueStart,
                        dueEnd: p.newDueEnd,
                      }),
                    });
                    await p.commit();
                  } catch { /* ignore */ }
                }}
                className="rounded bg-theme-500 text-white px-4 py-1.5 text-sm font-medium hover:bg-theme-600"
              >範囲を拡張して配置</button>
            </div>
          </div>
        </div>
      )}

      {/* Busy slot edit modal */}
      {editingBusy && (
        <BusyEditModal
          baseId={editingBusy}
          onClose={() => setEditingBusy(null)}
          onSaved={() => { setEditingBusy(null); onBusyChange(); }}
          onDeleted={() => { setEditingBusy(null); onBusyChange(); }}
        />
      )}

      {/* Instant tooltip via portal — shown at cursor, never clipped */}
      {tip && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-[1000] pointer-events-none bg-gray-900 text-white text-[11px] rounded px-2 py-1 shadow-lg min-w-[180px] max-w-[360px]"
          style={{ left: tip.x + 12, top: tip.y + 12 }}
        >
          <div className="font-semibold whitespace-pre-line leading-snug">{tip.title}</div>
          <div className="text-[10px] text-gray-300 mt-0.5">{tip.sub}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────

function renderActionSlot(
  slot: Slot, startMin: number, endMin: number, dayIdx: number,
  lane: number, laneCount: number,
  actions: ActionBlock[],
  onSlotPointerDown: (e: React.PointerEvent, s: Slot, di: number) => void,
  onResizePointerDown: (e: React.PointerEvent, s: Slot, di: number, edge: "top" | "bottom") => void,
  onClickSlot: (s: Slot, e: React.MouseEvent) => void,
  onDeleteSlot: (id: string, e: React.MouseEvent) => void,
  onToggleDone: (action: ActionBlock) => void,
  dragging: boolean,
  onShowTip: (e: React.MouseEvent, title: string, sub: string) => void,
  onMoveTip: (e: React.MouseEvent) => void,
  onHideTip: () => void,
) {
  const action = actions.find((a) => a.id === slot.action_block_id);
  // Prefer the live action.content (updated on toggle) over slot.content
  // which was baked in at slot-fetch time and can be stale.
  const liveContent = action?.content ?? slot.content ?? "";
  const content = liveContent.replace(/^!(action|done)(@\S+)?\s+/i, "");
  const isDone = /^!done/i.test(liveContent);
  const top = (startMin / 60) * HOUR_HEIGHT;
  const height = Math.max(18, ((endMin - startMin) / 60) * HOUR_HEIGHT);
  const label = `${Math.floor(startMin / 60)}:${pad(startMin % 60)} - ${Math.floor(endMin / 60)}:${pad(endMin % 60)}`;
  const widthPct = 100 / laneCount;
  const leftPct = lane * widthPct;
  return (
    <div
      key={`act-${slot.id}-${dayIdx}`}
      style={{ position: "absolute", left: `calc(${leftPct}% + 2px)`, width: `calc(${widthPct}% - 4px)`, top, height, zIndex: dragging ? 10 : 1 }}
      className={`rounded shadow-sm border group select-none cursor-grab active:cursor-grabbing ${isDone ? "bg-green-100 border-green-300" : "bg-theme-100 border-theme-300"} ${dragging ? "opacity-80" : "hover:brightness-95"}`}
      onPointerDown={(e) => onSlotPointerDown(e, slot, dayIdx)}
      onDoubleClick={(e) => { if (!dragging) onClickSlot(slot, e); }}
      onMouseEnter={(e) => onShowTip(e, content || "（内容なし）", `${label}（ダブルクリックでページへ）`)}
      onMouseMove={onMoveTip}
      onMouseLeave={onHideTip}
    >
      <div className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-black/10 rounded-t" onPointerDown={(e) => onResizePointerDown(e, slot, dayIdx, "top")} />
      <div className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-black/10 rounded-b" onPointerDown={(e) => onResizePointerDown(e, slot, dayIdx, "bottom")} />
      <div className="flex items-start gap-1 px-1 pt-0.5 text-[11px] leading-tight h-full overflow-hidden">
        <input
          type="checkbox" checked={isDone}
          onChange={() => { if (action) onToggleDone(action); }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="mt-0.5 flex-shrink-0 rounded border-gray-400 cursor-pointer"
        />
        <div className={`flex-1 min-w-0 ${isDone ? "line-through text-gray-500" : "text-gray-800"}`}>
          <div className="truncate font-medium">{content}</div>
          {height > 36 && <div className="text-[10px] text-gray-600 truncate">{label}</div>}
        </div>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => onDeleteSlot(slot.id, e)}
          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs leading-none px-0.5 flex-shrink-0"
          title="削除"
        >×</button>
      </div>

    </div>
  );
}

function renderBusySlot(
  bs: BusySlot, startMin: number, endMin: number, dayIdx: number,
  lane: number, laneCount: number,
  onSlotPointerDown: (e: React.PointerEvent, b: BusySlot, di: number) => void,
  onResizePointerDown: (e: React.PointerEvent, b: BusySlot, di: number, edge: "top" | "bottom") => void,
  onClickSlot: (b: BusySlot, e: React.MouseEvent) => void,
  dragging: boolean,
  onShowTip: (e: React.MouseEvent, title: string, sub: string) => void,
  onMoveTip: (e: React.MouseEvent) => void,
  onHideTip: () => void,
) {
  const title = bs.title || "設定不可";
  const top = (startMin / 60) * HOUR_HEIGHT;
  const height = Math.max(18, ((endMin - startMin) / 60) * HOUR_HEIGHT);
  const label = `${Math.floor(startMin / 60)}:${pad(startMin % 60)} - ${Math.floor(endMin / 60)}:${pad(endMin % 60)}`;
  const widthPct = 100 / laneCount;
  const leftPct = lane * widthPct;
  const recurLabel = bs.recurrence === "none" ? "" : bs.recurrence === "daily" ? " 🔁毎日" : " 🔁毎週";
  return (
    <div
      key={`busy-${bs.instance_id}-${dayIdx}`}
      style={{ position: "absolute", left: `calc(${leftPct}% + 2px)`, width: `calc(${widthPct}% - 4px)`, top, height, zIndex: dragging ? 10 : 1 }}
      className={`rounded shadow-sm border group select-none cursor-grab active:cursor-grabbing bg-gray-200 border-gray-400 text-gray-700 ${dragging ? "opacity-80" : "hover:brightness-95"}`}
      onPointerDown={(e) => onSlotPointerDown(e, bs, dayIdx)}
      onDoubleClick={(e) => { if (!dragging) onClickSlot(bs, e); }}
      onMouseEnter={(e) => onShowTip(e, `${title}${recurLabel}`, `${label}（ダブルクリックで編集）`)}
      onMouseMove={onMoveTip}
      onMouseLeave={onHideTip}
    >
      <div className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-black/10 rounded-t" onPointerDown={(e) => onResizePointerDown(e, bs, dayIdx, "top")} />
      <div className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-black/10 rounded-b" onPointerDown={(e) => onResizePointerDown(e, bs, dayIdx, "bottom")} />
      <div className="px-1.5 pt-0.5 text-[11px] leading-tight h-full overflow-hidden">
        <div className="truncate font-medium">{title}{recurLabel}</div>
        {height > 36 && <div className="text-[10px] text-gray-500 truncate">{label}</div>}
      </div>

    </div>
  );
}

// ─── Busy-slot edit modal ─────────────────────────────

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function BusyEditModal({ baseId, onClose, onSaved, onDeleted }: { baseId: string; onClose: () => void; onSaved: () => void; onDeleted: () => void }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<BusySlotFull | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Fetch all busy slots (no range filter — returns base rows)
        const res = await fetch("/api/busy-slots");
        if (res.ok) {
          const j = await res.json() as { busySlots: any[] };
          const row = j.busySlots.find((b) => b.id === baseId);
          if (row) {
            setData({
              instance_id: row.id, id: row.id, title: row.title, start_at: row.start_at, end_at: row.end_at,
              recurrence: row.recurrence,
              weekdays: row.weekdays ? JSON.parse(row.weekdays) : [],
              recur_until: row.recur_until,
            });
          }
        }
      } finally { setLoading(false); }
    })();
  }, [baseId]);

  const handleSave = async () => {
    if (!data) return;
    setSaving(true);
    try {
      await fetch(`/api/busy-slots/${baseId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: data.title, start_at: data.start_at, end_at: data.end_at,
          recurrence: data.recurrence, weekdays: data.weekdays, recur_until: data.recur_until,
        }),
      });
      onSaved();
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!confirm("この設定不可スロットを削除しますか？（繰り返しの場合は全てのインスタンスが削除されます）")) return;
    await fetch(`/api/busy-slots/${baseId}`, { method: "DELETE" });
    onDeleted();
  };

  // ISO → date + time inputs
  const startDate = data ? data.start_at.slice(0, 10) : "";
  const startTime = data ? data.start_at.slice(11, 16) : "";
  const endDate = data ? data.end_at.slice(0, 10) : "";
  const endTime = data ? data.end_at.slice(11, 16) : "";

  const updateDateTime = (date: string, time: string, which: "start" | "end") => {
    if (!data) return;
    const iso = `${date}T${time}:00`;
    setData({ ...data, [which === "start" ? "start_at" : "end_at"]: iso });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-gray-800 mb-3">設定不可スロットの編集</h3>
        {loading ? <div className="py-8 text-center text-sm text-gray-400">読み込み中...</div> : !data ? <div className="py-8 text-center text-sm text-red-500">見つかりませんでした</div> : (
          <div className="space-y-3 text-sm">
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">タイトル（デフォルト: 設定不可）</label>
              <input
                type="text" value={data.title} onChange={(e) => setData({ ...data, title: e.target.value })}
                placeholder="設定不可"
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:ring-2 focus:ring-theme-400 focus:outline-none"
              />
              <div className="text-[10px] text-gray-400 mt-0.5">例: 定例MTG、打ち合わせ、外出 など自由に設定できます</div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">開始</label>
                <input type="date" value={startDate} onChange={(e) => updateDateTime(e.target.value, startTime, "start")} className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                <input type="time" value={startTime} onChange={(e) => updateDateTime(startDate, e.target.value, "start")} className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm" />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">終了</label>
                <input type="date" value={endDate} onChange={(e) => updateDateTime(e.target.value, endTime, "end")} className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
                <input type="time" value={endTime} onChange={(e) => updateDateTime(endDate, e.target.value, "end")} className="mt-1 w-full border border-gray-300 rounded px-2 py-1 text-sm" />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">繰り返し</label>
              <div className="flex gap-1">
                {(["none", "daily", "weekly"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setData({ ...data, recurrence: r })}
                    className={`rounded border px-3 py-1 text-xs transition ${data.recurrence === r ? "bg-theme-500 text-white border-theme-500" : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                  >{r === "none" ? "なし" : r === "daily" ? "毎日" : "毎週"}</button>
                ))}
              </div>
            </div>
            {data.recurrence === "weekly" && (
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">曜日</label>
                <div className="flex gap-1">
                  {WEEKDAY_LABELS.map((w, i) => {
                    const on = (data.weekdays || []).includes(i);
                    return (
                      <button
                        key={i}
                        onClick={() => {
                          const next = on ? (data.weekdays || []).filter((x) => x !== i) : [...(data.weekdays || []), i].sort();
                          setData({ ...data, weekdays: next });
                        }}
                        className={`rounded border w-8 h-8 text-xs transition ${on ? "bg-theme-500 text-white border-theme-500" : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"}`}
                      >{w}</button>
                    );
                  })}
                </div>
              </div>
            )}
            {data.recurrence !== "none" && (
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">繰り返し終了日（任意）</label>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={data.recur_until || ""}
                    onChange={(e) => setData({ ...data, recur_until: e.target.value || null })}
                    className="border border-gray-300 rounded px-2 py-1 text-sm"
                  />
                  {data.recur_until && (
                    <button onClick={() => setData({ ...data, recur_until: null })} className="text-xs text-gray-500 underline">クリア（無期限）</button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        <div className="flex items-center justify-between mt-5 pt-3 border-t border-gray-100">
          <button onClick={handleDelete} className="text-xs text-red-500 hover:text-red-700 hover:underline">削除</button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100">キャンセル</button>
            <button onClick={handleSave} disabled={saving || !data} className="rounded bg-theme-500 text-white px-4 py-1.5 text-sm font-medium hover:bg-theme-600 disabled:opacity-50">
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar component (exported for portal rendering elsewhere) ─

interface SidebarProps {
  actions: ActionBlock[];
  latestByAction: Record<string, string>;
  onToggleDone: (a: ActionBlock) => void;
}

export function CalendarSidebar({ actions, latestByAction, onToggleDone }: SidebarProps) {
  const now = new Date();
  const sections = useMemo(() => {
    const unfinished = actions.filter((a) => !/^!done/i.test(a.content));
    const scheduled: ActionBlock[] = [];
    const unscheduled: ActionBlock[] = [];
    for (const a of unfinished) {
      const latest = latestByAction[a.id];
      if (latest && parseISO(latest) > now) scheduled.push(a);
      else unscheduled.push(a);
    }
    const byDueEnd = (x: ActionBlock, y: ActionBlock) => {
      const dx = x.due_end || "9999"; const dy = y.due_end || "9999";
      return dx.localeCompare(dy);
    };
    scheduled.sort(byDueEnd);
    unscheduled.sort(byDueEnd);
    return { scheduled, unscheduled };
  }, [actions, latestByAction, now]); // eslint-disable-line react-hooks/exhaustive-deps

  const startActionDrag = (e: React.PointerEvent, action: ActionBlock) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent<CalendarDragDetail>("calendar-drag-begin", {
      detail: { kind: "action", actionBlockId: action.id, actionContent: action.content },
    }));
  };
  const startBusyDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent<CalendarDragDetail>("calendar-drag-begin", {
      detail: { kind: "busy" },
    }));
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-gray-200 text-sm font-medium text-gray-700 flex-shrink-0">
        カレンダー
      </div>

      {/* Busy-slot drag source */}
      <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0">
        <div
          className="rounded border border-gray-300 bg-gray-100 hover:bg-gray-200 px-3 py-2 text-xs text-gray-700 cursor-grab active:cursor-grabbing select-none text-center"
          onPointerDown={startBusyDrag}
        >
          🚫 設定不可（ドラッグで追加）
        </div>
        <div className="text-[10px] text-gray-400 mt-1 leading-tight">
          会議・外出など予定が入っている時間帯。カレンダーに配置したスロットをクリックで繰り返し設定できます。
        </div>
      </div>

      {/* Action sections */}
      <div className="overflow-y-auto flex-1">
        {sections.unscheduled.length === 0 && sections.scheduled.length === 0 ? (
          <div className="px-3 py-6 text-xs text-gray-400 text-center">
            未完了のアクションはありません
          </div>
        ) : (
          <>
            <div className="border-b border-gray-100">
              <div className="px-3 py-1 bg-amber-50 text-xs font-semibold text-amber-800 sticky top-0">
                未設定 <span className="font-normal text-gray-500">({sections.unscheduled.length})</span>
              </div>
              {sections.unscheduled.length === 0 && <div className="px-3 py-2 text-xs text-gray-400">すべて設定済み</div>}
              {sections.unscheduled.map((a) => (
                <SidebarActionItem key={a.id} action={a} onPointerDown={startActionDrag} onToggleDone={onToggleDone} />
              ))}
            </div>
            <div>
              <div className="px-3 py-1 bg-green-50 text-xs font-semibold text-green-800 sticky top-0">
                設定済み <span className="font-normal text-gray-500">({sections.scheduled.length})</span>
              </div>
              {sections.scheduled.length === 0 && <div className="px-3 py-2 text-xs text-gray-400">まだありません</div>}
              {sections.scheduled.map((a) => (
                <SidebarActionItem key={a.id} action={a} onPointerDown={startActionDrag} onToggleDone={onToggleDone} />
              ))}
            </div>
          </>
        )}
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
          type="checkbox" checked={isDone}
          onChange={() => onToggleDone(action)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="mt-0.5 flex-shrink-0 rounded border-gray-300 cursor-pointer"
        />
        <div className="flex-1 min-w-0">
          <div className={`text-xs truncate ${isDone ? "line-through text-gray-400" : "text-gray-700"}`}>{label}</div>
          {pillText && <div className={`text-[10px] mt-0.5 ${pillColor}`}>📅 {pillText}</div>}
        </div>
      </div>
    </div>
  );
}
