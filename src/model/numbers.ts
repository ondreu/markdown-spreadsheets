/**
 * Locale-tolerant number parsing and formatting for the aggregations of §12.
 *
 * Cell content is markdown text, so this has to survive `**42**`, `1 234,56` with a
 * non-breaking space, currency symbols and a trailing percent sign.
 */

/** Every space-like character that can turn up as a thousands separator. */
const SPACES = /[\s\u00a0\u202f\u2009\u2007\u2060]/g;
/** Currency symbols and the Unicode currency block. */
const CURRENCY = /[$€£¥₽₴₹¢₠-₿]/g;
const NUMERIC_CORE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const INLINE_WRAPPERS = ["**", "__", "~~", "*", "_", "`"];

/** Strips balanced inline markdown wrappers so `**42**` still counts as a number. */
export function stripInlineMarkdown(s: string): string {
	let out = s.trim();
	let changed = true;
	while (changed) {
		changed = false;
		for (const w of INLINE_WRAPPERS) {
			if (out.length > w.length * 2 && out.startsWith(w) && out.endsWith(w)) {
				out = out.slice(w.length, out.length - w.length).trim();
				changed = true;
				break;
			}
		}
	}
	return out;
}

export interface NumberParseOptions {
	/** `'auto'` resolves a single separator as decimal and a repeated one as grouping. */
	decimalSeparator?: "auto" | "," | ".";
}

/**
 * Parses a cell into a number, or returns `null` when the cell is not numeric.
 *
 * Separator disambiguation:
 * - both `,` and `.` present -> the rightmost one is the decimal separator;
 * - one separator, appearing more than once -> grouping (`1.234.567`);
 * - one separator, appearing once -> decimal (`1,5` and `1.5` both work, and `1,234`
 *   reads as 1.234 which is what a Czech-locale user typed).
 */
export function parseNumber(text: string, opts: NumberParseOptions = {}): number | null {
	let s = stripInlineMarkdown(text);
	if (s === "") return null;

	let percent = false;
	if (s.endsWith("%")) {
		percent = true;
		s = s.slice(0, -1);
	}

	s = s.replace(SPACES, "").replace(CURRENCY, "");
	if (s === "") return null;

	// Accounting negatives: (1 234,56)
	let negate = false;
	if (s.startsWith("(") && s.endsWith(")")) {
		negate = true;
		s = s.slice(1, -1);
	}

	const decSep = resolveDecimalSeparator(s, opts.decimalSeparator ?? "auto");
	if (decSep === ",") s = s.split(".").join("").replace(",", ".");
	else s = s.split(",").join("");

	if (!NUMERIC_CORE.test(s)) return null;
	let n = Number.parseFloat(s);
	if (!Number.isFinite(n)) return null;
	if (percent) n /= 100;
	if (negate) n = -n;
	return n;
}

function resolveDecimalSeparator(s: string, pref: "auto" | "," | "."): "," | "." {
	const commas = (s.match(/,/g) ?? []).length;
	const dots = (s.match(/\./g) ?? []).length;
	if (pref !== "auto") {
		// An explicit preference still has to defer when only the other separator is present.
		if (pref === "," && commas === 0 && dots > 0) return ".";
		if (pref === "." && dots === 0 && commas > 0) return ",";
		return pref;
	}
	if (commas > 0 && dots > 0) return s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
	if (commas > 1) return ".";
	if (dots > 1) return ",";
	if (commas === 1) return ",";
	return ".";
}

/** True when the cell holds something a `SUM` would count. */
export function isNumeric(text: string, opts?: NumberParseOptions): boolean {
	return parseNumber(text, opts) !== null;
}

/**
 * Formats a computed result for insertion into a cell.
 *
 * `locale` empty means "follow the host", which is what a Czech user wants — `Intl` then
 * produces `1 234,56` with a narrow no-break space, and `parseNumber` reads it back.
 */
export function formatNumber(value: number, decimals: number, locale?: string): string {
	const d = Math.max(0, Math.min(10, Math.round(decimals)));
	try {
		return new Intl.NumberFormat(locale && locale.length > 0 ? locale : undefined, {
			minimumFractionDigits: d,
			maximumFractionDigits: d,
			useGrouping: true,
		}).format(value);
	} catch {
		return value.toFixed(d);
	}
}

/** Compact form for the status bar, where trailing zeros are noise. */
export function formatCompact(value: number, locale?: string): string {
	try {
		return new Intl.NumberFormat(locale && locale.length > 0 ? locale : undefined, {
			maximumFractionDigits: 6,
			useGrouping: true,
		}).format(value);
	} catch {
		return String(value);
	}
}
