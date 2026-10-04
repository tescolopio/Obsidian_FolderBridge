import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Adapter } from '../src/S3Adapter';
import { PathMapper } from '../src/PathMapper';
import { SecurityManager } from '../src/SecurityManager';
import { VirtualAdapter } from '../src/VirtualAdapter';
import type { MountPoint } from '../src/types';

interface Command {
    kind: string;
    input: Record<string, unknown>;
}

const state = vi.hoisted(() => {
    const command = (kind: string) => class {
        kind = kind;
        constructor(public input: Record<string, unknown>) {}
    };
    const send = vi.fn<(command: Command) => Promise<Record<string, unknown>>>();
    return {
        send,
        aws: {
            S3Client: class { send = send; },
            PutObjectCommand: command('put'),
            GetObjectCommand: command('get'),
            HeadObjectCommand: command('head'),
            DeleteObjectCommand: command('delete'),
            DeleteObjectsCommand: command('deleteMany'),
            CopyObjectCommand: command('copy'),
            ListObjectsV2Command: command('list'),
        },
    };
});

vi.mock('../src/runtimeNode', async importOriginal => {
    const original = await importOriginal<typeof import('../src/runtimeNode')>();
    return {
        ...original,
        loadOptionalNodeModule: (id: string) => id === '@aws-sdk/client-s3'
            ? state.aws : original.loadOptionalNodeModule(id),
    };
});

function setup(realPath = '/notes', overrides: Partial<MountPoint> = {}) {
    const mount: MountPoint = {
        id: 's3-test', virtualPath: 'Cloud', realPath, mountType: 's3',
        enabled: true, readOnly: false, s3Bucket: 'test-bucket',
        s3Region: 'us-east-1', s3AccessKeyId: 'test-only', s3SecretKey: 'test-only',
        ...overrides,
    };
    const s3 = S3Adapter.fromMount(mount);
    if (!s3) throw new Error('Expected test S3 adapter');
    const mapper = new PathMapper();
    mapper.update([mount], 'test-device');
    const adapter = new VirtualAdapter(
        {}, mapper, new SecurityManager([]), false, 1024,
        async () => 'cancel', async () => {}, () => false,
    );
    adapter.setS3Adapter(mount.id, s3);
    return { adapter, s3, mount };
}

function inputs(kind: string) {
    return state.send.mock.calls.filter(([command]) => command.kind === kind).map(([command]) => command.input);
}

function notFound() {
    return Object.assign(new Error('Not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
}

beforeEach(() => {
    state.send.mockReset();
    state.send.mockImplementation(async command => {
        if (command.kind === 'head') return { ContentLength: 4, LastModified: new Date(0) };
        if (command.kind === 'get') return {
            Body: {
                transformToString: async () => 'old\n',
                transformToByteArray: async () => new Uint8Array([1, 2]),
            },
        };
        return {};
    });
});

describe('S3 keys through actual VirtualAdapter routing', () => {
    it.each([
        ['/', ''],
        ['/notes', 'notes/'],
        ['/notes/', 'notes/'],
        ['/team/notes', 'team/notes/'],
    ])('uses %s exactly once for all file operations', async (realPath, prefix) => {
        const { adapter } = setup(realPath);
        await adapter.write('Cloud/sub/a.md', 'new');
        await adapter.writeBinary('Cloud/sub/b.bin', new Uint8Array([3]).buffer);
        expect(await adapter.read('Cloud/sub/a.md')).toBe('old\n');
        expect(new Uint8Array(await adapter.readBinary('Cloud/sub/b.bin'))).toEqual(new Uint8Array([1, 2]));
        expect(await adapter.exists('Cloud/sub/a.md')).toBe(true);
        expect(await adapter.stat('Cloud/sub/a.md')).toMatchObject({ type: 'file' });
        await adapter.append('Cloud/sub/a.md', 'appended');
        await adapter.mkdir('Cloud/new-dir');
        await adapter.remove('Cloud/sub/a.md');
        expect(inputs('put').map(input => input.Key)).toEqual([
            `${prefix}sub/a.md`, `${prefix}sub/b.bin`, `${prefix}sub/a.md`, `${prefix}new-dir/`,
        ]);
        expect(inputs('put')[2].Body).toBe('old\nappended');
        expect(inputs('get').map(input => input.Key)).toEqual([
            `${prefix}sub/a.md`, `${prefix}sub/b.bin`, `${prefix}sub/a.md`,
        ]);
        expect(inputs('head').every(input => input.Key === `${prefix}sub/a.md`)).toBe(true);
        expect(inputs('delete').map(input => input.Key)).toEqual([`${prefix}sub/a.md`, `${prefix}sub/a.md/`]);
    });

    it.each([['/', ''], ['/notes', 'notes/'], ['/notes/', 'notes/']])(
        'lists %s with correct virtual children and pagination', async (realPath, prefix) => {
            const { adapter } = setup(realPath);
            state.send.mockImplementation(async command => command.input.ContinuationToken ? {
                Contents: [{ Key: `${prefix}b.md` }],
            } : {
                Contents: [{ Key: prefix }, { Key: `${prefix}a.md` }],
                CommonPrefixes: [{ Prefix: `${prefix}sub/` }],
                IsTruncated: true, NextContinuationToken: 'page-2',
            });
            expect(await adapter.list('Cloud')).toEqual({
                files: ['Cloud/a.md', 'Cloud/b.md'], folders: ['Cloud/sub'],
            });
            expect(inputs('list')).toEqual([
                expect.objectContaining({ Prefix: prefix || undefined, Delimiter: '/', ContinuationToken: undefined }),
                expect.objectContaining({ Prefix: prefix || undefined, Delimiter: '/', ContinuationToken: 'page-2' }),
            ]);
        },
    );

    it('uses the active cloud device override rather than prepending the primary prefix', async () => {
        const { adapter } = setup('/notes', { deviceOverrides: { 'test-device': '/device-notes' } });
        await adapter.write('Cloud/a.md', 'new');
        expect(inputs('put')[0].Key).toBe('device-notes/a.md');
    });

    it('retains the configured prefix for the connection probe', async () => {
        const { s3 } = setup('/notes/');
        expect(await s3.testConnection()).toBeNull();
        expect(inputs('list')[0]).toMatchObject({ Prefix: 'notes/', MaxKeys: 1 });
    });

    it('does not automatically migrate or delete doubled-prefix objects', async () => {
        const { adapter } = setup();
        state.send.mockResolvedValue({ Contents: [{ Key: 'notes/notes/legacy.md' }] });
        expect(await adapter.list('Cloud')).toEqual({ files: [], folders: [] });
        expect(state.send.mock.calls.map(([command]) => command.kind)).toEqual(['list']);
        expect(inputs('list')[0].Prefix).toBe('notes/');
    });

    it('refuses append writes after a non-missing read failure', async () => {
        const { adapter } = setup();
        state.send.mockRejectedValue(new Error('Service unavailable'));
        await expect(adapter.append('Cloud/a.md', 'new')).rejects.toThrow('Service unavailable');
        expect(inputs('put')).toEqual([]);
    });

    it('creates an appended object at the corrected key only after a genuine 404', async () => {
        const { adapter } = setup();
        state.send.mockImplementation(async command => {
            if (command.kind === 'get') throw notFound();
            return {};
        });
        await adapter.append('Cloud/a.md', 'new');
        expect(inputs('put')[0]).toMatchObject({ Key: 'notes/a.md', Body: 'new' });
    });

    it('maps paginated explicit prefix removal without doubling its namespace', async () => {
        const { s3 } = setup();
        state.send.mockImplementation(async command => {
            if (command.kind !== 'list') return {};
            return command.input.ContinuationToken ? {
                Contents: [{ Key: 'notes/dir/b.md' }],
            } : {
                Contents: [{ Key: 'notes/dir/a.md' }],
                IsTruncated: true, NextContinuationToken: 'page-2',
            };
        });
        await s3.removePrefix('/notes/dir');
        expect(inputs('list').every(input => input.Prefix === 'notes/dir/')).toBe(true);
        expect(inputs('deleteMany').map(input => input.Delete)).toEqual([
            { Objects: [{ Key: 'notes/dir/a.md' }], Quiet: true },
            { Objects: [{ Key: 'notes/dir/b.md' }], Quiet: true },
        ]);
    });
});

describe('S3 prefix and CopySource encoding together', () => {
    it.each([
        ['plain.md', 'plain.md'],
        ['my file+100%.md', 'my%20file%2B100%25.md'],
        ['na\u00efve?#.md', 'na%C3%AFve%3F%23.md'],
        ['literal%2F.md', 'literal%252F.md'],
        ["special!'()*.md", 'special%21%27%28%29%2A.md'],
    ])('encodes %s once while keeping separators and destination keys literal', async (name, encoded) => {
        const { adapter } = setup();
        await adapter.copy(`Cloud/sub/${name}`, `Cloud/copy/${name}`);
        expect(inputs('head')[0].Key).toBe(`notes/sub/${name}`);
        expect(inputs('copy')).toEqual([{
            Bucket: 'test-bucket', CopySource: `test-bucket/notes/sub/${encoded}`, Key: `notes/copy/${name}`,
        }]);
        expect(inputs('delete')).toEqual([]);
    });

    it('keeps bucket-root copy behavior unchanged', async () => {
        const { adapter } = setup('/');
        await adapter.copy('Cloud/plain.md', 'Cloud/copy.md');
        expect(inputs('copy')[0]).toMatchObject({ CopySource: 'test-bucket/plain.md', Key: 'copy.md' });
    });

    it('copies a renamed file before deleting its original key', async () => {
        const { adapter } = setup();
        await adapter.rename('Cloud/sub/my file.md', 'Cloud/sub/new name.md');
        expect(inputs('copy')[0]).toMatchObject({
            CopySource: 'test-bucket/notes/sub/my%20file.md', Key: 'notes/sub/new name.md',
        });
        expect(inputs('delete')[0].Key).toBe('notes/sub/my file.md');
        expect(state.send.mock.calls.map(([command]) => command.kind)).toEqual(['head', 'copy', 'delete', 'delete']);
    });

    it('never deletes the original when rename copy fails', async () => {
        const { adapter } = setup();
        state.send.mockImplementation(async command => {
            if (command.kind === 'copy') throw new Error('Copy refused');
            return { ContentLength: 4 };
        });
        await expect(adapter.rename('Cloud/a.md', 'Cloud/b.md')).rejects.toThrow('Copy refused');
        expect(inputs('delete')).toEqual([]);
    });

    it('encodes every folder-copy page without doubling its prefix', async () => {
        const { adapter } = setup();
        state.send.mockImplementation(async command => {
            if (command.kind === 'head') throw notFound();
            if (command.kind !== 'list') return {};
            if (command.input.MaxKeys === 1) return { KeyCount: 1 };
            return command.input.ContinuationToken ? {
                Contents: [{ Key: 'notes/dir/sub/na\u00efve?.md' }],
            } : {
                Contents: [{ Key: 'notes/dir/' }, { Key: 'notes/dir/my file+1.md' }],
                IsTruncated: true, NextContinuationToken: 'page-2',
            };
        });
        await adapter.copy('Cloud/dir', 'Cloud/copy-dir');
        expect(inputs('copy')).toEqual([
            { Bucket: 'test-bucket', CopySource: 'test-bucket/notes/dir/', Key: 'notes/copy-dir/' },
            { Bucket: 'test-bucket', CopySource: 'test-bucket/notes/dir/my%20file%2B1.md', Key: 'notes/copy-dir/my file+1.md' },
            { Bucket: 'test-bucket', CopySource: 'test-bucket/notes/dir/sub/na%C3%AFve%3F.md', Key: 'notes/copy-dir/sub/na\u00efve?.md' },
        ]);
        expect(inputs('list').every(input => input.Prefix === 'notes/dir/')).toBe(true);
        expect(inputs('list')[2].ContinuationToken).toBe('page-2');
        expect(inputs('delete')).toEqual([]);
    });

    it('stops a folder copy on failure without deleting source objects', async () => {
        const { adapter } = setup();
        state.send.mockImplementation(async command => {
            if (command.kind === 'head') throw notFound();
            if (command.kind === 'list') return {
                Contents: [{ Key: 'notes/dir/first.md' }, { Key: 'notes/dir/second.md' }],
            };
            if (command.kind === 'copy') throw new Error('Copy refused');
            return {};
        });
        await expect(adapter.copy('Cloud/dir', 'Cloud/copy-dir')).rejects.toThrow('Copy refused');
        expect(inputs('copy')).toHaveLength(1);
        expect(inputs('delete')).toEqual([]);
    });
});
