import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, Server as TCPServer, Socket } from 'node:net';
import { SFTPAdapter } from '../src/SFTPAdapter';

interface AuthContext {
    method: string;
    username: string;
    password?: string;
    accept(): void;
    reject(): void;
}
interface Session {
    on(event: 'sftp', callback: (accept: () => unknown) => void): Session;
}
interface Connection {
    on(event: 'authentication', callback: (context: AuthContext) => void): Connection;
    on(event: 'ready', callback: () => void): Connection;
    on(event: 'session', callback: (accept: () => Session) => void): Connection;
    on(event: 'error', callback: (error: Error) => void): Connection;
    end(): void;
}
interface Server {
    listen(port: number, host: string, callback: () => void): void;
    address(): { port: number };
    close(callback: () => void): void;
    on(event: 'error', callback: (error: Error) => void): void;
}

const require = createRequire(import.meta.url);
const { Server: SSHServer } = require('ssh2') as {
    Server: new (options: { hostKeys: string[] }, callback: (connection: Connection) => void) => Server;
};
const clients = new Set<Connection>();
let server: Server | undefined;
let adapter: SFTPAdapter | undefined;
let stalledServer: TCPServer | undefined;
const stalledSockets = new Set<Socket>();

async function startServer(port = 0, authenticationState = { stall: false }) {
    const authentication = vi.fn();
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    server = new SSHServer({ hostKeys: [key] }, client => {
        clients.add(client);
        client.on('error', () => {}).on('authentication', context => {
            if (context.method === 'password') authentication();
            if (context.method === 'password' && authenticationState.stall) return;
            if (context.method === 'password' && context.username === 'tester' && context.password === 'test-only') context.accept();
            else context.reject();
        }).on('ready', () => {
            client.on('session', accept => accept().on('sftp', acceptSftp => { acceptSftp(); }));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server!.on('error', reject);
        server!.listen(port, '127.0.0.1', resolve);
    });
    return { port: server.address().port, authentication };
}

describe('real loopback SSH host-key handshake', () => {
    afterEach(async () => {
        await adapter?.disconnect();
        adapter = undefined;
        for (const client of clients) client.end();
        clients.clear();
        if (server) await new Promise<void>(resolve => server!.close(resolve));
        server = undefined;
        for (const socket of stalledSockets) socket.destroy();
        stalledSockets.clear();
        if (stalledServer) await new Promise<void>(resolve => stalledServer!.close(() => resolve()));
        stalledServer = undefined;
    });

    it('waits for approval before sending password authentication and verifies reconnects', async () => {
        const { port, authentication } = await startServer();
        let approve!: () => void;
        const verification = vi.fn((_fingerprint: string, _signal: AbortSignal, allowApproval: boolean) =>
            allowApproval ? new Promise<void>(resolve => { approve = resolve; }) : Promise.resolve());
        adapter = new SFTPAdapter('127.0.0.1', port, 'tester', { password: 'test-only', verifyHostKey: verification });
        const connection = adapter.testConnection();
        await vi.waitFor(() => expect(verification).toHaveBeenCalledOnce());
        expect(verification.mock.calls[0][0]).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
        expect(authentication).not.toHaveBeenCalled();
        approve();
        expect(await connection).toBeNull();
        expect(authentication).toHaveBeenCalledOnce();
        await adapter.disconnect();
        verification.mockImplementation(async () => {});
        expect(await adapter.testConnection()).toBeNull();
        expect(verification).toHaveBeenCalledTimes(4);
        expect(authentication).toHaveBeenCalledTimes(2);
    }, 15000);

    it('refuses an untrusted host without sending a password', async () => {
        const { port, authentication } = await startServer();
        adapter = new SFTPAdapter('127.0.0.1', port, 'tester', {
            password: 'test-only',
            verifyHostKey: async () => { throw new Error('Changed key refused'); },
        });
        expect(await adapter.testConnection()).toContain('Changed key refused');
        expect(authentication).not.toHaveBeenCalled();
    }, 15000);

    it('permits approval after the original 20-second handshake deadline', async () => {
        const { port, authentication } = await startServer();
        let approve!: () => void;
        let approvalSignal!: AbortSignal;
        const verification = vi.fn((_fingerprint: string, signal: AbortSignal, allowApproval: boolean) => {
            if (!allowApproval) return Promise.resolve();
            approvalSignal = signal;
            return new Promise<void>(resolve => { approve = resolve; });
        });
        adapter = new SFTPAdapter('127.0.0.1', port, 'tester', { password: 'test-only', verifyHostKey: verification });
        const connection = adapter.testConnection();
        await vi.waitFor(() => expect(verification).toHaveBeenCalledOnce());
        const started = Date.now();
        await new Promise(resolve => setTimeout(resolve, 21000));
        expect(Date.now() - started).toBeGreaterThan(20000);
        expect(approvalSignal.aborted).toBe(false);
        expect(authentication).not.toHaveBeenCalled();
        approve();
        expect(await connection).toBeNull();
        expect(authentication).toHaveBeenCalledOnce();
    }, 35000);

    it('refuses a key changed between discovery and authentication without prompting again', async () => {
        const first = await startServer();
        let approve!: () => void;
        const verification = vi.fn((_fingerprint: string, _signal: AbortSignal, allowApproval: boolean) =>
            allowApproval ? new Promise<void>(resolve => { approve = resolve; }) : Promise.resolve());
        adapter = new SFTPAdapter('127.0.0.1', first.port, 'tester', { password: 'test-only', verifyHostKey: verification });
        const connection = adapter.testConnection();
        await vi.waitFor(() => expect(verification).toHaveBeenCalledOnce());
        for (const client of clients) client.end();
        clients.clear();
        await new Promise<void>(resolve => server!.close(resolve));
        const second = await startServer(first.port);
        approve();
        expect(await connection).toContain('changed between discovery and authentication');
        expect(first.authentication).not.toHaveBeenCalled();
        expect(second.authentication).not.toHaveBeenCalled();
        expect(verification).toHaveBeenCalledOnce();
    }, 15000);

    it('cancels pending approval and allows a later connection attempt', async () => {
        const { port, authentication } = await startServer();
        const verification = vi.fn((_fingerprint: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Approval cancelled')), { once: true });
        }));
        adapter = new SFTPAdapter('127.0.0.1', port, 'tester', { password: 'test-only', verifyHostKey: verification });
        const connection = adapter.testConnection();
        await vi.waitFor(() => expect(verification).toHaveBeenCalledOnce());
        await adapter.disconnect();
        expect(await connection).toContain('cancelled');
        expect(authentication).not.toHaveBeenCalled();
        verification.mockImplementation(async () => {});
        expect(await adapter.testConnection()).toBeNull();
        expect(authentication).toHaveBeenCalledOnce();
    }, 15000);

    it('keeps network discovery bounded and recovers after handshake timeout', async () => {
        stalledServer = createServer(socket => { stalledSockets.add(socket); });
        await new Promise<void>(resolve => stalledServer!.listen(0, '127.0.0.1', resolve));
        const address = stalledServer.address();
        if (!address || typeof address === 'string') throw new Error('Expected a TCP server address');
        const verify = vi.fn(async () => {});
        adapter = new SFTPAdapter('127.0.0.1', address.port, 'tester', {
            password: 'test-only', verifyHostKey: verify, readyTimeout: 250,
        });
        const started = Date.now();
        expect(await adapter.testConnection()).toContain('Timed out');
        expect(Date.now() - started).toBeLessThan(3000);
        expect(verify).not.toHaveBeenCalled();
        for (const socket of stalledSockets) socket.destroy();
        stalledSockets.clear();
        await new Promise<void>(resolve => stalledServer!.close(() => resolve()));
        stalledServer = undefined;
        const replacement = await startServer(address.port);
        expect(await adapter.testConnection()).toBeNull();
        expect(replacement.authentication).toHaveBeenCalledOnce();
    }, 15000);

    it('keeps authentication bounded and permits retry after its timeout', async () => {
        const authenticationState = { stall: true };
        const { port, authentication } = await startServer(0, authenticationState);
        const verify = vi.fn(async () => {});
        adapter = new SFTPAdapter('127.0.0.1', port, 'tester', {
            password: 'test-only', verifyHostKey: verify, readyTimeout: 500,
        });
        const started = Date.now();
        expect(await adapter.testConnection()).toContain('Timed out');
        expect(Date.now() - started).toBeGreaterThanOrEqual(500);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(verify).toHaveBeenCalledTimes(2);
        expect(authentication).toHaveBeenCalledOnce();
        authenticationState.stall = false;
        expect(await adapter.testConnection()).toBeNull();
        expect(authentication).toHaveBeenCalledTimes(2);
    }, 15000);
});
