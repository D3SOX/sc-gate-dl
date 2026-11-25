import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebuiHandler } from './webuiServer';

describe('createWebuiHandler', () => {
	let base: string;
	let handle: ReturnType<typeof createWebuiHandler>;

	beforeAll(async () => {
		base = await mkdtemp(join(tmpdir(), 'webui-server-'));
		const dist = join(base, 'dist');
		await mkdir(join(dist, '_astro'), { recursive: true });
		await writeFile(join(dist, 'index.html'), '<!doctype html>');
		await writeFile(join(dist, '_astro', 'App.abc123.js'), 'export {}');
		await writeFile(join(base, 'secret.txt'), 'secret');
		handle = createWebuiHandler(dist);
	});

	afterAll(async () => {
		await rm(base, { recursive: true, force: true });
	});

	const get = (path: string, method = 'GET') =>
		handle(new Request(`http://localhost:4321${path}`, { method }));

	test('serves index.html for / and keeps the query', async () => {
		const response = await get('/?embedded=1');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toStartWith('text/html');
		expect(response.headers.get('Cache-Control')).toBe('no-cache');
		expect(response.headers.get('Access-Control-Allow-Private-Network')).toBe(
			'true',
		);
		expect(await response.text()).toBe('<!doctype html>');
	});

	test('caches hashed assets', async () => {
		const response = await get('/_astro/App.abc123.js');
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toContain('immutable');
	});

	test('answers HEAD without a body', async () => {
		const response = await get('/', 'HEAD');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('');
	});

	test.each([
		'/missing.js',
		'/%2e%2e/secret.txt',
		'/..%2fsecret.txt',
		'/_astro',
	])('returns 404 for %p', async (path) => {
		expect((await get(path)).status).toBe(404);
	});

	test('rejects other methods', async () => {
		expect((await get('/', 'POST')).status).toBe(405);
	});
});
