import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import { FileChange, hasWorktreeChange, isStaged, isUntracked } from "../git/GitBackend";
import { IgnoreOption, ignoreOptionForFolder, ignoreOptionsForFile } from "../git/ignore";
import type VaultScmPlugin from "../main";
import { iconButton } from "../ui/dom";
import { FolderNode, buildTree, filesUnder } from "./tree";

export const CHANGES_VIEW_TYPE = "hmb-scm-changes";

const STATUS_NAMES: Record<string, string> = {
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	T: "modified",
	U: "conflict",
	"?": "untracked",
};

export class ChangesView extends ItemView {
	private emptyEl!: HTMLElement;
	private headerEl!: HTMLElement;
	private commitEl!: HTMLElement;
	private listEl!: HTMLElement;
	private messageEl!: HTMLTextAreaElement;
	/** Collapsed folders, keyed by section and folder path. */
	private readonly collapsed = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: VaultScmPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CHANGES_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Git changes";
	}

	override getIcon(): string {
		return "git-branch";
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("hmb-scm-view");
		this.emptyEl = root.createDiv({ cls: "hmb-scm-empty" });
		this.headerEl = root.createDiv({ cls: "hmb-scm-header" });
		this.commitEl = root.createDiv({ cls: "hmb-scm-commit" });
		this.listEl = root.createDiv({ cls: "hmb-scm-list" });
		this.buildCommitBox();

		this.registerEvent(this.plugin.events.on("status-changed", () => this.render()));
		this.render();
	}

	/** Built once so the message survives status refreshes. */
	private buildCommitBox(): void {
		this.messageEl = this.commitEl.createEl("textarea", {
			cls: "hmb-scm-message",
			attr: { rows: "3" },
		});
		this.messageEl.addEventListener("keydown", (evt) => {
			if ((evt.ctrlKey || evt.metaKey) && evt.key === "Enter") {
				evt.preventDefault();
				void this.commit(false);
			}
		});

		const buttons = this.commitEl.createDiv({ cls: "hmb-scm-commit-buttons" });
		buttons.createEl("button", { text: "Commit", cls: "mod-cta" }).addEventListener("click", () => {
			void this.commit(false);
		});
		buttons.createEl("button", { text: "Commit & push" }).addEventListener("click", () => {
			void this.commit(true);
		});
	}

	private async commit(push: boolean): Promise<void> {
		const status = this.plugin.status;
		if (!status) return;
		// Like VS Code: commit what is staged, or everything when nothing is.
		const all = !status.files.some(isStaged);
		const committed = await this.plugin.commit(this.messageEl.value, { all, push });
		if (committed) this.messageEl.value = "";
	}

	private render(): void {
		const { isRepo, status } = this.plugin;
		this.emptyEl.empty();
		this.headerEl.empty();
		this.listEl.empty();

		const ready = isRepo && status !== null;
		this.emptyEl.toggle(!ready);
		this.headerEl.toggle(ready);
		this.commitEl.toggle(ready);
		this.listEl.toggle(ready);

		const untrusted = this.plugin.untrustedRepoPath;
		if (untrusted) {
			this.emptyEl.createEl("p", {
				text: `Git does not trust "${untrusted}" because another user account owns it, for example after copying it from another account or computer.`,
			});
			this.emptyEl
				.createEl("button", { text: "Trust this repository…", cls: "mod-cta" })
				.addEventListener("click", () => this.plugin.confirmTrustRepo());
			return;
		}
		if (!isRepo) {
			this.emptyEl.createEl("p", { text: "This vault is not a Git repository yet." });
			this.emptyEl
				.createEl("button", { text: "Initialize repository", cls: "mod-cta" })
				.addEventListener("click", () => void this.plugin.initRepo());
			return;
		}
		if (!status) {
			this.emptyEl.createEl("p", { text: "Reading repository status…" });
			return;
		}

		this.renderHeader();

		const staged = status.files.filter(isStaged);
		const unstaged = status.files.filter(hasWorktreeChange);
		const pending = staged.length ? staged.length : unstaged.length;
		this.messageEl.placeholder =
			`Message (Ctrl+Enter to commit). Empty uses: ${this.plugin.renderTemplate(pending)}` +
			(staged.length ? "" : "\nNothing staged: all changes will be committed.");

		if (!status.files.length) {
			this.listEl.createDiv({ cls: "hmb-scm-muted", text: "No changes. Everything is committed." });
			return;
		}
		this.renderSection("Staged changes", staged, true);
		this.renderSection("Changes", unstaged, false);
	}

	private renderHeader(): void {
		const status = this.plugin.status!;
		const branchRow = this.headerEl.createDiv({ cls: "hmb-scm-branch" });
		setIcon(branchRow.createSpan({ cls: "hmb-scm-branch-icon" }), "git-branch");
		branchRow.createSpan({ cls: "hmb-scm-branch-name", text: status.branch ?? "detached HEAD" });

		const sync = this.headerEl.createDiv({ cls: "hmb-scm-muted" });
		if (status.noCommits) sync.setText("No commits yet");
		else if (!status.upstream) sync.setText("Not published to a remote yet");
		else sync.setText(`${status.upstream}  ↑${status.ahead} ↓${status.behind}`);

		const toolbar = this.headerEl.createDiv({ cls: "hmb-scm-toolbar" });
		iconButton(toolbar, "refresh-cw", "Refresh", () => void this.plugin.refresh());
		iconButton(toolbar, "cloud-download", "Fetch", () => void this.plugin.fetch());
		iconButton(toolbar, "arrow-down", "Pull", () => void this.plugin.pull());
		iconButton(toolbar, "arrow-up", "Push", () => void this.plugin.push());
		iconButton(toolbar, "history", "Open history", () => void this.plugin.openHistory("vault"));
		const tree = this.plugin.settings.changesLayout === "tree";
		iconButton(toolbar, tree ? "list" : "list-tree", tree ? "View as list" : "View as tree", () => {
			this.plugin.settings.changesLayout = tree ? "list" : "tree";
			this.render();
			void this.plugin.saveSettings();
		});

		const autoOn = this.plugin.settings.autoCommitEnabled;
		const autoButton = iconButton(
			toolbar,
			autoOn ? "timer" : "timer-off",
			autoOn ? `${this.plugin.autoCommitDescription()}. Click to turn off.` : "Auto-commit is off. Click to turn on.",
			() => void this.plugin.setAutoCommit(!autoOn),
		);
		autoButton.toggleClass("is-active", autoOn);
		if (autoOn) this.headerEl.createDiv({ cls: "hmb-scm-muted", text: this.plugin.autoCommitDescription() });

		this.renderSquashBar();
	}

	private renderSquashBar(): void {
		const run = this.plugin.squashable;
		if (!run.length) return;
		const bar = this.headerEl.createDiv({ cls: "hmb-scm-squash-bar" });
		setIcon(bar.createSpan({ cls: "hmb-scm-squash-icon" }), "git-merge");
		bar.createSpan({
			cls: "hmb-scm-squash-text",
			text: `${run.length} unpushed auto-commit${run.length === 1 ? "" : "s"}`,
		});
		bar.createEl("button", { text: "Squash…" }).addEventListener("click", () => this.plugin.promptSquash());
	}

	private renderSection(title: string, files: FileChange[], staged: boolean): void {
		if (!files.length) return;
		const section = this.listEl.createDiv({ cls: "hmb-scm-section" });
		const head = section.createDiv({ cls: "hmb-scm-section-header" });
		head.createSpan({ cls: "hmb-scm-section-title", text: title });
		this.renderGroupActions(head.createDiv({ cls: "hmb-scm-actions" }), files, staged, "all");
		head.createSpan({ cls: "hmb-scm-count", text: String(files.length) });

		if (this.plugin.settings.changesLayout === "tree") {
			this.renderFolderContents(section, buildTree(files), staged, 0);
		} else {
			for (const file of files) this.renderFile(section, file, staged, 0, true);
		}
	}

	/** Stage / unstage / discard buttons acting on a group of files. */
	private renderGroupActions(actions: HTMLElement, files: FileChange[], staged: boolean, scope: string): void {
		const paths = () => files.map((file) => file.path);
		if (staged) {
			iconButton(actions, "minus", `Unstage ${scope}`, () => void this.plugin.unstage(paths()));
		} else {
			iconButton(actions, "undo-2", `Discard ${scope}`, () => this.plugin.confirmDiscard(files));
			iconButton(actions, "plus", `Stage ${scope}`, () => void this.plugin.stage(paths()));
		}
	}

	private renderFolderContents(parent: HTMLElement, node: FolderNode, staged: boolean, depth: number): void {
		for (const folder of node.folders) this.renderFolder(parent, folder, staged, depth);
		for (const file of node.files) this.renderFile(parent, file, staged, depth, false);
	}

	private renderFolder(parent: HTMLElement, folder: FolderNode, staged: boolean, depth: number): void {
		const key = `${staged ? "staged" : "changes"}:${folder.path}`;
		const collapsed = this.collapsed.has(key);
		const files = filesUnder(folder);

		const row = parent.createDiv({ cls: ["hmb-scm-row", "hmb-scm-folder"] });
		row.style.setProperty("--hmb-scm-depth", String(depth));
		row.setAttr("aria-label", folder.path);
		const chevron = row.createSpan({ cls: "hmb-scm-chevron" });
		setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
		setIcon(row.createSpan({ cls: "hmb-scm-folder-icon" }), collapsed ? "folder" : "folder-open");
		row.createDiv({ cls: "hmb-scm-row-name", text: folder.name });
		const actions = row.createDiv({ cls: "hmb-scm-actions" });
		this.addIgnoreActions(row, actions, [ignoreOptionForFolder(folder.path)]);
		this.renderGroupActions(actions, files, staged, "folder");
		row.createSpan({ cls: "hmb-scm-count", text: String(files.length) });

		row.addEventListener("click", () => {
			if (collapsed) this.collapsed.delete(key);
			else this.collapsed.add(key);
			this.render();
		});

		if (!collapsed) this.renderFolderContents(parent, folder, staged, depth + 1);
	}

	private renderFile(parent: HTMLElement, file: FileChange, staged: boolean, depth: number, showDir: boolean): void {
		const code = staged ? file.index : file.worktree;
		const kind = STATUS_NAMES[code] ?? "modified";
		const row = parent.createDiv({ cls: ["hmb-scm-row", "hmb-scm-file", `hmb-scm-file-${kind}`] });
		row.style.setProperty("--hmb-scm-depth", String(depth));
		row.setAttr("aria-label", file.origPath ? `${file.origPath} → ${file.path}` : file.path);

		const name = row.createDiv({ cls: "hmb-scm-row-name" });
		const slash = file.path.lastIndexOf("/");
		name.createSpan({ cls: "hmb-scm-file-basename", text: file.path.slice(slash + 1) });
		if (showDir && slash > 0) name.createSpan({ cls: "hmb-scm-file-dir", text: file.path.slice(0, slash) });

		const actions = row.createDiv({ cls: "hmb-scm-actions" });
		if (kind !== "deleted") iconButton(actions, "file-text", "Open note", () => void this.plugin.openFile(file.path));
		this.addIgnoreActions(row, actions, ignoreOptionsForFile(file.path));
		if (staged) {
			iconButton(actions, "minus", "Unstage", () => void this.plugin.unstage([file.path]));
		} else {
			iconButton(actions, "undo-2", isUntracked(file) ? "Delete file" : "Discard changes", () =>
				this.plugin.confirmDiscard([file]),
			);
			iconButton(actions, "plus", "Stage", () => void this.plugin.stage([file.path]));
		}

		const badgeText = kind === "untracked" ? "U" : kind === "conflict" ? "!" : code;
		row.createSpan({ cls: ["hmb-scm-badge", `hmb-scm-badge-${kind}`], text: badgeText, attr: { title: kind } });

		// Like VS Code, clicking a changed file opens its diff.
		row.addEventListener("click", () => void this.plugin.openDiff({ kind: "working", change: file, staged }));
	}

	/** "Add to .gitignore" button, and the same menu on right-click of the row. */
	private addIgnoreActions(row: HTMLElement, actions: HTMLElement, options: IgnoreOption[]): void {
		const show = (evt: MouseEvent) => {
			const menu = new Menu();
			for (const option of options) {
				menu.addItem((item) =>
					item
						.setTitle(`${option.label} (${option.pattern})`)
						.setIcon("eye-off")
						.onClick(() => void this.plugin.addToGitignore([option.pattern])),
				);
			}
			menu.showAtMouseEvent(evt);
		};
		iconButton(actions, "eye-off", "Add to .gitignore…", show);
		row.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			show(evt);
		});
	}
}
