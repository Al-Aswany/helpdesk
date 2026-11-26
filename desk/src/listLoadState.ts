export type ListLoadState = "loading" | "rows" | "empty" | "error";

/**
 * A failed load is not an empty list. Rows already on screen stay visible
 * while a later request is in flight or has failed after a previous success
 * that had rows.
 */
export function listLoadState(input: {
  loading: boolean;
  error: unknown;
  rowCount: number;
}): ListLoadState {
  if (input.rowCount > 0) return "rows";
  if (input.loading) return "loading";
  if (input.error) return "error";
  return "empty";
}
