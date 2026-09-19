import { describe, expect, it, vi } from 'vitest';
import { loadOptionalNodeModule } from '../src/runtimeNode';
import { shouldUseFolderNameAsLabel } from '../src/ui/mountLabel';

vi.mock('../src/runtimeNode', () => ({
    loadOptionalNodeModule: vi.fn(() => null),
    getRuntimeRequire: vi.fn(() => undefined),
}));

describe('shouldUseFolderNameAsLabel without Node modules', () => {
    it.each([
        ['WebDAV source', 'https://dav.example.com/remote.php/dav/files/user/Documents/', 'Documents', true],
        ['WebDAV path', '/remote.php/dav/files/user/Documents', 'Documents', true],
        ['custom WebDAV label', '/remote.php/dav/files/user/Documents', 'Remote docs', false],
        ['POSIX path', '/home/user/Documents', 'Documents', true],
        ['POSIX trailing separators', '/home/user/Documents///', 'Documents', true],
        ['Windows path', 'C:\\Users\\user\\Documents', 'Documents', true],
        ['Windows trailing separators', 'C:\\Users\\user\\Documents\\\\', 'Documents', true],
        ['Windows forward slashes', 'C:/Users/user/Documents/', 'Documents', true],
        ['UNC path', '\\\\server\\share\\Documents\\', 'Documents', true],
        ['drive-relative path', 'C:Documents', 'Documents', true],
        ['trimmed label', '/home/user/Documents', ' Documents ', true],
        ['custom label', '/home/user/Documents', 'Work docs', false],
        ['case mismatch', '/home/user/Documents', 'documents', false],
        ['undefined label', '/Documents', undefined, false],
        ['empty label', '/Documents', '', false],
        ['whitespace label', '/Documents', '   ', false],
        ['empty path', '', 'Documents', false],
        ['empty label and path', '', '', false],
        ['POSIX root', '/', '/', false],
        ['Windows root', 'C:\\', 'C:', false],
    ])('%s', (_name, realPath, label, expected) => {
        expect(shouldUseFolderNameAsLabel(realPath, label)).toBe(expected);
    });

    it('does not try to load Node modules for a labeled remote mount', () => {
        expect(shouldUseFolderNameAsLabel('/Documents', 'Documents')).toBe(true);
        expect(loadOptionalNodeModule).not.toHaveBeenCalled();
    });
});
