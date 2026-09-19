import { describe, it, expect, vi } from 'vitest';
import { WebDAVAdapter } from '../src/WebDAVAdapter';

type StubClient = {
	getFileContents: ReturnType<typeof vi.fn>;
	putFileContents: ReturnType<typeof vi.fn>;
};

function makeAdapter(client: StubClient): WebDAVAdapter {
	const adapter = new WebDAVAdapter('https://dav.example.test/');
	(adapter as unknown as { client: StubClient }).client = client;
	return adapter;
}

describe('WebDAVAdapter.append', () => {
	it('appends to the existing content', async () => {
		const client = {
			getFileContents: vi.fn().mockResolvedValue('old\n'),
			putFileContents: vi.fn().mockResolvedValue(true),
		};
		await makeAdapter(client).append('/note.md', 'new');
		expect(client.putFileContents).toHaveBeenCalledTimes(1);
		expect(client.putFileContents.mock.calls[0][1]).toBe('old\nnew');
	});

	it('creates the file when the read fails with 404', async () => {
		const client = {
			getFileContents: vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 })),
			putFileContents: vi.fn().mockResolvedValue(true),
		};
		await makeAdapter(client).append('/note.md', 'new');
		expect(client.putFileContents.mock.calls[0][1]).toBe('new');
	});

	it('does NOT write when the read fails for any other reason', async () => {
		const client = {
			getFileContents: vi.fn().mockRejectedValue(Object.assign(new Error('Service Unavailable'), { status: 503 })),
			putFileContents: vi.fn().mockResolvedValue(true),
		};
		await expect(makeAdapter(client).append('/note.md', 'new')).rejects.toThrow('Service Unavailable');
		expect(client.putFileContents).not.toHaveBeenCalled();
	});
});
