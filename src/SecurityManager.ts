import { MountPoint, MountType } from './types';
import { normalizeForComparison, isUNCPath } from './OSHelpers';
import { loadOptionalNodeModule } from './runtimeNode';
// Node.js builtins are lazy-loaded so the plugin still loads on mobile
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

/** Mount types whose realPath is a remote address, not a local filesystem path. */
const CLOUD_MOUNT_TYPES: Set<MountType> = new Set(['webdav', 's3', 'sftp']);

/**
 * SecurityManager enforces an explicit allowlist of real filesystem paths.
 * Every I/O operation on a mounted path is checked against this list before
 * proceeding.  On Windows, comparisons are case-insensitive to match NTFS
 * semantics (e.g. 'C:\Docs' and 'c:\docs' refer to the same location).
 */
export class SecurityManager {
	private allowlist: Set<string>;

	constructor(allowedPaths: string[]) {
		this.allowlist = new Set(allowedPaths.map(p => normalizeForComparison(p)));
	}

	/** Replace the entire allowlist (call after settings change). */
	setAllowlist(paths: string[]): void {
		this.allowlist = new Set(paths.map(p => normalizeForComparison(p)));
	}

	/**
	 * Returns true when realPath is equal to an allowlisted path, or is
	 * contained inside one.  The check is path-separator-aware to prevent
	 * prefix-substring false positives (e.g. "/foo" must not match "/foobar").
	 * On Windows the comparison is case-insensitive.
	 */
	isAllowed(realPath: string): boolean {
		const normalized = normalizeForComparison(realPath);
		for (const allowed of this.allowlist) {
			if (
				normalized === allowed ||
				normalized.startsWith(allowed + path.sep) ||
				// Case-insensitive comparison may produce lowercased sep; check both
				normalized.startsWith(allowed + '/')
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Validates a candidate mount before it is added to settings.
	 * Returns an error string on failure, or null on success.
	 */
	validateMount(
		mount: Omit<MountPoint, 'id'>,
		existingMounts: MountPoint[]
	): string | null {
		if (!mount.virtualPath || !mount.virtualPath.trim()) {
			return 'Virtual path cannot be empty.';
		}

		// Cloud mounts (WebDAV, S3, SFTP) don't have local real paths — skip local-path checks.
		const isCloud = mount.mountType != null && CLOUD_MOUNT_TYPES.has(mount.mountType);

		if (!isCloud) {
			if (!mount.realPath || !mount.realPath.trim()) {
				return 'Real path cannot be empty.';
			}
			if (!path.posix.isAbsolute(mount.realPath) && !path.win32.isAbsolute(mount.realPath)) {
				return 'Real path must be an absolute filesystem path.';
			}

			// Block obviously dangerous root-level paths and their subdirectories
			const dangerous = [
				'/', '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/var',
				'C:\\', 'C:/',
				'C:\\Windows', 'C:/Windows',
				'C:\\Program Files', 'C:/Program Files',
				'C:\\Program Files (x86)', 'C:/Program Files (x86)'
			];
			const norm = normalizeForComparison(mount.realPath);
			for (const d of dangerous) {
				const dangerousNorm = normalizeForComparison(d);
				if (
					norm === dangerousNorm ||
					norm.startsWith(dangerousNorm + path.sep) ||
					// Case-insensitive comparison may produce lowercased or normalized separators; check both
					norm.startsWith(dangerousNorm + '/')
				) {
					return `"${mount.realPath}" is a protected system path and cannot be mounted.`;
				}
			}
		}

		// Normalize virtual path (trim and remove trailing slashes) for comparison
		const virtualNorm = mount.virtualPath.trim().replace(/[\\/]+$/, '');

		// Reject duplicate virtual paths
		if (
			existingMounts.some(
				m => (m.virtualPath || '').trim().replace(/[\\/]+$/, '') === virtualNorm
			)
		) {
			return `Virtual path "${virtualNorm}" is already in use.`;
		}

		// Reject mounts whose virtual paths are parents/children of existing ones
		for (const m of existingMounts) {
			const existingVirtual = (m.virtualPath || '').trim();
			if (!existingVirtual) {
				continue;
			}
			const existingVirtualNorm = existingVirtual.replace(/[\\/]+$/, '');
			if (!existingVirtualNorm || existingVirtualNorm === virtualNorm) {
				continue;
			}

			// Check for path-separator-aware parent/child relationships
			const isCandidateChildOfExisting =
				virtualNorm.startsWith(existingVirtualNorm + path.sep) ||
				virtualNorm.startsWith(existingVirtualNorm + '/');
			const isExistingChildOfCandidate =
				existingVirtualNorm.startsWith(virtualNorm + path.sep) ||
				existingVirtualNorm.startsWith(virtualNorm + '/');

			if (isCandidateChildOfExisting || isExistingChildOfCandidate) {
				return `Virtual path "${virtualNorm}" overlaps with existing mount "${existingVirtualNorm}".`;
			}
		}

		return null;
	}

	/**
	 * Returns non-blocking advisory warnings for a real path.
	 * Unlike validateMount(), these do not prevent the mount from being added —
	 * they are surfaced to the user as informational notices.
	 *
	 * Pass `existingMounts` to also receive overlap advisories when the
	 * candidate real path is a parent or child of an already-mounted path.
	 */
	getPathWarnings(realPath: string, existingMounts: MountPoint[] = [], mountType?: MountType): string[] {
		const warnings: string[] = [];

		// Cloud mounts use remote addresses, not local paths — skip all local-path warnings.
		if (mountType != null && CLOUD_MOUNT_TYPES.has(mountType)) return warnings;

		if (isUNCPath(realPath)) {
			warnings.push(
				`"${realPath}" is a UNC network path. Network mounts may be slow, ` +
				`unavailable offline, or behave differently from local folders ` +
				`(e.g. file watching may not work on some servers).`
			);
		}

		const norm = normalizeForComparison(realPath);
		for (const m of existingMounts) {
			const existingReal = m.realPath;
			if (!existingReal) continue;
			const existingRealNorm = normalizeForComparison(existingReal);
			if (existingRealNorm === norm) continue;

			const isCandidateChildOfExisting =
				norm.startsWith(existingRealNorm + path.sep) ||
				norm.startsWith(existingRealNorm + '/');
			const isExistingChildOfCandidate =
				existingRealNorm.startsWith(norm + path.sep) ||
				existingRealNorm.startsWith(norm + '/');

			if (isCandidateChildOfExisting || isExistingChildOfCandidate) {
				warnings.push(
					`Real path "${realPath}" overlaps with existing mount "${existingReal}". ` +
					`The same files on disk will be reachable via two different vault paths.`
				);
			}
		}

		return warnings;
	}

	/** Add a path to the allowlist. */
	allow(realPath: string): void {
		this.allowlist.add(normalizeForComparison(realPath));
	}

	/** Remove a path from the allowlist. */
	revoke(realPath: string): void {
		this.allowlist.delete(normalizeForComparison(realPath));
	}

	getAllowedPaths(): string[] {
		return Array.from(this.allowlist);
	}
}
