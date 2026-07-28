# Handoff

State as of **28 July 2026**, on `main`, version **0.3.0**.

This file goes stale. `CLAUDE.md` holds the durable rules; this one holds what is done, what is
not, and what to look at first.

## Where things stand

The plugin is complete against `docs/design` v0.4 — all ten steps of §16, not just the 1–6 the
design scopes to one session. `main` and `claude/obsidian-plugin-design-13a7yl` point at the same
commit; there is no open pull request.

| | |
| --- | --- |
| Source | ~7 000 lines across 30 files |
| Tests | 190, in 8 files |
| Lint | `eslint-plugin-obsidianmd` at 0 errors, 0 warnings |
| Bundle | `main.js` 109 kB against the ~1 MB budget of §15.1 |
| Runtime dependencies | none |
| Release | [0.3.0](https://github.com/ondreu/markdown-spreadsheets/releases/tag/0.3.0), three assets, published. 0.1.0 was published under the old `markdown-grid` id |

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
- **Mobile.** `isDesktopOnly: true` per D7. A ribbon at 380 px is its own project.

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
