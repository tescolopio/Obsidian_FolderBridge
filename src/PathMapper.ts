import { normalizePath } from 'obsidian';
import { MountPoint } from './types';
import { loadOptionalNodeModule } from './runtimeNode';
// Node.js builtins are lazy-loaded so the plugin still loads on mobile
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

/**
 * PathMapper maintains the list of active mount points and provides
 * bidirectional translation between vault-relative virtual paths and
 * real absolute filesystem paths.
 *
 * All vault paths are "normalized" (forward slashes, no leading slash),
 * matching the format Obsidian uses internally.
 */
export class PathMapper {
	private mounts: MountPoint[] = [];
	private currentDeviceId: string = '';

	/**
	 * Pre-sorted, pre-normalized cache rebuilt by update().
	 * Sorted descending by normalizedVirtualPath.length so that the
	 * most-specific (longest) mount always wins when paths overlap.
	 * Avoids allocating a new sorted array and re-calling normalizePath
	 * on every getMountForPath() invocation (which fires on every I/O op).
	 */
	private sortedMountCache: ReadonlyArray<{
		mount: MountPoint;
		normalizedVirtualPath: string;
	}> = [];

	/**
	 * Runtime-resolved real paths, keyed by mount ID.
	 * Populated once at mount activation when fallbackRealPath is used
	 * (primary path inaccessible, fallback accessible).
	 * Never written to data.json — reset on each session.
	 */
	private resolvedRealPaths: Map<string, string> = new Map();

	/** Replace the active mount list (call after settings change). */
	update(mounts: MountPoint[], deviceId: string = ''): void {
		this.currentDeviceId = deviceId;
		this.mounts = mounts.filter(m => m.enabled);
		// Build a sorted, pre-normalized lookup cache so hot-path methods
		// (getMountForPath, getMountByVirtualPath, …) never sort or normalize
		// inside their loops.
		this.sortedMountCache = this.mounts
			.map(m => ({ mount: m, normalizedVirtualPath: normalizePath(m.virtualPath) }))
			.sort((a, b) => b.normalizedVirtualPath.length - a.normalizedVirtualPath.length);
		// Remove runtime-resolved paths for mounts no longer active
		const activeIds = new Set(this.mounts.map(m => m.id));
		for (const id of this.resolvedRealPaths.keys()) {
			if (!activeIds.has(id)) this.resolvedRealPaths.delete(id);
		}
	}

	/**
	 * Store a runtime-resolved real path for a mount (used when the fallback
	 * path was selected at activation time because the primary was inaccessible).
	 */
	setResolvedPath(mountId: string, resolvedPath: string): void {
		this.resolvedRealPaths.set(mountId, resolvedPath);
	}

	/** Clear a previously stored runtime-resolved path (primary is accessible again). */
	clearResolvedPath(mountId: string): void {
		this.resolvedRealPaths.delete(mountId);
	}

	getMounts(): MountPoint[] {
		return this.mounts;
	}

	/**
	 * Gets the effective real path for a mount on this specific device.
	 * Priority:
	 *   1. Explicit per-device override (deviceOverrides[currentDeviceId])
	 *   2. Runtime-resolved fallback (set at activation when primary was inaccessible)
	 *   3. Primary realPath
	 */
	getEffectiveRealPath(mount: MountPoint): string {
		if (this.currentDeviceId && mount.deviceOverrides?.[this.currentDeviceId]) {
			return mount.deviceOverrides[this.currentDeviceId];
		}
		if (this.resolvedRealPaths.has(mount.id)) {
			return this.resolvedRealPaths.get(mount.id)!;
		}
		return mount.realPath;
	}

	/**
	 * Returns the mount whose virtualPath exactly matches the given path.
	 * Used to detect "this IS a mount root" checks.
	 */
	getMountByVirtualPath(virtualPath: string): MountPoint | undefined {
		const n = normalizePath(virtualPath);
		return this.sortedMountCache.find(({ normalizedVirtualPath }) => normalizedVirtualPath === n)?.mount;
	}

	/**
	 * Returns the mount that owns the given virtual path (the path is the
	 * mount root OR a descendant of it).  Returns undefined if the path
	 * lives entirely inside the real vault.
	 */
	getMountForPath(virtualPath: string): MountPoint | undefined {
		const n = normalizePath(virtualPath);
		// sortedMountCache is already sorted longest-first and pre-normalized,
		// so no allocation or per-entry normalizePath() needed here.
		return this.sortedMountCache.find(
			({ normalizedVirtualPath: mv }) => n === mv || n.startsWith(mv + '/')
		)?.mount;
	}

	/** True if virtualPath is a mount root or inside a mount. */
	isInsideMount(virtualPath: string): boolean {
		return this.getMountForPath(virtualPath) !== undefined;
	}

	/**
	 * Translate a virtual vault path to the real filesystem path using
	 * the provided mount.  The mount must be the one returned by
	 * getMountForPath() for this virtualPath.
	 */
	toRealPath(virtualPath: string, mount: MountPoint): string {
		const n = normalizePath(virtualPath);
		const mv = normalizePath(mount.virtualPath);
		const effectiveRealPath = this.getEffectiveRealPath(mount);

		if (n === mv) return effectiveRealPath;
		const relative = n.slice(mv.length + 1); // strip "mount/" prefix
		// On Windows path.join handles backslash; on POSIX it stays as '/'
		return path.join(effectiveRealPath, ...relative.split('/'));
	}

	/**
	 * Translate a real filesystem path back to a virtual vault path.
	 * Only valid if realPath is inside mount.realPath.
	 */
	toVirtualPath(realPath: string, mount: MountPoint): string {
		const effectiveRealPath = this.getEffectiveRealPath(mount);
		const rel = path.relative(effectiveRealPath, realPath);
		if (!rel || rel.startsWith('..')) return normalizePath(mount.virtualPath);
		return normalizePath(mount.virtualPath + '/' + rel.split(path.sep).join('/'));
	}

	/**
	 * Returns the normalized virtual paths of mounts that are DIRECT children
	 * of parentVirtualPath.  Used to inject virtual folders into vault listings.
	 *
	 * parentVirtualPath === '' means the vault root.
	 */
	getVirtualMountsDirectChildren(parentVirtualPath: string): string[] {
		const parent = parentVirtualPath === '' ? '' : normalizePath(parentVirtualPath);
		const result: string[] = [];

		for (const { normalizedVirtualPath: mv } of this.sortedMountCache) {
			if (parent === '') {
				// Root: return the first path component of each mount so that
				// intermediate virtual folders (e.g. "Projects" for a mount at
				// "Projects/Work") also appear in the vault root listing.
				const firstSlash = mv.indexOf('/');
				const directChild = firstSlash === -1 ? mv : mv.slice(0, firstSlash);
				if (!result.includes(directChild)) result.push(directChild);
			} else {
				// Non-root: include the first direct child under this parent,
				// whether it is the mount itself or an intermediate virtual folder.
				if (mv.startsWith(parent + '/')) {
					const remainder = mv.slice(parent.length + 1);
					const nextSlash = remainder.indexOf('/');
					const directChild = nextSlash === -1
						? mv
						: parent + '/' + remainder.slice(0, nextSlash);
					if (!result.includes(directChild)) result.push(directChild);
				}
			}
		}

		return result;
	}

	/**
	 * True if any active mount is the given path or a descendant/child.
	 * Used to decide whether a non-existent vault directory should
	 * "appear to exist" because it is a virtual parent of a mount.
	 */
	hasMountsUnder(virtualPath: string): boolean {
		const n = virtualPath === '' ? '' : normalizePath(virtualPath);
		return this.sortedMountCache.some(
			({ normalizedVirtualPath: mv }) => mv === n || mv.startsWith(n === '' ? '' : n + '/')
		);
	}
}
