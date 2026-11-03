// Drives page.html (the real GridView on a shim of the Obsidian API) and writes the README images
// into the directory given as the first argument. Set CHROMIUM to a browser binary when the
// Playwright that resolves here has no browser of its own.
const { chromium } = require("playwright");
const out = process.argv[2];
const launchOptions = process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {};
async function open(b, theme) {
	const p = await b.newPage({ viewport: { width: 1200, height: 580 }, deviceScaleFactor: 2 });
	p.on("pageerror", (e) => console.log("ERR", String(e)));
	await p.goto("file://" + process.cwd() + "/page.html");
	await p.evaluate((t) => { document.body.className = t; }, theme);
	await p.waitForFunction(() => window.ready === true);
	await p.waitForTimeout(400);
	return p;
}
const tab = (p, label) => p.locator(".mds-ribbon-tab", { hasText: label }).click();
const shoot = (p, name) => p.locator("#view").screenshot({ path: `${out}/${name}.png` });
(async () => {
	const b = await chromium.launch(launchOptions);
	let p = await open(b, "theme-light");
	await p.evaluate(() => { window.host.goTo(1, 3); window.host.moveActive(4, 2, true); });
	await p.waitForTimeout(150);
	await shoot(p, "grid-light");
	await tab(p, "Data");
	await p.locator('.mds-colhead[data-col="6"]').hover();
	await p.locator('.mds-colhead[data-col="6"] .mds-colhead-filter').click();
	await p.waitForTimeout(200);
	await shoot(p, "filter");
	await p.keyboard.press("Escape");
	await p.mouse.click(5, 5);
	await tab(p, "Calculate");
	await p.evaluate(() => window.host.goTo(8, 5));
	await p.waitForTimeout(150);
	await shoot(p, "formula");
	await tab(p, "Home");
	await p.evaluate(() => { window.host.goTo(3, 1); window.host.focus(); });
	await p.keyboard.type("[[Me");
	await p.waitForTimeout(150);
	await shoot(p, "suggest");
	await p.keyboard.press("Escape");
	await p.keyboard.press("Escape");
	await p.close();
	p = await open(b, "theme-dark");
	await p.evaluate(() => { window.host.goTo(2, 0); window.host.moveActive(2, 1, true); });
	await p.waitForTimeout(150);
	await shoot(p, "grid-dark");
	console.log("done");
	await b.close();
})();
