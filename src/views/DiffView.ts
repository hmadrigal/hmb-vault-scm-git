import { ItemView, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import { renderDiffFiles } from "../diff/render";
import { parseUnifiedDiff } from "../diff/unified";
import type { FileChange } from "../git/GitBackend";
import type VaultScmPlugin from "../main";

export const DIFF_VIEW_TYPE = "hmb-scm-diff";

/** What a diff tab shows. Plain data, so it survives app restarts as view state. */
export type DiffRequest =
	| { kind: "working"; change: FileChange; staged: boolean }
	| { kind: "commit"; hash: string; shortHash: string; subject: string; path?: string };

export class DiffView extends ItemView {
	private request: DiffRequest | null = null;
	private fullFile = false;
	private bodyEl!: HTMLElement;
	private styleAction!: HTMLElement;
	private fullFileAction!: HTMLElement;
	/** Discards results of a load that was superseded by a newer one. */
	private loadToken = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: VaultScmPlugin,
	) {
		super(leaf);
		this.navigation = true;
	}

	getViewType(): string {
		return DIFF_VIEW_TYPE;
	}

	getDisplayText(): string {
		const request = this.request;
		if (!request) return "Diff";
		if (request.kind === "working") {
			return `${basename(request.change.path)} (${request.staged ? "staged" : "working tree"})`;
		}
		return request.path ? `${basename(request.path)} @ ${request.shortHash}` : `${request.shortHash}: ${request.subject}`;
	}

	override getIcon(): string {
		return "file-diff";
	}

	override async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("hmb-scm-diff-view");
		this.bodyEl = this.contentEl.createDiv({ cls: "hmb-scm-diff-body" });

		this.addAction("file-text", "Open note", () => void this.openNote());
		this.fullFileAction = this.addAction("unfold-vertical", "", () => {
			this.fullFile = !this.fullFile;
			this.updateActions();
			void this.reload();
		});
		this.styleAction = this.addAction("columns-2", "", async () => {
			const settings = this.plugin.settings;
			settings.diffStyle = settings.diffStyle === "split" ? "inline" : "split";
			await this.plugin.saveSettings();
			this.updateActions();
			void this.reload();
		});
		this.updateActions();

		// Uncommitted diffs follow edits to the note.
		this.registerEvent(
			this.plugin.events.on("status-changed", () => {
				if (this.request?.kind === "working") void this.reload();
			}),
		);
		await this.reload();
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const request = (state as { request?: DiffRequest } | null)?.request;
		if (request) this.request = request;
		await super.setState(state, result);
		if (this.bodyEl) await this.reload();
	}

	override getState(): Record<string, unknown> {
		return { request: this.request };
	}

	private updateActions(): void {
		const split = this.plugin.settings.diffStyle === "split";
		setIcon(this.styleAction, split ? "rows-2" : "columns-2");
		this.styleAction.setAttr("aria-label", split ? "Show inline diff" : "Show side-by-side diff");
		setIcon(this.fullFileAction, this.fullFile ? "fold-vertical" : "unfold-vertical");
		this.fullFileAction.setAttr("aria-label", this.fullFile ? "Show only changes" : "Show whole file");
	}

	async reload(): Promise<void> {
		const token = ++this.loadToken;
		const request = this.currentRequest();
		if (!request) return this.showMessage("No uncommitted changes in this file.");

		let text: string;
		try {
			text = await this.plugin.fetchDiff(request, this.fullFile);
		} catch (error) {
			if (token === this.loadToken) this.showMessage(error instanceof Error ? error.message : String(error));
			return;
		}
		if (token !== this.loadToken) return;

		const scrollTop = this.bodyEl.scrollTop;
		this.bodyEl.empty();
		if (request.kind === "commit") {
			const info = this.bodyEl.createDiv({ cls: "hmb-scm-diff-commit-info" });
			info.createDiv({ cls: "hmb-scm-commit-subject", text: request.subject });
			info.createDiv({ cls: "hmb-scm-muted", text: request.hash });
		}
		renderDiffFiles(this.bodyEl, parseUnifiedDiff(text), this.plugin.settings.diffStyle);
		this.bodyEl.scrollTop = scrollTop;
	}

	/** For working diffs, use the file's latest status (e.g. untracked → staged). */
	private currentRequest(): DiffRequest | null {
		const request = this.request;
		if (request?.kind !== "working") return request;
		const change = this.plugin.status?.files.find((file) => file.path === request.change.path);
		return change ? { ...request, change } : null;
	}

	private showMessage(text: string): void {
		this.bodyEl.empty();
		this.bodyEl.createDiv({ cls: "hmb-scm-diff-empty", text });
	}

	private async openNote(): Promise<void> {
		const request = this.request;
		const path = request?.kind === "working" ? request.change.path : request?.path;
		if (path) await this.plugin.openFile(path);
	}
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
