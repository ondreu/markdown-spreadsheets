import { GridView } from "../../src/view/GridView";
import { PivotView } from "../../src/view/PivotView";
import { Sidecar } from "../../src/store/Sidecar";
import { FormulaHelperModal, SheetImportModal } from "../../src/view/toolModals";
import type { ImportedSheet } from "../../src/feature/importTable";
import { TFile } from "obsidian";

const NOTE = `# Office move

| Task | Owner | Due | Qty | Unit price | Cost | Status |
| --- | --- | --- | ---: | ---: | ---: | :---: |
| Book the movers | [[Alice]] | 2026-11-10 | 1 | 1 200 | 1 200 %%=D2*E2%% | **Done** |
| Pack the archive | [[Bohdan]] | 2026-11-12 | 14 | 45 | 630 %%=D3*E3%% | In progress |
| Order new desks | [[Carla]] | 2026-11-14 | 6 | 3 490 | 20 940 %%=D4*E4%% | _Waiting_ |
| Network cabling | [[Dmitri]] | 2026-11-18 | 1 | 8 750 | 8 750 %%=D5*E5%% | Planned |
| Plants for the lobby | [[Alice]] | 2026-11-20 | 8 | 390 | 3 120 %%=D6*E6%% | Planned |
| Farewell party | [[Eva]] | 2026-11-21 | 1 | 2 500 | 2 500 %%=D7*E7%% | ~~Cancelled~~ |
| Update the \`wiki\` | [[Bohdan]] | 2026-11-24 | 1 | 0 | 0 %%=D8*E8%% | Planned |
| **Total** |  |  |  |  | **37 140** %%=SUM(F2:F8)%% |  |
`;
const file = Object.assign(new TFile(), { path: "Office move.md", name: "Office move.md", basename: "Office move", extension: "md" });
let text = NOTE;
const files = ["Alice", "Bohdan", "Carla", "Dmitri", "Eva", "Projects/Budget 2026", "Meetings/Kick-off"].map((n) =>
	Object.assign(new TFile(), { path: `${n}.md`, name: `${n}.md`, basename: n.split("/").pop(), extension: "md", parent: { path: n.includes("/") ? n.split("/")[0] : "/", isRoot: () => !n.includes("/") }, stat: { mtime: 0 } }),
);
const binaries = new Map<string, ArrayBuffer>();
const app: any = {
	scope: {},
	vault: {
		getFileByPath: (p: string) => (p === file.path ? file : null),
		cachedRead: async () => text,
		process: async (_f: unknown, fn: (d: string) => string) => (text = fn(text)),
		on: () => ({}),
		getFiles: () => files,
		getMarkdownFiles: () => files,
		// What an export writes: kept so a check can read the bytes back out of the page.
		createBinary: async (path: string, data: ArrayBuffer) => {
			binaries.set(path, data);
			(window as any).lastBinary = { path, data };
		},
		create: async (path: string, data: string) => {
			binaries.set(path, new TextEncoder().encode(data).buffer as ArrayBuffer);
			(window as any).lastBinary = { path, data };
		},
		getFolderByPath: () => ({ path: "/" }),
		createFolder: async () => {},
	},
	metadataCache: { fileToLinktext: (f: any) => f.basename, getFileCache: () => ({ tags: [{ tag: "#office" }, { tag: "#move" }] }) },
	workspace: { trigger: () => {}, getLeaf: () => ({}), openLinkText: async (t: string) => { (window as any).openedLink = t; } },
};
const store: { data: unknown } = { data: null };
const plugin: any = { loadData: async () => store.data, saveData: async (d: unknown) => (store.data = d), setStatusBarText: () => {}, clearStatusBar: () => {} };
(async () => {
	plugin.sidecar = new Sidecar(plugin);
	await plugin.sidecar.load();
	const params = new URLSearchParams(location.search);
	if (params.get("icons") === "1") plugin.sidecar.settings.ribbonStyle = "icons";
	const view = new GridView({ app, detach: () => {} } as any, plugin);
	await view.onOpen();
	await (view as any).openTable(file.path);
	(window as any).view = view;
	(window as any).host = (view as any).host;
	(window as any).noteText = () => text;
	// The screenshots only ever need one note; the sheet-tab check needs a second table.
	(window as any).setNote = (next: string) => {
		text = next;
	};
	(window as any).reloadTable = () => (view as any).openTable(file.path);
	// The pivot is a leaf of its own; the harness mounts it in place of the grid.
	(window as any).openPivotView = async (tableIndex = 0) => {
		const mount = document.getElementById("view");
		if (!mount) return false;
		mount.innerHTML = "";
		const leaf: any = { app, view: null };
		const pivot = new PivotView(leaf, plugin);
		leaf.view = pivot;
		await pivot.setState({ path: file.path, tableIndex }, {} as any);
		await pivot.onOpen();
		return true;
	};

	// The two dialogs of the workbook import and the formula helper, rendered by the same code the
	// plugin runs. They are here so their layout can be judged at desktop and phone widths.
	const sheetRow = (...cells: Array<string | { value: string; formula?: string }>) =>
		cells.map((cell) => (typeof cell === "string" ? { value: cell } : cell));
	const demoSheets: ImportedSheet[] = [
		{
			name: "Kalkulace",
			hidden: false,
			rows: [
				sheetRow("Položka", "Ks", "Cena", "Celkem"),
				sheetRow("Šroub M6", "120", "3.5", { value: "420", formula: "B2*C2" }),
				sheetRow("Matice M6", "120", "1.2", { value: "144", formula: "B3*C3" }),
				sheetRow("Podložka", "240", "0.4", { value: "96", formula: "B4*C4" }),
				sheetRow("Profil 40×40", "12", "289", { value: "3 468", formula: "B5*C5" }),
				sheetRow("Spojka", "36", "48", { value: "1 728", formula: "B6*C6" }),
				sheetRow("Doprava", "1", "2 900", { value: "2 900", formula: "VLOOKUP(A7,Rates!A:B,2,FALSE)" }),
				sheetRow("Montáž", "16", "450", { value: "7 200", formula: "B8*C8" }),
				sheetRow("Celkem", "", "", { value: "15 956", formula: "SUM(D2:D8)" }),
			],
		},
		{
			name: "Q1 (rozpis)",
			hidden: true,
			rows: [
				sheetRow("Měsíc", "Hodiny", "Sazba"),
				sheetRow("Leden", "168", { value: "420", formula: "B2*2.5" }),
				sheetRow("Únor", "152", { value: "380", formula: "B3*2.5" }),
			],
		},
		{ name: "Poznámky", hidden: false, rows: [] },
	];
	(window as any).openSheetImport = (multiple = true) => {
		new SheetImportModal(app, {
			fileName: "Kalkulace 2026.xlsx",
			sheets: demoSheets,
			multiple,
			formulas: true,
			target: multiple ? "Each sheet becomes its own table in the note, at the cursor." : "It is written into the grid starting at B2.",
			onSubmit: () => {},
		}).open();
	};
	(window as any).openFormulaHelper = () => {
		new FormulaHelperModal(app, {
			cellLabel: "D9",
			onInsert: (expr: string) => {
				(window as any).insertedFormula = expr;
			},
			attachSink: (sink) => (window as any).host?.setReferenceSink(sink),
		}).open();
	};
	/** Picks a function and fills its arguments, so a screenshot shows the form in use. */
	(window as any).fillFormulaDemo = (name: string, args: string[]) => {
		const item = Array.from(document.querySelectorAll<HTMLButtonElement>(".mds-function-item")).find((el) =>
			(el.textContent ?? "").startsWith(name),
		);
		item?.click();
		const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(".mds-formula-args input"));
		args.forEach((value, index) => {
			const input = inputs[index];
			if (input === undefined) return;
			input.value = value;
			input.dispatchEvent(new Event("input"));
		});
	};
	(window as any).ready = true;
})();
