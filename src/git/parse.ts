import { AUTO_COMMIT_TRAILER_KEY, CommitInfo, StatusResult } from "./GitBackend";

const BRANCH_HEADER = /^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/;

/**
 * Parses `git status --porcelain=v1 -z --branch` output. Porcelain paths are
 * relative to the repository root, which is the vault root.
 */
export function parseStatus(output: string): StatusResult {
	const result: StatusResult = {
		branch: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		noCommits: false,
		files: [],
	};
	const entries = output.split("\0");

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;

		if (entry.startsWith("## ")) {
			result.noCommits = /^## (No commits yet|Initial commit) on /.test(entry);
			const match = BRANCH_HEADER.exec(entry);
			if (match) {
				const name = match[1];
				result.branch = name.startsWith("HEAD (no branch)") ? null : name;
				result.upstream = match[2] ?? null;
				const tracking = match[3] ?? "";
				result.ahead = Number(/ahead (\d+)/.exec(tracking)?.[1] ?? 0);
				result.behind = Number(/behind (\d+)/.exec(tracking)?.[1] ?? 0);
				if (tracking === "gone") result.upstream = null;
			}
			continue;
		}

		const index = entry[0];
		const worktree = entry[1];
		const path = entry.slice(3);
		let origPath: string | undefined;
		// With -z, renames/copies are followed by the original path as its own entry.
		if (index === "R" || index === "C") origPath = entries[++i];

		result.files.push({ path, origPath, index, worktree });
	}

	result.files.sort((a, b) => a.path.localeCompare(b.path));
	return result;
}

export const LOG_FORMAT =
	`%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%P%x1f%(trailers:key=${AUTO_COMMIT_TRAILER_KEY},valueonly)%x1e`;

export function parseLog(output: string): CommitInfo[] {
	return output
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const [hash, shortHash, author, date, subject, parents, autoTrailer] = record.split("\x1f");
			return {
				hash,
				shortHash,
				author,
				date: new Date(date),
				subject,
				parents: parents ? parents.split(" ") : [],
				auto: autoTrailer?.trim() === "true",
			};
		});
}
