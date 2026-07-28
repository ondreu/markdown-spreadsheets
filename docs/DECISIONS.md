# Implementation decisions

Where the code departs from `docs/design` (v0.4), and why. Everything else follows the spec as
written.

---

## 1. The grid is our own plain DOM, not `jspreadsheet-ce`

**Design:** §15.1 picks `jspreadsheet-ce` v5, with plain `<table>` plus own handlers named as the
fallback (§18, "Fallback je plain `<table>`, ne engine").

**Built:** the fallback, deliberately, from the start — `src/view/GridHost.ts`.

Reasoning:

- **Every constraint in §8–§10 fights the library.** CSS custom properties for column widths and
  a constructable stylesheet for row heights (§8.5), `activeDocument`/`ownerDocument` instead of
  the globals (§8.5/3), freeze via sticky offsets we compute, grow-on-demand (§9), an own undo
  stack (§13.2), a `Scope`-based key map (§10), paste through `evt.defaultPrevented` (§9). Each of
  those is something `jspreadsheet-ce` also does, its own way, on the global `document`.
- **The one risk §15.1 says to verify first is unverifiable from here.** "Does it work in an
  `ItemView` and in a popped-out window?" can only be answered by running Obsidian. Choosing the
  option that cannot fail that test removes the risk instead of deferring it.
- **D8 made it cheap.** Without virtualization the grid is a flex table with a selection model.
- **Bundle:** `main.js` is ~107 kB against the ~1 MB budget, with no runtime dependencies at all.

Cost: no library to inherit behaviour from, so keyboard and selection semantics are ours to get
right. Mitigated by keeping every model mutation behind `GridHost.mutate()` and unit-testing the
operations directly.

## 2. Own parser and serializer instead of `@tgrosinger/md-advanced-tables`

**Design:** §6 says to use the library and not write our own.

**Built:** `src/model/parse.ts` and `src/model/serialize.ts`, ~250 lines together.

§6 then specifies the algorithm itself — the manual character scan for escaped pipes (because
`regex-lookbehind` rules out `/(?<!\\)\|/`), the exact serializer steps, and a sparse cell map
where an empty cell is absent. `md-advanced-tables` is built around a text-buffer/cursor model for
formatting a table in place in an editor, not around "markdown ↔ sparse cell map", so adapting it
would have been more code than implementing §6 directly — and every line of it would still have
needed the round-trip suite that now covers 19 pathological tables.

## 3. Own XLSX writer instead of `exceljs`

**Design:** §14 picks `exceljs` with a lazy import, and names "vlastní minimální XLSX zipper" as
the fallback if Node builtins get in the way.

**Built:** the fallback — `src/feature/zip.ts` (stored-only ZIP, ~150 lines) plus
`src/feature/exportXlsx.ts`.

Reasoning: `no-nodejs-modules` only tolerates Node builtins behind a `Platform.isDesktop` guard,
and an esbuild shim for `stream`/`zlib`/`buffer` is exactly the kind of thing that breaks on an
app update. D1 already removed the features `exceljs` would be buying us — no colours, no merged
cells — so what remains is cell values, column widths, a bold frozen header row and per-column
alignment. That is a few XML files in a zip, worth ~10 kB rather than ~1 MB, with no lazy-load
path to get wrong. `tests/export.test.ts` walks the produced archive, verifies every CRC, and the
output has been re-read with an independent ZIP implementation.

## 4. Open questions from §17, resolved

**§17/1 — saving.** Autosave is the default, exactly as §13.2 describes (800 ms debounce, plus on
`onClose` and on tab blur). Because the section flags the cost for git-tracked vaults and Obsidian
Sync, `saveMode: 'manual'` is also a setting: the status bar then shows an explicit *Unsaved*
state and waits for Ctrl+S or the `Save grid to note` command.

**§17/2 — popout windows.** Supported. Every document and window reference goes through
`ownerDocument` / `ownerDocument.defaultView` (or `.win`), which is what decision 1 above buys.

**§17/3 — publishing.** Built to community-store standards: the Obsidian ESLint plugin is a
blocking CI step at zero errors *and* zero warnings, and the naming, manifest and release rules of
§15.3 are followed. BRAT or manual installation works from the same artefacts.

## 5. Smaller deviations

- **`anchorStrategy` semantics (§7, layer 3).** The setting reads as three thresholds for the same
  offer rather than three different mechanisms: `fingerprint` (default) offers a block ID after
  the *second* failed layer-2 resolution for a file, `ask` offers on the first, `blockId` adds one
  when a table is opened. Nothing is ever added without an explicit confirmation except under
  `blockId`, which is itself an explicit opt-in.
- **External change with nothing unsaved.** §13.2 says an externally changed region raises the
  conflict banner and is never resolved automatically. That applies when the grid has unsaved
  edits. When it does not, the note's version is adopted and a notice says so — there is nothing
  to lose, and a banner demanding a decision between two identical outcomes is worse.
- **Rows longer than the header.** GFM drops the overflow cells. The parser keeps them, so opening
  and saving such a table widens the header instead of silently deleting a user's text. Covered by
  a round-trip test.
- **Column cap of 128.** Column widths rely on one pre-generated CSS rule per index (§8.5/1), so
  the cap is whatever `styles.css` was generated for. `scripts/gen-styles.mjs` reads `MAX_COLS`
  from `src/view/constants.ts`; CI fails if the committed CSS is stale.
- **Tab title after a rename.** The view follows the renamed file correctly, but Obsidian's typed
  API has no supported way to force a tab header repaint, so the tab keeps its original label
  until it is reopened. Cosmetic only.
- **`setDestructive()`** would raise `minAppVersion` to 1.13.0 for one button style, so the banner
  and modal use the `mod-warning` class directly.
- **`getSettingDefinitions()`** (Obsidian 1.13+ declarative settings) is not in the `obsidian`
  typings this builds against, and `minAppVersion` is below 1.13, where `display()` is the correct
  implementation. `settings-tab/prefer-setting-definitions` is switched off in `eslint.config.mjs`
  with that reasoning; `settings-tab/require-display` keeps us honest.

## 6. Still only answerable by running Obsidian

§16 lists four of these; three now have a definite answer and one does not.

1. ~~Does `jspreadsheet-ce` behave in an `ItemView` and a popout?~~ Not applicable — decision 1.
2. ~~Does `exceljs` survive esbuild?~~ Not applicable — decision 3.
3. **Does `adoptedStyleSheets` work in the Obsidian renderer and in a popout?** Handled either
   way: `GridStyles` probes for it at mount, falls back to per-row `setCssStyles` (the sanctioned
   dynamic-style API, so no lint exception is needed), and the status bar says which path is live.
4. **Do the §7 scoring weights hold up on real notes?** Open, as the design predicts. The weights
   are the spec's, the decisive margin is 30, and everything below it asks the user. The failure
   mode is therefore "asks too often", not "opens the wrong table" — `tests/anchor.test.ts`
   pins that direction.

## 7. Renamed to Markdown Spreadsheets

**Design:** §15.3 fixes the naming rules, not the name; the plugin shipped 0.1.0 as
`markdown-grid` / "Markdown Grid".

**Built:** `markdown-spreadsheets` / "Markdown Spreadsheets", matching the repository.

What the rename touches, and the cost of each:

- **`manifest.json` `id`.** Obsidian keys the plugin folder and `loadData()`/`saveData()` off it,
  so an existing 0.1.0 install becomes a second, separate plugin and its sidecar — column widths,
  row heights, freeze state, the ten backups per table — is not carried over. Nothing in the notes
  is affected, because none of that ever lived there (§8.4). Uninstall the old one.
- **`VIEW_TYPE`,** now `markdown-spreadsheet-view`. A saved workspace that had a grid tab open
  reopens it as an empty pane once; closing and reopening the table fixes it for good.
- **The CSS prefix,** `mg-` → `mds-`, including the generated per-column rules. A user snippet
  written against the old class names needs the same substitution.

## 8. Rendered cells by default

**Design:** §5 makes raw the default and calls rendered mode the perf risk.

**Built:** `defaultRenderMode: "rendered"`.

The risk §5 names is real but bounded by what is already implemented: only cells that intersect
the viewport are rendered, and identical content is rendered once and cloned by content hash. What
§5 did not weigh is the cost of the other default — a column of wikilinks or footnotes is close to
unreadable as raw text, which is most of the value of a grid view gone. `Home ▸ Raw` toggles per
tab and the setting flips the default back; editing a cell always shows the raw Markdown, so the
D2 hazard (a WYSIWYG round trip) never arises.

## 9. The ribbon is not laid out like Excel's

**Design:** §11 describes Excel's ribbon — groups with the label under the buttons, every action a
labelled button.

**Built:** the same four tabs and the same grouping, presented as a segmented tab control with the
group name above its actions, related actions folded into segmented icon clusters (alignment,
emphasis, insert/delete, freeze), and the whole panel collapsible from the tab strip.

The tab and group structure of §11 is what makes the surface learnable; the button-per-action
rendering of it is what made four tabs of dense text unreadable. Icon clusters keep every action
one click away with its name in the tooltip and its `aria-label`, which is also what the
accessibility side of review asks for. `ribbonCollapsed` is a setting so the choice survives a
restart.

## 10. Grouping separators are validated, so dates are not numbers

`parseNumber` used to strip a repeated separator as grouping without checking the digit runs, so
`07.07.2026` parsed as 7 072 026 and Excel export wrote `07072026`. A separator is now only
dropped when the runs it separates are real thousands groups (1–3 digits, then exactly 3), which
keeps dotted dates, `1.2.3` and `10.000.5` on the text path. Dates are exported as text rather
than as Excel serial numbers on purpose: `07.07.2026` and `07/07/2026` cannot be told apart
without guessing a locale, and guessing wrong silently rewrites the day and the month.

## 11. The in-note button decorates the rendered DOM only

`Table ▸ Edit` on a note's table is a Markdown post processor: it wraps the rendered `<table>` and
adds a hover button. The note's text is never touched, which keeps it inside the §7 rule that the
note is only marked up on explicit opt-in — a block ID still needs confirmation. The source line
comes from `getSectionInfo`, so the button opens the table it sits on instead of an index guess; a
table inside a callout or an embed has no section info and falls back to the picker.
