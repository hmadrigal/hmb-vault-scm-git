/**
 * Backend-agnostic view of a git repository. The desktop build talks to the
 * git CLI (CliGitBackend); a future mobile build can provide an
 * isomorphic-git implementation without touching the UI.
 *
 * All paths are relative to the vault root, using forward slashes.
 */

/** One entry of `git status`, using the porcelain XY codes. */
export interface FileChange {
	path: string;
	/** Previous path for renames/copies. */
	origPath?: string;
	/** Index (staged) status: ' ', M, A, D, R, C, U or ? */
	index: string;
	/** Working tree (unstaged) status: ' ', M, D, U or ? */
	worktree: string;
}

export interface StatusResult {
	/** Current branch, or null when HEAD is detached. */
	branch: string | null;
	/** Upstream like "origin/main", or null when none is configured. */
	upstream: string | null;
	ahead: number;
	behind: number;
	/** True when the repository has no commits yet. */
	noCommits: boolean;
	files: FileChange[];
}

export interface CommitInfo {
	hash: string;
	shortHash: string;
	author: string;
	date: Date;
	subject: string;
	parents: string[];
	/** True when the message carries the auto-commit trailer. */
	auto: boolean;
}

/** Trailer appended to auto-commit messages so they can be recognised later. */
export const AUTO_COMMIT_TRAILER_KEY = "Auto-commit";
export const AUTO_COMMIT_TRAILER = `${AUTO_COMMIT_TRAILER_KEY}: true`;

export type PullResult =
	| { status: "up-to-date" | "updated" }
	| { status: "conflict"; conflicts: string[] };

export interface GitBackend {
	isRepo(): Promise<boolean>;
	init(defaultBranch: string): Promise<void>;
	status(): Promise<StatusResult>;

	stage(paths: string[]): Promise<void>;
	stageAll(): Promise<void>;
	unstage(paths: string[]): Promise<void>;
	discard(changes: FileChange[]): Promise<void>;
	/** Committed files that .gitignore now matches (git keeps tracking them until untracked). */
	trackedIgnoredFiles(): Promise<string[]>;
	/** Removes files from the index only; they stay on disk and show as staged deletions. */
	untrack(paths: string[]): Promise<void>;
	/** Commits what is staged and returns the new short hash. */
	commit(message: string): Promise<string>;

	fetch(remote: string): Promise<void>;
	push(remote: string, branch: string, setUpstream: boolean): Promise<void>;
	/** Pulls with rebase; on conflict the rebase is aborted and nothing changes. */
	pull(remote: string, branch: string, hasUpstream: boolean): Promise<PullResult>;

	log(limit: number, path?: string): Promise<CommitInfo[]>;
	/** Commits reachable from HEAD that no remote-tracking branch contains, newest first. */
	unpushedCommits(limit: number): Promise<CommitInfo[]>;
	/**
	 * Replaces the commits after `base` (null: all of history) with one commit
	 * holding HEAD's tree. Index and working tree are untouched. Returns the short hash.
	 */
	squash(base: string | null, message: string): Promise<string>;
	/** Patch introduced by a commit, optionally limited to one file. */
	showCommit(hash: string, path?: string, contextLines?: number): Promise<string>;
	/** Uncommitted diff of one file (staged or working tree). */
	diffWorking(change: FileChange, staged: boolean, contextLines?: number): Promise<string>;
	/** Overwrites the working copy of a file with its content at a commit. */
	restoreFile(hash: string, path: string): Promise<void>;

	getRemoteUrl(remote: string): Promise<string | null>;
	setRemoteUrl(remote: string, url: string): Promise<void>;

	/** Adds a folder to git's global safe.directory list (see UnsafeRepositoryError). */
	trustRepository(repoPath: string): Promise<void>;
}

export class GitError extends Error {
	constructor(message: string, readonly stderr = "", readonly exitCode: number | null = null) {
		super(message);
		this.name = "GitError";
	}
}

/**
 * git refuses to work in a repository owned by another user (for example a
 * folder copied from another account or machine) until it is listed in
 * safe.directory. `repoPath` is the repository root as git reports it.
 */
export class UnsafeRepositoryError extends GitError {
	constructor(
		readonly repoPath: string,
		stderr: string,
	) {
		super(`Git does not trust "${repoPath}" because another user owns it.`, stderr, 128);
		this.name = "UnsafeRepositoryError";
	}
}

export function isStaged(change: FileChange): boolean {
	return change.index !== " " && change.index !== "?" && change.index !== "!";
}

export function hasWorktreeChange(change: FileChange): boolean {
	return change.worktree !== " ";
}

export function isUntracked(change: FileChange): boolean {
	return change.index === "?";
}

/** The newest unbroken run of auto-commits in a newest-first list (merge commits end a run). */
export function latestAutoRun(commits: CommitInfo[]): CommitInfo[] {
	const run: CommitInfo[] = [];
	for (const commit of commits) {
		if (!commit.auto || commit.parents.length > 1) break;
		run.push(commit);
	}
	return run;
}
