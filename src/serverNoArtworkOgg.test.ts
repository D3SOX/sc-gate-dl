import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Subprocess, spawn } from 'bun';

const FIXTURE = 'coverless-fixture.ogg';
const FIXTURE_PATH = join('downloads', FIXTURE);

describe('finalizing a coverless OGG job over HTTP', () => {
	let base = '';
	let jobId = '';
	let server: Subprocess | undefined;

	beforeAll(async () => {
		await mkdir('downloads', { recursive: true });
		await writeFile(FIXTURE_PATH, 'OggS-fixture');
		const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
		const port = probe.port ?? 0;
		probe.stop(true);
		base = `http://127.0.0.1:${port}`;
		server = spawn(['bun', 'run', './src/server.ts'], {
			env: {
				...(process.env as Record<string, string>),
				SC_COMMENT: 'test-comment',
				SC_GATE_DL_PORT: String(port),
				SC_GATE_DL_ALLOW_TEST_FIXTURES: '1',
				SC_GATE_DL_TEST_FIXTURE_JOB: FIXTURE,
			},
			stdout: 'pipe',
			stderr: 'ignore',
		});
		const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffered = '';
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
				if ((await fetch(base)).ok) return;
			} catch {
				// not listening yet
			}
			await Bun.sleep(100);
		}
		throw new Error('server did not start');
	});

	afterAll(async () => {
		server?.kill();
		await server?.exited;
		await rm(FIXTURE_PATH, { force: true });
	});

	test('tags a coverless OGG instead of rejecting it for missing artwork', async () => {
		expect(jobId).not.toBe('');
		const response = await fetch(`${base}/api/job/${jobId}/metadata`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'No Cover', nameAsArtistTitle: false }),
		});
		const body = await response.text();
		expect(body).not.toContain('No artwork available');
		expect(response.status).toBe(200);
	}, 30_000);
});
