/** Shared grid limits. `scripts/gen-styles.mjs` reads MAX_COLS to emit the per-column rules. */

export const VIEW_TYPE_GRID = "markdown-grid-view";

/**
 * Hard stop on rows (§9). Not a feature — a guard so that holding the down arrow cannot grow
 * the DOM without bound. The plugin targets tables up to ~500 rows (D8).
 */
export const MAX_ROWS = 2000;

/**
 * Hard stop on columns. Column widths rely on one pre-generated CSS rule per index, so the
 * cap is whatever `styles.css` was generated for. 128 columns is ~5 kB of CSS.
 */
export const MAX_COLS = 128;

/** How many rows/columns to append when the viewport nears the end (§9). */
export const GROW_ROWS = 50;
export const GROW_COLS = 8;

/** Distance from the end, in rows/columns, that triggers a grow. */
export const GROW_THRESHOLD_ROWS = 10;
export const GROW_THRESHOLD_COLS = 3;

export const MIN_COL_WIDTH = 40;
export const MAX_COL_WIDTH = 800;
export const AUTOFIT_MAX_WIDTH = 400;

export const MIN_ROW_HEIGHT = 18;
export const MAX_ROW_HEIGHT = 400;

export const ROW_HEAD_WIDTH = 52;
export const HEAD_HEIGHT = 26;

/** Grip zone around a header border, in px, for resize drags. */
export const RESIZE_GRIP = 5;
