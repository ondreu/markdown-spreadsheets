import { getIcon, setIcon } from "obsidian";

/**
 * Icon names with fallbacks.
 *
 * Obsidian ships one Lucide release, and Lucide renames icons between releases: `arrow-down-a-z`
 * was `arrow-down-az`, `home` became `house`, `filter` became `funnel`, `alert-triangle` became
 * `triangle-alert`. A name the running app does not know renders as nothing at all — which is how
 * the sort buttons ended up blank. Every icon is therefore a list, newest name first, older names
 * and a generic stand-in after it, and the first one the app actually has wins.
 */
export const ICONS = {
	tabHome: ["house", "home"],
	tabData: ["database"],
	tabTable: ["table", "table-2", "sheet"],
	tabExport: ["upload", "share"],
	copy: ["copy"],
	cut: ["scissors"],
	paste: ["clipboard-paste", "clipboard"],
	undo: ["undo-2", "undo"],
	redo: ["redo-2", "redo"],
	// `between-horizontal-*` draws two rows with an arrow into the gap; `between-vertical-*` columns.
	rowAbove: ["between-horizontal-start", "arrow-up-to-line", "plus"],
	rowBelow: ["between-horizontal-end", "arrow-down-to-line", "plus"],
	colLeft: ["between-vertical-start", "arrow-left-to-line", "plus"],
	colRight: ["between-vertical-end", "arrow-right-to-line", "plus"],
	remove: ["trash-2", "trash"],
	up: ["arrow-up"],
	down: ["arrow-down"],
	left: ["arrow-left"],
	right: ["arrow-right"],
	alignLeft: ["text-align-start", "align-left"],
	alignCenter: ["text-align-center", "align-center"],
	alignRight: ["text-align-end", "align-right"],
	alignNone: ["remove-formatting", "eraser"],
	bold: ["bold"],
	italic: ["italic"],
	code: ["code"],
	strike: ["strikethrough"],
	wrap: ["text-wrap", "wrap-text"],
	raw: ["file-code-corner", "file-code-2", "file-code", "code-xml", "code"],
	rendered: ["eye"],
	sortAsc: ["arrow-down-a-z", "arrow-down-az", "arrow-up-narrow-wide", "sort-asc", "arrow-up-down"],
	sortDesc: ["arrow-up-z-a", "arrow-up-za", "arrow-down-wide-narrow", "sort-desc", "arrow-up-down"],
	sortDialog: ["list-ordered", "list-filter", "arrow-up-down"],
	filter: ["funnel", "filter"],
	filterClear: ["funnel-x", "filter-x", "x"],
	search: ["search"],
	findNext: ["search", "arrow-right"],
	fillDown: ["arrow-down-to-line", "arrow-down"],
	fillRight: ["arrow-right-to-line", "arrow-right"],
	clear: ["eraser", "x"],
	calculate: ["sigma"],
	again: ["rotate-ccw", "refresh-ccw"],
	autofitCols: ["move-horizontal", "arrow-left-right"],
	autofitRows: ["move-vertical", "arrow-up-down"],
	autofitAll: ["maximize-2", "expand"],
	reset: ["rotate-ccw", "undo"],
	freeze: ["pin"],
	freezePanes: ["grid-2x2", "layout-grid", "pin"],
	unfreeze: ["pin-off", "x"],
	reformat: ["wand-sparkles", "wand-2", "wand", "align-justify"],
	shrink: ["minimize-2", "shrink"],
	restore: ["history"],
	csv: ["file-text", "file"],
	excel: ["file-spreadsheet", "sheet", "table"],
	copyMarkdown: ["clipboard-copy", "copy"],
	copyText: ["clipboard-list", "clipboard"],
	save: ["save"],
	reload: ["refresh-cw", "rotate-cw"],
	note: ["file-text", "file"],
	edit: ["pencil", "edit"],
	warning: ["triangle-alert", "alert-triangle"],
	saving: ["loader-circle", "loader-2", "loader"],
	saved: ["check"],
	collapse: ["chevron-up"],
	expand: ["chevron-down"],
	launcher: ["table-2", "table", "sheet"],
	formula: ["square-function", "function-square", "sigma"],
	tabCalc: ["calculator", "sigma"],
	link: ["link", "link-2"],
	duplicate: ["copy-plus", "copy"],
	hide: ["eye-off"],
	show: ["eye"],
	zoomIn: ["zoom-in", "plus"],
	zoomOut: ["zoom-out", "minus"],
	zoomReset: ["scan", "maximize"],
	goTo: ["locate", "crosshair", "search"],
	textTools: ["case-sensitive", "type", "pilcrow"],
	split: ["split", "columns-2", "scissors"],
	merge: ["merge", "combine", "git-merge"],
	dedupe: ["list-x", "list-minus", "trash"],
	totals: ["sigma-square", "sigma"],
	compute: ["square-function", "function-square", "calculator"],
	stats: ["chart-bar", "bar-chart-2", "bar-chart"],
	numberFormat: ["hash", "binary"],
	json: ["file-json", "braces", "file-code"],
	html: ["code-xml", "code"],
	importFile: ["file-input", "import", "download"],
	mergeFile: ["git-merge", "merge", "combine"],
	switchTable: ["table-properties", "table", "list"],
	pasteSpecial: ["clipboard-type", "clipboard-paste", "clipboard"],
	date: ["calendar", "calendar-days"],
	// The touch bar (decision 24).
	rangeSelect: ["square-dashed-mouse-pointer", "box-select", "square-dashed", "maximize"],
	more: ["ellipsis", "more-horizontal"],
	done: ["check"],
} as const satisfies Record<string, readonly string[]>;

export type IconKey = keyof typeof ICONS;

const resolved = new Map<IconKey, string>();

/** The first name in the fallback list that this Obsidian build knows. */
export function iconName(key: IconKey): string {
	const cached = resolved.get(key);
	if (cached !== undefined) return cached;
	const candidates = ICONS[key];
	const hit = candidates.find((name) => getIcon(name) !== null) ?? candidates[candidates.length - 1];
	resolved.set(key, hit);
	return hit;
}

export function setIconSafe(el: HTMLElement, key: IconKey): void {
	setIcon(el, iconName(key));
}
