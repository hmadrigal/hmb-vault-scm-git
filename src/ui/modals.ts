import { App, Modal, Setting } from "obsidian";

export interface CommitModalOptions {
	title: string;
	defaultMessage: string;
	onSubmit: (message: string) => void;
	submitText?: string;
	/** Explanation shown above the message field. */
	description?: string;
	/** List shown under the description, e.g. the commits being squashed. */
	items?: string[];
}

export class CommitModal extends Modal {
	constructor(
		app: App,
		private readonly options: CommitModalOptions,
	) {
		super(app);
	}

	override onOpen(): void {
		const { title, defaultMessage, onSubmit, submitText = "Commit", description, items = [] } = this.options;
		this.titleEl.setText(title);
		if (description) this.contentEl.createEl("p", { text: description });
		if (items.length) {
			const list = this.contentEl.createEl("ul", { cls: "hmb-scm-modal-list" });
			for (const item of items) list.createEl("li", { text: item });
		}
		let message = defaultMessage;
		const submit = () => {
			this.close();
			onSubmit(message);
		};

		new Setting(this.contentEl).setName("Commit message").addText((text) => {
			text.setValue(message).onChange((value) => (message = value));
			text.inputEl.addClass("hmb-scm-wide-input");
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => text.inputEl.select(), 0);
		});
		new Setting(this.contentEl)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((btn) => btn.setButtonText(submitText).setCta().onClick(submit));
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly body: string,
		private readonly confirmText: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText(this.confirmText)
					.setDestructive()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
