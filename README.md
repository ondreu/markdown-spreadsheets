# Markdown Grid

Edit Markdown tables in a spreadsheet-style grid in a dedicated tab.

The note is the source of truth. Nothing is written into it that GFM cannot express natively —
no HTML, no merged cells, no cell colours, no live formulas. What comes back out is a strictly
valid GitHub-Flavored Markdown table.

## What it does

- **Opens a table in its own tab** — from the command palette, the editor context menu, or the
  file menu. A ribbon of tabs, an infinite grid, keyboard navigation, resizable cells.
- **Writes back as valid GFM.** The pipes are realigned to the widest cell, alignment markers come
  from the column alignment, and there is never any trailing whitespace.
- **Finds the same table again** after you have edited the note above it, without marking up your
  note. If two tables are genuinely indistinguishable, it asks instead of guessing.
- **Never resolves a conflict on its own.** If the table changed in the note while the grid was
  open, you get the choice, not a silent overwrite.
- **One-off calculations.** The status bar shows Sum · Avg · Count of the selection; `Calculate`
  inserts a literal result into a cell you pick.
- **Exports** to CSV (RFC 4180, delimiter and BOM you choose) and Excel.

## What it deliberately does not do

Markdown tables cannot express these, so the plugin does not pretend otherwise:

| Spreadsheet feature | Why not |
| --- | --- |
| Row 1 as data | GFM requires a header row. Row 1 is the header, always. |
| Merged cells | No GFM equivalent. There is no button for it. |
| Multi-line cell content | A GFM cell is one line. Text wrap in the grid is visual only. |
| Per-cell alignment | GFM aligns per column. The alignment buttons apply to the whole column. |
| Cell colours and fonts | No GFM equivalent. |
| Number formats | A cell is text. Formatting a number rewrites the cell's content. |
| Live formulas | No GFM equivalent. `Calculate` inserts a value, once, and it does not update. |

Column widths, row heights, wrap flags and freeze settings are cosmetic and live in the plugin's
own data, not in your note. Move the note to another vault and it stays perfectly readable — just
without the remembered sizes.

## Getting started

1. Put the cursor in a Markdown table.
2. Run **Open table in grid** from the command palette, or right-click and pick it from the menu.
3. Edit. In automatic save mode the note is updated shortly after you stop typing.

### Keys inside the grid

| Key | Action |
| --- | --- |
| Arrows | Move |
| Shift+arrows | Extend the selection |
| Ctrl/Cmd+arrows | Jump to the edge of the data |
| Tab / Shift+Tab | Next / previous cell |
| Enter / Shift+Enter | Down / up |
| F2, or just type | Edit the cell |
| Esc | Cancel the edit |
| Delete | Clear the selected cells |
| Ctrl/Cmd+C / X / V | Copy, cut, paste as tab-separated text |
| Ctrl/Cmd+A | Select the used range |
| Ctrl/Cmd+Z / Y | Undo, redo (the grid keeps its own history) |
| Ctrl/Cmd+S | Write back to the note |
| Ctrl/Cmd+B / I | Bold, italic |

Copy and paste use tab-separated text, so a range moves between the grid and Excel, LibreOffice or
Google Sheets in both directions.

### Resizing

Drag the border in the column or row header. Double-click a border to fit the content. Select
several columns or rows first to size them all alike. `Table ▸ Column width` takes an exact number.

## Things worth knowing

- **Undo in the note is coarse.** The grid has its own undo stack. Obsidian's undo in the note
  knows nothing about it, so after a write, Ctrl+Z in the note undoes the whole write as one step.
- **A sparse table gets a warning.** A value in `Z400` forces every cell above and to the left of
  it to be written, because GFM tables are always rectangular. You will be told how many empty
  cells that adds, and offered `Shrink to actual data`.
- **The last ten versions are kept.** `Restore previous version` brings back an earlier state of
  the table into the grid; nothing reaches the note until the next save.
- **Filtering is display-only.** Hidden rows are still written back.
- **Desktop only** in this version.
- **Aimed at tables up to roughly 500 rows.** There is no virtualization; the grid stops growing
  at 2000 rows and 128 columns.

## Settings worth changing

- **Save mode** — automatic by default. Switch to manual if your vault is under Git or Obsidian
  Sync and you would rather not have a revision per keystroke.
- **Anchor strategy** — how hard to try before offering to add a permanent `^grid-xxxx` marker to
  your note. Nothing is added without asking.
- **CSV delimiter and byte order mark** — a semicolon and a BOM by default, which is what Excel
  needs in locales that use the comma as a decimal mark.
- **Number locale and decimal separator** — how `1 234,56` is read and how results are written.

## No network, no telemetry

The plugin makes no network requests, loads no remote code, collects nothing and has no runtime
dependencies.

## Development

```bash
npm install
npm run dev     # watch build
npm run check   # styles + typecheck + lint + tests + production build
npm test
```

`npm run check` is what CI runs. The Obsidian ESLint plugin is blocking at zero errors and zero
warnings.

Release: `node scripts/bump-version.mjs <semver>`, then tag the commit with the version **exactly**
— `1.0.0`, never `v1.0.0` — and attach `main.js`, `manifest.json` and `styles.css` as separate
files.

`styles.css` is generated from `src/styles.src.css` by `scripts/gen-styles.mjs` and committed; CI
fails if it is stale.

- `docs/design` — the specification this implements.
- `docs/DECISIONS.md` — where the implementation departs from it, and why.

## Third-party attribution

None. There are no runtime dependencies. The build-time tools (esbuild, TypeScript, ESLint,
`eslint-plugin-obsidianmd`, Vitest) are all MIT-licensed and are not bundled into `main.js`.

The design credits `@tgrosinger/md-advanced-tables` and `ganesshkumar/obsidian-table-editor` (both
MIT) as prior art; see `docs/DECISIONS.md` for why neither ended up as a dependency.

## Licence

MIT — see `LICENSE`.
