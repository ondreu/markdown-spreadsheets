// Checks the three reported formula faults against the real GridView in headless Chromium.
// Run from tools/screenshots (page.html loads bundle.js and styles.css relatively).
const { chromium } = require("playwright");
const path = require("node:path");
const here = __dirname;
const launchOptions = process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {};

const TWO = `# Two tables

| Item | Qty |
| --- | --- |
| A | 1 |
| B | 2 |
| C | 3 |

Text between the tables.

| Item | Price |
| --- | --- |
| X | 10 |
| Y | 20 |
| Z | 30 |
`;

const results = [];
const check = (name, ok, detail) => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${detail}`}`);
};

const cell = (r, c) => `.mds-cell[data-row="${r}"][data-col="${c}"]`;

(async () => {
	const b = await chromium.launch(launchOptions);
	const open = async () => {
		const page = await b.newPage({ viewport: { width: 1200, height: 700 } });
		page.on("pageerror", (e) => console.log("PAGEERROR", String(e)));
		await page.goto("file://" + path.join(here, "page.html"));
		await page.waitForFunction(() => window.ready === true);
		await page.waitForTimeout(300);
		return page;
	};
	const box = async (p, r, c) => p.locator(cell(r, c)).boundingBox();
	const dragCells = async (p, r1, c1, r2, c2) => {
		const a = await box(p, r1, c1);
		const z = await box(p, r2, c2);
		await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
		await p.mouse.down();
		await p.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 6 });
		await p.mouse.up();
		await p.waitForTimeout(80);
	};
	const bar = (p) => p.locator(".mds-formula-input");
	const barValue = (p) => bar(p).inputValue();
	const note = (p) => p.evaluate(() => window.noteText());

	/* 1 — a range pointed into =SUM( is closed on Enter */
	let p = await open();
	await p.evaluate(() => {
		window.view.host.goTo(9, 5);
		window.view.host.focus();
	});
	await p.keyboard.type("=SUM(");
	await dragCells(p, 2, 3, 5, 3);
	const pointed = await barValue(p);
	check("range is written into the formula", pointed === "=SUM(D3:D6", pointed);
	await p.keyboard.press("Enter");
	await p.waitForTimeout(1400);
	let text = await note(p);
	check("Enter closes the bracket", /29 %%=SUM\(D3:D6\)%%/.test(text), text.split("\n").find((l) => l.includes("D3:D6")) ?? "(no line)");

	/* 3 — the formula bar suggests function names, and Enter accepts one */
	await p.evaluate(() => window.view.host.goTo(1, 1));
	await bar(p).click();
	await bar(p).fill("");
	await p.keyboard.type("=SU");
	await p.waitForTimeout(150);
	const listOpen = await p.locator(".mds-suggest").isVisible();
	const firstItem = listOpen ? await p.locator(".mds-suggest-item").first().innerText() : "";
	check("the formula bar shows a suggestion list", listOpen && /SUM/.test(firstItem), `${listOpen} / ${firstItem.replace(/\n/g, " ")}`);
	await p.keyboard.press("Enter");
	await p.waitForTimeout(150);
	check("Enter in the bar accepts the suggestion, not the cell", (await barValue(p)) === "=SUM(", await barValue(p));
	// The same flow in the table the formula belongs to: no table in front of the address.
	await p.keyboard.press("Escape");
	await p.waitForTimeout(100);
	await p.evaluate(() => {
		window.view.host.goTo(8, 5);
		window.view.host.focus();
	});
	await bar(p).click();
	await bar(p).fill("");
	await p.keyboard.type("=SUM(");
	await p.waitForTimeout(100);
	await dragCells(p, 1, 3, 3, 3);
	check("pointing in the same table adds no table prefix", (await barValue(p)) === "=SUM(D2:D4", await barValue(p));
	await p.keyboard.press("Enter");
	await p.waitForTimeout(1400);
	text = await note(p);
	check("the same-table formula lands in the cell the bar was opened on", /\*\*21\*\* %%=SUM\(D2:D4\)%%/.test(text), text.split("\n").find((l) => l.includes("D2:D4")) ?? "(no line)");
	await p.close();

	/* 2 — a formula survives a sheet switch and points at the other table */
	p = await open();
	await p.evaluate((t) => window.setNote(t), TWO);
	// The strip is rebuilt from the note; opening the file again would ask which table it means.
	await p.evaluate(() => window.view.refreshSheets());
	await p.waitForTimeout(300);
	await p.evaluate(() => {
		window.view.host.goTo(1, 1);
		window.view.host.focus();
	});
	await bar(p).click();
	await bar(p).fill("");
	await p.keyboard.type("=SUM(");
	await p.waitForTimeout(100);
	await p.locator(".mds-sheet").nth(1).click();
	await p.waitForTimeout(500);
	const switched = await p.evaluate(() => window.view.anchor.tableIndex);
	const banner = await p.evaluate(() => document.querySelector(".mds-banner")?.innerText ?? "");
	check("the tab switch shows the other table", switched === 1, `tableIndex=${switched} banner=${banner}`);
	check("the draft is still in the bar after the switch", (await barValue(p)) === "=SUM(", await barValue(p));
	const secondHead = await p.locator(cell(0, 1)).innerText();
	check("the grid shows the second table", /Price/.test(secondHead), secondHead);
	await dragCells(p, 1, 1, 3, 1);
	const crossRef = await barValue(p);
	check("pointing in the other table prefixes the table", crossRef === "=SUM(Table2!B2:B4", crossRef);
	await p.keyboard.press("Enter");
	await p.waitForTimeout(1600);
	text = await note(p);
	const backOnFirst = await p.evaluate(() => window.view.anchor.tableIndex);
	check(
		"Enter lands the formula in its own table",
		backOnFirst === 0 && /60 %%=SUM\(Table2!B2:B4\)%%/.test(text),
		`tableIndex=${backOnFirst}\n${text}`,
	);
	await p.close();

	await b.close();
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
	process.exit(failed.length === 0 ? 0 : 1);
})();
