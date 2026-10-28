import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as nodePath from "path";
import {
	CommitInfo,
	FileChange,
	GitBackend,
	GitError,
	PullResult,
	StatusResult,
} from "./GitBackend";
import { LOG_FORMAT, parseLog, parseStatus } from "./parse";

const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;

interface RunOptions {
	timeoutMs?: number;
	/** Non-zero exit codes that should not be treated as errors. */
	okExitCodes?: number[];
}

/** Desktop backend: runs the installed git executable inside the vault folder. */
function contextArg(contextLines?: number): string[] {
	return contextLines === undefined ? [] : [`--unified=${contextLines}`];
}

/** Compares two folder paths, resolving symlinks and Windows case/slash differences. */
async function samePath(a: string, b: string): Promise<boolean> {
	const normalize = async (p: string) => {
		const real = await fs.realpath(p).catch(() => nodePath.resolve(p));
		return process.platform === "win32" ? real.toLowerCase() : real;
	};
	return (await normalize(a)) === (await normalize(b));
}

export class CliGitBackend implements GitBackend {
	constructor(
		private readonly cwd: string,
		private readonly gitPath: () => string,
	) {}

	private run(args: string[], options: RunOptions = {}): Promise<string> {
		const executable = this.gitPath().trim() || "git";
		return new Promise((resolve, reject) => {
			execFile(
				executable,
				["-c", "core.quotepath=false", "-c", "color.ui=false", ...args],
				{
					cwd: this.cwd,
					encoding: "utf8",
					maxBuffer: 64 * 1024 * 1024,
					timeout: options.timeoutMs ?? LOCAL_TIMEOUT_MS,
					windowsHide: true,
					env: {
						...process.env,
						// Never block on a terminal prompt; credential helpers still work.
						GIT_TERMINAL_PROMPT: "0",
						// Vault paths are file names, not glob patterns.
						GIT_LITERAL_PATHSPECS: "1",
					},
				},
				(error, stdout, stderr) => {
					if (!error) return resolve(stdout);
					const code = typeof error.code === "number" ? error.code : null;
					if (code !== null && options.okExitCodes?.includes(code)) return resolve(stdout);
					if (error.code === "ENOENT") {
						return reject(new GitError(`git executable not found ("${executable}"). Check the plugin settings.`));
					}
					if (error.killed) return reject(new GitError(`git ${args[0]} timed out`, stderr, code));
					reject(new GitError((stderr || error.message).trim(), stderr, code));
				},
			);
		});
	}

	private async hasHead(): Promise<boolean> {
		const out = await this.run(["rev-parse", "--verify", "--quiet", "HEAD"], { okExitCodes: [1] });
		return out.trim().length > 0;
	}

	/**
	 * True only when the vault folder is itself the repository root. A vault
	 * nested inside some other repository (where it may even be ignored) does
	 * not count, so the user is offered to initialize the vault's own repo.
	 */
	async isRepo(): Promise<boolean> {
		try {
			const topLevel = (await this.run(["rev-parse", "--show-toplevel"])).trim();
			return (await samePath(topLevel, this.cwd));
		} catch {
			return false;
		}
	}

	async init(defaultBranch: string): Promise<void> {
		await this.run(["init", "-b", defaultBranch]);
		// Keep notes byte-for-byte as Obsidian wrote them (LF), whatever the
		// machine-wide setting is, so desktop and mobile clones stay identical.
		await this.run(["config", "core.autocrlf", "false"]);
	}

	async status(): Promise<StatusResult> {
		const out = await this.run(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
		return parseStatus(out);
	}

	async stage(paths: string[]): Promise<void> {
		if (paths.length) await this.run(["add", "-A", "--", ...paths]);
	}

	async stageAll(): Promise<void> {
		await this.run(["add", "-A", "--", "."]);
	}

	async unstage(paths: string[]): Promise<void> {
		if (!paths.length) return;
		if (await this.hasHead()) await this.run(["restore", "--staged", "--", ...paths]);
		else await this.run(["rm", "-r", "-q", "--cached", "--", ...paths]);
	}

	async discard(changes: FileChange[]): Promise<void> {
		for (const change of changes) {
			if (change.index === "?") {
				await this.removeUntracked(change.path);
			} else if (change.index === "A") {
				await this.run(["rm", "-f", "-q", "--cached", "--", change.path]);
				await this.removeUntracked(change.path);
			} else if (change.index === "R" && change.origPath) {
				await this.run(["rm", "-f", "-q", "--cached", "--", change.path]);
				await this.removeUntracked(change.path);
				await this.run(["restore", "--source=HEAD", "--staged", "--worktree", "--", change.origPath]);
			} else {
				await this.run(["restore", "--source=HEAD", "--staged", "--worktree", "--", change.path]);
			}
		}
	}

	private async removeUntracked(path: string): Promise<void> {
		await this.run(["clean", "-f", "-q", "--", path]);
	}

	async commit(message: string): Promise<string> {
		await this.run(["commit", "-m", message]);
		return (await this.run(["rev-parse", "--short", "HEAD"])).trim();
	}

	async fetch(remote: string): Promise<void> {
		await this.requireRemote(remote);
		await this.run(["fetch", remote], { timeoutMs: NETWORK_TIMEOUT_MS });
	}

	async push(remote: string, branch: string, setUpstream: boolean): Promise<void> {
		const args = ["push"];
		if (setUpstream) {
			await this.requireRemote(remote);
			args.push("-u", remote, branch);
		}
		await this.run(args, { timeoutMs: NETWORK_TIMEOUT_MS });
	}

	async pull(remote: string, branch: string, hasUpstream: boolean): Promise<PullResult> {
		const args = ["pull", "--rebase", "--autostash"];
		if (!hasUpstream) {
			await this.requireRemote(remote);
			args.push(remote, branch);
		}
		try {
			const out = await this.run(args, { timeoutMs: NETWORK_TIMEOUT_MS });
			return { status: /up to date/i.test(out) ? "up-to-date" : "updated" };
		} catch (error) {
			if (!(await this.rebaseInProgress())) throw error;
			const conflicts = (await this.run(["diff", "--name-only", "--relative", "--diff-filter=U"]))
				.split("\n")
				.filter(Boolean);
			await this.run(["rebase", "--abort"]);
			return { status: "conflict", conflicts };
		}
	}

	private async rebaseInProgress(): Promise<boolean> {
		for (const name of ["rebase-merge", "rebase-apply"]) {
			const gitPath = (await this.run(["rev-parse", "--git-path", name])).trim();
			try {
				await fs.access(nodePath.resolve(this.cwd, gitPath));
				return true;
			} catch {
				// not present
			}
		}
		return false;
	}

	private async requireRemote(remote: string): Promise<void> {
		if ((await this.getRemoteUrl(remote)) === null) {
			throw new GitError(`No remote named "${remote}" is configured. Add its URL in the plugin settings.`);
		}
	}

	async log(limit: number, path?: string): Promise<CommitInfo[]> {
		const args = ["log", `--format=${LOG_FORMAT}`, `-n${limit}`];
		if (path) args.push("--follow", "--", path);
		try {
			return parseLog(await this.run(args));
		} catch (error) {
			if (error instanceof GitError && /does not have any commits/.test(error.message)) return [];
			throw error;
		}
	}

	async unpushedCommits(limit: number): Promise<CommitInfo[]> {
		if (!(await this.hasHead())) return [];
		return parseLog(await this.run(["log", `--format=${LOG_FORMAT}`, `-n${limit}`, "HEAD", "--not", "--remotes"]));
	}

	async squash(base: string | null, message: string): Promise<string> {
		const args = ["commit-tree", "HEAD^{tree}", "-m", message];
		if (base) args.push("-p", base);
		const hash = (await this.run(args)).trim();
		await this.run(["reset", "--soft", hash]);
		return (await this.run(["rev-parse", "--short", "HEAD"])).trim();
	}

	async showCommit(hash: string, path?: string, contextLines?: number): Promise<string> {
		const args = ["show", "--format=", "--patch", "--find-renames", ...contextArg(contextLines), hash];
		if (path) args.push("--", path);
		return this.run(args);
	}

	async diffWorking(change: FileChange, staged: boolean, contextLines?: number): Promise<string> {
		if (!staged && change.index === "?") return this.untrackedDiff(change.path);
		const paths = change.origPath ? [change.origPath, change.path] : [change.path];
		const args = ["diff", "--find-renames", ...contextArg(contextLines)];
		if (staged) args.push("--cached");
		return this.run([...args, "--", ...paths]);
	}

	/** git diff ignores untracked files, so render the whole file as added. */
	private async untrackedDiff(path: string): Promise<string> {
		const content = await fs.readFile(nodePath.join(this.cwd, path), "utf8");
		const header = `diff --git a/${path} b/${path}\nnew file (untracked)\n`;
		if (content.includes("\0")) return `${header}Binary file`;
		const lines = content.replace(/\n$/, "").split("\n");
		return header + `@@ -0,0 +1,${lines.length} @@\n` + lines.map((line) => `+${line}`).join("\n");
	}

	async restoreFile(hash: string, path: string): Promise<void> {
		await this.run(["restore", `--source=${hash}`, "--worktree", "--", path]);
	}

	async getRemoteUrl(remote: string): Promise<string | null> {
		try {
			return (await this.run(["remote", "get-url", remote])).trim() || null;
		} catch {
			return null;
		}
	}

	async setRemoteUrl(remote: string, url: string): Promise<void> {
		const exists = (await this.getRemoteUrl(remote)) !== null;
		await this.run(["remote", exists ? "set-url" : "add", remote, url]);
	}
}
