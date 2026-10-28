# HMB Vault SCM Git

An Obsidian plugin to version your vault with git: commit, push and pull, review pending changes, and browse the history of the vault or a single note.

Desktop only for now. It runs your installed `git`, so pushing uses whatever SSH keys or credential manager you already have set up. Mobile support (isomorphic-git) is planned behind the same `GitBackend` interface.

## Features

- **Changes panel** (ribbon icon or *Open changes panel*), modelled on VS Code's Source Control view: branch and ahead/behind, *Staged changes* and *Changes* shown as a folder tree or a flat list, stage, unstage or discard a file, a folder or everything, then commit or commit and push. With nothing staged, *Commit* commits everything.
- **Diff tab**: clicking a file or a commit opens its diff in an editor tab, side-by-side or inline, showing only the changes or the whole file. Diffs of uncommitted changes update as you edit.
- **History panel**: commits of the whole vault or of the current note. Click a commit to see its diff; in *Current file* mode you can restore an older version.
- **Auto-commit**: commits all changes every N minutes (turn on in settings or with the timer button in the changes panel), waiting until you have stopped typing for 30 seconds. Optionally pushes afterwards. Auto-commits carry an `Auto-commit: true` trailer.
- **Squash auto-commits**: the newest run of auto-commits that no remote has yet can be squashed into one commit with a new message (changes panel, history panel or command). Pushed commits are never rewritten, and your notes, staged files and uncommitted edits are untouched.
- **Commands**: commit all, commit all and push, push, pull, fetch, initialize repository, show history of current file.
- **Status bar**: branch, number of changes, commits ahead/behind.
- **Safe pull**: `pull --rebase --autostash`. On a conflict the rebase is aborted, so nothing changes, and you get a notice listing the conflicting files.

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

Bump `version` in `manifest.json` and `package.json`, add it to `versions.json`, then create a GitHub release with that version as the tag and attach `main.js`, `manifest.json` and `styles.css`.
