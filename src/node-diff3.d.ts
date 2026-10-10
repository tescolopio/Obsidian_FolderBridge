// node-diff3 ships its types only through package.json "exports", which the
// project's "node" module resolution doesn't read. Declare the part we use.
declare module 'node-diff3' {
	export interface MergeRegion<T> {
		ok?: T[];
		conflict?: { a: T[]; aIndex: number; b: T[]; bIndex: number; o: T[]; oIndex: number };
	}
	export function diff3Merge<T = string>(
		a: string | T[],
		o: string | T[],
		b: string | T[],
		options?: { excludeFalseConflicts?: boolean; stringSeparator?: string | RegExp },
	): MergeRegion<T>[];
}
