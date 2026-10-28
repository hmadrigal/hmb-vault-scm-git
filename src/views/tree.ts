import type { FileChange } from "../git/GitBackend";

export interface FolderNode {
	/** Display name; may span several levels after compaction ("Projects/2026"). */
	name: string;
	path: string;
	folders: FolderNode[];
	files: FileChange[];
}

/** Groups changes by folder, merging single-child folder chains like VS Code. */
export function buildTree(files: FileChange[]): FolderNode {
	const root: FolderNode = { name: "", path: "", folders: [], files: [] };
	for (const file of files) {
		const parts = file.path.split("/");
		parts.pop();
		let node = root;
		for (const part of parts) {
			const path = node.path ? `${node.path}/${part}` : part;
			let child = node.folders.find((folder) => folder.path === path);
			if (!child) {
				child = { name: part, path, folders: [], files: [] };
				node.folders.push(child);
			}
			node = child;
		}
		node.files.push(file);
	}
	compact(root);
	return root;
}

function compact(node: FolderNode): void {
	node.folders = node.folders.map((folder) => {
		let merged = folder;
		while (merged.files.length === 0 && merged.folders.length === 1) {
			const only = merged.folders[0];
			merged = { ...only, name: `${merged.name}/${only.name}` };
		}
		compact(merged);
		return merged;
	});
	node.folders.sort((a, b) => a.name.localeCompare(b.name));
}

export function filesUnder(node: FolderNode): FileChange[] {
	return [...node.files, ...node.folders.flatMap(filesUnder)];
}
