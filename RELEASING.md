# Releasing

Everything here exists because Obsidian's plugin loader and its community-store validator both
look for very specific things. Get one of them wrong and the release either fails validation or
installs but does not load.

## What Obsidian expects from a release

| Requirement | Why it matters |
| --- | --- |
| The git tag equals `manifest.json`'s `version` **exactly** | The store validator matches them character for character. |
| **No `v` prefix** — `0.1.0`, never `v0.1.0` | The single most common reason a release is rejected. |
| `version` is valid semver | Sorting and update detection depend on it. |
| `main.js`, `manifest.json` and `styles.css` attached as **individual release assets** | Obsidian downloads them by name. A zip is not unpacked. |
| `manifest.json` in the release matches the one in the repository root | The validator reads the repository copy and the asset. |
| `minAppVersion` is an Obsidian version that actually exists | Users below it never see the update. |
| `versions.json` maps every released version to its `minAppVersion` | How Obsidian offers an older release to users on an older app. |
| The release is **published** — not a draft, not a pre-release | Drafts and pre-releases are invisible to the store. BRAT can install a pre-release; the store cannot. |

This plugin also has to keep satisfying the developer policies it was built against: no remote
code loading, no telemetry, no ads, no network access at all.

## Doing a release

1. **Bump the version.** One command keeps `manifest.json`, `versions.json` and `package.json`
   in step:

   ```bash
   node scripts/bump-version.mjs 0.2.0
   ```

   Raise `minAppVersion` in `manifest.json` by hand first if the release starts using a newer
   API — `eslint-plugin-obsidianmd`'s `no-unsupported-api` rule will tell you when that is
   necessary, and `npm run check` will fail until it is right.

2. **Check it locally.**

   ```bash
   npm run check
   ```

   Styles regeneration, typecheck, ESLint at zero errors *and* zero warnings, the test suite, and
   the production build.

3. **Commit and push** the version bump to `main`.

4. **Publish.** Either route runs the same job in `.github/workflows/release.yml`, which
   re-verifies the version, runs the same gates as CI, builds `main.js`, and publishes a release
   with `main.js`, `manifest.json` and `styles.css` attached as separate files.

   Pushing the tag:

   ```bash
   git tag -a 0.2.0 -m "0.2.0"
   git push origin 0.2.0
   ```

   Or run the **Release** workflow by hand — from the Actions tab, or with
   `gh workflow run release.yml -f confirm=release`. The version then comes from `manifest.json`
   and the tag is created on the server, which is the way out when the local environment cannot
   push tags. The confirm input exists so a stray click cannot publish.

   Whichever route, the job fails *before* building if the version is inconsistent or a release
   with that version already exists, rather than publishing something broken.

5. **Check the result** on the repository's releases page: three assets, no zip, published. The
   job prints the same thing at the end.

## If something went wrong

A published release with bad assets is worse than no release, because Obsidian may have already
handed it to users.

```bash
# Delete the remote tag and the release, fix, and start over with the same version number.
git push --delete origin 0.2.0
git tag -d 0.2.0
```

Delete the release on GitHub as well — deleting only the tag leaves the release behind, still
serving its assets. Then fix the problem and repeat from step 1. Reusing the version number is
fine as long as no user has installed it yet; otherwise bump the patch version instead, because
Obsidian caches by version.

## Submitting to the community plugin store

Only needed once, for the first release.

1. There must be a published release whose tag matches `manifest.json`.
2. `README.md` and `LICENSE` must be in the repository root — they are.
3. Fork [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases), add an
   entry to `community-plugins.json`, and open a pull request:

   ```json
   {
     "id": "markdown-grid",
     "name": "Markdown Grid",
     "author": "ondreu",
     "description": "Edit Markdown tables in a spreadsheet-style grid in a dedicated tab.",
     "repo": "ondreu/markdown-spreadsheets"
   }
   ```

   `id`, `name`, `author` and `description` must be byte-identical to `manifest.json`.

4. Expect review comments. The naming rules of §15.3 are already followed — the name contains
   neither "Obsidian" nor "plugin", the description does not begin with "This plugin…", and the
   ESLint plugin runs as a blocking CI step, which is what most review rounds are about.

Later releases need no further submission: the store follows the repository's releases.

## Installing without the store

For testing a build, or for anyone who does not want to wait for review:

- **BRAT** — add `ondreu/markdown-spreadsheets` in the BRAT settings. It reads the same release
  assets, and unlike the store it will also take a pre-release.
- **By hand** — create `<vault>/.obsidian/plugins/markdown-grid/` and put `main.js`,
  `manifest.json` and `styles.css` in it, then enable the plugin in Obsidian's settings. Use
  `npm run dev` and copy the files there while developing; `npm run dev` rebuilds on save.
