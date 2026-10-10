import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import { promises as nativeFs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PathMapper } from '../src/PathMapper';
import { SecurityManager } from '../src/SecurityManager';
import { VirtualAdapter } from '../src/VirtualAdapter';
import type { MountPoint } from '../src/types';
import * as runtimeNode from '../src/runtimeNode';
import { WebDAVAdapter } from '../src/WebDAVAdapter';
import { S3Adapter } from '../src/S3Adapter';
import { SFTPAdapter } from '../src/SFTPAdapter';

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

describe('VirtualAdapter trash on local mounts', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
    });

    async function setup(original: Record<string, unknown> | null = null, overrides: Partial<MountPoint> = {}, dryRun = false, ignored = false, allowed = true) {
        const mountDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-trash-mount-'));
        const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-trash-vault-'));
        tempDirs.push(mountDir, vaultDir);
        const mount = { ...makeMount(mountDir), ...overrides };
        const mapper = new PathMapper();
        mapper.update([mount], 'test-device');
        const onDelete = vi.fn().mockResolvedValue(undefined);
        const adapter = new VirtualAdapter(
            original ?? { getBasePath: () => vaultDir },
            mapper,
            new SecurityManager(allowed ? [mountDir] : []),
            dryRun,
            10 * 1024 * 1024,
            async () => 'delete',
            async () => { },
            () => ignored,
            undefined,
            onDelete,
        );
        return { adapter, mountDir, vaultDir, onDelete };
    }

    async function recoveryPaths(vaultDir: string, basename: string) {
        const entries = await fs.readdir(path.join(vaultDir, '.trash'));
        return entries.filter(name => name.startsWith('folderbridge-'))
            .map(name => path.join(vaultDir, '.trash', name, basename));
    }

    it.each(['local', 'vault'] as const)('trashLocal keeps files recoverable on a %s mount', async mountType => {
        const { adapter, mountDir, vaultDir, onDelete } = await setup(null, { mountType });
        await fs.writeFile(path.join(mountDir, 'note.md'), '# keep me');

        await adapter.trashLocal('Mounted/note.md');

        await expect(fs.stat(path.join(mountDir, 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
        const [recovered] = await recoveryPaths(vaultDir, 'note.md');
        expect(await fs.readFile(recovered, 'utf-8')).toBe('# keep me');
        expect(onDelete).toHaveBeenCalledWith('Mounted/note.md');
    });

    it('trashLocal keeps folder contents and does not overwrite an existing trash entry', async () => {
        const { adapter, mountDir, vaultDir } = await setup();
        await fs.mkdir(path.join(vaultDir, '.trash', 'sub'), { recursive: true });
        await fs.writeFile(path.join(vaultDir, '.trash', 'sub', 'older.md'), 'older');
        await fs.mkdir(path.join(mountDir, 'sub'));
        await fs.writeFile(path.join(mountDir, 'sub', 'inner.md'), 'inner');

        await adapter.trashLocal('Mounted/sub');

        expect(await fs.readFile(path.join(vaultDir, '.trash', 'sub', 'older.md'), 'utf-8')).toBe('older');
        const [recovered] = await recoveryPaths(vaultDir, 'sub');
        expect(await fs.readFile(path.join(recovered, 'inner.md'), 'utf-8')).toBe('inner');
    });

    it('trashLocal leaves the file in place when the vault path is unknown', async () => {
        const { adapter, mountDir } = await setup({});
        await fs.writeFile(path.join(mountDir, 'note.md'), '# keep me');

        await expect(adapter.trashLocal('Mounted/note.md')).rejects.toThrow(/not deleted/);
        expect(await fs.readFile(path.join(mountDir, 'note.md'), 'utf-8')).toBe('# keep me');
    });

    it('trashSystem reports failure instead of deleting when no system trash is available', async () => {
        const { adapter, mountDir, onDelete } = await setup();
        await fs.writeFile(path.join(mountDir, 'note.md'), '# keep me');

        expect(await adapter.trashSystem('Mounted/note.md')).toBe(false);
        expect(await fs.readFile(path.join(mountDir, 'note.md'), 'utf-8')).toBe('# keep me');
        expect(onDelete).not.toHaveBeenCalled();
    });

    it('preserves both concurrent deletions with identical filenames', async () => {
        const { adapter, mountDir, vaultDir, onDelete } = await setup();
        for (const name of ['a', 'b']) {
            await fs.mkdir(path.join(mountDir, name));
            await fs.writeFile(path.join(mountDir, name, 'note.md'), name);
        }

        await Promise.all(['a', 'b'].map(name => adapter.trashLocal(`Mounted/${name}/note.md`)));

        const recovered = await recoveryPaths(vaultDir, 'note.md');
        expect(recovered).toHaveLength(2);
        expect((await Promise.all(recovered.map(file => fs.readFile(file, 'utf8')))).sort()).toEqual(['a', 'b']);
        expect(onDelete).toHaveBeenCalledTimes(2);
    });

    it('copies a cross-volume folder completely before removing its source', async () => {
        const { adapter, mountDir, vaultDir } = await setup();
        await fs.mkdir(path.join(mountDir, 'sub', 'nested'), { recursive: true });
        await fs.writeFile(path.join(mountDir, 'sub', 'nested', 'note.md'), 'recover me');
        vi.spyOn(nativeFs, 'rename').mockRejectedValue(Object.assign(new Error('different volumes'), { code: 'EXDEV' }));

        await adapter.trashLocal('Mounted/sub');

        const [recovered] = await recoveryPaths(vaultDir, 'sub');
        expect(await fs.readFile(path.join(recovered, 'nested', 'note.md'), 'utf8')).toBe('recover me');
        await expect(fs.stat(path.join(mountDir, 'sub'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('leaves the complete source untouched when a cross-volume copy fails partway', async () => {
        const { adapter, mountDir, vaultDir, onDelete } = await setup();
        await fs.writeFile(path.join(mountDir, 'note.md'), 'complete source');
        vi.spyOn(nativeFs, 'rename').mockRejectedValue(Object.assign(new Error('different volumes'), { code: 'EXDEV' }));
        vi.spyOn(nativeFs, 'cp').mockImplementation(async (_source, destination) => {
            await fs.writeFile(destination, 'partial');
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        });
        const remove = vi.spyOn(nativeFs, 'rm');

        await expect(adapter.trashLocal('Mounted/note.md')).rejects.toThrow(/Recovery data/);

        expect(await fs.readFile(path.join(mountDir, 'note.md'), 'utf8')).toBe('complete source');
        expect(await fs.readFile((await recoveryPaths(vaultDir, 'note.md'))[0], 'utf8')).toBe('partial');
        expect(remove).not.toHaveBeenCalled();
        expect(onDelete).not.toHaveBeenCalled();
    });

    it('keeps a complete recovery copy and reports a failed source removal', async () => {
        const { adapter, mountDir, vaultDir, onDelete } = await setup();
        await fs.writeFile(path.join(mountDir, 'note.md'), 'complete source');
        vi.spyOn(nativeFs, 'rename').mockRejectedValue(Object.assign(new Error('different volumes'), { code: 'EXDEV' }));
        vi.spyOn(nativeFs, 'rm').mockRejectedValue(Object.assign(new Error('access denied'), { code: 'EACCES' }));

        await expect(adapter.trashLocal('Mounted/note.md')).rejects.toThrow(/Recovery data/);

        expect(await fs.readFile((await recoveryPaths(vaultDir, 'note.md'))[0], 'utf8')).toBe('complete source');
        expect(await fs.readFile(path.join(mountDir, 'note.md'), 'utf8')).toBe('complete source');
        expect(onDelete).not.toHaveBeenCalled();
    });

    it('does not use copy-and-delete for non-volume rename errors', async () => {
        const { adapter, mountDir, onDelete } = await setup();
        await fs.writeFile(path.join(mountDir, 'note.md'), 'keep me');
        vi.spyOn(nativeFs, 'rename').mockRejectedValue(Object.assign(new Error('access denied'), { code: 'EACCES' }));
        const copy = vi.spyOn(nativeFs, 'cp');
        const remove = vi.spyOn(nativeFs, 'rm');

        await expect(adapter.trashLocal('Mounted/note.md')).rejects.toThrow(/Access denied/);

        expect(copy).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(mountDir, 'note.md'), 'utf8')).toBe('keep me');
        expect(onDelete).not.toHaveBeenCalled();
    });

    it('refuses to trash a folder containing the vault trash', async () => {
        const { mountDir, onDelete } = await setup();
        const nestedVault = path.join(mountDir, 'vault');
        await fs.mkdir(nestedVault);
        const original = { getBasePath: () => nestedVault };
        const mapper = new PathMapper();
        mapper.update([makeMount(mountDir)], 'test-device');
        const nestedAdapter = new VirtualAdapter(
            original, mapper, new SecurityManager([mountDir]), false, undefined,
            async () => 'delete', async () => { }, () => false, undefined, onDelete,
        );

        await expect(nestedAdapter.trashLocal('Mounted')).rejects.toThrow(/inside the item/);

        expect((await fs.stat(mountDir)).isDirectory()).toBe(true);
        expect(onDelete).not.toHaveBeenCalled();
    });

    it.each(['read-only', 'dry-run', 'ignored', 'not allowed'])('preserves %s trash protection', async mode => {
        const { adapter, mountDir, vaultDir, onDelete } = await setup(
            null, { readOnly: mode === 'read-only' }, mode === 'dry-run', mode === 'ignored', mode !== 'not allowed',
        );
        await fs.writeFile(path.join(mountDir, 'note.md'), 'keep me');
        for (const operation of ['trashLocal', 'trashSystem'] as const) {
            if (mode === 'ignored' || mode === 'not allowed') await expect(adapter[operation]('Mounted/note.md')).rejects.toThrow();
            else await adapter[operation]('Mounted/note.md');
        }
        expect(await fs.readFile(path.join(mountDir, 'note.md'), 'utf8')).toBe('keep me');
        await expect(fs.stat(path.join(vaultDir, '.trash'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(onDelete).not.toHaveBeenCalled();
    });

    it('returns false without deleting or notifying when the system trash throws', async () => {
        const { adapter, mountDir, onDelete } = await setup();
        await fs.writeFile(path.join(mountDir, 'note.md'), 'keep me');
        const trashItem = vi.fn().mockRejectedValue(new Error('no system trash'));
        vi.spyOn(runtimeNode, 'loadOptionalNodeModule').mockReturnValue({ shell: { trashItem } });

        expect(await adapter.trashSystem('Mounted/note.md')).toBe(false);
        expect(await fs.readFile(path.join(mountDir, 'note.md'), 'utf8')).toBe('keep me');
        expect(onDelete).not.toHaveBeenCalled();
    });

    it('notifies only after a successful system trash operation', async () => {
        const { adapter, mountDir, onDelete } = await setup();
        await fs.writeFile(path.join(mountDir, 'note.md'), 'keep me');
        const trashItem = vi.fn(async (file: string) => {
            expect(onDelete).not.toHaveBeenCalled();
            await fs.unlink(file);
        });
        vi.spyOn(runtimeNode, 'loadOptionalNodeModule').mockReturnValue({ shell: { trashItem } });

        expect(await adapter.trashSystem('Mounted/note.md')).toBe(true);
        expect(onDelete).toHaveBeenCalledExactlyOnceWith('Mounted/note.md');
    });

    it.each(['webdav', 's3', 'sftp'] as const)('refuses both trash modes for %s without contacting the backend', async mountType => {
        const { adapter, mountDir, onDelete } = await setup(null, { mountType });
        const remove = vi.fn().mockResolvedValue(undefined);
        if (mountType === 'webdav') {
            const backend = new WebDAVAdapter('https://example.invalid');
            vi.spyOn(backend, 'remove').mockImplementation(remove);
            adapter.setWebDAVAdapter('mount-1', backend);
        } else if (mountType === 's3') {
            const backend = new S3Adapter('test-bucket', 'us-east-1', 'test-access', 'test-secret');
            vi.spyOn(backend, 'remove').mockImplementation(remove);
            adapter.setS3Adapter('mount-1', backend);
        } else {
            const backend = new SFTPAdapter('example.invalid', 22, 'test-user', {});
            vi.spyOn(backend, 'remove').mockImplementation(remove);
            adapter.setSFTPAdapter('mount-1', backend);
        }
        await fs.writeFile(path.join(mountDir, 'note.md'), 'keep me');

        for (const operation of ['trashLocal', 'trashSystem'] as const) {
            await expect(adapter[operation]('Mounted/note.md')).rejects.toThrow(/Recoverable trash is unavailable/);
        }

        expect(remove).not.toHaveBeenCalled();
        expect(onDelete).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(mountDir, 'note.md'), 'utf8')).toBe('keep me');
        await adapter.remove('Mounted/note.md');
        expect(remove).toHaveBeenCalledOnce();
        expect(onDelete).toHaveBeenCalledExactlyOnceWith('Mounted/note.md');
    });
});

describe('VirtualAdapter mount-root trash fallback', () => {
    it('asks about deleting a mount root only once when the system trash is unavailable', async () => {
        const mountDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-root-mount-'));
        const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-root-vault-'));
        try {
            const mount = makeMount(mountDir);
            const mapper = new PathMapper();
            mapper.update([mount], 'test-device');
            const onRootDelete = vi.fn().mockResolvedValue('delete');
            const adapter = new VirtualAdapter(
                { getBasePath: () => vaultDir },
                mapper,
                new SecurityManager([mountDir]),
                false,
                10 * 1024 * 1024,
                onRootDelete,
                async () => { },
                () => false,
            );
            await fs.writeFile(path.join(mountDir, 'note.md'), '# keep me');

            // Obsidian's vault.trash(): try the system trash, then fall back.
            if (!(await adapter.trashSystem('Mounted'))) await adapter.trashLocal('Mounted');

            expect(onRootDelete).toHaveBeenCalledTimes(1);
            expect(onRootDelete).toHaveBeenCalledWith(mount, true);
            const [recoveryDir] = await fs.readdir(path.join(vaultDir, '.trash'));
            const trashed = path.join(vaultDir, '.trash', recoveryDir, path.basename(mountDir), 'note.md');
            expect(await fs.readFile(trashed, 'utf-8')).toBe('# keep me');
        } finally {
            await fs.rm(mountDir, { recursive: true, force: true });
            await fs.rm(vaultDir, { recursive: true, force: true });
        }
    });

    it.each(['expired', 'changed path'] as const)('does not reuse a root confirmation after it is %s', async reason => {
        const mountDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-confirm-mount-'));
        const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-confirm-vault-'));
        const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-confirm-other-'));
        try {
            const mapper = new PathMapper();
            const mount = makeMount(mountDir);
            mapper.update([mount], 'test-device');
            const onRootDelete = vi.fn().mockResolvedValueOnce('delete').mockResolvedValueOnce('cancel');
            const adapter = new VirtualAdapter(
                { getBasePath: () => vaultDir }, mapper, new SecurityManager([mountDir, otherDir]),
                false, undefined, onRootDelete, async () => { }, () => false,
            );
            const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
            expect(await adapter.trashSystem('Mounted')).toBe(false);
            if (reason === 'expired') now.mockReturnValue(6001);
            else mapper.update([{ ...mount, realPath: otherDir }], 'test-device');

            await expect(adapter.trashLocal('Mounted')).rejects.toThrow(/cancelled/);

            expect(onRootDelete).toHaveBeenCalledTimes(2);
            expect((await fs.stat(mountDir)).isDirectory()).toBe(true);
            expect((await fs.stat(otherDir)).isDirectory()).toBe(true);
        } finally {
            vi.restoreAllMocks();
            await fs.rm(mountDir, { recursive: true, force: true });
            await fs.rm(vaultDir, { recursive: true, force: true });
            await fs.rm(otherDir, { recursive: true, force: true });
        }
    });
});

describe('VirtualAdapter text encodings on local mounts', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
    });

    async function setup() {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folderbridge-enc-'));
        tempDirs.push(tempDir);
        const mount = makeMount(tempDir);
        const mapper = new PathMapper();
        mapper.update([mount], 'test-device');
        const adapter = new VirtualAdapter(
            {},
            mapper,
            new SecurityManager([tempDir]),
            false,
            10 * 1024 * 1024,
            async () => 'cancel',
            async () => { },
            () => false,
        );
        return { adapter, tempDir };
    }

    // "Price: £5 – café" in Windows-1252 (£ = A3, – = 96, é = E9)
    const cp1252 = Buffer.from([0x50, 0x72, 0x69, 0x63, 0x65, 0x3a, 0x20, 0xa3, 0x35, 0x20, 0x96, 0x20, 0x63, 0x61, 0x66, 0xe9]);

    it('reads a Windows-1252 note with the right characters and refuses to save it', async () => {
        const { adapter, tempDir } = await setup();
        const file = path.join(tempDir, 'old.md');
        await fs.writeFile(file, cp1252);

        expect(await adapter.read('Mounted/old.md')).toBe('Price: £5 – café');
        await expect(adapter.write('Mounted/old.md', 'Price: £6 – café')).rejects.toThrow(/not stored as UTF-8/);
        await expect(adapter.append('Mounted/old.md', '\nmore')).rejects.toThrow(/not stored as UTF-8/);
        expect(Buffer.compare(await fs.readFile(file), cp1252)).toBe(0);
    });

    it('reads UTF-16 notes and refuses to save them', async () => {
        const { adapter, tempDir } = await setup();
        const file = path.join(tempDir, 'utf16.md');
        const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('£ note', 'utf16le')]);
        await fs.writeFile(file, bytes);

        expect(await adapter.read('Mounted/utf16.md')).toBe('£ note');
        await expect(adapter.write('Mounted/utf16.md', 'x')).rejects.toThrow(/not stored as UTF-8/);
        expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0);
    });

    it('saves again once the file on disk is UTF-8', async () => {
        const { adapter, tempDir } = await setup();
        const file = path.join(tempDir, 'old.md');
        await fs.writeFile(file, cp1252);
        await adapter.read('Mounted/old.md');
        await fs.writeFile(file, 'converted £', 'utf8'); // a colleague re-saved it as UTF-8

        await adapter.write('Mounted/old.md', 'edited £');
        expect(await fs.readFile(file, 'utf8')).toBe('edited £');
    });

    it('keeps the refusal when the note is renamed', async () => {
        const { adapter, tempDir } = await setup();
        await fs.writeFile(path.join(tempDir, 'old.md'), cp1252);
        await adapter.read('Mounted/old.md');
        await adapter.rename('Mounted/old.md', 'Mounted/renamed.md');

        await expect(adapter.write('Mounted/renamed.md', 'x')).rejects.toThrow(/not stored as UTF-8/);
    });

    it('leaves UTF-8 notes, including a byte-order mark, exactly as before', async () => {
        const { adapter, tempDir } = await setup();
        const file = path.join(tempDir, 'bom.md');
        await fs.writeFile(file, '﻿hello £', 'utf8');

        const text = await adapter.read('Mounted/bom.md');
        expect(text).toBe('﻿hello £');
        await adapter.write('Mounted/bom.md', text + '!');
        expect(await fs.readFile(file, 'utf8')).toBe('﻿hello £!');
    });
});
