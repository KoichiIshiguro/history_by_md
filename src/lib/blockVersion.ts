/**
 * Compute a "version token" for a scope (page / date / meeting).
 * Uses MAX(updated_at) of blocks matching the scope. Returns null if
 * the scope is empty (no blocks yet).
 *
 * Used by GET /api/blocks to tag responses, and by save endpoints to
 * detect stale writes (optimistic concurrency control).
 */
export function scopeVersion(
  db: any,
  scope: { user_id: string; page_id?: string; date?: string; meeting_id?: string },
): string | null {
  let row: { v: string | null } | undefined;
  if (scope.meeting_id) {
    row = db.prepare(
      "SELECT MAX(updated_at) as v FROM blocks WHERE user_id = ? AND meeting_id = ?"
    ).get(scope.user_id, scope.meeting_id) as any;
  } else if (scope.page_id) {
    row = db.prepare(
      "SELECT MAX(updated_at) as v FROM blocks WHERE user_id = ? AND page_id = ?"
    ).get(scope.user_id, scope.page_id) as any;
  } else if (scope.date) {
    row = db.prepare(
      "SELECT MAX(updated_at) as v FROM blocks WHERE user_id = ? AND date = ? AND page_id IS NULL AND meeting_id IS NULL"
    ).get(scope.user_id, scope.date) as any;
  }
  return row?.v ?? null;
}
