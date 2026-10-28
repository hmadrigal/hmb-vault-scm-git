import { DropdownComponent, ItemView, WorkspaceLeaf } from "obsidian";
import type { CommitInfo } from "../git/GitBackend";
import type VaultScmPlugin from "../main";
import { iconButton } from "../ui/dom";
import { formatDate, fromNow } from "../ui/time";

export const HISTORY_VIEW_TYPE = "hmb-scm-history";

export type HistoryMode = "vault" | "file";

export class HistoryView extends ItemView {
	private mode: HistoryMode = "vault";
	private modeDropdown!: DropdownComponent;
	private titleEl!: HTMLElement;
	private listEl!: HTMLElement;
	private squashButton!: HTMLElement;
	/** Discards results of a load that was superseded by a newer one. */
	private loadToken = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: VaultScmPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return HISTORY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Git history";
	}

	override getIcon(): string {
		return "history";
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("hmb-scm-view");

		const toolbar = root.createDiv({ cls: "hmb-scm-history-toolbar" });
		this.modeDropdown = new DropdownComponent(toolbar)
			.addOption("vault", "Whole vault")
			.addOption("file", "Current file")
			.setValue(this.mode)
			.onChange((value) => this.setMode(value as HistoryMode));
		iconButton(toolbar, "refresh-cw", "Refresh", () => void this.reload());
		this.squashButton = iconButton(toolbar, "git-merge", "", () => this.plugin.promptSquash());
		this.updateSquashButton();

		this.titleEl = root.createDiv({ cls: "hmb-scm-muted hmb-scm-history-title" });
		this.listEl = root.createDiv({ cls: "hmb-scm-list" });

		this.registerEvent(this.plugin.events.on("head-changed", () => void this.reload()));
		this.registerEvent(this.plugin.events.on("status-changed", () => this.updateSquashButton()));
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				if (this.mode === "file") void this.reload();
			}),
		);
		await this.reload();
	}

	private updateSquashButton(): void {
		const count = this.plugin.squashable.length;
		this.squashButton.toggle(count > 0);
		this.squashButton.setAttr("aria-label", `Squash ${count} unpushed auto-commit${count === 1 ? "" : "s"}`);
	}

	setMode(mode: HistoryMode): void {
		this.mode = mode;
		this.modeDropdown?.setValue(mode);
		void this.reload();
	}

	async reload(): Promise<void> {
		const token = ++this.loadToken;
		const path = this.mode === "file" ? (this.app.workspace.getActiveFile()?.path ?? null) : null;

		if (!this.plugin.isRepo) return this.showMessage("This vault is not a git repository yet.");
		if (this.mode === "file" && !path) return this.showMessage("Open a note to see its history.");

		const commits = await this.plugin.log(path ?? undefined);
		if (token !== this.loadToken) return;

		this.titleEl.setText(path ? `History of ${path}` : "Vault history");
		this.listEl.empty();
		if (!commits.length) {
			this.listEl.createDiv({ cls: "hmb-scm-muted", text: "No commits yet." });
			return;
		}
		for (const commit of commits) this.renderCommit(commit, path);
	}

	private showMessage(text: string): void {
		this.titleEl.setText("");
		this.listEl.empty();
		this.listEl.createDiv({ cls: "hmb-scm-muted", text });
	}

	private renderCommit(commit: CommitInfo, path: string | null): void {
		const row = this.listEl.createDiv({ cls: "hmb-scm-commit-row" });
		row.setAttr("aria-label", `${commit.hash}\n${commit.author}, ${formatDate(commit.date, "LLL")}`);

		if (this.plugin.squashable.some((c) => c.hash === commit.hash)) row.addClass("hmb-scm-squashable");

		const text = row.createDiv({ cls: "hmb-scm-commit-text" });
		const subject = text.createDiv({ cls: "hmb-scm-commit-subject" });
		if (commit.auto) subject.createSpan({ cls: "hmb-scm-auto-badge", text: "auto" });
		subject.appendText(commit.subject);
		text.createDiv({
			cls: "hmb-scm-muted",
			text: `${commit.shortHash} · ${commit.author} · ${fromNow(commit.date)}`,
		});

		const actions = row.createDiv({ cls: "hmb-scm-actions" });
		if (path) {
			iconButton(actions, "rotate-ccw", "Restore this version", () =>
				this.plugin.confirmRestore(commit, path),
			);
		}

		row.addEventListener("click", () =>
			void this.plugin.openDiff({
				kind: "commit",
				hash: commit.hash,
				shortHash: commit.shortHash,
				subject: commit.subject,
				path: path ?? undefined,
			}),
		);
	}
}
