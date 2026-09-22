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

		it('allows child paths when the allowlisted path has a trailing separator', () => {
			withPlatform('win32', () => {
				const secTrailing = new SecurityManager(['C:\\foo\\bar\\']);
				expect(secTrailing.isAllowed('C:\\foo\\bar\\README.md')).toBe(true);
				expect(secTrailing.isAllowed('C:\\foo\\bar\\sub\\file.txt')).toBe(true);
				expect(secTrailing.isAllowed('C:\\foo\\bar')).toBe(true);
			});
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
		describe.each(['linux', 'darwin'] as const)('POSIX host protection on %s', platform => {
			it.each([
				'//etc/ssh',
				'///etc/ssh',
				'//home/Notes/../../etc/ssh',
				'//home/Notes/../..',
			])('blocks protected primary and fallback path %s', candidate => {
				withPlatform(platform, () => {
					expect(sec.validateMount(mkMount('Protected', candidate), [])).toMatch(/protected/i);
					expect(sec.validateMount({ ...mkMount('Notes', '/home/user/Notes'), fallbackRealPath: candidate }, [])).toMatch(/protected.*fallback/i);
				});
			});

			it.each(['/home/user/Notes', '//home/user/Notes', '///home/user/Notes', '//etc-backup/Notes', '//ETC/ssh'])('preserves safe path %s', candidate => {
				withPlatform(platform, () => {
					expect(sec.validateMount(mkMount('Notes', candidate), [])).toBeNull();
					expect(sec.validateMount({ ...mkMount('Notes', '/home/user/Notes'), fallbackRealPath: candidate }, [])).toBeNull();
				});
			});

			it('does not widen a POSIX allowlist through UNC normalization or case folding', () => {
				withPlatform(platform, () => {
					const posixAllowlist = new SecurityManager(['/home/user/Notes']);
					expect(posixAllowlist.isAllowed('///home/user/Notes/file.md')).toBe(true);
					for (const candidate of ['//home/user/notes/file.md', '///home/user/notes/file.md', '//home/user/Notes/../../private/file.md']) {
						expect(posixAllowlist.isAllowed(candidate)).toBe(false);
					}
				});
			});
		});

		describe.each(['linux', 'win32', 'darwin'] as const)('cross-host validation on %s', platform => {
			it.each([
				'C:\\Windows\\System32',
				'C:/Windows/System32',
				'\\\\?\\C:\\Windows\\System32',
				'//?/C:/Windows/System32',
				'C:\\Notes\\..\\Windows\\System32',
				'c:\\PROGRAM FILES\\App',
				'\\\\?\\C:\\Program Files (x86)\\App',
				'\\\\?\\C:\\',
			])('blocks protected primary and fallback path %s', candidate => {
				withPlatform(platform, () => {
					expect(sec.validateMount(mkMount('Protected', candidate), [])).toMatch(/protected/i);
					expect(sec.validateMount({ ...mkMount('Notes', '/home/user/Notes'), fallbackRealPath: candidate }, [])).toMatch(/protected.*fallback/i);
				});
			});

			it.each([
				'\\\\.\\C:\\Windows\\System32',
				'\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Windows',
				'\\\\?\\Volume{test}\\Windows',
				'\\??\\C:\\Windows\\System32',
				'\\\\?\\UNC\\server',
			])('rejects unsupported device path %s', candidate => {
				withPlatform(platform, () => {
					expect(sec.validateMount(mkMount('Device', candidate), [])).toMatch(/unsupported.*device/i);
					expect(sec.validateMount({ ...mkMount('Notes', '/home/user/Notes'), fallbackRealPath: candidate }, [])).toMatch(/fallback.*unsupported.*device/i);
					const deviceAllowlist = new SecurityManager([candidate]);
					expect(deviceAllowlist.isAllowed(candidate)).toBe(false);
				});
			});

			it.each(['wsl$', 'wsl.localhost', 'server'])('preserves UNC mounts and boundaries for %s', host => {
				withPlatform(platform, () => {
					const realPath = `\\\\${host}\\Ubuntu\\home\\Notes`;
					const extended = `\\\\?\\UNC\\${host}\\Ubuntu\\home\\Notes`;
					const forward = `//${host}/Ubuntu/home/Notes`;
					for (const candidate of [realPath, extended, forward]) {
						expect(sec.validateMount(mkMount('Notes', candidate), [])).toBeNull();
						expect(sec.validateMount({ ...mkMount('Notes', '/home/user/Notes'), fallbackRealPath: candidate }, [])).toBeNull();
						const uncAllowlist = new SecurityManager([`${candidate}/`]);
						expect(uncAllowlist.isAllowed(`${realPath}\\file.md`)).toBe(true);
						expect(uncAllowlist.isAllowed(`${extended}\\file.md`)).toBe(true);
						expect(uncAllowlist.isAllowed(`${forward}/file.md`)).toBe(true);
						expect(uncAllowlist.isAllowed(`${extended}-other\\file.md`)).toBe(false);
						expect(uncAllowlist.isAllowed(`${extended}\\..\\private\\file.md`)).toBe(false);
					}
				});
			});

			it('preserves ordinary folders and drive allowlist boundaries', () => {
				withPlatform(platform, () => {
					for (const candidate of ['C:\\Notes\\', 'C:/Windows-old/Notes', 'C:\\Program Files-other', '/home/user/Notes', '/etc-backup']) {
						expect(sec.validateMount(mkMount('Notes', candidate), [])).toBeNull();
					}
					const driveAllowlist = new SecurityManager(['C:\\Notes\\']);
					expect(driveAllowlist.isAllowed('\\\\?\\C:\\Notes\\file.md')).toBe(true);
					expect(driveAllowlist.isAllowed('c:/notes/file.md')).toBe(true);
					expect(driveAllowlist.isAllowed('\\\\?\\C:\\Notes-other\\file.md')).toBe(false);
					expect(driveAllowlist.isAllowed('C:\\Notes\\..\\private\\file.md')).toBe(false);
					driveAllowlist.revoke('\\\\?\\C:\\Notes');
					expect(driveAllowlist.isAllowed('C:\\Notes')).toBe(false);
				});
			});

			it('does not turn an unsupported device allowlist entry into an ordinary path', () => {
				withPlatform(platform, () => {
					const deviceAllowlist = new SecurityManager(['\\\\?\\UNC\\server']);
					expect(deviceAllowlist.isAllowed('/server')).toBe(false);
				});
			});

			it('keeps filesystem roots exact-only in the allowlist', () => {
				withPlatform(platform, () => {
					for (const root of ['/', 'C:/', '//server/share/']) {
						const rootAllowlist = new SecurityManager([root]);
						expect(rootAllowlist.isAllowed(root)).toBe(true);
						expect(rootAllowlist.isAllowed(`${root}child`)).toBe(false);
					}
				});
			});
		});

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

		it('rejects a non-absolute fallback real path', () => {
			expect(sec.validateMount({ ...mkMount('Work', '/home/user/Work'), fallbackRealPath: 'relative/fallback' }, [])).toMatch(/fallback.*absolute/i);
		});

		it.each(['wsl$', 'wsl.localhost'])('allows WSL UNC paths through %s on Windows without allowing siblings', host => {
			withPlatform('win32', () => {
				const realPath = `\\\\${host}\\Ubuntu\\home\\obsidian-private`;
				expect(sec.validateMount(mkMount('WSL Notes', realPath), [])).toBeNull();
				sec.allow(`${realPath}\\`);
				expect(sec.isAllowed(`${realPath}\\note.md`)).toBe(true);
				expect(sec.isAllowed(`${realPath}-other\\note.md`)).toBe(false);
			});
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
			expect(sec.validateMount({ ...mkMount('Work', '/home/user/Work'), fallbackRealPath: '/etc' }, [])).toMatch(/protected.*fallback/i);
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

describe('SecurityManager deviceOverrides validation', () => {
	const sec = new SecurityManager([]);

	it('accepts a mount whose device overrides are ordinary absolute paths', () => {
		const mount = { ...mkMount('Ext', '/data/notes'), deviceOverrides: { 'dev-a': '/mnt/other/notes' } };
		expect(sec.validateMount(mount, [])).toBeNull();
	});

	it('rejects a protected system path hidden in a device override', () => {
		const mount = { ...mkMount('Ext', '/data/notes'), deviceOverrides: { 'dev-a': '/etc' } };
		expect(sec.validateMount(mount, [])).toMatch(/protected system path/);
	});

	it('rejects a relative device override path', () => {
		const mount = { ...mkMount('Ext', '/data/notes'), deviceOverrides: { 'dev-a': '../../secret' } };
		expect(sec.validateMount(mount, [])).toMatch(/absolute/);
	});

	it('rejects non-string and non-object overrides from untrusted JSON', () => {
		expect(sec.validateDeviceOverrides({ 'dev-a': 42 })).toMatch(/path string/);
		expect(sec.validateDeviceOverrides(['/etc'])).toMatch(/must be an object/);
		expect(sec.validateDeviceOverrides(undefined)).toBeNull();
	});
});

describe('SecurityManager extended protected paths', () => {
	const sec = new SecurityManager([]);

	describe.each(['linux', 'darwin', 'win32'] as const)('on %s', platform => {
		it.each([
			'/private/etc',
			'/private/etc/ssh',
			'/private/var/db',
			'/System/Library',
			'/lib/modules',
			'/lib64/ld.so',
			'/home/user/.ssh',
			'/Users/me/.gnupg/private-keys',
			'/home/user/Notes/.ssh/keys',
			'C:\\Users\\me\\.ssh',
			'D:\\Windows\\System32',
			'e:/program files/App',
			'D:\\Program Files (x86)\\App',
		])('blocks %s', candidate => {
			withPlatform(platform, () => {
				expect(sec.validateMount(mkMount('Protected', candidate), [])).toMatch(/protected/i);
			});
		});

		it.each([
			'/home/user/Notes',
			'/private/tmp/notes',
			'/private/etc-backup/Notes',
			'/System-old/Notes',
			'/lib-notes/Notes',
			'/library/Notes',
			'/home/user/ssh-notes',
			'/home/user/.ssh-backup/Notes',
			'/home/user/.gnupg2/Notes',
			'D:\\Windows-old\\Notes',
			'D:\\Notes',
		])('preserves safe path %s', candidate => {
			withPlatform(platform, () => {
				expect(sec.validateMount(mkMount('Notes', candidate), [])).toBeNull();
			});
		});

		it.each(['/private', '/private/', '//private'])('blocks %s because it contains /private/etc', candidate => {
			withPlatform(platform, () => {
				expect(sec.validateMount(mkMount('Protected', candidate), [])).toMatch(/protected/i);
			});
		});

		it('documents a known limit: a whole non-C drive root can still be mounted', () => {
			// Deliberate trade-off (whole external-drive mounts keep working). It would
			// expose D:\\Windows if Windows is installed on D:. Revisit if that changes.
			withPlatform(platform, () => {
				expect(sec.validateMount(mkMount('Drive', 'D:\\'), [])).toBeNull();
				expect(sec.validateMount(mkMount('Drive', 'E:/'), [])).toBeNull();
			});
		});

		it('applies the same rules to device overrides', () => {
			withPlatform(platform, () => {
				expect(sec.validateDeviceOverrides({ dev: '/private/etc' })).toMatch(/protected/i);
				expect(sec.validateDeviceOverrides({ dev: '/home/user/.ssh' })).toMatch(/protected/i);
			});
		});
	});
});
