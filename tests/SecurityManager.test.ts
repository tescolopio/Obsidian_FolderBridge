import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { SecurityManager } from '../src/SecurityManager';
import type { MountPoint } from '../src/types';

// Helper: temporarily override process.platform
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
	const orig = process.platform;
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	try { fn(); } finally {
		Object.defineProperty(process, 'platform', { value: orig, configurable: true });
	}
}

function mkMount(virtualPath: string, realPath: string): Omit<MountPoint, 'id'> {
	return { virtualPath, realPath, enabled: true, readOnly: false };
}

describe('SecurityManager', () => {
	let sec: SecurityManager;

	beforeEach(() => {
		sec = new SecurityManager(['/allowed/path']);
	});

	describe('isAllowed', () => {
		it('allows an exact match to an allowlisted path', () => {
			expect(sec.isAllowed('/allowed/path')).toBe(true);
		});

		it('allows a subdirectory of an allowlisted path', () => {
			expect(sec.isAllowed('/allowed/path/subdir/file.md')).toBe(true);
		});

		it('rejects a path not in the allowlist', () => {
			expect(sec.isAllowed('/not/allowed')).toBe(false);
		});

		it('rejects a prefix-substring path that is not a subdirectory', () => {
			// /allowed/pathmore should NOT be allowed when /allowed/path is in list
			expect(sec.isAllowed('/allowed/pathmore')).toBe(false);
		});
	});

	describe('allow / revoke', () => {
		it('dynamically adds a path to the allowlist', () => {
			sec.allow('/new/path');
			expect(sec.isAllowed('/new/path/file.txt')).toBe(true);
		});

		it('revokes an allowlisted path', () => {
			sec.revoke('/allowed/path');
			expect(sec.isAllowed('/allowed/path')).toBe(false);
		});

		it('does not affect other entries when revoking', () => {
			sec.allow('/other');
			sec.revoke('/allowed/path');
			expect(sec.isAllowed('/other')).toBe(true);
		});
	});

	describe('validateMount', () => {
		it('returns null for a valid mount', () => {
			expect(sec.validateMount(mkMount('Work', '/home/user/Work'), [])).toBeNull();
		});

		it('rejects empty virtual path', () => {
			expect(sec.validateMount(mkMount('', '/home/user/Work'), [])).toMatch(/virtual path/i);
		});

		it('rejects empty real path', () => {
			expect(sec.validateMount(mkMount('Work', ''), [])).toMatch(/real path/i);
		});

		it('rejects a non-absolute real path', () => {
			expect(sec.validateMount(mkMount('Work', 'relative/path'), [])).toMatch(/absolute/i);
		});

		it('rejects a non-absolute fallback path', () => {
			expect(sec.validateMount({
				...mkMount('Work', '/home/user/Work'),
				fallbackRealPath: 'relative/fallback',
			}, [])).toMatch(/fallback path must be an absolute/i);
		});

		it('blocks the POSIX system root /', () => {
			expect(sec.validateMount(mkMount('Root', '/'), [])).toMatch(/protected/i);
		});

		it('blocks dangerous POSIX system paths like /etc', () => {
			expect(sec.validateMount(mkMount('Etc', '/etc'), [])).toMatch(/protected/i);
		});

		it('blocks /etc subdirectories', () => {
			expect(sec.validateMount(mkMount('Ssl', '/etc/ssl'), [])).toMatch(/protected/i);
		});

		it('blocks dangerous fallback paths like /etc', () => {
			expect(sec.validateMount({
				...mkMount('Work', '/home/user/Work'),
				fallbackRealPath: '/etc',
			}, [])).toMatch(/protected system path/i);
		});

		it('rejects a duplicate virtual path', () => {
			const existing: MountPoint[] = [{
				id: '1', virtualPath: 'Work', realPath: '/real/Work', enabled: true, readOnly: false,
			}];
			const err = sec.validateMount(mkMount('Work', '/real/Other'), existing);
			expect(err).toMatch(/already in use/i);
		});

		it('rejects a virtual path that is a child of an existing mount', () => {
			const existing: MountPoint[] = [{
				id: '1', virtualPath: 'Projects', realPath: '/real/Projects', enabled: true, readOnly: false,
			}];
			const err = sec.validateMount(mkMount('Projects/Work', '/real/Work'), existing);
			expect(err).toMatch(/overlaps/i);
		});

		it('allows a real path that is a subdirectory of an existing mount real path (advisory warning only)', () => {
			const existing: MountPoint[] = [{
				id: '1', virtualPath: 'ParentMount', realPath: '/real/parent', enabled: true, readOnly: false,
			}];
			// No longer a blocking error — overlap is surfaced as an advisory warning instead
			const err = sec.validateMount(mkMount('ChildMount', '/real/parent/child'), existing);
			expect(err).toBeNull();
			expect(sec.getPathWarnings('/real/parent/child', existing).length).toBeGreaterThan(0);
		});

		it('allows Backup/Code-Scalpel and Backup to coexist as separate bridges', () => {
			// Scenario from issue: mount virtualPath "Code-Scalpel" → /Backup/Code-Scalpel first,
			// then mount virtualPath "Backup" → /Backup.  Real paths overlap; virtual paths do not.
			const existing: MountPoint[] = [{
				id: '1', virtualPath: 'Code-Scalpel', realPath: '/Backup/Code-Scalpel', enabled: true, readOnly: false,
			}];
			const err = sec.validateMount(mkMount('Backup', '/Backup'), existing);
			expect(err).toBeNull();
			// Overlap between /Backup and /Backup/Code-Scalpel should be surfaced as an advisory warning
			const warnings = sec.getPathWarnings('/Backup', existing);
			expect(warnings.length).toBeGreaterThan(0);
		});

	});

	describe('getPathWarnings', () => {
		it('returns a warning for UNC paths', () => {
			const warnings = sec.getPathWarnings('\\\\server\\share\\folder');
			expect(warnings.length).toBeGreaterThan(0);
			expect(warnings[0]).toMatch(/UNC|network/i);
		});

		it('returns no warnings for a normal local path with no existing mounts', () => {
			const warnings = sec.getPathWarnings('/home/user/docs');
			expect(warnings).toHaveLength(0);
		});

		it('returns an advisory warning when the candidate is a child of an existing mount real path', () => {
			const existing: MountPoint[] = [{
				id: '1', virtualPath: 'Backup', realPath: '/Backup', enabled: true, readOnly: false,
			}];
			const warnings = sec.getPathWarnings('/Backup/Code-Scalpel', existing);
			expect(warnings.length).toBeGreaterThan(0);
			expect(warnings[0]).toMatch(/overlaps/i);
		});

		it('returns an advisory warning when the candidate is a parent of an existing mount real path', () => {
			const existing: MountPoint[] = [{
				id: '1', virtualPath: 'CodeScalpel', realPath: '/Backup/Code-Scalpel', enabled: true, readOnly: false,
			}];
			const warnings = sec.getPathWarnings('/Backup', existing);
			expect(warnings.length).toBeGreaterThan(0);
			expect(warnings[0]).toMatch(/overlaps/i);
		});

		it('returns no overlap warning when the real paths are unrelated', () => {
			const existing: MountPoint[] = [{
				id: '1', virtualPath: 'Work', realPath: '/home/user/Work', enabled: true, readOnly: false,
			}];
			const warnings = sec.getPathWarnings('/home/user/Docs', existing);
			expect(warnings).toHaveLength(0);
		});
	});

	// Note: the Windows case-insensitive comparison (normalizeForComparison) is
	// tested in OSHelpers.test.ts. SecurityManager delegates to that function.
});
