import { DiffFile, DiffLine, diffFileTitle, toSplitRows } from "./unified";

export type DiffStyle = "split" | "inline";

/** Rows rendered per file before truncating, to keep huge diffs responsive. */
const MAX_ROWS_PER_FILE = 10_000;

export function renderDiffFiles(container: HTMLElement, files: DiffFile[], style: DiffStyle): void {
	if (!files.length) {
		container.createDiv({ cls: "hmb-scm-diff-empty", text: "No changes." });
		return;
	}

	for (const file of files) {
		const section = container.createDiv({ cls: "hmb-scm-diff-file" });
		const header = section.createDiv({ cls: "hmb-scm-diff-file-header" });
		header.createDiv({ cls: "hmb-scm-diff-file-name", text: diffFileTitle(file) });
		for (const meta of file.meta) header.createDiv({ cls: "hmb-scm-muted", text: meta });

		if (file.binary) {
			section.createDiv({ cls: "hmb-scm-diff-empty", text: "Binary file, no text diff." });
			continue;
		}
		if (!file.hunks.length) {
			section.createDiv({ cls: "hmb-scm-diff-empty", text: "No textual changes." });
			continue;
		}

		const table = section.createEl("table", { cls: ["hmb-scm-diff-table", `hmb-scm-diff-${style}`] });
		let budget = MAX_ROWS_PER_FILE;
		for (const hunk of file.hunks) {
			const hunkRow = table.createEl("tr", { cls: "hmb-scm-diff-hunk" });
			hunkRow.createEl("td", { text: hunk.header, attr: { colspan: style === "split" ? "4" : "3" } });

			if (style === "inline") {
				for (const line of hunk.lines.slice(0, budget)) inlineRow(table, line);
				budget -= hunk.lines.length;
			} else {
				const rows = toSplitRows(hunk.lines);
				for (const row of rows.slice(0, budget)) {
					const tr = table.createEl("tr");
					splitCells(tr, row.left, "old");
					splitCells(tr, row.right, "new");
				}
				budget -= rows.length;
			}
			if (budget <= 0) {
				section.createDiv({ cls: "hmb-scm-diff-empty", text: "Diff truncated: too many lines to display." });
				break;
			}
		}
	}
}

function inlineRow(table: HTMLElement, line: DiffLine): void {
	const tr = table.createEl("tr");
	const cls = `hmb-scm-diff-${line.kind}`;
	tr.createEl("td", { cls: ["hmb-scm-diff-num", cls], text: line.oldNo?.toString() ?? "" });
	tr.createEl("td", { cls: ["hmb-scm-diff-num", cls], text: line.newNo?.toString() ?? "" });
	const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
	tr.createEl("td", { cls: ["hmb-scm-diff-code", cls], text: sign + line.text });
}

function splitCells(tr: HTMLElement, line: DiffLine | null, side: "old" | "new"): void {
	const cls = `hmb-scm-diff-${line?.kind ?? "filler"}`;
	const number = line ? (side === "old" ? line.oldNo : line.newNo) : null;
	tr.createEl("td", { cls: ["hmb-scm-diff-num", cls], text: number?.toString() ?? "" });
	tr.createEl("td", { cls: ["hmb-scm-diff-code", cls], text: line?.text ?? "" });
}
