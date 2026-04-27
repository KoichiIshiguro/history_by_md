/**
 * Compute a "version token" for a scope (page / date / meeting).
 *
 * Now backed by `MAX(blocks.version)` — a per-block monotonic counter that's
 * bumped on every INSERT (=1) / UPDATE (+1). This is robust against
 * same-second concurrent saves (the prior `MAX(updated_at)` token had
 * second-resolution and would silently miss conflicts).
 *
 * Returns a string like "v17" (not raw int, to keep the API contract opaque)
 * or null if the scope has no blocks yet.
 */
export function scopeVersion(
  db: any,
  scope: { user_id: string; page_id?: string; date?: string; meeting_id?: string },
): string | null {
  let row: { v: number | null } | undefined;
  if (scope.meeting_id) {
    row = db.prepare(
      "SELECT MAX(version) as v FROM blocks WHERE user_id = ? AND meeting_id = ?"
    ).get(scope.user_id, scope.meeting_id) as any;
  } else if (scope.page_id) {
    row = db.prepare(
      "SELECT MAX(version) as v FROM blocks WHERE user_id = ? AND page_id = ?"
    ).get(scope.user_id, scope.page_id) as any;
  } else if (scope.date) {
    row = db.prepare(
      "SELECT MAX(version) as v FROM blocks WHERE user_id = ? AND date = ? AND page_id IS NULL AND meeting_id IS NULL"
    ).get(scope.user_id, scope.date) as any;
  }
  if (row?.v == null) return null;
  return `v${row.v}`;
}
