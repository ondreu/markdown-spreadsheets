import { GridView } from "../../src/view/GridView";
import { Sidecar } from "../../src/store/Sidecar";
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
const app: any = {
	scope: {},
	vault: {
		getFileByPath: (p: string) => (p === file.path ? file : null),
		cachedRead: async () => text,
		process: async (_f: unknown, fn: (d: string) => string) => (text = fn(text)),
		on: () => ({}),
		getFiles: () => files,
		getMarkdownFiles: () => files,
	},
	metadataCache: { fileToLinktext: (f: any) => f.basename, getFileCache: () => ({ tags: [{ tag: "#office" }, { tag: "#move" }] }) },
	workspace: { trigger: () => {}, getLeaf: () => ({}) },
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
	(window as any).ready = true;
})();
