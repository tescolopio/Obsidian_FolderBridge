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

describe('VirtualAdapter mounted writes', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
    });

    async function setup(overrides: Partial<MountPoint> = {}, dryRun = false, ignored = false, allowed = true) {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-writes-'));
        tempDirs.push(tempDir);
        const mount = { ...makeMount(tempDir), ...overrides };
        const mapper = new PathMapper();
        mapper.update([mount], 'test-device');
        const original = {
            append: vi.fn().mockResolvedValue(undefined),
            writeBinary: vi.fn().mockResolvedValue(undefined),
            appendBinary: vi.fn().mockResolvedValue(undefined),
        };
        const onModify = vi.fn().mockResolvedValue(undefined);
        const adapter = new VirtualAdapter(
            original, mapper, new SecurityManager(allowed ? [tempDir] : []), dryRun,
            10 * 1024 * 1024, async () => 'delete', async () => { }, () => ignored, onModify,
        );
        return { adapter, original, onModify, filePath: path.join(tempDir, 'note.md') };
    }

    it('appends exact binary bytes only to the mounted file', async () => {
        const { adapter, original, onModify, filePath } = await setup();
        await fs.writeFile(filePath, new Uint8Array([0, 255]));

        await adapter.appendBinary('Mounted/note.md', new Uint8Array([128, 0]).buffer);

        expect(await fs.readFile(filePath)).toEqual(Buffer.from([0, 255, 128, 0]));
        expect(original.appendBinary).not.toHaveBeenCalled();
        expect(onModify).toHaveBeenCalledExactlyOnceWith('Mounted/note.md');
    });

    it('creates a missing mounted file when appending binary data', async () => {
        const { adapter, filePath } = await setup();
        await adapter.appendBinary('Mounted/note.md', new Uint8Array([255]).buffer);
        expect(await fs.readFile(filePath)).toEqual(Buffer.from([255]));
    });

    it('delegates non-mounted binary append with its options', async () => {
        const { adapter, original, onModify } = await setup();
        const data = new Uint8Array([1]).buffer;
        const options = { mtime: 42 };

        await adapter.appendBinary('vault/note.md', data, options);

        expect(original.appendBinary).toHaveBeenCalledExactlyOnceWith('vault/note.md', data, options);
        expect(onModify).not.toHaveBeenCalled();
    });

    it.each(['webdav', 's3', 'sftp'] as const)('rejects %s binary append without local or vault writes', async mountType => {
        const { adapter, original, onModify, filePath } = await setup({ mountType });
        await fs.writeFile(filePath, 'unchanged');

        await expect(adapter.appendBinary('Mounted/note.md', new ArrayBuffer(1))).rejects.toThrow('Binary append is not supported');

        expect(await fs.readFile(filePath, 'utf8')).toBe('unchanged');
        expect(original.appendBinary).not.toHaveBeenCalled();
        expect(onModify).not.toHaveBeenCalled();
    });

    it.each(['read-only', 'dry-run'])('does not modify files in %s mode', async mode => {
        const { adapter, original, onModify, filePath } = await setup({ readOnly: mode === 'read-only' }, mode === 'dry-run');
        await fs.writeFile(filePath, 'unchanged');

        await adapter.appendBinary('Mounted/note.md', new ArrayBuffer(1));

        expect(await fs.readFile(filePath, 'utf8')).toBe('unchanged');
        expect(original.appendBinary).not.toHaveBeenCalled();
        expect(onModify).not.toHaveBeenCalled();
    });

    it.each(['ignored', 'not allowed', 'filtered'])('rejects %s mounted binary writes', async reason => {
        const { adapter, original, onModify, filePath } = await setup(
            reason === 'filtered' ? { visibleFileFilter: 'pdf-only' } : {}, false, reason === 'ignored', reason !== 'not allowed',
        );
        await fs.writeFile(filePath, 'unchanged');

        await expect(adapter.appendBinary('Mounted/note.md', new ArrayBuffer(1))).rejects.toThrow();

        expect(await fs.readFile(filePath, 'utf8')).toBe('unchanged');
        expect(original.appendBinary).not.toHaveBeenCalled();
        expect(onModify).not.toHaveBeenCalled();
    });

    it('does not notify or delegate a failed mounted binary append', async () => {
        const { adapter, original, onModify } = await setup();

        await expect(adapter.appendBinary('Mounted/missing/note.md', new ArrayBuffer(1))).rejects.toThrow();

        expect(original.appendBinary).not.toHaveBeenCalled();
        expect(onModify).not.toHaveBeenCalled();
    });

    it.each(['writeBinary', 'append'] as const)('does not fall through to the vault after mounted %s', async operation => {
        const { adapter, original, onModify, filePath } = await setup();
        await fs.writeFile(filePath, 'initial');

        if (operation === 'append') await adapter.append('Mounted/note.md', 'more');
        else await adapter.writeBinary('Mounted/note.md', new Uint8Array([255, 0]).buffer);

        expect(await fs.readFile(filePath)).toEqual(operation === 'append' ? Buffer.from('initialmore') : Buffer.from([255, 0]));
        expect(original[operation]).not.toHaveBeenCalled();
        expect(onModify).toHaveBeenCalledExactlyOnceWith('Mounted/note.md');
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
