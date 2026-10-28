# HMB Vault SCM Git

An Obsidian plugin to version your vault with git: commit, push and pull, review pending changes, and browse the history of the vault or a single note.

Requires Obsidian 1.13 or later, desktop only for now. It runs your installed `git`, so pushing uses whatever SSH keys or credential manager you already have set up. Mobile support (isomorphic-git) is planned behind the same `GitBackend` interface.

## Features

- **Changes panel** (ribbon icon or *Open changes panel*), modelled on VS Code's Source Control view: branch and ahead/behind, *Staged changes* and *Changes* shown as a folder tree or a flat list, stage, unstage or discard a file, a folder or everything, then commit or commit and push. With nothing staged, *Commit* commits everything.
- **Diff tab**: clicking a file or a commit opens its diff in an editor tab, side-by-side or inline, showing only the changes or the whole file. Diffs of uncommitted changes update as you edit.
- **History panel**: commits of the whole vault or of the current note. Click a commit to see its diff; in *Current file* mode you can restore an older version.
- **Auto-commit**: commits all changes every N minutes (turn on in settings or with the timer button in the changes panel), waiting until you have stopped typing for 30 seconds. Optionally pushes afterwards. Auto-commits carry an `Auto-commit: true` trailer.
- **Squash auto-commits**: the newest run of auto-commits that no remote has yet can be squashed into one commit with a new message (changes panel, history panel or command). Pushed commits are never rewritten, and your notes, staged files and uncommitted edits are untouched.
- **Commands**: commit all, commit all and push, push, pull, fetch, initialize repository, show history of current file.
- **Status bar**: branch, number of changes, commits ahead/behind.
- **Safe pull**: `pull --rebase --autostash`. On a conflict the rebase is aborted, so nothing changes, and you get a notice listing the conflicting files.

## What the plugin can access

Obsidian's plugin review flags this plugin for running external programs. That is how it works, so here is exactly what it does:

- **Runs `git`, and nothing else.** Commands go through Node's `child_process.execFile` to the `git` executable on your PATH, or the path set under *Settings → Git executable*. No shell is involved, and every command runs in the vault folder. The plugin itself only writes one file: the default `.gitignore` when you initialize a repository, through Obsidian's vault API. Everything else is done by `git`.
- **Files outside the vault.** `git` reads its own configuration (for example `~/.gitconfig`), and when you push, pull or fetch it uses your SSH keys or credential manager. The plugin never reads these.
- **Network.** The only network traffic is `git` talking to the remote you configured, and only when you push, pull or fetch, or when auto-commit is set to push afterwards.
- **No telemetry**, no accounts, no ads.

Each release's `main.js`, `manifest.json` and `styles.css` carry a [build provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds). To check that a downloaded file was built from this repository by its release workflow, run `gh attestation verify main.js --repo hmadrigal/hmb-vault-scm-git`.

## Setup in a vault

1. Run *Initialize repository in this vault*. This creates branch `main`, a default `.gitignore` (workspace files, `.trash/`), and sets `core.autocrlf=false` so notes are stored exactly as Obsidian writes them.
2. Make sure git knows who you are: `git config --global user.name "…"` and `git config --global user.email "…"`.
3. Create an empty repository on GitHub (private, most likely) and paste its URL under *Settings → Remote URL*.
4. Commit, then push. The first push sets the upstream branch.

## Development

Requires Node.js (LTS) and pnpm.

```sh
pnpm install
pnpm dev     # watch mode
pnpm build   # type check + production bundle
pnpm lint    # ESLint with Obsidian's review rules (eslint-plugin-obsidianmd)
```

Builds go to `main.js` in the repository root. When a `test-vault/` folder exists (git-ignored), each build is also copied into `test-vault/.obsidian/plugins/hmb-vault-scm-git/`. Open `test-vault` as a vault in Obsidian, turn on community plugins, and enable **HMB Vault SCM Git**. Run *Reload app without saving* (Ctrl+R) after rebuilding, or install the [Hot Reload](https://github.com/pjeby/hot-reload) plugin in the test vault.

### Layout

```
src/
  main.ts               plugin entry: commands, state, actions
  settings.ts           settings tab
  git/GitBackend.ts     backend interface + shared types
  git/CliGitBackend.ts  desktop implementation (git CLI)
  git/parse.ts          porcelain status / log parsers
  diff/unified.ts       unified diff parser, side-by-side row pairing
  diff/render.ts        diff table renderer (split / inline)
  views/ChangesView.ts  changes side panel (list or folder tree)
  views/tree.ts         folder tree building
  views/DiffView.ts     diff editor tab
  views/HistoryView.ts  history side panel
  ui/                   modals, DOM helpers
```

### Releasing

Releases follow Obsidian's rules: the tag is the bare version (`0.1.1`, no `v`), it matches `manifest.json`, and `main.js`, `manifest.json` and `styles.css` are attached to the release as separate files.

1. With a clean working tree, run `npm version patch` (or `minor` / `major`). This bumps `package.json`, copies the version into `manifest.json`, adds it to `versions.json` (mapped to the current `minAppVersion`), commits, and creates the tag (`.npmrc` drops the `v` prefix).
2. `git push --follow-tags`
3. The *Release* workflow checks that the tag, `manifest.json`, `package.json` and `versions.json` agree, runs the linter, builds, and publishes the release with the three files and generated notes.
4. Obsidian's automated review and BRAT pick up the published release. Run `pnpm lint` before tagging: a lint error fails the release.

If you raise `minAppVersion` in `manifest.json`, do it before step 1 so the new entry in `versions.json` records it.

To install a release without the community catalogue, use [BRAT](https://github.com/TfTHacker/obsidian42-brat) with this repository, or copy the three files into `<vault>/.obsidian/plugins/hmb-vault-scm-git/`.
