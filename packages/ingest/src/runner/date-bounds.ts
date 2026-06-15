/**
 * Resolve published_at lower/upper bounds for registry selection from the
 * caller's dates + traversal direction.
 *
 * Spec (per the per-document-coverage migration): a SINGLE date is an ANCHOR,
 * and `direction` decides which way you walk from it:
 *   - forward  → from the anchor onward    (published_at >= anchor, ASC)
 *   - backward → from the anchor backward  (published_at <= anchor, DESC)
 * Two dates = an explicit [from, to] range; direction then only sets sort order.
 * Neither date (downloaded-backlog-only run) → no bounds.
 *
 * Returns the bounds as { lower (>=), upper (< upper+1day) } in the caller's
 * date strings — the selection query keeps its existing `>=` / `< +1day`
 * comparisons; only WHICH bound a lone date fills changes with direction.
 */
export function resolveDateBounds(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  direction: 'forward' | 'backward',
): { lower?: string; upper?: string } {
  // Explicit range — honor both bounds verbatim; direction is sort-order only.
  if (dateFrom && dateTo) return { lower: dateFrom, upper: dateTo };
  // Exactly one date = anchor; direction picks the bound it fills.
  const anchor = dateFrom ?? dateTo;
  if (!anchor) return {};
  return direction === 'backward' ? { upper: anchor } : { lower: anchor };
}
