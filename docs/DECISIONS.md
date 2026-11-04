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

*Placement superseded by decision 18; the reasoning about not touching the note still holds.*

`Table ▸ Edit` on a note's table is a Markdown post processor: it wraps the rendered `<table>` and
adds a hover button. The note's text is never touched, which keeps it inside the §7 rule that the
note is only marked up on explicit opt-in — a block ID still needs confirmation. The source line
comes from `getSectionInfo`, so the button opens the table it sits on instead of an index guess; a
table inside a callout or an embed has no section info and falls back to the picker.

## 12. A code span needs its closing backticks

**Design:** §6 gives `splitRow` as a toggle — every backtick flips an `inCode` flag, and an
escaped character is skipped even inside code.

**Built:** a backtick run opens a code span only when a run of the same length closes it later on
the line, and backslashes do not escape inside the span (both CommonMark §6.1).

The literal algorithm corrupts tables. One unmatched backtick — `it's a ` tick` — left `inCode` set
to the end of the line, so every remaining pipe stopped separating cells and the next save wrote the
rest of the row as one cell with escaped pipes. `` `a\` `` did the same, because the backslash
"escaped" the closing backtick. Balanced spans still protect their pipes exactly as §6 intends, and
the round-trip suite has a case for each form.

## 13. A pipe the person escaped is not escaped again

`escapeCell` escapes a `|` only when it follows an even run of backslashes. The parser never
produces a pipe after an odd run — it unescapes `\|` — so nothing read from a note serializes
differently. What changes is a cell where someone typed Markdown: `a \| b` used to become
`a \\| b`, an escaped backslash and a bare pipe, which the next read split into two cells, shifting
the rest of the row.

## 14. The alignment row must have as many cells as the header

`scanTables` now requires it, which is the GFM rule and what Obsidian's own table parser does.
Without it, `a | b` over `---` — a setext heading — was found as a table, and opening and saving it
rewrote the heading. A table the scanner no longer finds is one Obsidian does not render as a table
either.

## 15. A block ID after a blank line

Obsidian's documentation asks for the block ID of a structured block, a table included, on its own
line with a blank line before and after. `Writer.addBlockId` now writes it that way, preserving the
note's line endings, and `blockIdAfter` reads an ID either after one blank line or — as earlier
versions wrote it — directly below the table, so existing markers keep working.

## 16. Line endings are kept per line

`Writer` used to split the note on `/\r?\n/` and join it back with one detected ending, which
rewrote every line ending of a note that mixed CRLF and LF — a change well outside the table, and
one a Git diff shows as the whole file touched. `spliceLines` keeps each existing separator and
gives new lines the ending of the region they replace.

## 17. Versions remember why they were recorded

`BackupEntry.source` is `opened`, `saved` or `unsaved`. Only a save coalesces into a save (§13.2's
two-minute window from round three). Before this, the first autosave — 800 ms after the first
keystroke — overwrote the version recorded when the table was opened, so `Restore a version` could
not return to "before I started", which is what it is for.

`unsaved` is new: in manual save mode, closing a tab with unsaved edits used to discard them
silently, because `onClose` cannot be cancelled. The grid is now kept as a version and a notice
says so; the note is not touched.

## 18. The edit button lives in Live Preview; reading view is opt-in

Supersedes the placement in decision 11. Live Preview does not run Markdown post processors on
tables — Obsidian draws them with its own editable widget — so the button never appeared where
people edit, and it did appear in reading view and in PDF export, which run through the post
processor. A CodeMirror view plugin (`src/view/livePreviewButton.ts`) now adds the button to the
widget on first hover; CodeMirror ignores DOM changes inside widgets, and the note's text is never
touched. The reading-view button is behind `showTableButtonInReading`, off by default, and
`@media print` hides both regardless.

`@codemirror/view` and `@codemirror/state` are listed as dev dependencies at exactly the versions
the `obsidian` package pins: Obsidian provides them at runtime, `esbuild.config.mjs` already marks
them external, and `dependencies` stays empty.

## 19. Icons are lists of names

Obsidian ships one Lucide release, Lucide renames icons between releases, and an unknown name
renders as nothing — which is why the sort buttons had no icon. `src/view/icons.ts` gives every
icon a fallback list, newest name first, and uses the first one `getIcon` knows.

## 20. Translucent theme colours are overlays, never backgrounds

Obsidian's hover, selection and accent-tint variables are translucent. Used as the background of a
sticky header they let the scrolling cells show through — the column letters of the active column
were always see-through, because that column is always selected. Every cell and header now has an
opaque base, and those colours are laid over it as a gradient layer.

## 21. Formulas live in the cell, as an Obsidian comment

**Design:** D2 — no live formulas; `Calculate` inserts a literal value once.

**Built, at the user's request:** a cell may carry a formula after its value,
`**22 140** %%=SUM(B2:B3)%%`. The value is always a literal, so the note reads correctly in any
Markdown viewer; `%%…%%` is Obsidian's comment syntax, so Obsidian shows only the value and other
viewers show the formula as text after it. Nothing GFM cannot express is written: a comment is text.

Chosen over a comment line under the table (addresses go stale when rows are moved by hand) and over
the plugin's own data (formulas lost with the vault's plugin data). The grid recalculates inside
every `mutate()` — same undo step — and once when a table is opened; a value that changed while the
note was edited elsewhere becomes a normal, undoable edit. References are shifted on row and column
insert/delete like Excel's; sorting and moving rows do not rewrite them.

A display that already parses to the computed number is left as written. Formatting is locale
dependent, and rewriting `1 200` as `1,200` on a machine with another locale would turn every open
there into an edit — two devices would rewrite the note back and forth. `tests/formula.test.ts`
pins it.

The cell editor and the formula bar show a formula cell as `=EXPR`, not as its raw Markdown. This
is the one exception to "editing shows the raw Markdown" (invariant 7), and it is not a WYSIWYG
round trip: `rawFromEdit` rebuilds the stored form from the typed text and keeps the value's
emphasis layers; an untouched edit returns the original string byte for byte.

## 22. The ribbon's group labels sit under their actions

Supersedes the "group name above its actions" part of decision 9: the toolbar was redesigned as
underlined tabs over a panel of flat buttons, labels underneath, as Office does — the eye lands on
the buttons first. A setting reduces every button to its icon.

## 23. Tools, imports and suggestions are pure modules

Everything new that computes — `src/feature/transform.ts` (split, merge, de-duplicate, multi-key
sort, case, statistics, number formats, filter predicates), `series.ts` (fill series),
`formula.ts`, `importTable.ts`, `exportExtra.ts` — has no Obsidian import and is unit-tested. The
view layer only wires them to the ribbon, the commands and the dialogs in `src/view/toolModals.ts`.

## 24. The plugin runs on mobile, with a touch layout

**Design:** D7 — v1 is desktop-only (`isDesktopOnly: true`), because "a ribbon at 380 px is its
own project".

**Built:** at the author's request, that project. `isDesktopOnly` is `false`, and a grid opened in
the mobile app — or anywhere with `Touch layout` set to *Always* — uses the touch layout. Nothing
about the note, the write path or the anchor changes; this is the view only.

- **Gestures are recognised, not reimplemented.** A one-finger drag stays the browser's native
  scroll (`touch-action: pan-x pan-y`), and the browser announces it by cancelling the pointer. What
  is left — tap, long press, pinch — is `GestureTracker` in `src/feature/gesture.ts`, a pure state
  machine with its own tests. A gesture that ever had two fingers, or that the browser took over,
  never ends in a tap.
- **Tap selects; a tap on the selected cell edits.** The second tap is the double-click. It never
  follows a link in that cell: a column of `[[links]]` — the common case in rendered mode — could
  otherwise not be edited by touch at all. The long-press menu offers *Open link* instead.
- **Range mode replaces Shift.** Dragging across cells would fight scrolling, so a toggle in the
  action bar makes the next taps extend the selection. Starting an edit turns it off.
- **The emulated mouse events are ignored.** After a tap the browser fires `mousedown`, `dblclick`
  and, on Android, `contextmenu` for the same touch. `pointerdown` is `preventDefault`ed, which
  suppresses most of them, and the mouse handlers additionally stand down for 800 ms after a touch.
- **Desktop-only gestures stay desktop-only.** The fill handle is hidden, header borders do not
  resize and selected headers do not drag-move; *Fill down*, *Width* and *Move* on the toolbar
  do the same jobs. A touch version of each is possible later; none was worth a gesture that
  collides with scrolling.
- **The action bar** under the grid carries edit, range mode, undo, redo, copy, paste, add row and
  the selection's context menu, each icon with its name under it — a touch screen shows no tooltips.
- **The context menu gained Cut, Copy and Paste**, through the system clipboard, on desktop too: on
  touch there is no other route to them, and Excel's menu has them first.
- **Inputs are 16 px** in the touch layout. Below that, iOS zooms the whole page into a field when
  it gets focus.
- **A phone opens a tab, not a split**, whatever `Open the spreadsheet in` says.

The Node built-ins rule (`no-nodejs-modules`) now applies, because the manifest says mobile. The
plugin itself never imported one; the tests do, and run only in Node, so the rule is off for
`tests/` in `eslint.config.mjs`.

## 25. Formulas have values, not only numbers

**Design:** D2 and decision 21 describe formulas as arithmetic over cells, which is what the first
release needed.

**Built:** a value is a number, text, a boolean, empty or an error. Comparisons (`= <> < <= > >=`),
`&`, `IF`, `IFERROR`, `AND`, `OR`, `NOT` and the conditional aggregates need that, and text has to
survive the trip through the note.

- **Text results are written as plain cell text.** `IF(C2>2,"many","few")` stores `many %%=…%%`,
  which reads correctly without the plugin. A line break becomes a space and `%%` becomes `% %`,
  because either would break the table or the comment; a pipe is left to the serializer, which
  already escapes it.
- **A text value in arithmetic is `#VALUE!`, not 0.** Excel coerces `"12"` silently; in a note a
  stray word in a sum is nearly always a mistake, and a visible error is worth the difference.
- **A missing third argument of `IF` gives an empty cell.** Excel gives `FALSE`, which is noise in
  a note. Everything else follows Excel, because the XLSX export hands this same text to it.
- **Criteria follow Excel's rules**: `">100"`, `"*desk*"`, `"<>"`, an empty string for empty cells,
  and text matched without case. Matching is by value, so a number cell matches `"100"`.
- **The dependency graph is unchanged.** `IF` evaluates only the branch it takes (so
  `IF(C2>0, 1/C2, 0)` is safe), but both branches still contribute edges, and an edge that does not
  run cannot cause a cycle — the sort is over references, not over evaluation.
- **`TRUE` and `FALSE` work with and without parentheses**, as in Excel.

## 26. A formula is written by pointing at the cells

**Design:** §5 and §9 describe the editor as a text field over the cell, with the grid out of the
way while it is open.

**Built:** when the text starts with `=` — not `==`, which is Obsidian's highlight — a mousedown on
a grid cell writes that cell's reference at the caret instead of committing the edit, and dragging
writes `B2:C4`.

- **`preventDefault` on mousedown is the whole trick.** It is the blur that commits the editor, so
  a pick that let the browser move focus would commit a half-typed formula. The editor therefore
  keeps focus and the caret stays where the reference was written.
- **A reference immediately before the caret is replaced, not appended.** Clicking B2 when the
  caret sits after `B3` changes `B3` into `B2`, which is what the click means.
- **Typing ends the pick.** An `input` event clears it, so the next click starts a new reference
  rather than rewriting the last one.
- **The pick is shown as a dashed outline, not as a selection.** Moving the real selection while an
  editor is open would fire `onSelectionChange` for a cell nobody selected and pull the ribbon and
  the formula bar along with it. `is-point-preview` is a class on the cells, like the fill preview.
- **Only in the grid, not the formula bar.** The formula bar lives in `GridView` and owns its own
  focus; pointing from there is a second piece of work, not a variant of this one.
- **Not on touch.** There is no hover and no mousedown; a tap that picked a cell would fight the
  tap that edits one.

## 27. The function list lives in the editor's suggestion popup

**Design:** §9 has one suggestion popup for `[[` links, `#` tags and the values already used in a
column, and says nothing about functions.

**Built:** a fourth source in the same popup, offered only inside a formula.

- **It is the same popup, not a second one.** Two keyboard handlers competing for Enter is the bug
  the popup exists to avoid (`CellSuggest` asks first, always). A second popup would reintroduce it.
- **Only where a name can start.** The caret must be at the start of a word, inside a formula —
  `=` without the doubles, since `==` is Obsidian's highlight — and outside a string literal, where
  a word is text and not a call.
- **The list is documentation, not only completion.** Each row is the name, its arguments and one
  line about what it does, because the formula language now has twenty-three functions and no one
  remembers the argument order of `AVERAGEIFS`. Two lines, monospace signature, muted description.
- **`FORMULA_FUNCTIONS` is checked against `FUNCTIONS` by a test.** A name that the parser rejects
  must never be offered, which is the one way this list can go quietly wrong.
- **Picking writes `NAME(` and puts the caret inside**, so the next keystroke is the first argument;
  a constant such as `TRUE` gets `TRUE()` and the caret between the parentheses.
- **The typed letters are tinted, the rest is not.** A list that filters on two letters and does not
  show which two is a guessing game once the names are long.

## 28. A note that changes outside the grid is recalculated in the background

**Design:** decision 21 accepts that a formula cell stores its last value as literal text, which
means the note is correct without the plugin and *stale* with it, until something recalculates.
§13 recalculates when the grid opens and after every write. That leaves the case the whole design
worries about: a change delivered by Obsidian Sync, or made by another plugin, while no grid is
open. The number is then wrong in a way nothing announces.

**Built:** `FormulaWatcher` (`src/file/FormulaWatcher.ts`), no button anywhere.

- **It listens to `vault.on("modify")`**, debounced per path at 1.2 s, because one save from Sync
  arrives as a burst of events.
- **Only a note that contains `%%=` is opened.** The check is one `includes` on the cached text;
  everything else stops there.
- **Only a value that changed is written.** `recalculate` reports what it rewrote and the table is
  serialized back only then — through `Writer.reformatAll`, which already skips a table whose hash
  is unchanged, so a note that was right is never touched.
- **A note that is open is skipped**, whether in an editor — whose buffer the vault write would
  race and lose — or in a grid, which has its own conflict handling and recalcs on open. This is the
  one rule that matters: a background write must never compete with a person.
- **One sweep at startup**, 4 s after the workspace is ready, over notes edited in the last 45 days,
  in chunks of 20 with a pause. The edits that matter most — a phone's changes arriving while the
  desktop was closed — are exactly the ones no event announces.
- **A table it had to write comes back in the configured layout** (aligned or compact), because the
  value cannot be replaced without re-serializing the table. `compact` keeps that diff to the line
  that changed.
- **A failure is silent** by design: a note being written by something else at that instant is not
  worth a notice, and the next modify event schedules another attempt.
- **The setting exists** (`Recalculate when a note changes`, on) because a vault under Git or Sync
  may prefer its numbers to move only while somebody is looking. The watcher checks it at every
  step rather than at registration, so turning it off takes effect at once.

## 29. A file is merged into a table by a key, and nothing is deleted by default

**Design:** §14 covers importing a file as a new table or into the grid at the active cell. Paste
over a table was the only way to refresh one, and it loses the cells the file does not carry.

**Built:** `src/feature/merge.ts` — a plan, then an apply — behind a dialog that states the
consequences in numbers.

- **Matching is by a value, not by position.** A key column of the table is matched against the same
  column of the file (by header name, or by position if asked), so a sorted or padded export is not
  a requirement.
- **Columns are matched by header name by default.** An export that reordered its columns still
  updates the right cells; an export with a new column adds it when asked, and is ignored otherwise.
- **Removing is opt-in**, because a row missing from an export is usually news — a discontinued
  product, a cancelled order — not an instruction to delete it. When it is asked for, the rows go
  through `deleteRows` plus `adjustFormulaRefs`, so a formula elsewhere keeps pointing at the right
  cells and the row heights follow their rows.
- **A repeated key is reported, not merged.** Two rows with one key would make the merge ambiguous;
  the first is updated and the dialog says how many were left alone.
- **The plan carries its own `removeMissing`.** The first version read the flag from the options in
  `planMerge` and forgot it in `applyMerge`, and a test with the option off deleted rows. A plan that
  can be applied without knowing what it was planned for is a loaded gun.
- **Nothing is written until Merge is pressed**, and the dialog shows updated / added / removed /
  new columns with every change of a setting. The merge is one undo step in the grid.
- **A file with no header, no data or no key column is refused with the reason**, not merged badly.

## 30. The tables of a note are tabs under the grid

**Design:** §11 puts a picker and a switch into the formula bar, and the first release shipped the
switch as a `<select>` there — a dropdown labelled "Table 2: Item, Owner, Due".

**Built:** the dropdown is gone; the tables are tabs at the bottom of the view, where a spreadsheet
puts them.

- **The label is the table's own first headers.** "Table 2" identifies a table only to whoever
  counted the tables; `Item, Qty` is what the person recognises. The index survives in the tooltip,
  because that is what the anchor and the picker use.
- **Nothing is stored.** The strip is rebuilt from the note every time it is needed — `scanTables`
  on the current text. There is no list of tab names, no order to keep in sync, and deleting a table
  in the note removes its tab. That is the whole point of a note-first design.
- **One table means no strip.** A single-table note should not pay for a feature it cannot use.
- **Switching is the existing path.** A tab calls `switchTable`, which is what the dropdown called:
  commit, save or refuse, then adopt the region. The only change is who asks.
- **Buttons, not a native tab widget.** They are real `<button role="tab">` elements with an
  `aria-selected` state, so the strip reads to a screen reader, and their geometry is reset
  explicitly — Obsidian's `button` rule fixes a 30 px height and centred text, which turns a tab
  into a pill.

## 31. A note is a workbook; its tables are numbered from the top

**Design:** nothing. The first seven releases treat a table as the unit, and a note with several of
them as several unrelated tables.

**Built:** `Table2!B3` and `Table2!C2:C9` read another table of the same note, and
`recalculateWorkbook` runs the tables in document order until nothing changes (decision: four passes,
which settles any realistic chain).

- **A number, not a name.** The alternative was the heading above the table, and it fails the way this
  vault actually looks: many tables have no heading, and several share one. A number always exists and
  can never be ambiguous. The cost is that inserting a table renumbers the ones below it, which is the
  deal accepted in exchange.
- **The plugin follows what it can see.** `FormulaWatcher` remembers the tables of each note (headers
  and height, in memory, nothing stored) and, when one appears or disappears above another, rewrites
  `TableN!` in that note's formulas through `shiftTableRefs`. A note open in an editor is not rewritten
  — that would race the caret — so the plugin says what happened and where.
- **Nothing is written into the note but the numbers.** A reference is text inside the formula comment,
  so a note opened elsewhere still reads `37 140` and, beside it, `Table2!B3` as prose.
- **A reference to a missing table is `#REF!` with the number in the message**, and `Budget!B2` — a
  name that is not a table number — is `#NAME?` that says to use `Table1, Table2, …`.
- **Cross-table dependencies are ordered by the workbook, not by the cell sort**, because the sort is
  per table. Inside one table a cycle still shows `#CYCLE!`; a cycle that runs through two tables
  settles on whatever the last pass wrote, and that limit is written down rather than hidden.
- **The XLSX export carries the value only.** `Table2!B3` has no Excel equivalent: a sheet-qualified
  reference needs a sheet name the note does not have.

