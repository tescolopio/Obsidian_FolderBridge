import { diff3Merge } from 'node-diff3';

/**
 * Three-way merge of line-based text: `base` is the version both sides
 * started from, `mine` is what Obsidian is saving, `theirs` is what is on
 * disk now. Changes to different lines are combined; `clean` is false when
 * both sides changed the same lines (then nothing is merged).
 */
export function mergeText(base: string, mine: string, theirs: string): { clean: boolean; merged: string } {
	const lines = (s: string) => s.replace(/\r\n/g, '\n').split('\n');
	const regions = diff3Merge(lines(mine), lines(base), lines(theirs), { excludeFalseConflicts: true });
	const merged: string[] = [];
	for (const region of regions) {
		if (region.conflict) return { clean: false, merged: '' };
		if (region.ok) merged.push(...region.ok);
	}
	return { clean: true, merged: merged.join('\n') };
}

/** File types Obsidian edits as plain text, where a line-based merge makes sense. */
export function isMergeableText(path: string): boolean {
	return /\.(md|mdx|canvas|base|txt|csv|json)$/i.test(path);
}

/** A text as Obsidian read or wrote it, with the file's modification time at that moment. */
export interface RecentText {
	text: string;
	/** Rounded modification time (ms) of the version this text came from. */
	mtime: number;
}

/**
 * Small LRU of the last text Obsidian read or wrote per path: the "base" of
 * a three-way merge. Entries for notes open in an editor (`isPinned`) are not
 * evicted, because they are exactly the ones a merge needs.
 */
export class RecentTexts {
	private map = new Map<string, RecentText>();
	private chars = 0;

	constructor(
		private readonly isPinned: (path: string) => boolean = () => false,
		private readonly maxEntries = 200,
		private readonly maxChars = 8 * 1024 * 1024,
	) { }

	get(path: string): RecentText | undefined {
		const value = this.map.get(path);
		if (value !== undefined) { this.map.delete(path); this.map.set(path, value); }
		return value;
	}

	set(path: string, text: string, mtime: number): void {
		this.delete(path);
		if (text.length > this.maxChars / 4) return; // don't keep huge files
		this.map.set(path, { text, mtime });
		this.chars += text.length;
		let guard = this.map.size;
		while ((this.map.size > this.maxEntries || this.chars > this.maxChars) && guard-- > 0) {
			const oldest = this.map.keys().next().value as string;
			const value = this.map.get(oldest) as RecentText;
			this.map.delete(oldest);
			if (this.isPinned(oldest)) this.map.set(oldest, value); // keep, move to the newest end
			else this.chars -= value.text.length;
		}
	}

	delete(path: string): void {
		const old = this.map.get(path);
		if (old === undefined) return;
		this.chars -= old.text.length;
		this.map.delete(path);
	}
}
