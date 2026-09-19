import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BuildOptions, OnResolveArgs, PluginBuild } from 'esbuild';

const { context } = vi.hoisted(() => ({
    context: vi.fn(async (_options: BuildOptions) => ({
        watch: vi.fn(),
        rebuild: vi.fn(),
    })),
}));

vi.mock('esbuild', () => ({ default: { context } }));

beforeAll(async () => {
    await import('../esbuild.config.mjs');
});

describe('optional module build resolution', () => {
    it.each([
        '/home/user/folderbridge/src/runtimeNode.ts',
        'C:/plugins/folderbridge/src/runtimeNode.ts',
        'C:\\plugins\\folderbridge\\src\\runtimeNode.ts',
        '\\\\server\\plugins\\folderbridge\\src\\runtimeNode.ts',
    ])('bundles optional modules for %s', async importer => {
        const onResolve = vi.fn<PluginBuild['onResolve']>();
        const plugin = context.mock.calls[0][0].plugins?.find(candidate => candidate.name === 'optional-node-modules');
        expect(plugin).toBeDefined();
        await plugin!.setup({ onResolve, onLoad: vi.fn() } as unknown as PluginBuild);
        const [options, resolve] = onResolve.mock.calls[0];
        expect(options.filter.test('./optionalNodeModules')).toBe(true);
        expect(await resolve({ importer, path: './optionalNodeModules' } as OnResolveArgs)).toEqual({
            path: 'folderbridge-optional-node-modules',
            namespace: 'folderbridge-optional-node-modules',
        });
        expect(await resolve({ importer: importer.replace('runtimeNode.ts', 'other.ts'), path: './optionalNodeModules' } as OnResolveArgs)).toBeNull();
    });
});
