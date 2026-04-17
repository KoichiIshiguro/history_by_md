"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import { ActionBlock, ActionGroup, formatDuePill } from "./ActionList";
import { PageInfo } from "./BlockEditor";

interface Props {
  groups: ActionGroup[];
  allPages: PageInfo[];
  onPageClick: (id: string, name: string) => void;
  onDateClick: (date: string) => void;
  onActionChange: () => void;
}

const DAY_WIDTH = 32; // px per day column
const LABEL_WIDTH = 220;
const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 40;

function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysBetween(a: Date, b: Date): number {
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((b.getTime() - a.getTime()) / MS);
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function todayISO(): string {
  return toISO(new Date());
}

export default function GanttView({ groups, allPages, onPageClick, onDateClick, onActionChange }: Props) {
  // Build timeline range from all actions + today
  const { rangeStart, rangeEnd, totalDays } = useMemo(() => {
    let minDate = todayISO();
    let maxDate = todayISO();
    for (const g of groups) {
      for (const a of g.actions) {
        if (a.due_start && a.due_start < minDate) minDate = a.due_start;
        if (a.due_end && a.due_end > maxDate) maxDate = a.due_end;
      }
    }
    // Pad 3 days before and 14 days after for comfort
    const start = addDays(parseISO(minDate), -3);
    const end = addDays(parseISO(maxDate), 14);
    return { rangeStart: start, rangeEnd: end, totalDays: daysBetween(start, end) + 1 };
  }, [groups]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll to today on mount
  useEffect(() => {
    if (!scrollRef.current) return;
    const todayOffset = daysBetween(rangeStart, parseISO(todayISO())) * DAY_WIDTH;
    scrollRef.current.scrollLeft = Math.max(0, todayOffset - 100);
  }, [rangeStart]);

  // Drag state
  const [drag, setDrag] = useState<{
    actionId: string;
    mode: "move" | "left" | "right";
    origStart: string;
    origEnd: string;
    startX: number;
    deltaDays: number; // for preview
    deltaStart: number;
    deltaEnd: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent, action: ActionBlock, mode: "move" | "left" | "right") => {
    if (!action.due_start || !action.due_end) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({
      actionId: action.id,
      mode,
      origStart: action.due_start,
      origEnd: action.due_end,
      startX: e.clientX,
      deltaDays: 0,
      deltaStart: 0,
      deltaEnd: 0,
    });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const deltaPx = e.clientX - drag.startX;
    const deltaDays = Math.round(deltaPx / DAY_WIDTH);
    let deltaStart = 0;
    let deltaEnd = 0;
    if (drag.mode === "move") { deltaStart = deltaDays; deltaEnd = deltaDays; }
    else if (drag.mode === "left") { deltaStart = deltaDays; }
    else if (drag.mode === "right") { deltaEnd = deltaDays; }
    setDrag({ ...drag, deltaDays, deltaStart, deltaEnd });
  };

  const onPointerUp = async (e: React.PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.deltaStart === 0 && d.deltaEnd === 0) return;
    const newStart = toISO(addDays(parseISO(d.origStart), d.deltaStart));
    let newEnd = toISO(addDays(parseISO(d.origEnd), d.deltaEnd));
    if (newEnd < newStart) newEnd = newStart;

    try {
      await fetch("/api/actions/resize", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockId: d.actionId, dueStart: newStart, dueEnd: newEnd }),
      });
      onActionChange();
    } catch (err) {
      console.error("Failed to resize action:", err);
    }
  };

  const handleAddAction = async (group: ActionGroup) => {
    const title = window.prompt("新しいアクションの内容を入力:", "");
    if (!title || !title.trim()) return;
    try {
      const res = await fetch("/api/actions/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: group.isPage ? group.pageId : undefined,
          content: title,
        }),
      });
      if (!res.ok) throw new Error("作成失敗");
      onActionChange();
    } catch (err) {
      alert("アクションの作成に失敗しました: " + (err as Error).message);
    }
  };

  // Render month/day headers
  const dateHeaders = [];
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(rangeStart, i);
    const iso = toISO(d);
    const isToday = iso === todayISO();
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    dateHeaders.push({ iso, d, isToday, isWeekend, offset: i * DAY_WIDTH });
  }
  // Month spans — group consecutive days by year-month
  const monthSpans: { label: string; left: number; width: number }[] = [];
  {
    let curLabel = "";
    let curLeft = 0;
    let curWidth = 0;
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(rangeStart, i);
      const label = `${d.getFullYear()}/${d.getMonth() + 1}`;
      if (label !== curLabel) {
        if (curLabel) monthSpans.push({ label: curLabel, left: curLeft, width: curWidth });
        curLabel = label;
        curLeft = i * DAY_WIDTH;
        curWidth = DAY_WIDTH;
      } else {
        curWidth += DAY_WIDTH;
      }
    }
    if (curLabel) monthSpans.push({ label: curLabel, left: curLeft, width: curWidth });
  }

  const timelineWidth = totalDays * DAY_WIDTH;

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden" style={{ userSelect: drag ? "none" : undefined }}>
      <div className="flex">
        {/* Sticky label column */}
        <div className="flex-shrink-0 border-r border-gray-200 bg-gray-50" style={{ width: LABEL_WIDTH }}>
          <div style={{ height: HEADER_HEIGHT }} className="border-b border-gray-200" />
          {groups.map((group) => (
            <div key={group.key}>
              {/* Group header */}
              <div
                className="flex items-center justify-between px-3 border-b border-gray-100 bg-gray-50"
                style={{ height: ROW_HEIGHT }}
              >
                <span
                  className="text-xs font-medium text-gray-700 truncate cursor-pointer hover:text-blue-600"
                  onClick={() => {
                    if (group.isPage) onPageClick(group.pageId, group.label);
                    else if (group.label !== "日付なし") onDateClick(group.label);
                  }}
                  title={group.label}
                >
                  {group.isPage ? <span className="page-link">{group.label}</span> : group.label}
                </span>
                <button
                  onClick={() => handleAddAction(group)}
                  className="flex-shrink-0 ml-1 rounded text-gray-400 hover:bg-theme-100 hover:text-theme-600 w-5 h-5 flex items-center justify-center text-sm leading-none"
                  title="このグループに追加"
                >
                  +
                </button>
              </div>
              {/* Action rows */}
              {group.actions.map((action) => {
                const isDone = /^!done/i.test(action.content);
                const label = action.content.replace(/^!(action|done)(@\S+)?\s+/i, "");
                return (
                  <div
                    key={action.id}
                    className="flex items-center px-3 border-b border-gray-100 text-xs"
                    style={{ height: ROW_HEIGHT, paddingLeft: `${12 + action.indent_level * 8}px` }}
                  >
                    <span className={`truncate ${isDone ? "line-through text-gray-400" : "text-gray-700"}`} title={label}>
                      {label}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Scrollable timeline */}
        <div ref={scrollRef} className="flex-1 overflow-x-auto" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div style={{ width: timelineWidth, position: "relative" }}>
            {/* Header: months + days */}
            <div className="sticky top-0 z-10 bg-white border-b border-gray-200" style={{ height: HEADER_HEIGHT }}>
              {/* Month row */}
              <div style={{ height: 18, position: "relative", borderBottom: "1px solid #e5e7eb" }}>
                {monthSpans.map((s, i) => (
                  <div
                    key={i}
                    className="absolute text-xs font-medium text-gray-600 px-1"
                    style={{ left: s.left, width: s.width, top: 0, height: 18 }}
                  >
                    {s.label}
                  </div>
                ))}
              </div>
              {/* Day row */}
              <div style={{ height: 22, position: "relative" }}>
                {dateHeaders.map((h) => (
                  <div
                    key={h.iso}
                    className={`absolute text-center text-[10px] ${
                      h.isToday ? "bg-theme-100 text-theme-700 font-semibold" : h.isWeekend ? "text-gray-400" : "text-gray-600"
                    }`}
                    style={{ left: h.offset, width: DAY_WIDTH, top: 0, height: 22, lineHeight: "22px" }}
                  >
                    {h.d.getDate()}
                  </div>
                ))}
              </div>
            </div>

            {/* Body: grid + bars */}
            <div style={{ position: "relative" }}>
              {/* Vertical grid lines */}
              {dateHeaders.map((h) => (
                <div
                  key={h.iso}
                  className={h.isWeekend ? "bg-gray-50" : ""}
                  style={{
                    position: "absolute",
                    left: h.offset,
                    top: 0,
                    width: DAY_WIDTH,
                    bottom: 0,
                    borderLeft: h.isToday ? "2px solid rgb(251 146 60)" : "1px solid #f3f4f6",
                  }}
                />
              ))}

              {/* Group rows */}
              {(() => {
                let yOffset = 0;
                const rows: React.ReactElement[] = [];
                for (const group of groups) {
                  // group header row (empty on timeline, matches label column header)
                  rows.push(
                    <div
                      key={`${group.key}-header`}
                      style={{ position: "absolute", left: 0, top: yOffset, width: timelineWidth, height: ROW_HEIGHT, borderBottom: "1px solid #f3f4f6", background: "#f9fafb" }}
                    />
                  );
                  yOffset += ROW_HEIGHT;

                  for (const action of group.actions) {
                    const isDone = /^!done/i.test(action.content);
                    let ds = action.due_start;
                    let de = action.due_end;
                    if (ds && de && drag && drag.actionId === action.id) {
                      ds = toISO(addDays(parseISO(ds), drag.deltaStart));
                      de = toISO(addDays(parseISO(de), drag.deltaEnd));
                      if (de < ds) de = ds;
                    }
                    if (ds && de) {
                      const startDays = daysBetween(rangeStart, parseISO(ds));
                      const endDays = daysBetween(rangeStart, parseISO(de));
                      const barLeft = startDays * DAY_WIDTH + 2;
                      const barWidth = Math.max(DAY_WIDTH - 4, (endDays - startDays + 1) * DAY_WIDTH - 4);
                      const barTop = yOffset + 4;
                      const barHeight = ROW_HEIGHT - 8;
                      const barColor = isDone ? "bg-green-300 border-green-400" : "bg-amber-300 border-amber-400";

                      rows.push(
                        <div
                          key={action.id}
                          className={`rounded border ${barColor} group shadow-sm cursor-grab hover:brightness-95 active:cursor-grabbing`}
                          style={{
                            position: "absolute",
                            left: barLeft,
                            top: barTop,
                            width: barWidth,
                            height: barHeight,
                          }}
                          onPointerDown={(e) => onPointerDown(e, action, "move")}
                          title={formatDuePill(ds, de)}
                        >
                          {/* Left handle */}
                          <div
                            onPointerDown={(e) => onPointerDown(e, action, "left")}
                            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-black/20"
                          />
                          {/* Right handle */}
                          <div
                            onPointerDown={(e) => onPointerDown(e, action, "right")}
                            className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-black/20"
                          />
                          {/* Label (truncated) */}
                          <div className="px-2 text-[11px] leading-none h-full flex items-center overflow-hidden">
                            <span className={`truncate ${isDone ? "line-through" : ""}`}>
                              {action.content.replace(/^!(action|done)(@\S+)?\s+/i, "")}
                            </span>
                          </div>
                        </div>
                      );
                    }
                    // row separator
                    rows.push(
                      <div
                        key={`${action.id}-row`}
                        style={{ position: "absolute", left: 0, top: yOffset, width: timelineWidth, height: ROW_HEIGHT, borderBottom: "1px solid #f3f4f6", pointerEvents: "none" }}
                      />
                    );
                    yOffset += ROW_HEIGHT;
                  }
                }
                return <div style={{ position: "relative", height: yOffset }}>{rows}</div>;
              })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
