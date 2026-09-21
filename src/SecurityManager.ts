import { MountPoint, MountType } from './types';
import { getPlatform, normalizeForComparison, isUNCPath, isUnsupportedWindowsDevicePath } from './OSHelpers';
import { loadOptionalNodeModule } from './runtimeNode';
// Node.js builtins are lazy-loaded so the plugin still loads on mobile
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

/** Mount types whose realPath is a remote address, not a local filesystem path. */
const CLOUD_MOUNT_TYPES: Set<MountType> = new Set(['webdav', 's3', 'sftp']);

/** Folder names that hold credentials; a path containing one of these segments is never mountable. */
const CREDENTIAL_FOLDERS: ReadonlySet<string> = new Set(['.ssh', '.gnupg']);

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
		if (isUnsupportedWindowsDevicePath(realPath)) return false;
		const normalized = normalizeForComparison(realPath);
		for (const allowed of this.allowlist) {
			if (
				normalized === allowed ||
				normalized.startsWith(allowed + '/')
			) {
				return true;
			}
		}
		return false;
	}

	private validateLocalPath(candidatePath: string | undefined, fieldLabel: string, usageLabel: string): string | null {
		const trimmedPath = candidatePath?.trim();
		if (!trimmedPath) {
			return `${fieldLabel} cannot be empty.`;
		}
		if (isUnsupportedWindowsDevicePath(trimmedPath)) {
			return `${fieldLabel} uses an unsupported Windows device path.`;
		}
		const isPosixAbsolute = path.posix.isAbsolute(trimmedPath);
		const isWindowsAbsolute = path.win32.isAbsolute(trimmedPath);
		if (!isPosixAbsolute && !isWindowsAbsolute) {
			return `${fieldLabel} must be an absolute filesystem path.`;
		}
		const comparisonPaths = [normalizeForComparison(trimmedPath)];
		if (getPlatform() !== 'windows' && isPosixAbsolute) {
			comparisonPaths.push(path.posix.normalize(trimmedPath));
		}

		const dangerous = [
			'C:\\', 'C:/',
			'C:\\Windows', 'C:/Windows',
			'C:\\Program Files', 'C:/Program Files',
			'C:\\Program Files (x86)', 'C:/Program Files (x86)',
			'/', '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/var',
			// macOS keeps the real /etc and /var under /private; also system libraries.
			'/private/etc', '/private/var', '/System', '/lib', '/lib32', '/lib64', '/libx32',
		];
		for (const dangerousPath of dangerous) {
			const dangerousNorm = normalizeForComparison(dangerousPath);
			if (
				comparisonPaths.some(norm =>
					norm === dangerousNorm ||
					(dangerousNorm !== '/' && norm.startsWith(dangerousNorm + '/'))
				)
			) {
				return `"${trimmedPath}" is a protected system path and cannot be ${usageLabel}.`;
			}
		}

		// Windows can be installed on any drive letter, not only C:.
		if (comparisonPaths.some(norm => /^[a-z]:\/(windows|program files( \(x86\))?)(\/|$)/.test(norm))) {
			return `"${trimmedPath}" is a protected system path and cannot be ${usageLabel}.`;
		}

		// Credential folders are never a sensible mount, wherever they live.
		if (comparisonPaths.some(norm => norm.split('/').some(segment => CREDENTIAL_FOLDERS.has(segment)))) {
			return `"${trimmedPath}" is a protected path (it can hold credentials) and cannot be ${usageLabel}.`;
		}

		return null;
	}

	/**
	 * Validates every per-device override path with the same rules as realPath.
	 * Returns an error string on failure, or null on success.
	 */
	validateDeviceOverrides(deviceOverrides: unknown): string | null {
		if (deviceOverrides == null) return null;
		if (typeof deviceOverrides !== 'object' || Array.isArray(deviceOverrides)) {
			return 'Device overrides must be an object mapping device IDs to paths.';
		}
		for (const [deviceId, overridePath] of Object.entries(deviceOverrides as Record<string, unknown>)) {
			if (typeof overridePath !== 'string') {
				return `Device override for "${deviceId}" must be a path string.`;
			}
			const error = this.validateLocalPath(overridePath, `Device override path for "${deviceId}"`, 'mounted');
			if (error) return error;
		}
		return null;
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
			const realPathError = this.validateLocalPath(mount.realPath, 'Real path', 'mounted');
			if (realPathError) return realPathError;

			if (mount.fallbackRealPath?.trim()) {
				const fallbackPathError = this.validateLocalPath(mount.fallbackRealPath, 'Fallback path', 'used as a fallback path');
				if (fallbackPathError) return fallbackPathError;
			}

			// A device override replaces realPath as the effective mount root on
			// that device (and is auto-allowlisted), so it must pass the same
			// checks.  Without this, a shared TOC file or imported JSON could map
			// a protected path via deviceOverrides while realPath looks harmless.
			const overridesError = this.validateDeviceOverrides(mount.deviceOverrides);
			if (overridesError) return overridesError;
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
				norm.startsWith(existingRealNorm + '/');
			const isExistingChildOfCandidate =
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
