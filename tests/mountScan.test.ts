import { describe, expect, it, vi } from 'vitest';
import type { MountPoint } from '../src/types';
import { replayMountContentsToVault } from '../src/mountScan';

function mkMount(overrides: Partial<MountPoint> = {}): MountPoint {
    return {
        id: 'm1',
        virtualPath: 'mounts/docs',
        realPath: '/tmp/docs',
        enabled: true,
        readOnly: false,
        ...overrides,
    };
}

describe('replayMountContentsToVault', () => {
    it('skips child replay entirely when watcher suppression is enabled', async () => {
        const mount = mkMount({ watcherSuppressAllEvents: true });
        const deps = {
            list: vi.fn(),
            stat: vi.fn(),
            hasAbstractFile: vi.fn(() => false),
            isIgnored: vi.fn(() => false),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mount, deps);

        expect(result).toEqual({ fileCount: 0, folderCount: 0, scanLimitHit: false, isHuge: false });
        expect(deps.list).not.toHaveBeenCalled();
        expect(deps.onFolderCreated).not.toHaveBeenCalled();
        expect(deps.onFileCreated).not.toHaveBeenCalled();
    });

    it('replays child folders and files when suppression is disabled', async () => {
        const mount = mkMount();
        const deps = {
            list: vi.fn(async (folderPath: string) => {
                if (folderPath === 'mounts/docs') {
                    return {
                        folders: ['mounts/docs/subfolder'],
                        files: ['mounts/docs/note.md'],
                    };
                }
                return { folders: [], files: ['mounts/docs/subfolder/child.md'] };
            }),
            stat: vi.fn(async () => ({ type: 'file' as const, ctime: 0, mtime: 0, size: 1 })),
            hasAbstractFile: vi.fn(() => false),
            isIgnored: vi.fn(() => false),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
            yieldToEventLoop: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mount, deps);

        expect(result.fileCount).toBe(2);
        expect(result.folderCount).toBe(1);
        expect(result.scanLimitHit).toBe(false);
        expect(deps.onFolderCreated).toHaveBeenCalledWith('mounts/docs/subfolder');
        expect(deps.onFileCreated).toHaveBeenCalledWith('mounts/docs/note.md', expect.any(Object));
        expect(deps.onFileCreated).toHaveBeenCalledWith('mounts/docs/subfolder/child.md', expect.any(Object));
    });

    it('uses configured exclusions for dot-prefixed folders and files', async () => {
        const mount = mkMount();
        const deps = {
            list: vi.fn(async (folderPath: string) => folderPath === mount.virtualPath
                ? { folders: ['mounts/docs/.notes', 'mounts/docs/.git'], files: ['mounts/docs/.note.md', 'mounts/docs/.DS_Store'] }
                : { folders: [], files: ['mounts/docs/.notes/child.md'] }),
            stat: vi.fn(async () => ({ type: 'file' as const, ctime: 0, mtime: 0, size: 1 })),
            hasAbstractFile: vi.fn(() => false),
            isIgnored: vi.fn((name: string) => name === '.git' || name === '.DS_Store'),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
            yieldToEventLoop: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mount, deps);

        expect(result.folderCount).toBe(1);
        expect(result.fileCount).toBe(2);
        expect(deps.list).not.toHaveBeenCalledWith('mounts/docs/.git');
        expect(deps.onFileCreated).toHaveBeenCalledWith('mounts/docs/.note.md', expect.any(Object));
        expect(deps.onFileCreated).toHaveBeenCalledWith('mounts/docs/.notes/child.md', expect.any(Object));
    });

    it('skips files hidden by the mount visible-file filter', async () => {
        const mount = mkMount({ visibleFileFilter: 'markdown-only' });
        const deps = {
            list: vi.fn(async () => ({
                folders: [],
                files: ['mounts/docs/note.md', 'mounts/docs/attachment.pdf'],
            })),
            stat: vi.fn(async () => ({ type: 'file' as const, ctime: 0, mtime: 0, size: 1 })),
            hasAbstractFile: vi.fn(() => false),
            isIgnored: vi.fn(() => false),
            onFolderCreated: vi.fn(async () => { }),
            onFileCreated: vi.fn(async () => { }),
            yieldToEventLoop: vi.fn(async () => { }),
        };

        const result = await replayMountContentsToVault(mount, deps);

        expect(result.fileCount).toBe(1);
        expect(deps.onFileCreated).toHaveBeenCalledTimes(1);
        expect(deps.onFileCreated).toHaveBeenCalledWith('mounts/docs/note.md', expect.any(Object));
    });
});
