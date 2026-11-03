# Handoff

State as of **3 November 2026**, on `main`, version **0.4.0**.

This file goes stale. `CLAUDE.md` holds the durable rules; this one holds what is done, what is
not, and what to look at first.

## Where things stand

The plugin is complete against `docs/design` v0.4 — all ten steps of §16, not just the 1–6 the
design scopes to one session, plus the feature list of round six. 0.4.0 is the first release with
formulas, the header filter and the redesigned ribbon; 0.5.0 is the first that runs on mobile
(round seven).

| | |
| --- | --- |
| Source | ~13 500 lines across 42 files |
| Tests | 352, in 13 files |
| Lint | `eslint-plugin-obsidianmd` at 0 errors, 0 warnings |
| Bundle | `main.js` 228 kB against the ~1 MB budget of §15.1 |
| Runtime dependencies | none |
| Release | [0.5.0](https://github.com/ondreu/markdown-spreadsheets/releases/tag/0.5.0), three assets. 0.1.0 was published under the old `markdown-grid` id |

`npm run check` was green at this commit, and the released assets' SHA-256 digests matched a local
build byte for byte.

## What has never run inside Obsidian

**This is the important part of the handoff.** Every line was written and tested outside Obsidian.
The model, file and feature layers are covered by unit and integration tests, but nothing has been
loaded into the app. Expect the first real session to be about the view layer.

Install it before doing anything else — `RELEASING.md` has the manual and BRAT routes — and check,
roughly in this order:

1. **Does `GridHost` mount and behave in an `ItemView`?** Sticky headers and frozen rows and
   columns rely on `position: sticky` inside a flex row within the scroll container. If the freeze
   offsets are wrong, they come from `GridStyles.buildCss` and the constants in
   `src/view/constants.ts` (`HEAD_HEIGHT`, `ROW_HEAD_WIDTH`), which are assumed, not measured.
2. **Does `adoptedStyleSheets` work in the Obsidian renderer, and in a popped-out window?** §8.5's
   open question. `GridStyles.attach` probes it and falls back to per-row `setCssStyles`; the
   status bar says "Row sizing uses the fallback path" when it did. If the fallback is in use,
   find out why before accepting it.
3. **Does the view `Scope` capture the keys it should, and only those?** `shouldIgnoreKey()` bails
   out when focus is in any input inside the view. The interaction between the `Scope` handlers and
   the cell editor's own `keydown` is the part most likely to need adjusting.
4. **Do the clipboard events fire?** Copy/cut/paste are DOM events on the scroll container, which
   needs focus. `Ctrl+C` is deliberately *not* registered in the `Scope` so the native `copy` event
   can happen. The ribbon buttons use `navigator.clipboard` instead and may need a permission the
   DOM path does not.
5. **Is rendered mode usable?** Off by default for the reason in §5. It renders only cells that
   intersect the viewport and caches by content hash, but "hundreds of `MarkdownRenderer` calls" is
   still the plausible way to make this view feel slow.
6. **Do the §7 scoring weights hold up on real notes?** The one open question the design predicts
   will survive. They are the spec's numbers, untuned. Collect the cases where the picker appears
   and it should have been obvious.

## Deliberate deviations — do not "fix" these

Full reasoning in `docs/DECISIONS.md`. In short:

- The grid is **our own plain DOM**, not `jspreadsheet-ce`. This is the fallback §18 names, chosen
  up front because every constraint in §8–§10 fights the library and because the risk §15.1 says to
  verify first cannot be verified without running Obsidian.
- **`parse.ts` / `serialize.ts` are ours**, not `@tgrosinger/md-advanced-tables`. §6 specifies the
  algorithm anyway.
- **XLSX uses an own stored-only zip writer**, not `exceljs` — §14's named fallback, taken to avoid
  the Node-builtin problem `no-nodejs-modules` creates.

§17's three open questions are resolved there too: autosave with a manual mode, popout supported,
built to community-store standards.

## Known gaps and rough edges

Small, honest, and none of them data-affecting:

- **Tab title after a rename.** The view follows the renamed file, but Obsidian's typed API has no
  supported way to force a tab header repaint, so the label stays stale until the tab is reopened.
- **`getSettingDefinitions()`** (Obsidian 1.13+ declarative settings) is not implemented — it is
  absent from the typings we build against, and `minAppVersion` is 1.7.2 where `display()` is
  correct. `settings-tab/prefer-setting-definitions` is off in `eslint.config.mjs` for that reason.
  Revisit when `minAppVersion` reaches 1.13.
- **128-column cap**, because column widths need one pre-generated CSS rule per index. Raising it
  is one constant in `src/view/constants.ts` plus regenerating `styles.css`.
- **`GridHost` and `GridView` have no unit tests** — no DOM in the test environment. Logic worth
  testing belongs in the Obsidian-free layers.
- **Row heights are measured, not predicted**, so `autofitRows` depends on the DOM already being
  laid out. It is called after a paint in every current path; a new caller may need to wait.

## Not done, and not asked for

- **Community-store submission.** Pre-flight is done and verified item by item in `RELEASING.md`,
  including the `community-plugins.json` entry to copy. What is left is the fork and the pull
  request against `obsidianmd/obsidian-releases`, which needs the author's GitHub account.
- ~~**Mobile.**~~ Done in round seven: `isDesktopOnly: false` and a touch layout (decision 24).

## If you are picking this up cold

Read in this order: `docs/design` §2 (the decisions), §3 (what GFM cannot do — it explains most of
the design), §13 (the write path, which matters more than the whole ribbon), then `CLAUDE.md`.
Then install the plugin and work down the list above.

## Round two: what the first real session in Obsidian produced

The plugin was installed and used. Nine things came back; all nine are addressed on
`claude/markdown-spreadsheets-plugin-3xpmnl`, and the two that are answers rather than code are
marked as such.

1. **Renamed** to `markdown-spreadsheets` / "Markdown Spreadsheets" — decision 7 in
   `docs/DECISIONS.md` lists what the new `id`, view type and CSS prefix cost an existing install.
2. **The ribbon was rebuilt** — segmented tabs with icons, group names above their actions, icon
   clusters for alignment/emphasis/insert/delete/freeze, a collapse toggle persisted in
   `ribbonCollapsed`. Decision 9.
3. **Alignment did nothing.** `buildCell` applied `is-align-*` once at build time and `paintCell`
   never touched it, so `setAlignment` — which repaints — appeared to do nothing until the tab was
   reopened. `paintCell` now owns the alignment classes.
4. **`&nbsp;` is not ours.** Nothing in the plugin writes an HTML entity; the notes in question
   carry it, which is what pasting a web or Word table produces. Rendered mode shows it as a space,
   and find and replace removes it. Answer, not a change.
5. **Restore was unusable.** It dumped three lines of every version at once and restored on a
   single click. It is now a version list, a line diff against the current grid once one is picked
   (`src/feature/diff.ts`, unit-tested), and an explicit `Restore this version`. The conflict
   dialog uses the same diff view.
6. **A click inside an open cell editor** hit the grid's `mousedown`, which committed the edit and
   re-selected the cell, so the caret could never be placed mid-word. `mousedown` and `dblclick`
   now leave events inside `.mds-editor` alone. The editor's own listeners are also released per
   edit instead of accumulating in `cleanup` for the life of the grid.
7. **`07.07.2026` exported to Excel as `07072026`.** `parseNumber` stripped repeated dots as
   grouping without validating the digit runs. Decision 10.
8. **Rendered by default**, raw as the option. Decision 8.
9. **Two more ways in** — a sidebar ribbon icon, and a hover `Edit` button on tables in the note
   itself (a post processor over the rendered DOM; the note is never modified). Decision 11.

### Still not verified in Obsidian

Everything in this round was written outside the app again, so the list at the top of this file
still applies, plus:

- **The ribbon's Lucide icon names.** Obsidian ships a subset, and a name it does not have renders
  as nothing at all rather than failing. The tab icons (`home`, `database`, `table`, `upload`) and
  the cluster icons are the conservative picks, but they want a look.
- **Rendered mode as the default** on a real, wide table: this is the one change with a plausible
  performance cost. If it drags, `Home ▸ Raw` and the `Cell display` setting are the escape, and
  the render cache and observer in `GridHost` are where to look.
- **The in-note button** inside callouts, embeds, tables in table cells and Live Preview versus
  reading mode.

## Round three: the restore list

Two things, both from a screenshot of the restore dialog:

1. **List items overflowed their own box.** They are `<button>`s, and Obsidian's own button rule
   sets a fixed `height: 30px` with `white-space: nowrap` and centred text, so the third line of a
   multi-line item spilled out over the item below it. `.mds-restore-item` and
   `.mds-table-picker-item` — same bug, unreported — now reset height, wrapping and alignment. The
   layout also wraps to one column in a narrow pane instead of pushing the diff off the edge, and
   each item is two lines rather than three. Reproduced and verified in Chromium against the real
   `styles.css` with Obsidian's button defaults, at 430 px and at 900 px.
2. **Ten versions of the same minute.** Autosave writes 800 ms after a keystroke and every write
   pushed a backup, so the list filled with "Just now" and the versions worth returning to fell off
   the end. Writes within `BACKUP_COALESCE_MS` (two minutes) of the newest entry now replace it,
   keeping its original timestamp. `tests/sidecar.test.ts` covers the burst, the cap, an
   out-of-order timestamp and a rename.

`src/settings.ts` lost its Obsidian import in the process — the tab moved to
`src/view/SettingTab.ts` — which is what makes `Sidecar` unit-testable at all.

Store pre-flight also produced two real changes: `authorUrl` points at the author rather than at
the repository, and export paths built from the `exportFolder` setting go through `normalizePath`.

## Round four: the same list, at length

Round three fixed half of it. The screenshot that produced this round was the table picker with
**thirteen** candidates, and every item was crushed to 19 px with both its lines painted over the
item below — the exact symptom round three thought it had closed.

The reset from round three (`height: auto`, `min-height: 0`, `white-space: normal`,
`text-align: left`) is necessary but not sufficient. Both lists are flex columns with a
`max-height`, so their items kept the default `flex-shrink: 1` and were squeezed *below their own
content* the moment they stopped fitting. `overflow-y: auto` never scrolled, because shrinking had
already removed the overflow. `flex: 0 0 auto` on `.mds-table-picker-item` and `.mds-restore-item`
is the fix; the lists now scroll.

The lesson worth keeping is in how round three missed it: it was verified at two window *widths*
but only ever with a short list. A capped, scrolling list has to be checked at the length that
overflows it. This one was reproduced in headless Chromium against the real `styles.css` with
Obsidian's button defaults — 13 picker items and 10 restore items, asserting that no item's
`scrollHeight` exceeds its box and that no item's ink crosses into the next — and re-checked at
420 px, 640 px and 1000 px.

## Round five: a bug hunt across the whole plugin

Six reports came back from use, and the rest of the code was read for the same kinds of fault.
Everything below is on `claude/loving-euler-vo4rr9`. The view layer was, for the first time,
exercised outside Obsidian: `GridHost` and `Ribbon` were bundled against a small shim of the
Obsidian API and driven in headless Chromium — selection, editing, clipboard events, autofit, wrap,
freeze panes, the fill handle, link clicks, ribbon patching — with screenshots of the sticky
headers. That is real code in a real browser, not Obsidian; the list of what is still unverified
is at the end.

### Reported

1. **`_kurzíva_` was not italic** to the format buttons. Emphasis is now read as layers
   (`peelInline` in `src/feature/ops.ts`): `*`/`_` and `**`/`__` are equivalent, `***x***` is both,
   and toggling removes exactly one layer. Before, Ctrl+I on `_x_` produced `*_x_*` and Ctrl+I on
   `**x**` turned bold into italic. The ribbon shows which formats the active cell has.
2. **The edit button showed in reading view and in PDF export.** It was a post processor, which is
   exactly the reading/PDF pipeline. It is now off there by default (decision 18) and hidden from
   print regardless.
3. **The column letters showed through.** Obsidian's selection and hover colours are translucent,
   and the active column's header is always selected. Opaque bases with the tints laid over them
   (decision 20). The fill handle also painted over the headers; it now sits below them and hides
   under the frozen panes.
4. **"Some functions don't work as expected"** — see the list below.
5. **The sort buttons had no icon.** Lucide renames; icons are now fallback lists (decision 19).
6. **No button in Live Preview.** A CodeMirror view plugin adds it to Obsidian's table widget.

### Found while reading

Data:
- An unmatched backtick merged the rest of a row into one cell on save (decision 12).
- A typed `\|` was escaped again and split the cell on the next read (decision 13).
- A setext heading `a | b` over `---` was taken for a table (decision 14).
- A note with mixed line endings had all of them rewritten on save (decision 16).
- The first autosave overwrote the "as opened" version, and manual mode lost unsaved edits on close
  (decision 17).
- Text typed into the formula bar was lost when you then clicked another cell: the selection change
  overwrote the input before its blur committed. It now commits to the cell it was opened on.
- A ribbon action while a cell editor was open would have repainted the cell under it; `mutate()`
  now commits the editor first, as its own undo step.

Behaviour:
- Shift+arrows or a drag up/left of the starting cell lost the anchor after one step.
- Committing an edit by clicking elsewhere pulled focus back into the grid, so the click — into the
  note, the formula bar, a ribbon field — did not land.
- Autofit rows grew a row by 6 px per click and never shrank it; autofit columns could not shrink.
- Wrap did nothing visible, because rows kept their one-line height.
- Ctrl+C/X/V only worked when the DOM happened to hold a text selection inside the grid; the
  listeners are now on the document and check focus.
- Every edit made all visible rendered cells flash their raw Markdown; rendered content is reused
  synchronously from the cache. Every edit also leaked an `IntersectionObserver`.
- A plain click on a link in a rendered cell could navigate the app window; it now selects the cell,
  and Ctrl/Cmd+click opens the link in a new tab.
- The ribbon rebuilt itself on every arrow key; it now patches state. Its buttons no longer take
  focus from the grid, and disabled buttons keep their tooltip.
- Home/End jumped between data blocks instead of to the row's ends; F2 selected the whole cell, so
  the next key wiped it; dismissing the table picker left an empty tab; a tooltip followed the
  pointer over every cell; Plain-text export kept `*`, `_` and `~~` inside a cell.

An independent review of the view changes caught five interactions between "toolbar buttons keep
focus in the grid" and fields that commit on blur, all fixed: pending formula-bar text is landed in
its own cell before any mutation (`GridHostCallbacks.onBeforeMutate`) instead of after rows had
moved under it; an external change while a cell or the formula bar is being typed in raises the
conflict banner instead of reloading underneath; a commit while the editor still has focus hands
focus to the grid rather than to `<body>`; a click in the grid moves focus before it moves the
selection, and a ribbon number field commits against the selection it was typed for; layout
changes refresh the ribbon, so the freeze toggles are never stale.

Added: Excel's typing mode (arrows commit), Shift+click and drag on column and row headers,
Freeze panes at the active cell, Find next, pasting a Markdown table, a single value filling a
range, Ctrl+D, sort from the column header menu, and a range outline in place of per-cell tint.

### Still not verified in Obsidian

- **The Live Preview button** relies on Obsidian's widget classes `cm-embed-block cm-table-widget`
  and on that widget not handling the button's events in the capture phase. If the button does not
  appear, the selector in `src/view/livePreviewButton.ts` is the first thing to check; if clicking
  it starts a cell edit instead, the widget is listening in capture.
- **Which icon names this Obsidian build has.** The fallback lists make a blank icon unlikely, but
  the first name that resolves is the one shown.
- Everything from the earlier "Still not verified" lists that this round did not touch.

## Round six: the feature list

The user went through a list of proposed features and asked for all of them. In one go:

- **Editing**: suggestions under the cell editor (`[[` notes, `#` tags, values of the column,
  Alt+↓ pick list), Ctrl+Enter fill, Ctrl+; date and time, Ctrl+K link, Ctrl+G go to, an editor
  that grows over its neighbours for long cells, duplicate and drag-to-move rows and columns, paste
  transposed and as plain text, fill series for dates, weekdays, months and `Item 1`, find in
  selection via Find next, text tools (case, trim, `&nbsp;`), split and merge columns, remove
  duplicates, multi-key sort.
- **Header filter**: the arrow in a column letter opens sort, a condition and a value checklist;
  the letter itself still selects the column.
- **Obsidian**: page preview on Ctrl-hover, pasted and dropped files become attachments and links,
  notes dropped from the file explorer become links, open in a split, switch between the tables of
  a note from the formula bar, find any table in the vault, reformat every table of a note, insert
  a new table, import CSV/TSV/XLSX as a new table or into the grid.
- **Calculate**: formulas in the cell as an Obsidian comment (decision 21), a totals row, compute a
  column from an expression, column statistics, format numbers, configurable status-bar figures
  that copy on click.
- **Look**: a redesigned ribbon (decision 22) with an icons-only option, active row and column
  tint, striped rows, column names next to the letters, zoom, the used-range edge, hidden columns,
  remembered scroll and selection, autofit on first open.
- **Safety and export**: a diff preview before saving in manual mode, restored cells highlighted,
  a configurable number of versions, a notice for rows with a different cell count, a status hint
  for repeated column names; HTML and JSON copy, JSON export, selection-only export, compact table
  layout for small Git diffs.

The pure logic was written in parallel by two sub-agents into new modules with their own tests
(`transform.ts`, `series.ts`, `exportExtra.ts`, `formula.ts`, `importTable.ts`); the view
integration, commands, settings and styles were done in the main session. Tests went from 217 to
340-odd.

Two real bugs surfaced while rendering the README screenshots: a click on any icon inside the grid
did nothing (the target is an `<svg>`, and `asElement` returned null for it), and a formula display
written in one locale was rewritten on every open in another. Both are fixed; the second is pinned
by a test.

### Screenshots and the browser harness

`tools/screenshots/` bundles the real `GridView` against `obsidian-shim.ts` and drives it in
headless Chromium; `node tools/screenshots/run.mjs` regenerates `docs/images`. Icons need
`npm install --no-save lucide-static@0.460.0`. If Playwright resolves a browser that is not
installed, pass `CHROMIUM=/path/to/chrome` (see `shoot.cjs`). Use it to see a view change working
before taking it into Obsidian — it found both bugs above.

### Mobile

Done in round seven, below.

### Still not verified in Obsidian

- The Live Preview button, page preview (`hover-link` with `registerHoverLinkSource`), file drops
  from Obsidian's own file explorer (the drag payload is not documented; the code accepts a path,
  a link text or an `obsidian://open` URL) and pasted images through `getAvailablePathForAttachment`.
- `MarkdownRenderer` hiding `%%…%%` inside a rendered cell, as it does in a note.
- Everything in the earlier lists.

## Round seven: mobile

Asked for explicitly, which is what D7 was waiting on. `isDesktopOnly` is `false`; decision 24 has
the design and the reasoning. In short:

- **Touch layout**, on in the mobile app (`Touch layout` setting: automatic, always, never). The
  view gets `.mds-touch`, the grid host `.is-touch`.
- **Gestures** in `src/feature/gesture.ts` (`GestureTracker`, pure, `tests/gesture.test.ts`): tap
  selects, a tap on the selected cell edits, long press opens the context menu (with *Open link* on
  a link), two fingers zoom. One-finger scrolling stays native. `GridHost` feeds it pointer events
  and ignores the emulated mouse events that follow a touch.
- **Range mode** instead of Shift; **the action bar** (`src/view/TouchBar.ts`) under the grid;
  the ribbon scrolls sideways with 36 px controls, and on a phone only the open tab shows its name.
- Cut, copy and paste were added to the cell context menu on every platform.

Verified in headless Chromium with touch emulation (Playwright `hasTouch`, CDP touch events for
long press, swipe and pinch) against the real `GridView` and `styles.css` at 390 × 760: 30 checks,
including a tap, a quick double tap, editing through the on-screen-keyboard path, autosave, range
mode, long press, a swipe that scrolls without selecting, a pinch, the header filter, and that
nothing overflows the width. The desktop README images regenerated byte for byte identical.
`docs/images/mobile.png` comes from `tools/screenshots/shoot.cjs`; `page.html?mobile=1` is the
mobile stand-in (`Platform.isMobile` in the shim).

### Not verified on a device

**Nothing in this round has run in the Obsidian mobile app.** Chromium's touch emulation is close
to Android's WebView and further from iOS's WKWebView. Check, in this order:

1. **Does the keyboard open on the second tap?** The editor is focused inside `pointerup`, which
   the HTML spec counts as a user activation for touch; WebKit has historically been strict about
   programmatic focus. If iOS does not show the keyboard, move the edit start into the `click` that
   follows the tap.
2. **Does pinch reach the grid**, or does the app's own gesture handling take it first?
3. **Is the cell being edited visible above the keyboard?** It is scrolled into view on `resize`,
   which only helps if the app resizes the view when the keyboard opens.
4. **Clipboard.** Copy and paste on the action bar use `navigator.clipboard`; iOS asks for paste
   permission each time.
5. **The Live Preview button** is always visible on screens without hover (`@media (hover: none)`).
   Whether tapping it competes with Obsidian entering the table for editing is unknown.

