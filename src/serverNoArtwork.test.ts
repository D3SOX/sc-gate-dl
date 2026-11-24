import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Subprocess, spawn } from 'bun';

const FIXTURE = 'artwork-fixture.mp3';
const FIXTURE_PATH = join('downloads', FIXTURE);
let PORT = 0;
let BASE = '';
let server: Subprocess | undefined;
let jobId = '';

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
	const port = probe.port ?? 0;
	probe.stop(true);
	if (port === 0) throw new Error('could not allocate a free port');
	return port;
}

async function startServer(): Promise<void> {
	PORT = await freePort();
	BASE = `http://127.0.0.1:${PORT}`;
	server = spawn(['bun', 'run', './src/server.ts'], {
		env: {
			...(process.env as Record<string, string>),
			SC_COMMENT: 'test-comment',
			SC_GATE_DL_PORT: String(PORT),
			SC_GATE_DL_TEST_FIXTURE_JOB: FIXTURE,
		},
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const decoder = new TextDecoder();
	let buffered = '';
	const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
	const deadline = Date.now() + 15_000;
	while (!jobId && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		const match = buffered.match(/\[test-fixture\] job (\S+)/);
		if (match?.[1]) jobId = match[1];
	}
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const response = await fetch(BASE);
			if (response.ok) return;
		} catch {
			// Not listening yet.
		}
		await Bun.sleep(100);
	}
	throw new Error('server did not start');
}

async function stopServer(): Promise<void> {
	server?.kill();
	await server?.exited;
	server = undefined;
}

describe('finalizing a job without artwork over HTTP', () => {
	beforeAll(async () => {
		await mkdir('downloads', { recursive: true });
		await writeFile(FIXTURE_PATH, 'ID3-artwork-fixture');
		await startServer();
	});
	afterAll(async () => {
		await stopServer();
		await rm(FIXTURE_PATH, { force: true });
	});

	test('rejects tags without artwork and leaves the file unchanged', async () => {
		expect(jobId).not.toBe('');
		const before = await readFile(FIXTURE_PATH);
		const response = await fetch(`${BASE}/api/job/${jobId}/metadata`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'No Cover', nameAsArtistTitle: false }),
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toContain(
			'No artwork available',
		);
		expect(await readFile(FIXTURE_PATH)).toEqual(before);
	});
});
