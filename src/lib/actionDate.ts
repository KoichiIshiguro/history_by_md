/**
 * Action date-range parser / formatter.
 *
 * Syntax (as typed in block content):
 *   !action content                       — no @: falls back to block.date or today
 *   !action@4/17 content                  — single day this year
 *   !action@4/17-29 content               — range, same month
 *   !action@4/17-5/1 content              — range, this year
 *   !action@2026/4/17 content             — explicit year single
 *   !action@2026/4/17-2026/6/1 content    — explicit both years
 *   !action@2026/4/17-6/1 content         — end year = start year
 *   !done@...                             — same syntax for !done
 *
 * Rules:
 *   - Year omitted → current year
 *   - End < start → end = start (single day)
 *   - Space required between the date spec and content
 */

const ACTION_PREFIX_RE = /^!(action|done)(?:@(\S+))?\s+(.*)$/i;

export interface ActionMeta {
  isAction: boolean;
  isDone: boolean;
  /** The @-spec as written, or null if not present */
  rawSpec: string | null;
  /** YYYY-MM-DD or null if unparseable */
  dueStart: string | null;
  /** YYYY-MM-DD or null */
  dueEnd: string | null;
  /** Content after the prefix (the human-readable body) */
  body: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toISO(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Parse "M/D", "YYYY/M/D". Returns {y,m,d} or null. Year defaults to defaultYear if omitted. */
function parseDateToken(tok: string, defaultYear: number): { y: number; m: number; d: number } | null {
  const parts = tok.split("/").map((s) => s.trim());
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    if (isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y: defaultYear, m, d };
  }
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y, m, d };
  }
  return null;
}

/**
 * Parse the portion after '@' up to the next whitespace.
 * Supports:
 *   "4/17"                → [2026/4/17, 2026/4/17]
 *   "4/17-29"             → [2026/4/17, 2026/4/29]  (end is day-only, same month)
 *   "4/17-5/1"            → [2026/4/17, 2026/5/1]   (end is M/D)
 *   "2026/4/17-2026/6/1"  → [...]
 *   "2026/4/17-6/1"       → end year = start year
 */
function parseDateSpec(
  spec: string,
  currentYear: number,
): { start: string; end: string } | null {
  const dash = spec.indexOf("-");
  if (dash === -1) {
    const one = parseDateToken(spec, currentYear);
    if (!one) return null;
    const iso = toISO(one.y, one.m, one.d);
    return { start: iso, end: iso };
  }
  const startTok = spec.slice(0, dash);
  const endTok = spec.slice(dash + 1);
  const start = parseDateToken(startTok, currentYear);
  if (!start) return null;

  // End token may be: "D" | "M/D" | "YYYY/M/D"
  let end: { y: number; m: number; d: number } | null = null;
  if (!endTok.includes("/")) {
    // day only
    const d = parseInt(endTok, 10);
    if (isNaN(d) || d < 1 || d > 31) return null;
    end = { y: start.y, m: start.m, d };
  } else {
    end = parseDateToken(endTok, start.y);
    if (!end) return null;
  }

  let startISO = toISO(start.y, start.m, start.d);
  let endISO = toISO(end.y, end.m, end.d);
  // End < start → single day
  if (endISO < startISO) endISO = startISO;
  return { start: startISO, end: endISO };
}

/**
 * Parse an action block's content line. Returns ActionMeta.
 * If not an action, returns { isAction: false } and other fields are null/empty.
 *
 * @param defaultDate fallback "YYYY-MM-DD" when no @-spec is present (block's date or today)
 */
export function parseAction(
  content: string,
  defaultDate: string,
  currentYear?: number,
): ActionMeta {
  const year = currentYear ?? new Date().getFullYear();
  const m = content.match(ACTION_PREFIX_RE);
  if (!m) {
    return { isAction: false, isDone: false, rawSpec: null, dueStart: null, dueEnd: null, body: content };
  }
  const kind = m[1].toLowerCase();
  const spec = m[2] ?? null;
  const body = m[3] ?? "";

  let dueStart: string | null = null;
  let dueEnd: string | null = null;
  if (spec) {
    const parsed = parseDateSpec(spec, year);
    if (parsed) {
      dueStart = parsed.start;
      dueEnd = parsed.end;
    }
  }
  if (!dueStart) {
    dueStart = defaultDate || null;
    dueEnd = defaultDate || null;
  }

  return {
    isAction: true,
    isDone: kind === "done",
    rawSpec: spec,
    dueStart,
    dueEnd,
    body,
  };
}

/**
 * Format a (start, end) pair into the most compact @-spec:
 *   same day, current year      → "M/D"
 *   same day, other year        → "YYYY/M/D"
 *   range, same month & year    → "M/D-D"
 *   range, same year            → "M/D-M/D"
 *   range, spans year           → "YYYY/M/D-YYYY/M/D"
 */
export function formatDateSpec(startISO: string, endISO: string, currentYear?: number): string {
  const year = currentYear ?? new Date().getFullYear();
  const [sy, sm, sd] = startISO.split("-").map((s) => parseInt(s, 10));
  const [ey, em, ed] = endISO.split("-").map((s) => parseInt(s, 10));

  const startOmitYear = sy === year;
  const singleDay = startISO === endISO;

  const startFmt = startOmitYear ? `${sm}/${sd}` : `${sy}/${sm}/${sd}`;
  if (singleDay) return startFmt;

  if (sy === ey && sm === em) {
    // same month range
    return `${startFmt}-${ed}`;
  }
  if (sy === ey) {
    // same year range
    return `${startFmt}-${em}/${ed}`;
  }
  // different years
  const endFmt = `${ey}/${em}/${ed}`;
  return startOmitYear ? `${sy}/${sm}/${sd}-${endFmt}` : `${startFmt}-${endFmt}`;
}

/**
 * Rewrite the date spec in an action's content. Handles three cases:
 *   1. content has @-spec → replace it
 *   2. content has no @-spec → insert one after "!action" / "!done"
 *   3. content is not an action → return unchanged
 */
export function rewriteActionDate(
  content: string,
  startISO: string,
  endISO: string,
  currentYear?: number,
): string {
  const m = content.match(ACTION_PREFIX_RE);
  if (!m) return content;
  const kind = m[1]; // preserves original case
  const body = m[3] ?? "";
  const newSpec = formatDateSpec(startISO, endISO, currentYear);
  return `!${kind}@${newSpec} ${body}`;
}

/** Today in YYYY-MM-DD (local time) */
export function todayISO(): string {
  const d = new Date();
  return toISO(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
