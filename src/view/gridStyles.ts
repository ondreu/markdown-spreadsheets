/**
 * Data-driven geometry for the grid (§8.5).
 *
 * Three kinds of size cannot be expressed by static CSS:
 *
 * - **Column widths** are few (tens), so `styles.css` ships one rule per column index that
 *   reads a custom property, and only the property is set at runtime. That keeps every
 *   assignment a `setCssProps` call on a single container.
 * - **Row heights** cannot be pre-generated for 500 indices, and `no-forbidden-elements`
 *   rules out injecting a `<style>` element. A constructable stylesheet is the CSSOM way to
 *   get the same result without a DOM node. Rules exist only for rows the user actually
 *   resized, which keeps the sheet tiny (`rowHeights` is sparse by design).
 * - **Freeze offsets** are cumulative sums of the above, so they live in the same sheet.
 *
 * If `new CSSStyleSheet()` or `adoptedStyleSheets` is unavailable, the class degrades to
 * per-element `setCssStyles`, which is the sanctioned dynamic-style API and needs no lint
 * exception.
 */

export interface GeometrySpec {
	rowDefault: number;
	/** Sparse: row index (as a string) -> height in px. */
	rowHeights: Record<string, number>;
	colWidths: number[];
	colDefault: number;
	frozenRows: number;
	frozenCols: number;
	/** Height of the column-letter header row. */
	headHeight: number;
	/** Width of the row-number gutter. */
	rowHeadWidth: number;
	/** Total rows currently in the DOM, so freeze offsets stay in range. */
	rowCount: number;
	colCount: number;
}

export type GeometryMode = "stylesheet" | "inline";

let hostCounter = 0;

export class GridStyles {
	/** Unique per host so two open grids never restyle each other. */
	readonly hostClass = `mg-host-${++hostCounter}`;
	private sheet: CSSStyleSheet | null = null;
	private doc: Document | null = null;
	private mode: GeometryMode = "inline";

	/**
	 * `ownerDocument` rather than a global: in a popped-out window the grid lives in a
	 * different document, and a sheet adopted by the main one would have no effect
	 * (`prefer-active-doc`, §15.2).
	 */
	attach(host: HTMLElement): GeometryMode {
		host.addClass(this.hostClass);
		const doc = host.ownerDocument;
		this.doc = doc;
		try {
			const win = doc.defaultView;
			if (!win || typeof win.CSSStyleSheet !== "function") throw new Error("no CSSStyleSheet");
			const sheet = new win.CSSStyleSheet();
			sheet.replaceSync(`.${this.hostClass}{--mg-probe:1}`);
			doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
			this.sheet = sheet;
			this.mode = "stylesheet";
		} catch {
			this.sheet = null;
			this.mode = "inline";
		}
		return this.mode;
	}

	detach(host: HTMLElement): void {
		host.removeClass(this.hostClass);
		if (this.doc && this.sheet) {
			this.doc.adoptedStyleSheets = this.doc.adoptedStyleSheets.filter((s) => s !== this.sheet);
		}
		this.sheet = null;
		this.doc = null;
	}

	getMode(): GeometryMode {
		return this.mode;
	}

	/**
	 * Column widths go on the host as custom properties, matched by the pre-generated
	 * `[data-col]` rules in `styles.css`. One assignment per column, none per cell.
	 */
	applyColumnWidths(host: HTMLElement, spec: GeometrySpec): void {
		const props: Record<string, string> = {
			"--mg-col-default": `${spec.colDefault}px`,
			"--mg-row-default": `${spec.rowDefault}px`,
			"--mg-head-h": `${spec.headHeight}px`,
			"--mg-rowhead-w": `${spec.rowHeadWidth}px`,
		};
		for (let c = 0; c < spec.colCount; c++) {
			const w = spec.colWidths[c];
			props[`--mg-col-${c}`] = `${w !== undefined && w > 0 ? w : spec.colDefault}px`;
		}
		host.setCssProps(props);
	}

	/**
	 * Regenerates the whole sheet in one `replaceSync`.
	 *
	 * Rule-by-rule mutation would be a lot of CSSOM churn for no benefit; the caller debounces
	 * this while a drag is in flight.
	 */
	applyGeometry(spec: GeometrySpec, rowEls: Map<number, HTMLElement>): void {
		if (this.sheet) {
			this.sheet.replaceSync(this.buildCss(spec));
			return;
		}
		// Fallback: the same geometry, one element at a time.
		for (const [row, el] of rowEls) {
			const h = spec.rowHeights[String(row)];
			el.setCssStyles({ height: `${h !== undefined && h > 0 ? h : spec.rowDefault}px` });
			if (row < spec.frozenRows) {
				el.setCssStyles({ top: `${spec.headHeight + this.rowOffset(spec, row)}px` });
			} else {
				el.setCssStyles({ top: "" });
			}
		}
	}

	private buildCss(spec: GeometrySpec): string {
		const h = `.${this.hostClass}`;
		const rules: string[] = [];

		for (const [key, value] of Object.entries(spec.rowHeights)) {
			const row = Number.parseInt(key, 10);
			if (!Number.isFinite(row) || row < 0 || row >= spec.rowCount) continue;
			if (!(value > 0)) continue;
			rules.push(`${h} .mg-r${row}{height:${value}px}`);
		}

		// Frozen rows stack below the column-letter header, each offset by the ones above it.
		for (let r = 0; r < Math.min(spec.frozenRows, spec.rowCount); r++) {
			rules.push(`${h} .mg-row.is-frozen-row[data-row="${r}"]{top:${spec.headHeight + this.rowOffset(spec, r)}px}`);
		}

		for (let c = 0; c < Math.min(spec.frozenCols, spec.colCount); c++) {
			const left = spec.rowHeadWidth + this.colOffset(spec, c);
			rules.push(`${h} .mg-cell.is-frozen-col[data-col="${c}"]{left:${left}px}`);
			rules.push(`${h} .mg-colhead.is-frozen-col[data-col="${c}"]{left:${left}px}`);
		}

		return rules.join("\n");
	}

	private rowOffset(spec: GeometrySpec, row: number): number {
		let sum = 0;
		for (let r = 0; r < row; r++) {
			const h = spec.rowHeights[String(r)];
			sum += h !== undefined && h > 0 ? h : spec.rowDefault;
		}
		return sum;
	}

	private colOffset(spec: GeometrySpec, col: number): number {
		let sum = 0;
		for (let c = 0; c < col; c++) {
			const w = spec.colWidths[c];
			sum += w !== undefined && w > 0 ? w : spec.colDefault;
		}
		return sum;
	}
}
