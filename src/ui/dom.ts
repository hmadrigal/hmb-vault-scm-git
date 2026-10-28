import { setIcon } from "obsidian";

export function iconButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	onClick: (evt: MouseEvent) => void,
): HTMLElement {
	const el = parent.createDiv({ cls: ["clickable-icon", "hmb-scm-icon-btn"], attr: { "aria-label": label } });
	setIcon(el, icon);
	el.addEventListener("click", (evt) => {
		evt.stopPropagation();
		onClick(evt);
	});
	return el;
}
