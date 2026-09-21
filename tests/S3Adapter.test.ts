import { describe, it, expect, vi } from 'vitest';
import { S3Adapter } from '../src/S3Adapter';
import { PathMapper } from '../src/PathMapper';
import type { MountPoint } from '../src/types';

type Sent = { input: Record<string, unknown> };

function makeAdapter(realPath: string) {
	const s3 = new S3Adapter('bucket', 'us-east-1', 'AKIATEST', 'secret');
	s3.setPrefix(realPath);
	const send = vi.fn().mockResolvedValue({});
	(s3 as unknown as { client: { send: typeof send } }).client = { send };
	return { s3, send };
}

/** Build the server path exactly the way VirtualAdapter.toServerPath does. */
function serverPath(mount: MountPoint, virtualPath: string): string {
	const mapper = new PathMapper();
	mapper.update([mount]);
	return mapper.toRealPath(virtualPath, mount).replace(/\\/g, '/');
}

function s3Mount(realPath: string): MountPoint {
	return { id: 'm1', virtualPath: 'Cloud', realPath, mountType: 's3', enabled: true } as MountPoint;
}

describe('S3Adapter key mapping', () => {
	it('does not apply the mount prefix twice', async () => {
		const mount = s3Mount('/notes');
		const { s3, send } = makeAdapter(mount.realPath);
		await s3.writeText(serverPath(mount, 'Cloud/a.md'), 'hello');
		const cmd = send.mock.calls[0][0] as Sent;
		expect(cmd.input.Key).toBe('notes/a.md');
	});

	it('maps nested paths under the prefix', async () => {
		const mount = s3Mount('/notes/');
		const { s3, send } = makeAdapter(mount.realPath);
		await s3.writeText(serverPath(mount, 'Cloud/sub/b.md'), 'x');
		expect((send.mock.calls[0][0] as Sent).input.Key).toBe('notes/sub/b.md');
	});

	it('maps bucket-root mounts to bare keys', async () => {
		const mount = s3Mount('/');
		const { s3, send } = makeAdapter(mount.realPath);
		await s3.writeText(serverPath(mount, 'Cloud/a.md'), 'x');
		expect((send.mock.calls[0][0] as Sent).input.Key).toBe('a.md');
	});

	it('lists the mount root under the configured prefix', async () => {
		const mount = s3Mount('/notes');
		const { s3, send } = makeAdapter(mount.realPath);
		send.mockResolvedValue({ Contents: [{ Key: 'notes/a.md' }], CommonPrefixes: [{ Prefix: 'notes/sub/' }] });
		const result = await s3.list(serverPath(mount, 'Cloud'), 'Cloud', mount);
		expect((send.mock.calls[0][0] as Sent).input.Prefix).toBe('notes/');
		expect(result).toEqual({ files: ['Cloud/a.md'], folders: ['Cloud/sub'] });
	});
});
