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
