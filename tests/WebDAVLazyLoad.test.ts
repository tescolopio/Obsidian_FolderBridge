import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** What the optional-module loader returns for 'webdav' in the current test. */
let webdavModule: unknown = null;
const createClient = vi.fn(() => ({ fake: 'client' }));

vi.mock('../src/runtimeNode', () => ({
	loadOptionalNodeModule: (id: string) => (id === 'webdav' ? webdavModule : null),
}));

import { WebDAVAdapter, isWebDAVAvailable } from '../src/WebDAVAdapter';
import type { MountPoint } from '../src/types';

const mount = {
	id: 'm1', virtualPath: 'Remote', realPath: '/', enabled: true, readOnly: false,
	mountType: 'webdav', webdavUrl: 'https://dav.example.test/',
} as MountPoint;

describe('WebDAVAdapter lazy webdav loading (#18)', () => {
	beforeEach(() => { createClient.mockClear(); });

	it('loads the webdav client on first use where it is available', () => {
		webdavModule = { createClient };
		expect(isWebDAVAvailable()).toBe(true);
		expect(WebDAVAdapter.fromMount(mount)).toBeInstanceOf(WebDAVAdapter);
		expect(createClient).toHaveBeenCalledWith('https://dav.example.test');
	});

	it('degrades to "no adapter" instead of throwing where webdav cannot load (mobile)', () => {
		webdavModule = null;
		expect(isWebDAVAvailable()).toBe(false);
		expect(WebDAVAdapter.fromMount(mount)).toBeNull();
		expect(() => new WebDAVAdapter('https://dav.example.test/')).toThrow(/unavailable/);
	});

	it('never imports webdav at module-evaluation time', () => {
		// A value import would be bundled eagerly and make the plugin fail to
		// load on Obsidian Mobile, where webdav's Node dependencies are missing.
		const source = fs.readFileSync(path.resolve(__dirname, '../src/WebDAVAdapter.ts'), 'utf8');
		const webdavImports = source.split('\n').filter(line => /from 'webdav'/.test(line));
		expect(webdavImports.length).toBeGreaterThan(0);
		for (const line of webdavImports) expect(line).toMatch(/^import type /);
	});

	it('bundles webdav through the optional-module shim', () => {
		const config = fs.readFileSync(path.resolve(__dirname, '../esbuild.config.mjs'), 'utf8');
		expect(config).toMatch(/case 'webdav':\s*return require\('webdav'\);/);
	});
});
