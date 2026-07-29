# Working in this repository

An Obsidian plugin that edits a GFM table in a spreadsheet-style grid and writes it back.
`docs/design` is the specification and it is binding. `docs/DECISIONS.md` records where the
implementation departs from it and why — read that before "fixing" an apparent deviation.

For the current state of the work and what is open, see `docs/HANDOFF.md`.

## Non-negotiables

These are the invariants the design is built on. Breaking one is a design change, not a bug fix,
so raise it rather than quietly doing it.

1. **The note is the source of truth.** Nothing goes into it that GFM cannot express natively: no
   HTML, no merged cells, no colours, no per-cell alignment, no live formulas (D1, D2).
2. **All writes go through `Writer` and `vault.process`.** Never `read()` + `modify()` — that pair
   loses whatever another writer did in between. The anchor is re-resolved and the region hashed
   *inside* the callback, on the exact string about to be replaced (§13.1).
3. **A changed region is never resolved automatically.** Hash mismatch with unsaved edits means the
   conflict banner. The one exception, already implemented and documented, is adopting the note's
   version when the grid has nothing unsaved.
4. **Never guess which table.** The fingerprint winner needs a lead of `DECISIVE_MARGIN` (30);
   anything closer asks the user. Failing towards "asks too often" is correct.
5. **The note is only marked up on explicit opt-in.** Block IDs (§7 layer 3) are never added
   without confirmation.
6. **Row 0 is the markdown header** and cannot be deleted or pushed down. GFM requires it.
7. **`Cell.raw` is raw markdown.** No WYSIWYG round trip through rich text — that is a source of
   silent loss (§5).
8. **The cell map stays sparse.** An empty cell is absent, never a whitespace entry.
9. **Every model mutation goes through `GridHost.mutate()`**, which snapshots for undo, recomputes
   the used range, and marks the note dirty. There is no other path.
10. **No network, no telemetry, no remote code, no runtime dependencies.** All four are load-bearing
    for the community-store review, and `package.json` has an empty `dependencies`.

## Obsidian conventions that shape the code

`eslint-plugin-obsidianmd` runs as a **blocking CI step at zero errors and zero warnings**. It is
not cosmetic — roughly half its rules are real popout-window and memory-leak bugs. Consequences
that are easy to trip over:

- **No lookbehind in regex.** That is why pipe splitting is a manual character scan (§6).
- **No inline styles.** Sizes go through `setCssProps` on a container against pre-generated
  per-index rules, or through the constructable stylesheet in `GridStyles` (§8.5). `setCssStyles`
  is the sanctioned escape hatch for genuinely dynamic geometry.
- **No `<style>` or `<script>` elements** in the DOM. Styles live in `styles.css`.
- **Every class the plugin adds is prefixed `mds-`,** including the generated per-column rules.
- **A multi-line `<button>` needs its geometry reset.** Obsidian's own `button` rule fixes the
  height at 30 px with `white-space: nowrap` and centred text, so a list item built from a button
  spills its last line over the item below unless it sets `height: auto`, `min-height: 0`,
  `white-space: normal` and `text-align: left`. That is what broke the restore list.
- **A scrolling list needs `flex: 0 0 auto` on its items**, and this is the half that only shows up
  once the list is long. Both modal lists are flex columns with a `max-height`, so the items'
  default `flex-shrink: 1` squeezed them *below their own content* as soon as they stopped fitting
  — `overflow-y: auto` never scrolled, because shrinking removed the overflow first. Thirteen table
  candidates collapsed to 19 px each and every line painted over the item below it. Verify a list
  at the length that overflows it, not at three items.
- **`ownerDocument` / `ownerDocument.defaultView` / `.win`, never the globals.** A popped-out
  window is a different document with its own class identities. Narrow event targets with
  `asElement` / `asNode` from `src/view/dom.ts`, not `instanceof HTMLElement`.
- **`window.setTimeout`, not `activeWindow.setTimeout`** — what `prefer-window-timers` wants.
- **Obsidian DOM helpers**, not `document.createElement`: `createDiv`, `createEl`, `createSpan`,
  `win.createFragment`. `src/obsidian-augment.d.ts` declares the per-window forms.
- **Sentence case for every UI string.** Brand names stay capitalised — the rule wants
  "Markdown", "Obsidian", "Excel", "Windows", "Git" — but ordinary words after the first do not.
  Do not prefix notices with the plugin name; the rule reads it as prose.
- **`MarkdownRenderer.render()` gets the view as its component**, never the plugin.
- **The plugin never holds a view instance.** Ask `workspace.getLeavesOfType()`.
- **No `detachLeavesOfType()` in `onunload()`.** Closing the user's tabs is not the plugin's call.
- **Commands have no default hotkeys.** In-view keys live in the view's `Scope`.
- **Sidecar goes through `loadData()` / `saveData()`**, never a hand-built path into `.obsidian`.
- **`no-unsupported-api` polices `minAppVersion`.** Using a newer API means raising it in
  `manifest.json` — a decision with a user cost, so weigh it. `setDestructive()` was skipped for
  exactly this reason; the `mod-warning` class does the job.

When a rule genuinely does not apply, switch it off in `eslint.config.mjs` with the reasoning in a
comment (see the two existing cases). Inline `eslint-disable` for `ui/sentence-case` is refused by
the config on purpose — reword instead.

## Commands

```bash
npm run check    # styles + tsc + eslint + tests + production build — what CI runs
npm test
npm run dev      # watch build
npm run styles   # regenerate styles.css; CI fails if the committed file is stale
```

`styles.css` is **generated** from `src/styles.src.css` by `scripts/gen-styles.mjs` and committed
as the release artefact. Edit the source, never `styles.css`. The generator reads `MAX_COLS` from
`src/view/constants.ts` to emit one rule per column index, which is what caps columns at 128.

Releasing: `RELEASING.md`. Short version — `node scripts/bump-version.mjs <semver>`, push, then
either push a tag named exactly like the version (no `v` prefix) or run the Release workflow with
`confirm=release`.

## Where things live

```
src/model/     parse, serialize, sparse cell map, addressing, locale numbers   (no Obsidian imports)
src/file/      table scanning, anchor scoring, the write path                  (Writer needs Vault)
src/store/     Sidecar: cosmetic per-table state through loadData/saveData
src/feature/   row/column ops, undo, aggregation, clipboard TSV, CSV, XLSX + zip
src/view/      GridView (orchestration), GridHost (the grid), Ribbon, StatusBar, modals, gridStyles,
               SettingTab
```

`src/model/`, `src/feature/`, `src/store/`, `src/settings.ts` (types and defaults only; the tab
lives in `src/view/SettingTab.ts`) and `src/file/scanTables.ts`/`AnchorResolver.ts` are free of
Obsidian imports and directly unit-testable — keep them that way. Put new logic there rather than
in the view when there is a choice; that is what makes the 190 tests possible without an Obsidian
harness.

## Testing expectations

- **Round-trip stability is mandatory** (§6): `serialize(parse(x))` must equal
  `serialize(parse(serialize(parse(x))))`. Any parser or serializer change adds a case to the
  pathological-table list in `tests/parse-serialize.test.ts`.
- **Insert/delete must reindex** `colWidths`, `rowHeights` and `wrapCols`. §8.4 calls this out as
  easy to forget and miserable to debug; `tests/ops.test.ts` covers it. Extend it for any new
  structural operation.
- **The write path gets integration tests** against the `FakeVault` in `tests/writer.test.ts` —
  conflict, drift, missing table, CRLF, repeated cycles. §16 says never to cut this.
- Tests run in plain Node with no DOM. `GridHost` and `GridView` are therefore not unit-tested;
  that is the deliberate trade for having no Obsidian test harness, and it is why the logic they
  call lives elsewhere.

## Reviewing your own changes

Ask specifically: can this lose data? §16 closes with the real risk — the write-back path fails
rarely and quietly. A conflict during concurrent editing, anchor drift after a sync, sizes
reindexed wrong after a column delete: none of it shows up on the first table, and all of it shows
up a month later on the one that matters.
