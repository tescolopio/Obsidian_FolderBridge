import { describe, it, expect, vi } from 'vitest';
import { S3Adapter } from '../src/S3Adapter';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };

/** An adapter whose client answers HeadObject as an existing file and records every command. */
function makeAdapter(prefix = '/') {
	const s3 = new S3Adapter('bucket', 'us-east-1', 'AKIATEST', 'secret');
	s3.setPrefix(prefix);
	const send = vi.fn(async (cmd: Sent) => {
		if (cmd.constructor.name === 'HeadObjectCommand') return { ContentLength: 1, LastModified: new Date(0) };
		if (cmd.constructor.name === 'ListObjectsV2Command') {
			return { Contents: [{ Key: 'dir/my file+1.md' }, { Key: 'dir/sub/naïve?.md' }], IsTruncated: false };
		}
		return {};
	});
	(s3 as unknown as { client: { send: typeof send } }).client = { send };
	return { s3, send };
}

function copySources(send: ReturnType<typeof makeAdapter>['send']): string[] {
	return send.mock.calls
		.map(([cmd]) => cmd as Sent)
		.filter(cmd => cmd.constructor.name === 'CopyObjectCommand')
		.map(cmd => cmd.input.CopySource as string);
}

describe('S3Adapter CopySource encoding', () => {
	it('URL-encodes each key segment but keeps the bucket/key separators', async () => {
		const { s3, send } = makeAdapter();
		await s3.copy('/notes/my file+1.md', '/notes/copy.md');
		expect(copySources(send)).toEqual(['bucket/notes/my%20file%2B1.md']);
	});

	it('encodes unicode and reserved characters', async () => {
		const { s3, send } = makeAdapter();
		await s3.copy('/a/naïve?#.md', '/a/b.md');
		expect(copySources(send)).toEqual(['bucket/a/na%C3%AFve%3F%23.md']);
	});

	it('leaves plain keys unchanged', async () => {
		const { s3, send } = makeAdapter();
		await s3.copy('/plain/a.md', '/plain/b.md');
		expect(copySources(send)).toEqual(['bucket/plain/a.md']);
	});

	it('rename copies with an encoded source before removing the original', async () => {
		const { s3, send } = makeAdapter();
		await s3.rename('/notes/my file.md', '/notes/renamed.md');
		expect(copySources(send)).toEqual(['bucket/notes/my%20file.md']);
	});
});
