import { App, PluginSettingTab, SettingDefinitionItem } from "obsidian";
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

type SettingKey = keyof ScmSettings;

const atLeastOne = (value: number) => (Number.isInteger(value) && value >= 1 ? undefined : "Enter a whole number of 1 or more.");

/** Declarative settings (Obsidian 1.13+), so every option shows up in the settings search. */
export class ScmSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: VaultScmPlugin,
	) {
		super(app, plugin);
	}

	override getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return [
			{
				type: "group",
				heading: "Repository",
				items: [
					{
						name: "Initialize repository",
						desc: 'This vault is not a Git repository yet. Create one (branch "main") with a default .gitignore.',
						visible: () => !this.plugin.isRepo && !this.plugin.untrustedRepoPath,
						render: (setting) => {
							setting.addButton((btn) =>
								btn
									.setButtonText("Initialize")
									.setCta()
									.onClick(async () => {
										await this.plugin.initRepo();
										this.update();
									}),
							);
						},
					},
					{
						name: "Trust repository",
						desc: "Git refuses to use this vault's repository because another user account owns the folder. Add it to safe.directory in your global Git config.",
						visible: () => this.plugin.untrustedRepoPath !== null,
						render: (setting) => {
							setting.addButton((btn) =>
								btn
									.setButtonText("Trust…")
									.setCta()
									.onClick(() => this.plugin.confirmTrustRepo()),
							);
						},
					},
					{
						name: "Remote name",
						desc: "Remote used for push and pull when the branch has no upstream yet.",
						control: { type: "text", key: "remoteName", placeholder: DEFAULT_SETTINGS.remoteName },
					},
					{
						name: "Remote URL",
						desc: "Stored in the repository's Git config, e.g. git@github.com:you/notes.git or https://github.com/you/notes.git.",
						visible: () => this.plugin.isRepo,
						render: (setting) => {
							let remoteUrl = "";
							setting.addText((text) => {
								text.setPlaceholder("Not configured").onChange((value) => (remoteUrl = value.trim()));
								text.inputEl.addClass("hmb-scm-wide-input");
								void this.plugin.git.getRemoteUrl(this.plugin.settings.remoteName).then((url) => {
									remoteUrl = url ?? "";
									text.setValue(remoteUrl);
								});
							});
							setting.addButton((btn) =>
								btn.setButtonText("Save").onClick(async () => {
									if (remoteUrl) await this.plugin.setRemoteUrl(remoteUrl);
								}),
							);
						},
					},
				],
			},
			{
				type: "group",
				heading: "Auto-commit",
				items: [
					{
						name: "Auto-commit changes",
						desc:
							"Periodically commit all changes, waiting until you have stopped typing for a moment. " +
							"Also toggled from the changes panel. Runs of auto-commits that are not pushed yet can be squashed into one commit.",
						control: { type: "toggle", key: "autoCommitEnabled" },
					},
					{
						name: "Interval (minutes)",
						desc: "How often to auto-commit when there are changes.",
						control: { type: "number", key: "autoCommitIntervalMinutes", min: 1, step: 1, validate: atLeastOne },
					},
					{
						name: "Push after auto-commit",
						desc: "Push right after each auto-commit. Pushed commits can no longer be squashed.",
						control: { type: "toggle", key: "autoPushAfterAutoCommit" },
					},
				],
			},
			{
				type: "group",
				heading: "Commits",
				items: [
					{
						name: "Commit message template",
						desc: "Used when the message is left empty. Placeholders: {{date}}, {{count}} (files), {{hostname}}.",
						control: { type: "text", key: "commitTemplate", placeholder: DEFAULT_SETTINGS.commitTemplate },
					},
					{
						name: "Date format",
						desc: "Moment.js format used for {{date}}.",
						render: (setting) => {
							setting.addMomentFormat((format) =>
								format
									.setDefaultFormat(DEFAULT_SETTINGS.dateFormat)
									.setValue(this.plugin.settings.dateFormat)
									.onChange((value) => void this.setControlValue("dateFormat", value)),
							);
						},
					},
				],
			},
			{
				type: "group",
				heading: "Interface",
				items: [
					{
						name: "History length",
						desc: "Maximum number of commits shown in the history panel.",
						control: { type: "number", key: "historyLimit", min: 1, step: 1, validate: atLeastOne },
					},
					{
						name: "Show status bar item",
						desc: "Branch, number of changes and commits ahead/behind the remote.",
						control: { type: "toggle", key: "showStatusBar" },
					},
				],
			},
			{
				type: "group",
				heading: "Advanced",
				items: [
					{
						name: "Git executable",
						desc: "Command or full path, e.g. C:\\Program Files\\Git\\cmd\\git.exe if Git is not on your PATH.",
						control: { type: "text", key: "gitPath", placeholder: DEFAULT_SETTINGS.gitPath },
					},
				],
			},
		];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "autoCommitEnabled") {
			await this.plugin.setAutoCommit(value === true);
			return;
		}
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		// Empty text falls back to the default, so the plugin always has a usable value.
		settings[key] = typeof value === "string" ? value.trim() || DEFAULT_SETTINGS[key as SettingKey] : value;
		await this.plugin.saveSettings();
		if (key === "autoCommitIntervalMinutes") this.plugin.scheduleAutoCommit();
		if (key === "showStatusBar") this.plugin.updateStatusBar();
	}
}
