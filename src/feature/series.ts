import { parseNumber, type NumberParseOptions } from "../model/numbers";

/**
 * Series recognition for the fill handle.
 *
 * A series is a function from a step index to a cell value: index 0 is the first source cell,
 * `values.length - 1` the last, and filling continues with larger indices forwards and negative
 * ones backwards (up or left). `null` means "no series" and the caller repeats the source.
 *
 * The order of the checks matters. Plain numbers come first so a single `7` still copies, as it
 * does in Excel without Ctrl; dates come before "text ending in a number", because `2026-01-05`
 * also ends in digits and would otherwise count up its day field past 31.
 */
export type SeriesFn = (index: number) => string;

const DAY_MS = 86_400_000;

export function detectSeries(values: string[], numberOpts?: NumberParseOptions): SeriesFn | null {
	if (values.length === 0) return null;
	const trimmed = values.map((v) => v.trim());
	// A gap in the source is a pattern to repeat, not a series to extend.
	if (trimmed.some((v) => v === "")) return null;

	const nums = trimmed.map((v) => parseNumber(v, numberOpts));
	if (nums.every((n): n is number => n !== null)) {
		if (nums.length < 2) return null;
		const step = constantStep(nums);
		if (step === null) return null;
		const start = nums[0];
		return (k) => trimFloat(start + step * k);
	}

	return isoDateSeries(trimmed) ?? dottedDateSeries(trimmed) ?? nameSeries(trimmed) ?? suffixNumberSeries(trimmed);
}

/** The common difference of `nums`, or null when the steps differ. A single value steps by one. */
function constantStep(nums: number[]): number | null {
	if (nums.length === 1) return 1;
	const step = nums[1] - nums[0];
	const constant = nums.every((n, i) => Math.abs(n - (nums[0] + step * i)) < 1e-9);
	return constant ? step : null;
}

export function trimFloat(n: number): string {
	const rounded = Math.round(n * 1e9) / 1e9;
	return String(rounded);
}

/* --------------------------------------------------------------------- dates */

interface Ymd {
	y: number;
	m: number;
	d: number;
}

function validDate(y: number, m: number, d: number): boolean {
	if (m < 1 || m > 12 || d < 1) return false;
	return d <= daysInMonth(y, m);
}

function daysInMonth(y: number, m: number): number {
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dayNumber(date: Ymd): number {
	return Math.round(Date.UTC(date.y, date.m - 1, date.d) / DAY_MS);
}

function fromDayNumber(n: number): Ymd {
	const dt = new Date(n * DAY_MS);
	return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * Steps a list of dates: by whole months when every date falls on the same day of the month and
 * the months differ (Excel's monthly fill — 31 January, 28 February, 31 March would otherwise be
 * three different day steps), otherwise by days.
 */
function dateStepper(dates: Ymd[]): ((k: number) => Ymd) | null {
	const first = dates[0];
	if (dates.length >= 2) {
		const months = dates.map((d) => d.y * 12 + d.m - 1);
		if (dates.every((d) => d.d === first.d) && months[1] !== months[0]) {
			const step = constantStep(months);
			if (step === null) return null;
			return (k) => {
				const index = months[0] + step * k;
				const y = Math.floor(index / 12);
				const m = index - y * 12 + 1;
				// The 31st of a short month clamps to its last day, as a spreadsheet does.
				return { y, m, d: Math.min(first.d, daysInMonth(y, m)) };
			};
		}
	}
	const days = dates.map(dayNumber);
	const step = constantStep(days);
	if (step === null) return null;
	return (k) => fromDayNumber(days[0] + step * k);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoDateSeries(values: string[]): SeriesFn | null {
	const dates: Ymd[] = [];
	for (const v of values) {
		const m = ISO_DATE.exec(v);
		if (!m) return null;
		const date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
		if (!validDate(date.y, date.m, date.d)) return null;
		dates.push(date);
	}
	const step = dateStepper(dates);
	if (!step) return null;
	return (k) => {
		const { y, m, d } = step(k);
		return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
	};
}

/** `1.2.2026`, `01.02.2026` and the Czech typographic `1. 2. 2026`. */
const DOTTED_DATE = /^(\d{1,2})\.( ?)(\d{1,2})\.( ?)(\d{4})$/;

/**
 * Dotted European dates keep the width they were written with: a leading zero on either field
 * (`30.01.2026`) means the `DD.MM.YYYY` form and pads both, `1.2.2026` pads neither, and the space
 * after each dot carries over as typed.
 */
function dottedDateSeries(values: string[]): SeriesFn | null {
	const dates: Ymd[] = [];
	let padded = false;
	let gap = "";
	for (let i = 0; i < values.length; i++) {
		const m = DOTTED_DATE.exec(values[i]);
		if (!m) return null;
		const date = { y: Number(m[5]), m: Number(m[3]), d: Number(m[1]) };
		if (!validDate(date.y, date.m, date.d)) return null;
		if (/^0\d$/.test(m[1]) || /^0\d$/.test(m[3])) padded = true;
		if (i === 0) gap = m[2];
		dates.push(date);
	}
	const step = dateStepper(dates);
	if (!step) return null;
	return (k) => {
		const { y, m, d } = step(k);
		const day = padded ? pad(d, 2) : String(d);
		const month = padded ? pad(m, 2) : String(m);
		return `${day}.${gap}${month}.${gap}${y}`;
	};
}

function pad(n: number, width: number): string {
	return String(n).padStart(width, "0");
}

/* --------------------------------------------------------------------- names */

/**
 * Day and month names, lowercase. Short lists come first so `May` continues as `Jun`, the way
 * Excel's built-in lists are ordered; `May, June` fails the short list and matches the full one.
 *
 * `single: false` marks lists whose entries are also ordinary Czech words: `ne` is "no", `po`,
 * `so`, `pro`, `dub` and `lis` are words too. One of them alone in a yes/no or for/against column
 * has to copy, not turn into a weekday; two or more cells with a constant step make the intent clear.
 */
const NAME_LISTS: ReadonlyArray<{ names: readonly string[]; single: boolean }> = [
	{ names: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], single: true },
	{ names: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], single: true },
	{ names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], single: true },
	{
		names: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
		single: true,
	},
	{ names: ["po", "út", "st", "čt", "pá", "so", "ne"], single: false },
	{ names: ["pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota", "neděle"], single: true },
	{ names: ["led", "úno", "bře", "dub", "kvě", "čvn", "čvc", "srp", "zář", "říj", "lis", "pro"], single: false },
	{
		names: ["leden", "únor", "březen", "duben", "květen", "červen", "červenec", "srpen", "září", "říjen", "listopad", "prosinec"],
		single: true,
	},
];

type CaseStyle = "upper" | "lower" | "title";

function caseStyleOf(s: string): CaseStyle {
	if (s === s.toLowerCase()) return "lower";
	if (s === s.toUpperCase()) return "upper";
	return "title";
}

function applyCase(s: string, style: CaseStyle): string {
	if (style === "upper") return s.toUpperCase();
	if (style === "lower") return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function nameSeries(values: string[]): SeriesFn | null {
	const lower = values.map((v) => v.toLowerCase());
	for (const { names: list, single } of NAME_LISTS) {
		const indices = lower.map((v) => list.indexOf(v));
		if (indices.some((i) => i === -1)) continue;
		if (values.length === 1 && !single) return null;
		const n = list.length;
		let step = 1;
		if (indices.length >= 2) {
			step = mod(indices[1] - indices[0], n);
			for (let i = 1; i < indices.length; i++) {
				if (mod(indices[i] - indices[i - 1], n) !== step) return null;
			}
		}
		const style = caseStyleOf(values[0]);
		const start = indices[0];
		return (k) => applyCase(list[mod(start + step * k, n)], style);
	}
	return null;
}

function mod(a: number, n: number): number {
	return ((a % n) + n) % n;
}

/* ------------------------------------------------------- text ending in a number */

const SUFFIX_NUMBER = /^(.*\D)(\d+)$/;

/**
 * `Item 9` -> `Item 10`, `Q1` -> `Q2`, `A-007` -> `A-008`. The prefix must be the same in every
 * source cell; zero padding holds the width it was written with. Counting back past zero keeps
 * the magnitude (`Item 0`, `Item 1`, ...), which is what Excel does rather than writing `Item -1`.
 */
function suffixNumberSeries(values: string[]): SeriesFn | null {
	const parsed: Array<{ prefix: string; digits: string }> = [];
	for (const v of values) {
		const m = SUFFIX_NUMBER.exec(v);
		if (!m) return null;
		parsed.push({ prefix: m[1], digits: m[2] });
	}
	const prefix = parsed[0].prefix;
	if (parsed.some((p) => p.prefix !== prefix)) return null;
	const nums = parsed.map((p) => Number.parseInt(p.digits, 10));
	const step = constantStep(nums);
	if (step === null) return null;
	const width = parsed.reduce((w, p) => (p.digits.length > 1 && p.digits.startsWith("0") ? Math.max(w, p.digits.length) : w), 0);
	return (k) => `${prefix}${String(Math.abs(nums[0] + step * k)).padStart(width, "0")}`;
}
