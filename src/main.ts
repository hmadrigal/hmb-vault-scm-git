import { Events, FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { hostname } from "os";
import { CliGitBackend } from "./git/CliGitBackend";
import {
	AUTO_COMMIT_TRAILER,
	CommitInfo,
	FileChange,
	GitBackend,
	StatusResult,
	UnsafeRepositoryError,
	isStaged,
	isUntracked,
	latestAutoRun,
} from "./git/GitBackend";
import { appendToGitignore } from "./git/ignore";
import { DEFAULT_SETTINGS, ScmSettingTab, ScmSettings } from "./settings";
import { CommitModal, ConfirmModal } from "./ui/modals";
import { formatDate } from "./ui/time";
import { CHANGES_VIEW_TYPE, ChangesView } from "./views/ChangesView";
import { DIFF_VIEW_TYPE, DiffRequest, DiffView } from "./views/DiffView";
import { HISTORY_VIEW_TYPE, HistoryMode, HistoryView } from "./views/HistoryView";

const DEFAULT_BRANCH = "main";
/** Context lines large enough to show any note in full. */
const FULL_FILE_CONTEXT = 1_000_000;
/** Auto-commit waits until the vault has been quiet this long, to avoid committing mid-sentence. */
const AUTO_COMMIT_IDLE_MS = 30_000;
/** Most unpushed commits examined when looking for a squashable run. */
const SQUASH_SCAN_LIMIT = 500;

const DEFAULT_GITIGNORE = `# Obsidian settings, plugins and workspace state, at any level of the vault
.obsidian/

# Deleted notes
.trash/

.DS_Store
Thumbs.db
`;

export default class VaultScmPlugin extends Plugin {
	override settings!: ScmSettings;
	git!: GitBackend;
	/** "status-changed" after every status refresh, "head-changed" when commits change. */
	readonly events = new Events();
	status: StatusResult | null = null;
	isRepo = false;
	/** Repository git refuses to use because another user owns it, until the user trusts it. */
	untrustedRepoPath: string | null = null;
	/** Latest run of unpushed auto-commits, newest first; empty when there is nothing to squash. */
	squashable: CommitInfo[] = [];
	/** When the next auto-commit check is due, or null when auto-commit is off. */
	nextAutoCommitAt: number | null = null;

	private queue: Promise<unknown> = Promise.resolve();
	private statusBarEl: HTMLElement | null = null;
	private readonly requestRefresh = debounce(() => void this.refresh(), 1500, true);
	private autoCommitTimer: number | null = null;
	private lastEditAt = 0;
	/** Last auto-commit error shown, so a failure repeating every interval is reported once. */
	private lastAutoCommitError: string | null = null;

	override async onload(): Promise<void> {
		await this.loadSettings();

		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("This plugin needs the desktop app.");
			return;
		}
		this.git = new CliGitBackend(adapter.getBasePath(), () => this.settings.gitPath);

		this.registerView(CHANGES_VIEW_TYPE, (leaf) => new ChangesView(leaf, this));
		this.registerView(HISTORY_VIEW_TYPE, (leaf) => new HistoryView(leaf, this));
		this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, this));
		this.addSettingTab(new ScmSettingTab(this.app, this));
		this.addRibbonIcon("git-branch", "Open Git changes", () => void this.activateView(CHANGES_VIEW_TYPE));
		this.registerCommands();

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("mod-clickable", "hmb-scm-statusbar");
		this.registerDomEvent(this.statusBarEl, "click", () => void this.activateView(CHANGES_VIEW_TYPE));

		this.register(() => this.clearAutoCommitTimer());
		this.app.workspace.onLayoutReady(() => {
			// Registered after layout is ready so the initial vault scan does not trigger refreshes.
			for (const event of ["create", "modify", "delete", "rename"] as const) {
				this.registerEvent(
					this.app.vault.on(event as "modify", () => {
						this.lastEditAt = Date.now();
						this.requestRefresh();
					}),
				);
			}
			void this.refresh();
			this.scheduleAutoCommit();
		});
	}

	private registerCommands(): void {
		this.addCommand({
			id: "open-changes",
			name: "Open changes panel",
			callback: () => void this.activateView(CHANGES_VIEW_TYPE),
		});
		this.addCommand({
			id: "open-history",
			name: "Open vault history",
			callback: () => void this.openHistory("vault"),
		});
		this.addCommand({
			id: "open-file-history",
			name: "Show history of current file",
			checkCallback: (checking) => {
				if (!this.app.workspace.getActiveFile()) return false;
				if (!checking) void this.openHistory("file");
				return true;
			},
		});
		this.addCommand({
			id: "commit-all",
			name: "Commit all changes",
			callback: () => this.promptCommitAll(false),
		});
		this.addCommand({
			id: "commit-all-and-push",
			name: "Commit all changes and push",
			callback: () => this.promptCommitAll(true),
		});
		this.addCommand({
			id: "toggle-auto-commit",
			name: "Toggle auto-commit",
			callback: () => void this.setAutoCommit(!this.settings.autoCommitEnabled),
		});
		this.addCommand({
			id: "squash-auto-commits",
			name: "Squash unpushed auto-commits",
			callback: () => this.promptSquash(),
		});
		this.addCommand({ id: "push", name: "Push", callback: () => void this.push() });
		this.addCommand({ id: "pull", name: "Pull", callback: () => void this.pull() });
		this.addCommand({ id: "fetch", name: "Fetch", callback: () => void this.fetch() });
		this.addCommand({
			id: "init",
			name: "Initialize repository in this vault",
			callback: () => void this.initRepo(),
		});
	}

	// ---- settings ---------------------------------------------------------

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<ScmSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	renderTemplate(count: number): string {
		return this.settings.commitTemplate
			.replace(/{{date}}/g, formatDate(Date.now(), this.settings.dateFormat))
			.replace(/{{count}}/g, String(count))
			.replace(/{{hostname}}/g, hostname());
	}

	// ---- state ------------------------------------------------------------

	/** Serializes git calls so they never fight over index.lock. */
	private exclusive<T>(task: () => Promise<T>): Promise<T> {
		const result = this.queue.then(task, task);
		this.queue = result.catch(() => undefined);
		return result;
	}

	async refresh(): Promise<void> {
		try {
			this.isRepo = await this.git.isRepo();
			this.untrustedRepoPath = null;
			if (this.isRepo) {
				const [status, unpushed] = await this.exclusive(async () => [
					await this.git.status(),
					await this.git.unpushedCommits(SQUASH_SCAN_LIMIT),
				] as const);
				this.status = status;
				this.squashable = latestAutoRun(unpushed);
			} else {
				this.status = null;
				this.squashable = [];
			}
		} catch (error) {
			this.status = null;
			this.squashable = [];
			if (error instanceof UnsafeRepositoryError) {
				if (this.untrustedRepoPath !== error.repoPath) {
					new Notice(`${error.message} Open the changes panel to trust it.`, 10000);
				}
				this.isRepo = false;
				this.untrustedRepoPath = error.repoPath;
			} else {
				console.error("[hmb-vault-scm-git] status failed", error);
			}
		}
		this.updateStatusBar();
		this.events.trigger("status-changed");
	}

	updateStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		el.empty();
		const status = this.status;
		el.toggle(this.settings.showStatusBar && this.isRepo && status !== null);
		if (!status) return;

		setIcon(el.createSpan({ cls: "hmb-scm-statusbar-icon" }), "git-branch");
		const count = status.files.length;
		let text = `${status.branch ?? "detached"} · ${count === 0 ? "clean" : `${count} change${count === 1 ? "" : "s"}`}`;
		if (status.upstream && (status.ahead || status.behind)) text += ` · ↑${status.ahead} ↓${status.behind}`;
		el.createSpan({ text });

		let label = "Open Git changes";
		if (this.settings.autoCommitEnabled) {
			setIcon(el.createSpan({ cls: "hmb-scm-statusbar-icon" }), "timer");
			label += `\n${this.autoCommitDescription()}`;
		}
		el.setAttr("aria-label", label);
	}

	/** e.g. "Auto-commit every 10 min, next check 14:32". */
	autoCommitDescription(): string {
		const every = `Auto-commit every ${this.settings.autoCommitIntervalMinutes} min`;
		return this.nextAutoCommitAt ? `${every}, next check ${formatDate(this.nextAutoCommitAt, "LT")}` : every;
	}

	/** Runs a git operation with error reporting, then refreshes the status. */
	private async runAction<T>(task: () => Promise<T>): Promise<T | undefined> {
		try {
			return await this.exclusive(task);
		} catch (error) {
			this.showError(error);
			return undefined;
		} finally {
			await this.refresh();
		}
	}

	private showError(error: unknown, prefix = "Git"): void {
		const message = error instanceof Error ? error.message : String(error);
		console.error("[hmb-vault-scm-git]", error);
		new Notice(`${prefix}: ${message.split("\n").slice(0, 8).join("\n")}`, 10000);
	}

	// ---- auto-commit ------------------------------------------------------

	async setAutoCommit(enabled: boolean): Promise<void> {
		this.settings.autoCommitEnabled = enabled;
		await this.saveSettings();
		this.scheduleAutoCommit();
		new Notice(enabled ? `${this.autoCommitDescription()}.` : "Auto-commit off.");
		this.updateStatusBar();
		this.events.trigger("status-changed");
	}

	/** (Re)starts the auto-commit timer from the current settings. */
	scheduleAutoCommit(delayMs = this.settings.autoCommitIntervalMinutes * 60_000): void {
		this.clearAutoCommitTimer();
		if (!this.settings.autoCommitEnabled) return;
		this.nextAutoCommitAt = Date.now() + delayMs;
		this.autoCommitTimer = window.setTimeout(() => void this.autoCommitTick(), delayMs);
		this.updateStatusBar();
	}

	private clearAutoCommitTimer(): void {
		if (this.autoCommitTimer !== null) window.clearTimeout(this.autoCommitTimer);
		this.autoCommitTimer = null;
		this.nextAutoCommitAt = null;
	}

	private async autoCommitTick(): Promise<void> {
		this.autoCommitTimer = null;
		const quietFor = Date.now() - this.lastEditAt;
		if (quietFor < AUTO_COMMIT_IDLE_MS) {
			// Still typing: check again once the vault has been quiet long enough.
			this.scheduleAutoCommit(AUTO_COMMIT_IDLE_MS - quietFor);
			return;
		}
		await this.autoCommit();
		this.scheduleAutoCommit();
	}

	private async autoCommit(): Promise<void> {
		if (!this.isRepo) return;
		let committed = false;
		try {
			await this.exclusive(async () => {
				const status = await this.git.status();
				const conflicted = status.files.some((f) => f.index === "U" || f.worktree === "U");
				if (!status.files.length || conflicted) return;
				await this.git.stageAll();
				await this.git.commit(`${this.renderTemplate(status.files.length)}\n\n${AUTO_COMMIT_TRAILER}`);
				committed = true;
				if (this.settings.autoPushAfterAutoCommit) await this.pushUnlocked(true);
			});
			this.lastAutoCommitError = null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== this.lastAutoCommitError) this.showError(error, "Auto-commit");
			this.lastAutoCommitError = message;
		}
		await this.refresh();
		if (committed) this.events.trigger("head-changed");
	}

	// ---- squash -----------------------------------------------------------

	promptSquash(): void {
		const run = this.squashable;
		if (!run.length) {
			new Notice("There are no unpushed auto-commits to squash.");
			return;
		}
		const newest = run[0];
		const oldest = run[run.length - 1];
		const format = (date: Date) => formatDate(date, this.settings.dateFormat);
		const defaultMessage =
			run.length === 1 ? newest.subject : `vault changes ${format(oldest.date)} to ${format(newest.date)}`;
		const noun = `auto-commit${run.length === 1 ? "" : "s"}`;

		new CommitModal(this.app, {
			title: `Squash ${run.length} ${noun}`,
			description:
				`These unpushed ${noun} will be replaced by a single commit with the message below. ` +
				"Your notes and any uncommitted changes are not touched.",
			items: run.map((commit) => `${commit.shortHash}  ${commit.subject}`),
			defaultMessage,
			submitText: "Squash",
			onSubmit: (message) => void this.squash(run, message),
		}).open();
	}

	private async squash(run: CommitInfo[], message: string): Promise<void> {
		if (!message.trim()) {
			new Notice("A commit message is required to squash.");
			return;
		}
		const squashed = await this.runAction(async () => {
			// Re-check under the lock: an auto-commit or push may have happened since the dialog opened.
			const current = latestAutoRun(await this.git.unpushedCommits(SQUASH_SCAN_LIMIT));
			const unchanged =
				current.length >= run.length &&
				current[0].hash === run[0].hash &&
				current[run.length - 1].hash === run[run.length - 1].hash;
			if (!unchanged) throw new Error("History changed since the squash dialog opened. Please try again.");

			const base = run[run.length - 1].parents[0] ?? null;
			const hash = await this.git.squash(base, message.trim());
			new Notice(`Squashed ${run.length} auto-commit${run.length === 1 ? "" : "s"} into ${hash}.`);
			return true;
		});
		if (squashed) this.events.trigger("head-changed");
	}

	// ---- actions ----------------------------------------------------------

	async initRepo(): Promise<void> {
		if (this.untrustedRepoPath) {
			this.confirmTrustRepo();
			return;
		}
		if (await this.git.isRepo().catch(() => false)) {
			new Notice("This vault already has its own Git repository.");
			return;
		}
		await this.runAction(async () => {
			await this.git.init(DEFAULT_BRANCH);
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(".gitignore"))) await adapter.write(".gitignore", DEFAULT_GITIGNORE);
			new Notice("Repository initialized. Commit your notes from the changes panel.");
		});
		this.events.trigger("head-changed");
	}

	private promptCommitAll(push: boolean): void {
		const count = this.status?.files.length ?? 0;
		const title = push ? "Commit all changes and push" : "Commit all changes";
		new CommitModal(this.app, {
			title,
			defaultMessage: this.renderTemplate(count),
			onSubmit: (message) => void this.commit(message, { all: true, push }),
		}).open();
	}

	/** Returns true when a commit was created. */
	async commit(message: string, options: { all: boolean; push: boolean }): Promise<boolean> {
		const committed = await this.runAction(async () => {
			const before = await this.git.status();
			const count = options.all ? before.files.length : before.files.filter(isStaged).length;
			if (count === 0) {
				new Notice("Nothing to commit.");
				return false;
			}
			if (options.all) await this.git.stageAll();
			const hash = await this.git.commit(message.trim() || this.renderTemplate(count));
			new Notice(`Committed ${count} file${count === 1 ? "" : "s"} (${hash}).`);
			if (options.push) await this.pushUnlocked();
			return true;
		});
		if (committed) this.events.trigger("head-changed");
		return committed === true;
	}

	async push(): Promise<void> {
		await this.runAction(() => this.pushUnlocked());
	}

	private async pushUnlocked(quiet = false): Promise<void> {
		const status = await this.git.status();
		if (!status.branch) throw new Error("Cannot push: HEAD is detached.");
		if (status.noCommits) throw new Error("Nothing to push: there are no commits yet.");
		await this.git.push(this.settings.remoteName, status.branch, status.upstream === null);
		if (!quiet) new Notice(`Pushed ${status.branch} to ${status.upstream ?? this.settings.remoteName}.`);
	}

	async pull(): Promise<void> {
		const result = await this.runAction(async () => {
			const status = await this.git.status();
			if (!status.branch) throw new Error("Cannot pull: HEAD is detached.");
			return this.git.pull(this.settings.remoteName, status.branch, status.upstream !== null);
		});
		if (!result) return;
		if (result.status === "conflict") {
			const files = result.conflicts.length ? `\n\nConflicting files:\n${result.conflicts.join("\n")}` : "";
			new Notice(
				"Pull stopped: your changes conflict with the remote. Nothing was changed, " +
					`your local commits are intact. Resolve the conflict manually, then pull again.${files}`,
				0,
			);
			return;
		}
		new Notice(result.status === "up-to-date" ? "Already up to date." : "Pulled latest changes.");
		if (result.status === "updated") this.events.trigger("head-changed");
	}

	async fetch(): Promise<void> {
		const ok = await this.runAction(async () => {
			await this.git.fetch(this.settings.remoteName);
			return true;
		});
		if (ok) new Notice(`Fetched from ${this.settings.remoteName}.`);
	}

	async stage(paths: string[]): Promise<void> {
		await this.runAction(() => this.git.stage(paths));
	}

	async unstage(paths: string[]): Promise<void> {
		await this.runAction(() => this.git.unstage(paths));
	}

	confirmDiscard(changes: FileChange[]): void {
		const untracked = changes.filter(isUntracked).length;
		const what =
			changes.length === 1 ? `"${changes[0].path}"` : `${changes.length} files`;
		const body =
			untracked === changes.length
				? `Delete ${what}? This file has never been committed and cannot be recovered.`
				: `Discard all uncommitted changes to ${what}? This cannot be undone.` +
					(untracked ? ` ${untracked} new file(s) will be deleted.` : "");
		new ConfirmModal(this.app, "Discard changes", body, "Discard", () => {
			void this.runAction(() => this.git.discard(changes));
		}).open();
	}

	/**
	 * Appends patterns to the vault's .gitignore. Files that were already committed
	 * keep being tracked, so if the new patterns match any, offer to untrack them.
	 */
	async addToGitignore(patterns: string[]): Promise<void> {
		const result = await this.runAction(async () => {
			const adapter = this.app.vault.adapter;
			const before = new Set(await this.git.trackedIgnoredFiles());
			const existing = (await adapter.exists(".gitignore")) ? await adapter.read(".gitignore") : "";
			const updated = appendToGitignore(existing, patterns);
			if (updated !== null) await adapter.write(".gitignore", updated);
			const newlyIgnored = (await this.git.trackedIgnoredFiles()).filter((path) => !before.has(path));
			return { changed: updated !== null, newlyIgnored };
		});
		if (!result) return;
		const list = patterns.join(", ");
		new Notice(result.changed ? `Added ${list} to .gitignore.` : `.gitignore already contains ${list}.`);
		if (result.newlyIgnored.length) this.confirmUntrack(result.newlyIgnored);
	}

	private confirmUntrack(paths: string[]): void {
		const shown = paths.slice(0, 5).map((path) => `"${path}"`).join(", ");
		const more = paths.length > 5 ? ` and ${paths.length - 5} more` : "";
		const body =
			`${paths.length === 1 ? "This file is" : `${paths.length} files are`} already committed: ${shown}${more}. ` +
			"Git keeps tracking committed files even when .gitignore matches them. Stop tracking them? " +
			"They stay on disk; their removal from the repository shows up as staged changes to commit.";
		new ConfirmModal(this.app, "Stop tracking ignored files", body, "Stop tracking", () => {
			void this.runAction(() => this.git.untrack(paths));
		}).open();
	}

	/** Same as running `git config --global --add safe.directory <path>`, after the user confirms. */
	confirmTrustRepo(): void {
		const path = this.untrustedRepoPath;
		if (!path) return;
		const body =
			`"${path}" belongs to another user account (for example, it was copied from another account or computer), ` +
			"so Git refuses to use it. Trust it by adding it to safe.directory in your global Git config? " +
			"Only do this if you know where the folder came from.";
		new ConfirmModal(this.app, "Trust this repository", body, "Trust", () => {
			void this.runAction(async () => {
				await this.git.trustRepository(path);
				new Notice(`Git now trusts "${path}".`);
			}).then(() => this.events.trigger("head-changed"));
		}).open();
	}

	confirmRestore(commit: CommitInfo, path: string): void {
		const body =
			`Replace the current content of "${path}" with its version from ${commit.shortHash} ` +
			`("${commit.subject}")? Uncommitted changes to this file will be lost. ` +
			"The restored version shows up as a change you can commit.";
		new ConfirmModal(this.app, "Restore version", body, "Restore", () => {
			void this.runAction(async () => {
				await this.git.restoreFile(commit.hash, path);
				new Notice(`Restored ${path} from ${commit.shortHash}.`);
			});
		}).open();
	}

	async setRemoteUrl(url: string): Promise<void> {
		await this.runAction(async () => {
			await this.git.setRemoteUrl(this.settings.remoteName, url);
			new Notice(`Remote "${this.settings.remoteName}" set to ${url}.`);
		});
	}

	async log(path?: string): Promise<CommitInfo[]> {
		try {
			return await this.exclusive(() => this.git.log(this.settings.historyLimit, path));
		} catch (error) {
			this.showError(error);
			return [];
		}
	}

	/** Raw unified diff for a diff tab; `fullFile` includes every unchanged line as context. */
	fetchDiff(request: DiffRequest, fullFile: boolean): Promise<string> {
		const context = fullFile ? FULL_FILE_CONTEXT : undefined;
		return this.exclusive(() =>
			request.kind === "working"
				? this.git.diffWorking(request.change, request.staged, context)
				: this.git.showCommit(request.hash, request.path, context),
		);
	}

	// ---- workspace --------------------------------------------------------

	/** Shows a diff in the main area, reusing the existing diff tab like VS Code's preview tab. */
	async openDiff(request: DiffRequest): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getLeavesOfType(DIFF_VIEW_TYPE)[0] ?? workspace.getLeaf("tab");
		await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true, state: { request } });
		await workspace.revealLeaf(leaf);
	}

	async openFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
		else new Notice(`"${path}" is not a note Obsidian can open.`);
	}

	async openHistory(mode: HistoryMode): Promise<void> {
		const leaf = await this.activateView(HISTORY_VIEW_TYPE);
		if (leaf?.view instanceof HistoryView) leaf.view.setMode(mode);
	}

	async activateView(type: string): Promise<WorkspaceLeaf | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(type)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({ type, active: true });
		}
		await workspace.revealLeaf(leaf);
		return leaf;
	}
}
