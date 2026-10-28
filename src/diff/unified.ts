/** Structured form of `git diff` / `git show` unified diff output. */

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
	oldNo: number | null;
	newNo: number | null;
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export interface DiffFile {
	/** Null when the file was added. */
	oldPath: string | null;
	/** Null when the file was deleted. */
	newPath: string | null;
	/** Extended header lines worth showing (new file, rename, mode change…). */
	meta: string[];
	hunks: DiffHunk[];
	binary: boolean;
}

/** One row of a side-by-side diff; a missing side renders as filler. */
export interface SplitRow {
	left: DiffLine | null;
	right: DiffLine | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const HIDDEN_META = /^(index |--- |\+\+\+ )/;

export function parseUnifiedDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | null = null;
	let hunk: DiffHunk | null = null;
	let oldNo = 0;
	let newNo = 0;

	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
			file = { oldPath: match?.[1] ?? null, newPath: match?.[2] ?? null, meta: [], hunks: [], binary: false };
			files.push(file);
			hunk = null;
			continue;
		}
		if (!file) continue;

		const header = HUNK_HEADER.exec(line);
		if (header) {
			oldNo = Number(header[1]);
			newNo = Number(header[2]);
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
			continue;
		}

		if (!hunk) {
			// Extended header of the current file. --- / +++ hold the most reliable paths.
			if (line.startsWith("--- ")) file.oldPath = headerPath(line);
			else if (line.startsWith("+++ ")) file.newPath = headerPath(line);
			else if (line.startsWith("new file")) file.oldPath = null;
			else if (line.startsWith("deleted file")) file.newPath = null;
			if (line.startsWith("Binary files") || line === "Binary file") file.binary = true;
			if (line && !HIDDEN_META.test(line)) file.meta.push(line);
			continue;
		}

		if (line.startsWith("+")) hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
		else if (line.startsWith("-")) hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
		else if (line.startsWith(" ")) {
			hunk.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
		}
		// "\ No newline at end of file" and the trailing empty line are skipped.
	}
	return files;
}

/** "--- a/Notes/x.md" → "Notes/x.md"; "/dev/null" → null. Git appends a tab when the name has spaces. */
function headerPath(line: string): string | null {
	const raw = line.slice(4).replace(/\t$/, "");
	if (raw === "/dev/null") return null;
	return raw.replace(/^[ab]\//, "");
}

/** Pairs runs of deletions with the additions that follow them. */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i].kind === "context") {
			rows.push({ left: lines[i], right: lines[i] });
			i++;
			continue;
		}
		const dels: DiffLine[] = [];
		const adds: DiffLine[] = [];
		while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
		while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
		for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
			rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
		}
	}
	return rows;
}

export function diffFileTitle(file: DiffFile): string {
	if (file.oldPath && file.newPath && file.oldPath !== file.newPath) return `${file.oldPath} → ${file.newPath}`;
	return file.newPath ?? file.oldPath ?? "(unknown file)";
}
