## [0.2.0](https://github.com/hmadrigal/hmb-vault-scm-git/compare/0.1.3...0.2.0) (2026-10-28)

### Features

* **changes:** add a file, every file with the same name or extension, or a folder to `.gitignore` from the changes panel, and offer to stop tracking matching committed files ([9d3c741](https://github.com/hmadrigal/hmb-vault-scm-git/commit/9d3c741))
* **init:** the default `.gitignore` ignores `.obsidian/` at any level ([9d3c741](https://github.com/hmadrigal/hmb-vault-scm-git/commit/9d3c741))

## [0.1.3](https://github.com/hmadrigal/hmb-vault-scm-git/compare/0.1.2...0.1.3) (2026-10-28)

### Bug Fixes

* explain repositories Git does not trust (dubious ownership) and offer to add them to `safe.directory`, instead of offering to initialize a new repository ([37b2094](https://github.com/hmadrigal/hmb-vault-scm-git/commit/37b2094))

## [0.1.2](https://github.com/hmadrigal/hmb-vault-scm-git/compare/0.1.1...0.1.2) (2026-10-27)

### Bug Fixes

* stop using Node's `fs` module; all file access goes through `git` or Obsidian's vault API ([a82f12c](https://github.com/hmadrigal/hmb-vault-scm-git/commit/a82f12c))

### Build

* build provenance attestations for release files ([a82f12c](https://github.com/hmadrigal/hmb-vault-scm-git/commit/a82f12c))

## [0.1.1](https://github.com/hmadrigal/hmb-vault-scm-git/compare/0.1.0...0.1.1) (2026-10-27)

### ⚠ BREAKING CHANGES

* requires Obsidian 1.13.0 or later

### Bug Fixes

* settings use Obsidian's declarative settings API, so they appear in settings search ([97bf123](https://github.com/hmadrigal/hmb-vault-scm-git/commit/97bf123))
* address Obsidian's automated plugin review ([97bf123](https://github.com/hmadrigal/hmb-vault-scm-git/commit/97bf123))

## 0.1.0 (2026-10-27)

### Features

* changes panel, diff tab, history panel, auto-commit with squashing of unpushed auto-commits, and safe pull
