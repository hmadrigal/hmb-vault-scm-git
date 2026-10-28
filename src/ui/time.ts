import { moment } from "obsidian";

/**
 * The part of Obsidian's bundled moment.js used here. Its full typings come from
 * the "moment" package, which is not a dependency of this plugin, so the
 * function is narrowed to this shape instead.
 */
interface MomentLike {
	format(format?: string): string;
	fromNow(): string;
}

const momentFn = moment as unknown as (input?: Date | number) => MomentLike;

/** Formats a date with a moment.js format string, e.g. "YYYY-MM-DD HH:mm" or "LLL". */
export function formatDate(date: Date | number, format: string): string {
	return momentFn(date).format(format);
}

/** Relative time such as "3 hours ago". */
export function fromNow(date: Date | number): string {
	return momentFn(date).fromNow();
}
