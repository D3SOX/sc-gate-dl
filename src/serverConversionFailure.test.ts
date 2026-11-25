import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Subprocess, spawn } from 'bun';

const FIXTURE = 'broken-conversion.flac';
const FIXTURE_PATH = join('downloads', FIXTURE);

describe('a failed server conversion keeps and names the source', () => {
	let base = '';
	let jobId = '';
	let server: Subprocess | undefined;

	beforeAll(async () => {
		await mkdir('downloads', { recursive: true });
		await writeFile(FIXTURE_PATH, 'not really flac');
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
				SC_GATE_DL_TEST_FIXTURE_JOB_FORMAT: 'mp3-320',
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

	test('reports the kept source path and leaves the file untouched', async () => {
		expect(jobId).not.toBe('');
		const before = await readFile(FIXTURE_PATH);
		const form = new FormData();
		form.set('title', 'Broken');
		form.set('nameAsArtistTitle', 'false');
		form.set(
			'artwork',
			new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'cover.jpg', {
				type: 'image/jpeg',
			}),
		);
		const post = await fetch(`${base}/api/job/${jobId}/metadata`, {
			method: 'POST',
			body: form,
		});
		expect(post.status).toBe(200);
		let error = '';
		for (let attempt = 0; attempt < 100 && !error; attempt += 1) {
			const job = (await (await fetch(`${base}/api/job/${jobId}`)).json()) as {
				error?: string | null;
				progress?: { stage?: string };
			};
			if (job.progress?.stage === 'error') error = job.error ?? '';
			if (!error) await Bun.sleep(200);
		}
		expect(error).toContain('Files kept');
		expect(error).toContain(FIXTURE);
		expect(await readFile(FIXTURE_PATH)).toEqual(before);
	}, 60_000);
});
