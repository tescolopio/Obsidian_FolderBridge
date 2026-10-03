import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SFTPAdapter, formatHostKeyFingerprint, type SFTPHostKeyVerifier } from '../src/SFTPAdapter';

const state = vi.hoisted(() => ({
    key: Buffer.from('server-key-a'),
    authentication: vi.fn(),
    end: vi.fn(),
    get: vi.fn().mockResolvedValue(Buffer.from('note')),
    failAuthentication: false,
    cryptoUnavailable: false,
    ready: true,
    options: vi.fn(),
}));

vi.mock('../src/runtimeNode', async importOriginal => {
    const original = await importOriginal<typeof import('../src/runtimeNode')>();
    return {
        ...original,
        loadOptionalNodeModule: (id: string) => id === 'ssh2-sftp-client' ? class {
            constructor() { state.ready = true; }
            get sftp() { return state.ready ? {} : undefined; }
            get = state.get;
            end = state.end;
            async connect(options: { hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => void; password?: string; privateKey?: Buffer; readyTimeout: number }) {
                state.options(options);
                const accepted = await new Promise<boolean>(resolve => options.hostVerifier(state.key, resolve));
                if (!accepted) throw new Error('Host verification failed');
                state.authentication();
                if (state.failAuthentication) throw new Error('Authentication failed');
            }
        } : id === 'crypto' && state.cryptoUnavailable ? null
            : id === 'fs' ? { readFileSync: () => Buffer.from('test-only-private-key') }
            : original.loadOptionalNodeModule(id),
    };
});

describe('SFTP host-key verification before authentication', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.key = Buffer.from('server-key-a');
        state.failAuthentication = false;
        state.cryptoUnavailable = false;
        state.ready = true;
    });

    const adapter = (verifyHostKey?: SFTPHostKeyVerifier) =>
        new SFTPAdapter('example.invalid', 22, 'tester', { password: 'test-only', verifyHostKey });

    it('formats an OpenSSH SHA-256 fingerprint', () => {
        expect(formatHostKeyFingerprint(state.key)).toBe(`SHA256:${createHash('sha256').update(state.key).digest('base64').replace(/=+$/, '')}`);
    });

    it('does not authenticate until approval and persistence finish', async () => {
        let approve!: () => void;
        const verify = vi.fn((_fingerprint: string, _signal: AbortSignal, allowApproval: boolean) =>
            allowApproval ? new Promise<void>(resolve => { approve = resolve; }) : Promise.resolve());
        const read = adapter(verify).readText('/note.md');
        await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
        expect(state.authentication).not.toHaveBeenCalled();
        expect(state.get).not.toHaveBeenCalled();
        expect(state.options).toHaveBeenCalledWith(expect.objectContaining({ readyTimeout: 20000 }));
        expect(state.options.mock.calls[0][0].password).toBeUndefined();
        expect(state.options.mock.calls[0][0].privateKey).toBeUndefined();
        approve();
        expect(await read).toBe('note');
        expect(state.authentication).toHaveBeenCalledOnce();
    });

    it.each(['Approval cancelled', 'Host key changed', 'Could not save key'])('refuses authentication and I/O on %s', async message => {
        await expect(adapter(async () => { throw new Error(message); }).readText('/note.md')).rejects.toThrow(message);
        expect(state.authentication).not.toHaveBeenCalled();
        expect(state.get).not.toHaveBeenCalled();
        expect(state.end).toHaveBeenCalledOnce();
    });

    it('fails closed if no verifier was supplied', async () => {
        await expect(adapter().readText('/note.md')).rejects.toThrow('not been approved');
        expect(state.authentication).not.toHaveBeenCalled();
    });

    it('fails closed if fingerprint hashing is unavailable', async () => {
        state.cryptoUnavailable = true;
        await expect(adapter(async () => {}).readText('/note')).rejects.toThrow('requires crypto');
        expect(state.authentication).not.toHaveBeenCalled();
    });

    it('gates private-key authentication on approval too', async () => {
        const client = new SFTPAdapter('example.invalid', 22, 'tester', {
            privateKeyPath: 'test-only-key', passphrase: 'test-only',
            verifyHostKey: async () => { throw new Error('Approval cancelled'); },
        });
        await expect(client.readText('/note')).rejects.toThrow('Approval cancelled');
        expect(state.authentication).not.toHaveBeenCalled();
    });

    it('rechecks the host key when the underlying channel has dropped', async () => {
        const pin = formatHostKeyFingerprint(state.key);
        const client = adapter(async fingerprint => {
            if (fingerprint !== pin) throw new Error('Host key changed');
        });
        await client.readText('/note');
        state.ready = false;
        state.key = Buffer.from('server-key-b');
        await expect(client.readText('/note')).rejects.toThrow('Host key changed');
        expect(state.authentication).toHaveBeenCalledOnce();
    });

    it('checks the presented key again after disconnect and shares concurrent connections', async () => {
        const pin = formatHostKeyFingerprint(state.key);
        const verify = vi.fn(async (fingerprint: string) => {
            if (fingerprint !== pin) throw new Error('Host key changed');
        });
        const client = adapter(verify);
        await Promise.all([client.readText('/one'), client.readText('/two')]);
        expect(verify).toHaveBeenCalledTimes(2);
        await client.disconnect();
        state.key = Buffer.from('server-key-b');
        await expect(client.readText('/three')).rejects.toThrow('Host key changed');
        expect(verify).toHaveBeenCalledTimes(3);
        expect(state.authentication).toHaveBeenCalledOnce();
    });

    it('aborts an outstanding approval when disconnected', async () => {
        const verify = vi.fn((_fingerprint: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
        }));
        const client = adapter(verify);
        const result = expect(client.readText('/note')).rejects.toThrow('Cancelled');
        await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
        await client.disconnect();
        await result;
        expect(state.authentication).not.toHaveBeenCalled();
    });
});
