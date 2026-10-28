/** Building .gitignore patterns for vault paths. Pure functions, no I/O. */

export interface IgnoreOption {
	label: string;
	pattern: string;
}

/** Escapes glob characters so the pattern matches the literal name. */
function escapeGlob(text: string): string {
	return text.replace(/[\\*?[]/g, (char) => `\\${char}`);
}

/** Makes an unanchored pattern safe as a line: leading # or ! and trailing spaces are special. */
function lineSafe(pattern: string): string {
	const escaped = /^[#!]/.test(pattern) ? `\\${pattern}` : pattern;
	return escaped.replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
}

export function ignoreOptionsForFile(path: string): IgnoreOption[] {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const options: IgnoreOption[] = [{ label: "Ignore this file", pattern: lineSafe(`/${escapeGlob(path)}`) }];
	if (path.includes("/")) {
		options.push({ label: `Ignore every file named "${name}"`, pattern: lineSafe(escapeGlob(name)) });
	}
	const dot = name.lastIndexOf(".");
	if (dot > 0 && dot < name.length - 1) {
		const extension = name.slice(dot);
		options.push({ label: `Ignore all ${extension} files`, pattern: lineSafe(`*${escapeGlob(extension)}`) });
	}
	return options;
}

export function ignoreOptionForFolder(path: string): IgnoreOption {
	return { label: "Ignore this folder", pattern: lineSafe(`/${escapeGlob(path)}/`) };
}

/** Returns the new .gitignore content with the missing patterns appended, or null when all are present. */
export function appendToGitignore(existing: string, patterns: string[]): string | null {
	const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
	const missing = [...new Set(patterns)].filter((pattern) => !present.has(pattern));
	if (!missing.length) return null;
	const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
	return `${existing}${separator}${missing.join("\n")}\n`;
}
