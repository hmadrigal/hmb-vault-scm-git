import { App, PluginSettingTab, Setting } from "obsidian";
import type { DiffStyle } from "./diff/render";
import type VaultScmPlugin from "./main";

export interface ScmSettings {
	gitPath: string;
	remoteName: string;
	commitTemplate: string;
	dateFormat: string;
	historyLimit: number;
	showStatusBar: boolean;
	changesLayout: "list" | "tree";
	diffStyle: DiffStyle;
	autoCommitEnabled: boolean;
	autoCommitIntervalMinutes: number;
	autoPushAfterAutoCommit: boolean;
}

export const DEFAULT_SETTINGS: ScmSettings = {
	gitPath: "git",
	remoteName: "origin",
	commitTemplate: "vault backup: {{date}}",
	dateFormat: "YYYY-MM-DD HH:mm",
	historyLimit: 100,
	showStatusBar: true,
	changesLayout: "tree",
	diffStyle: "split",
	autoCommitEnabled: false,
	autoCommitIntervalMinutes: 10,
	autoPushAfterAutoCommit: false,
};

export class ScmSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: VaultScmPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const { settings } = this.plugin;

		new Setting(containerEl).setName("Repository").setHeading();

		if (!this.plugin.isRepo) {
			new Setting(containerEl)
				.setName("Initialize repository")
				.setDesc("This vault is not a git repository yet. Create one (branch \"main\") with a default .gitignore.")
				.addButton((btn) =>
					btn
						.setButtonText("Initialize")
						.setCta()
						.onClick(async () => {
							await this.plugin.initRepo();
							this.display();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Remote name")
			.setDesc("Remote used for push and pull when the branch has no upstream yet.")
			.addText((text) =>
				text
					.setPlaceholder("origin")
					.setValue(settings.remoteName)
					.onChange(async (value) => {
						settings.remoteName = value.trim() || DEFAULT_SETTINGS.remoteName;
						await this.plugin.saveSettings();
					}),
			);

		if (this.plugin.isRepo) {
			let remoteUrl = "";
			const remoteSetting = new Setting(containerEl)
				.setName("Remote URL")
				.setDesc("Stored in the repository's git config, e.g. git@github.com:you/notes.git or https://github.com/you/notes.git.")
				.addText((text) => {
					text.setPlaceholder("Not configured").onChange((value) => (remoteUrl = value.trim()));
					text.inputEl.addClass("hmb-scm-wide-input");
					void this.plugin.git.getRemoteUrl(settings.remoteName).then((url) => {
						remoteUrl = url ?? "";
						text.setValue(remoteUrl);
					});
				});
			remoteSetting.addButton((btn) =>
				btn.setButtonText("Save").onClick(async () => {
					if (remoteUrl) await this.plugin.setRemoteUrl(remoteUrl);
				}),
			);
		}

		new Setting(containerEl).setName("Auto-commit").setHeading();

		new Setting(containerEl)
			.setName("Auto-commit changes")
			.setDesc(
				"Periodically commit all changes, waiting until you have stopped typing for a moment. " +
					"Also toggled from the changes panel. Runs of auto-commits that are not pushed yet can be squashed into one commit.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.autoCommitEnabled).onChange((value) => void this.plugin.setAutoCommit(value)),
			);

		new Setting(containerEl)
			.setName("Interval (minutes)")
			.setDesc("How often to auto-commit when there are changes.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.setValue(String(settings.autoCommitIntervalMinutes)).onChange(async (value) => {
					const minutes = Number.parseInt(value, 10);
					if (Number.isFinite(minutes) && minutes >= 1) {
						settings.autoCommitIntervalMinutes = minutes;
						await this.plugin.saveSettings();
						this.plugin.scheduleAutoCommit();
					}
				});
			});

		new Setting(containerEl)
			.setName("Push after auto-commit")
			.setDesc("Push right after each auto-commit. Pushed commits can no longer be squashed.")
			.addToggle((toggle) =>
				toggle.setValue(settings.autoPushAfterAutoCommit).onChange(async (value) => {
					settings.autoPushAfterAutoCommit = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Commits").setHeading();

		new Setting(containerEl)
			.setName("Commit message template")
			.setDesc("Used when the message is left empty. Placeholders: {{date}}, {{count}} (files), {{hostname}}.")
			.addText((text) =>
				text.setValue(settings.commitTemplate).onChange(async (value) => {
					settings.commitTemplate = value || DEFAULT_SETTINGS.commitTemplate;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Date format")
			.setDesc("Moment.js format used for {{date}}.")
			.addMomentFormat((format) =>
				format
					.setDefaultFormat(DEFAULT_SETTINGS.dateFormat)
					.setValue(settings.dateFormat)
					.onChange(async (value) => {
						settings.dateFormat = value || DEFAULT_SETTINGS.dateFormat;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Interface").setHeading();

		new Setting(containerEl)
			.setName("History length")
			.setDesc("Maximum number of commits shown in the history panel.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(settings.historyLimit)).onChange(async (value) => {
					const n = Number.parseInt(value, 10);
					if (Number.isFinite(n) && n > 0) {
						settings.historyLimit = n;
						await this.plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName("Show status bar item")
			.setDesc("Branch, number of changes and commits ahead/behind the remote.")
			.addToggle((toggle) =>
				toggle.setValue(settings.showStatusBar).onChange(async (value) => {
					settings.showStatusBar = value;
					await this.plugin.saveSettings();
					this.plugin.updateStatusBar();
				}),
			);

		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Git executable")
			.setDesc("Command or full path, e.g. C:\\Program Files\\Git\\cmd\\git.exe if git is not on your PATH.")
			.addText((text) =>
				text
					.setPlaceholder("git")
					.setValue(settings.gitPath)
					.onChange(async (value) => {
						settings.gitPath = value.trim() || DEFAULT_SETTINGS.gitPath;
						await this.plugin.saveSettings();
					}),
			);
	}
}
