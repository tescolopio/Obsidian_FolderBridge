import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PathMapper } from '../src/PathMapper';
import { SecurityManager } from '../src/SecurityManager';
import { VirtualAdapter } from '../src/VirtualAdapter';
import type { MountPoint } from '../src/types';

function makeMount(realPath: string): MountPoint {
    return {
        id: 'mount-1',
        virtualPath: 'Mounted',
        realPath,
        enabled: true,
        readOnly: false,
    };
}

describe('VirtualAdapter delete notifications', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
    });

    it('notifies mounted file removals after delete succeeds', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-va-'));
        tempDirs.push(tempDir);

        const mount = makeMount(tempDir);
        const mapper = new PathMapper();
        mapper.update([mount], 'test-device');
        const security = new SecurityManager([tempDir]);
        const onDelete = vi.fn().mockResolvedValue(undefined);
        const adapter = new VirtualAdapter(
            {},
            mapper,
            security,
            false,
            10 * 1024 * 1024,
            async () => 'delete',
            async () => { },
            () => false,
            undefined,
            onDelete,
        );

        const normalizedPath = 'Mounted/note.md';
        await fs.writeFile(path.join(tempDir, 'note.md'), '# test');

        await adapter.remove(normalizedPath);

        expect(onDelete).toHaveBeenCalledWith(normalizedPath);
        await expect(fs.stat(path.join(tempDir, 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

describe('VirtualAdapter cachedRead', () => {
    it('reads mounted files through the mounted path instead of the original adapter cache', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-va-'));
        const mount = makeMount(tempDir);
        const mapper = new PathMapper();
        mapper.update([mount], 'test-device');
        const security = new SecurityManager([tempDir]);
        const original = {
            cachedRead: vi.fn().mockResolvedValue('wrong source'),
            read: vi.fn().mockResolvedValue('wrong source'),
        };
        const adapter = new VirtualAdapter(
            original,
            mapper,
            security,
            false,
            10 * 1024 * 1024,
            async () => 'delete',
            async () => { },
            () => false,
        );

        try {
            await fs.writeFile(path.join(tempDir, 'note.md'), 'mounted content');
            await expect(adapter.cachedRead('Mounted/note.md')).resolves.toBe('mounted content');
            expect(original.cachedRead).not.toHaveBeenCalled();
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    it('falls back to the original adapter cachedRead for non-mounted files', async () => {
        const original = {
            cachedRead: vi.fn().mockResolvedValue('vault content'),
            read: vi.fn().mockResolvedValue('vault content'),
        };
        const mapper = new PathMapper();
        mapper.update([], 'test-device');
        const adapter = new VirtualAdapter(
            original,
            mapper,
            new SecurityManager([]),
            false,
            10 * 1024 * 1024,
            async () => 'delete',
            async () => { },
            () => false,
        );

        await expect(adapter.cachedRead('vault/note.md')).resolves.toBe('vault content');
        expect(original.cachedRead).toHaveBeenCalledWith('vault/note.md');
    });
});
