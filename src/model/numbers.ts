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

/**
 * Removes every closed `%%…%%` Obsidian comment.
 *
 * A formula cell is `1 250 %%=SUM(B2:B3)%%` (see `src/feature/formula.ts`), and Obsidian hides the
 * comment, so the cell reads as 1 250 and has to count as that in sums and sorts. An unclosed `%%`
 * is left alone: it is not a comment we can bound, and the cell stays non-numeric.
 */
export function stripObsidianComments(s: string): string {
	if (!s.includes("%%")) return s;
	let out = "";
	let at = 0;
	for (;;) {
		const open = s.indexOf("%%", at);
		const close = open === -1 ? -1 : s.indexOf("%%", open + 2);
		if (close === -1) return out + s.slice(at);
		out += s.slice(at, open);
		at = close + 2;
	}
}

/**
 * A date as this plugin writes it: `YYYY-MM-DD`, optionally with a time.
 *
 * Excel has no date type — a date is a number with a style, and that is the whole problem this
 * solves. The note stores something a person can read, and a formula reads it back as the serial
 * number it was in the workbook, so `B2-A2` is still a number of days.
 */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** The Excel serial for an ISO date or date-time, or null when the text is not one. */
export function serialFromIsoDate(text: string): number | null {
	const m = ISO_DATE.exec(text.trim());
	if (m === null) return null;
	const year = Number.parseInt(m[1], 10);
	const month = Number.parseInt(m[2], 10);
	const day = Number.parseInt(m[3], 10);
	const hours = m[4] === undefined ? 0 : Number.parseInt(m[4], 10);
	const minutes = m[5] === undefined ? 0 : Number.parseInt(m[5], 10);
	const seconds = m[6] === undefined ? 0 : Number.parseInt(m[6], 10);
	const midnight = Date.UTC(year, month - 1, day);
	const check = new Date(midnight);
	if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
	if (hours > 23 || minutes > 59 || seconds > 59) return null;
	// 1970-01-01 is day 25569 of Excel's 1900 system, which is off by the leap year it wrongly
	// believes in; every date this plugin writes is far past that, so the shortcut is exact.
	return midnight / 86_400_000 + 25569 + (hours * 3600 + minutes * 60 + seconds) / 86_400;
}

/** The date part of a serial as `YYYY-MM-DD`. */
export function isoDateFromSerial(serial: number): string {
	const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
	const year = date.getUTCFullYear();
	const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
	const day = `${date.getUTCDate()}`.padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** The time of day a serial's fraction stands for, or null when it is midnight. */
export function isoTimeFromSerial(serial: number): string | null {
	const total = Math.round((serial - Math.floor(serial)) * 86_400);
	if (total === 0) return null;
	const hours = `${Math.floor(total / 3600)}`.padStart(2, "0");
	const minutes = `${Math.floor((total % 3600) / 60)}`.padStart(2, "0");
	const seconds = total % 60;
	return seconds === 0 ? `${hours}:${minutes}` : `${hours}:${minutes}:${`${seconds}`.padStart(2, "0")}`;
}

/** A serial as the text a cell holds: `2023-03-15`, or `2023-03-15 14:30`. */
export function isoFromSerial(serial: number): string {
	const time = isoTimeFromSerial(serial);
	return time === null ? isoDateFromSerial(serial) : `${isoDateFromSerial(serial)} ${time}`;
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
	let s = stripInlineMarkdown(stripObsidianComments(text));
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
	// `07.07.2026` is a date, not 07072026. A separator is only dropped as grouping when the digit
	// runs it separates really are thousands groups.
	if (!groupingIsValid(s, decSep)) return null;
	if (decSep === ",") s = s.split(".").join("").replace(",", ".");
	else s = s.split(",").join("");

	if (!NUMERIC_CORE.test(s)) return null;
	let n = Number.parseFloat(s);
	if (!Number.isFinite(n)) return null;
	if (percent) n /= 100;
	if (negate) n = -n;
	return n;
}

/**
 * True when the grouping separator, if present at all, groups digits the way a number does:
 * one to three digits, then groups of exactly three, and never in the fractional part.
 *
 * This is what keeps `07.07.2026`, `1.2.3` and `10.000.5` out of the numeric path. Without it a
 * dotted date exports to Excel as the integer 07072026 (§14).
 */
function groupingIsValid(s: string, decSep: "," | "."): boolean {
	const groupSep = decSep === "," ? "." : ",";
	if (!s.includes(groupSep)) return true;
	const body = s.replace(/^[+-]/, "");
	const cut = body.indexOf(decSep);
	const integer = cut === -1 ? body : body.slice(0, cut);
	const fraction = cut === -1 ? "" : body.slice(cut + 1);
	if (fraction.includes(groupSep)) return false;
	const groups = integer.split(groupSep);
	if (groups.length < 2) return false;
	if (!/^\d{1,3}$/.test(groups[0])) return false;
	return groups.slice(1).every((g) => /^\d{3}$/.test(g));
}

function resolveDecimalSeparator(s: string, pref: "auto" | "," | "."): "," | "." {
	const commas = (s.match(/,/g) ?? []).length;
	const dots = (s.match(/\./g) ?? []).length;
	if (pref !== "auto") {
		// An explicit preference defers when only the other separator is present *and* it appears
		// once, which is the ambiguous case (`1.5` under a comma preference). A repeated separator
		// is grouping, so the preference stands.
		if (pref === "," && commas === 0 && dots === 1) return ".";
		if (pref === "." && dots === 0 && commas === 1) return ",";
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
