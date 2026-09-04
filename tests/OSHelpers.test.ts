import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	normalizeRealPath,
	realPathToResourceUrl,
	normalizeForComparison,
	isUNCPath,
	ensureLongPathPrefix,
	isReservedWindowsFilename,
	translateFsError,
	isCloudPlaceholder,
	isWSL,
	wslMountToWindowsPath,
} from '../src/OSHelpers';

// Helper: temporarily override process.platform for Windows-specific tests
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
	const orig = process.platform;
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	try { fn(); } finally {
		Object.defineProperty(process, 'platform', { value: orig, configurable: true });
	}
}

describe('OSHelpers', () => {

	describe('normalizeRealPath', () => {
		it('normalizes a POSIX path', () => {
			expect(normalizeRealPath('/foo//bar/../baz')).toBe('/foo/baz');
		});
	});

	describe('realPathToResourceUrl', () => {
		it('converts a POSIX path to an app:// URL', () => {
			expect(realPathToResourceUrl('/home/user/image.png')).toBe('app://local/home/user/image.png');
		});

		it('handles platform paths using path.sep as the separator', () => {
			// On Linux, path.sep is '/' so POSIX paths work correctly.
			// On Windows this function converts backslashes to forward slashes.
			const url = realPathToResourceUrl('/home/user/images/photo.jpg');
			expect(url).toBe('app://local/home/user/images/photo.jpg');
		});

		it('ensures a leading slash after the protocol for absolute paths', () => {
			const url = realPathToResourceUrl('/already/absolute');
			expect(url.startsWith('app://local/')).toBe(true);
		});
	});

	describe('normalizeForComparison', () => {
		it('preserves case on Linux', () => {
			withPlatform('linux', () => {
				expect(normalizeForComparison('/Foo/Bar')).toBe('/Foo/Bar');
			});
		});

		it('lowercases paths on Windows', () => {
			withPlatform('win32', () => {
				const result = normalizeForComparison('C:\\Users\\NAME');
				expect(result).toBe(result.toLowerCase());
			});
		});

		it('trims a non-root trailing separator on Windows', () => {
			withPlatform('win32', () => {
				expect(normalizeForComparison('C:\\foo\\bar\\')).toBe('c:/foo/bar');
			});
		});

		it('preserves the trailing separator for a Windows filesystem root', () => {
			withPlatform('win32', () => {
				expect(normalizeForComparison('C:\\')).toBe('c:/');
			});
		});
	});

	describe('isUNCPath', () => {
		it('detects a UNC path', () => {
			expect(isUNCPath('\\\\server\\share')).toBe(true);
		});

		it('returns false for a normal Windows path', () => {
			expect(isUNCPath('C:\\Users')).toBe(false);
		});

		it('returns false for a POSIX path', () => {
			expect(isUNCPath('/home/user')).toBe(false);
		});
	});

	describe('ensureLongPathPrefix', () => {
		it('is a no-op on Linux regardless of path length', () => {
			withPlatform('linux', () => {
				const longPath = 'a'.repeat(300);
				expect(ensureLongPathPrefix(longPath)).toBe(longPath);
			});
		});

		it('is a no-op on Windows for short paths', () => {
			withPlatform('win32', () => {
				expect(ensureLongPathPrefix('C:\\short')).toBe('C:\\short');
			});
		});

		it('adds \\\\?\\ prefix for long Windows paths', () => {
			withPlatform('win32', () => {
				const longPath = 'C:\\' + 'a'.repeat(260);
				expect(ensureLongPathPrefix(longPath)).toBe('\\\\?\\' + longPath);
			});
		});

		it('adds \\\\?\\UNC\\ prefix for long UNC paths', () => {
			withPlatform('win32', () => {
				const longUNC = '\\\\server\\share\\' + 'a'.repeat(260);
				expect(ensureLongPathPrefix(longUNC)).toBe('\\\\?\\UNC\\server\\share\\' + 'a'.repeat(260));
			});
		});

		it('is a no-op if the path already has the \\\\?\\ prefix', () => {
			withPlatform('win32', () => {
				const prefixed = '\\\\?\\C:\\already\\prefixed';
				expect(ensureLongPathPrefix(prefixed)).toBe(prefixed);
			});
		});
	});

	describe('isReservedWindowsFilename', () => {
		it('returns false on Linux for any name', () => {
			withPlatform('linux', () => {
				expect(isReservedWindowsFilename('CON')).toBe(false);
				expect(isReservedWindowsFilename('NUL')).toBe(false);
			});
		});

		it('detects CON on Windows', () => {
			withPlatform('win32', () => {
				expect(isReservedWindowsFilename('CON')).toBe(true);
			});
		});

		it('detects NUL on Windows', () => {
			withPlatform('win32', () => {
				expect(isReservedWindowsFilename('NUL')).toBe(true);
			});
		});

		it('detects COM1-COM9 on Windows', () => {
			withPlatform('win32', () => {
				for (let i = 1; i <= 9; i++) {
					expect(isReservedWindowsFilename(`COM${i}`)).toBe(true);
				}
			});
		});

		it('detects LPT1-LPT9 on Windows', () => {
			withPlatform('win32', () => {
				for (let i = 1; i <= 9; i++) {
					expect(isReservedWindowsFilename(`LPT${i}`)).toBe(true);
				}
			});
		});

		it('detects reserved names with extensions on Windows', () => {
			withPlatform('win32', () => {
				expect(isReservedWindowsFilename('CON.txt')).toBe(true);
				expect(isReservedWindowsFilename('NUL.md')).toBe(true);
			});
		});

		it('is case-insensitive on Windows', () => {
			withPlatform('win32', () => {
				expect(isReservedWindowsFilename('con')).toBe(true);
				expect(isReservedWindowsFilename('Con')).toBe(true);
			});
		});

		it('returns false for normal filenames on Windows', () => {
			withPlatform('win32', () => {
				expect(isReservedWindowsFilename('notes.md')).toBe(false);
				expect(isReservedWindowsFilename('com.example')).toBe(false);
			});
		});
	});

	describe('translateFsError', () => {
		function mkErr(code: string, p?: string): NodeJS.ErrnoException {
			const e = new Error('test') as NodeJS.ErrnoException;
			e.code = code;
			e.path = p;
			return e;
		}

		it('translates EACCES', () => {
			expect(translateFsError(mkErr('EACCES', '/foo'), 'read')).toMatch(/access denied/i);
		});

		it('translates ENOENT', () => {
			expect(translateFsError(mkErr('ENOENT', '/foo/bar'), 'read')).toMatch(/not found/i);
		});

		it('translates EBUSY', () => {
			expect(translateFsError(mkErr('EBUSY', '/foo'), 'read')).toMatch(/locked/i);
		});

		it('translates ENOSPC', () => {
			expect(translateFsError(mkErr('ENOSPC'), 'write')).toMatch(/disk space/i);
		});

		it('translates EPERM on Windows with Developer Mode hint', () => {
			withPlatform('win32', () => {
				expect(translateFsError(mkErr('EPERM', '/foo'), 'write')).toMatch(/developer mode/i);
			});
		});

		it('translates EPERM on Linux without Windows hint', () => {
			withPlatform('linux', () => {
				const msg = translateFsError(mkErr('EPERM', '/foo'), 'write');
				expect(msg).not.toMatch(/developer mode/i);
				expect(msg).toMatch(/not permitted/i);
			});
		});

		it('translates ENAMETOOLONG on Windows with Long Paths hint', () => {
			withPlatform('win32', () => {
				expect(translateFsError(mkErr('ENAMETOOLONG'), 'write')).toMatch(/long paths/i);
			});
		});

		it('translates ENAMETOOLONG on Linux without Windows hint', () => {
			withPlatform('linux', () => {
				expect(translateFsError(mkErr('ENAMETOOLONG'), 'write')).toMatch(/too long/i);
			});
		});

		it('falls back to error message for unknown codes', () => {
			const e = mkErr('EUNKNOWN');
			e.message = 'something weird';
			expect(translateFsError(e, 'read')).toContain('something weird');
		});
	});

	describe('isWSL', () => {
		// Helper: temporarily set / clear a process.env variable
		function withEnv(key: string, value: string | undefined, fn: () => void): void {
			const orig = process.env[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
			try { fn(); } finally {
				if (orig === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = orig;
				}
			}
		}

		it('returns false on Windows', () => {
			withPlatform('win32', () => {
				expect(isWSL()).toBe(false);
			});
		});

		it('returns false on macOS', () => {
			withPlatform('darwin', () => {
				expect(isWSL()).toBe(false);
			});
		});

		it('returns true on Linux when WSL_DISTRO_NAME is set', () => {
			withPlatform('linux', () => {
				withEnv('WSL_DISTRO_NAME', 'Ubuntu', () => {
					withEnv('WSLENV', undefined, () => {
						expect(isWSL()).toBe(true);
					});
				});
			});
		});

		it('returns true on Linux when WSLENV is set', () => {
			withPlatform('linux', () => {
				withEnv('WSL_DISTRO_NAME', undefined, () => {
					withEnv('WSLENV', 'PATH/l', () => {
						expect(isWSL()).toBe(true);
					});
				});
			});
		});

		it('returns false on non-Linux even when WSL env vars are set', () => {
			withPlatform('win32', () => {
				withEnv('WSL_DISTRO_NAME', 'Ubuntu', () => {
					expect(isWSL()).toBe(false);
				});
			});
		});
	});

	describe('isCloudPlaceholder', () => {
		it('returns false for a path that does not exist at all', async () => {
			const result = await isCloudPlaceholder('/this/path/absolutely/does/not/exist/fb-test');
			expect(result).toBe(false);
		});

		it('returns true for a path that exists on disk (simulates cloud placeholder fingerprint)', async () => {
			// A cloud placeholder (e.g. OneDrive Files On Demand) passes F_OK even
			// though readFile would throw ENOENT. A real file on disk also passes
			// F_OK, which is sufficient to verify the true branch of isCloudPlaceholder.
			const tmpFile = path.join(os.tmpdir(), `fb-placeholder-test-${Date.now()}.md`);
			await fs.promises.writeFile(tmpFile, '');
			try {
				const result = await isCloudPlaceholder(tmpFile);
				expect(result).toBe(true);
			} finally {
				await fs.promises.unlink(tmpFile);
			}
		});
	});

	describe('wslMountToWindowsPath', () => {
		it('converts /mnt/c/Users/foo to C:\\Users\\foo', () => {
			expect(wslMountToWindowsPath('/mnt/c/Users/foo')).toBe('C:\\Users\\foo');
		});

		it('converts /mnt/d/projects/bar to D:\\projects\\bar', () => {
			expect(wslMountToWindowsPath('/mnt/d/projects/bar')).toBe('D:\\projects\\bar');
		});

		it('uppercases the drive letter', () => {
			expect(wslMountToWindowsPath('/mnt/z/foo')).toBe('Z:\\foo');
		});

		it('converts a bare drive mount /mnt/c to C:\\', () => {
			expect(wslMountToWindowsPath('/mnt/c')).toBe('C:\\');
		});

		it('handles paths with spaces', () => {
			expect(wslMountToWindowsPath('/mnt/c/Users/My Documents')).toBe('C:\\Users\\My Documents');
		});

		it('returns null for non-mount POSIX paths', () => {
			expect(wslMountToWindowsPath('/home/user')).toBeNull();
			expect(wslMountToWindowsPath('/usr/local/bin')).toBeNull();
		});

		it('returns null for empty string', () => {
			expect(wslMountToWindowsPath('')).toBeNull();
		});

		it('returns null for Windows-style paths', () => {
			expect(wslMountToWindowsPath('C:\\Users\\foo')).toBeNull();
		});
	});
});
