import { execFile } from "child_process";
import {
	CommitInfo,
	FileChange,
	GitBackend,
	GitError,
	PullResult,
	StatusResult,
	UnsafeRepositoryError,
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
					const unsafe = /detected dubious ownership in repository at '(.+)'/.exec(stderr);
					if (unsafe) return reject(new UnsafeRepositoryError(unsafe[1], stderr));
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
			// Prints "true" inside a working tree, then the vault's path within it (empty at the root).
			const [insideWorkTree, prefix] = (await this.run(["rev-parse", "--is-inside-work-tree", "--show-prefix"])).split("\n");
			return insideWorkTree === "true" && prefix === "";
		} catch (error) {
			if (error instanceof UnsafeRepositoryError) throw error;
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

	async trackedIgnoredFiles(): Promise<string[]> {
		const out = await this.run(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]);
		return out.split("\0").filter(Boolean);
	}

	async untrack(paths: string[]): Promise<void> {
		// Batches keep the command line under Windows' length limit.
		for (let i = 0; i < paths.length; i += 100) {
			await this.run(["rm", "--cached", "-r", "-q", "--", ...paths.slice(i, i + 100)]);
		}
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
			const conflicts = (await this.run(["diff", "--name-only", "--relative", "--diff-filter=U"]))
				.split("\n")
				.filter(Boolean);
			// Aborting only succeeds when the pull stopped mid-rebase; otherwise report the original error.
			if (!(await this.abortRebase())) throw error;
			return { status: "conflict", conflicts };
		}
	}

	private async abortRebase(): Promise<boolean> {
		try {
			await this.run(["rebase", "--abort"]);
			return true;
		} catch {
			return false;
		}
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
		if (!staged && change.index === "?") return this.untrackedDiff(change.path, contextLines);
		const paths = change.origPath ? [change.origPath, change.path] : [change.path];
		const args = ["diff", "--find-renames", ...contextArg(contextLines)];
		if (staged) args.push("--cached");
		return this.run([...args, "--", ...paths]);
	}

	/** git diff ignores untracked files, so compare the file with nothing (exit code 1 means "differs"). */
	private untrackedDiff(path: string, contextLines?: number): Promise<string> {
		return this.run(["diff", "--no-index", ...contextArg(contextLines), "--", "/dev/null", path], { okExitCodes: [1] });
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

	async trustRepository(repoPath: string): Promise<void> {
		await this.run(["config", "--global", "--add", "safe.directory", repoPath]);
	}
}
