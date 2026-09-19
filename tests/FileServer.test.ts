import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { FileServer } from '../src/FileServer';

function get(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => {
			let body = '';
			res.on('data', (c) => { body += c; });
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
		}).on('error', reject);
	});
}

describe('FileServer path containment', () => {
	let tmp: string;
	let root: string;
	let server: FileServer;

	beforeAll(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-fileserver-'));
		root = path.join(tmp, 'mount');
		fs.mkdirSync(root);
		fs.writeFileSync(path.join(root, 'inside.txt'), 'inside');
		fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside');
		server = new FileServer();
		await server.start();
		server.addAllowedPath(root);
	});

	afterAll(() => {
		server.stop();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('serves a file inside an allowed root', async () => {
		const res = await get(server.getFileUrl(path.join(root, 'inside.txt')));
		expect(res.status).toBe(200);
		expect(res.body).toBe('inside');
	});

	it('rejects a `..` path that lexically starts with an allowed root', async () => {
		const url = server.getFileUrl(`${root}/../outside.txt`);
		const res = await get(url);
		expect(res.status).toBe(403);
		expect(res.body).not.toContain('outside');
	});

	it('rejects a path outside every allowed root', async () => {
		const res = await get(server.getFileUrl(path.join(tmp, 'outside.txt')));
		expect(res.status).toBe(403);
	});
});
