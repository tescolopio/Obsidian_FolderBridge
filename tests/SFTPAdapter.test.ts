import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

/** Host key the fake server presents on the next connect(). */
let serverHostKey = Buffer.from('server-key-A');

class FakeSFTPClient {
	sftp = {};
	async connect(options: { hostVerifier?: (key: Buffer) => boolean }): Promise<void> {
		// Mirror ssh2: no hostVerifier means every key is accepted.
		if (options.hostVerifier && !options.hostVerifier(serverHostKey)) {
			throw new Error('Host denied (verification failed)');
		}
	}
	async list(): Promise<unknown[]> { return []; }
	async end(): Promise<void> { /* no-op */ }
}

vi.mock('../src/runtimeNode', () => ({
	loadOptionalNodeModule: (id: string) => (id === 'ssh2-sftp-client' ? FakeSFTPClient : nodeRequire(id)),
}));

import { SFTPAdapter, formatHostKeyFingerprint } from '../src/SFTPAdapter';

function fingerprint(key: Buffer): string {
	return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

describe('SFTPAdapter host key verification', () => {
	const pinned = vi.fn();

	beforeEach(() => {
		serverHostKey = Buffer.from('server-key-A');
		pinned.mockReset();
		SFTPAdapter.onHostKeyPinned = pinned;
	});

	afterEach(() => { SFTPAdapter.onHostKeyPinned = null; });

	it('formats fingerprints like ssh-keygen -lf', () => {
		expect(formatHostKeyFingerprint(serverHostKey)).toBe(fingerprint(serverHostKey));
		expect(formatHostKeyFingerprint(serverHostKey)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
	});

	it('pins the host key on the first successful connection', async () => {
		const adapter = new SFTPAdapter('host', 22, 'user', { password: 'pw', mountId: 'm1' });
		expect(await adapter.testConnection()).toBeNull();
		expect(adapter.getHostKeyFingerprint()).toBe(fingerprint(serverHostKey));
		expect(pinned).toHaveBeenCalledWith('m1', fingerprint(serverHostKey));
	});

	it('connects when the server presents the pinned key', async () => {
		const adapter = new SFTPAdapter('host', 22, 'user', {
			password: 'pw', mountId: 'm1', hostKeyFingerprint: fingerprint(serverHostKey),
		});
		expect(await adapter.testConnection()).toBeNull();
		expect(pinned).not.toHaveBeenCalled();
	});

	it('refuses to connect when the host key differs from the pinned one', async () => {
		const adapter = new SFTPAdapter('host', 22, 'user', {
			password: 'pw', mountId: 'm1', hostKeyFingerprint: fingerprint(Buffer.from('server-key-A')),
		});
		serverHostKey = Buffer.from('attacker-key');
		const error = await adapter.testConnection();
		expect(error).toMatch(/host key .* has changed/i);
		expect(adapter.getHostKeyFingerprint()).toBe(fingerprint(Buffer.from('server-key-A')));
		expect(pinned).not.toHaveBeenCalled();
	});

	it('reads the pinned fingerprint from the mount', async () => {
		const adapter = SFTPAdapter.fromMount({
			id: 'm1', virtualPath: 'Remote', realPath: '/', enabled: true, readOnly: false,
			mountType: 'sftp', sftpHost: 'host', sftpUsername: 'user', sftpPassword: 'pw',
			sftpHostKeyFingerprint: 'SHA256:pinned',
		});
		expect(adapter?.getHostKeyFingerprint()).toBe('SHA256:pinned');
	});
});
