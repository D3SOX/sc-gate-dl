import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Subprocess, spawn } from 'bun';

const FIXTURE = 'library-delivery.mp3';
let proc: Subprocess | undefined;
let libraryDir = '';

async function ffmpeg(args: string[]): Promise<void> {
	const p = spawn(['ffmpeg', '-v', 'error', '-y', ...args], {
		stdout: 'ignore',
		stderr: 'ignore',
	});
	if ((await p.exited) !== 0) throw new Error('ffmpeg failed');
}

async function start(): Promise<{ base: string; jobId: string }> {
	await mkdir('downloads', { recursive: true });
	await ffmpeg([
		'-f',
		'lavfi',
		'-i',
		'sine=frequency=440:duration=1',
		'-f',
		'lavfi',
		'-i',
		'color=c=red:s=64x64:d=1',
		'-map',
		'0:a',
		'-map',
		'1:v',
		'-c:a',
		'libmp3lame',
		'-b:a',
		'128k',
		'-c:v',
		'mjpeg',
		'-disposition:v',
		'attached_pic',
		join('downloads', FIXTURE),
	]);
	libraryDir = await mkdtemp(join(tmpdir(), 'sc-gate-library-'));
	const free = Bun.serve({ port: 0, fetch: () => new Response('') });
	const port = free.port ?? 0;
	free.stop(true);
	proc = spawn(['bun', 'run', './src/server.ts'], {
		env: {
			...(process.env as Record<string, string>),
			SC_COMMENT: 'test-comment',
			SC_GATE_DL_PORT: String(port),
			SC_GATE_DL_LIBRARY_DIR: libraryDir,
			SC_GATE_DL_ALLOW_TEST_FIXTURES: '1',
			SC_GATE_DL_TEST_FIXTURE_JOB: FIXTURE,
			SC_GATE_DL_TEST_FIXTURE_JOB_DESTINATION: 'library',
		},
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	let jobId = '';
	const deadline = Date.now() + 15_000;
	while (!jobId && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		jobId = buffered.match(/\[test-fixture\] job (\S+)/)?.[1] ?? '';
	}
	const base = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			if ((await fetch(base)).ok) break;
		} catch {
			// not listening yet
		}
		await Bun.sleep(100);
	}
	return { base, jobId };
}

afterEach(async () => {
	proc?.kill();
	await proc?.exited;
	proc = undefined;
	await rm(join('downloads', FIXTURE), { force: true });
	if (libraryDir) await rm(libraryDir, { recursive: true, force: true });
});

describe('server library delivery', () => {
	test('a finished library job lands in the library folder', async () => {
		const { base, jobId } = await start();
		const form = new FormData();
		form.set('title', 'Library Song');
		form.set('nameAsArtistTitle', 'false');
		const post = await fetch(`${base}/api/job/${jobId}/metadata`, {
			method: 'POST',
			body: form,
		});
		expect(post.status).toBe(200);
		let stage = '';
		let libraryFilename: string | null = null;
		for (let attempt = 0; attempt < 150 && stage !== 'ready'; attempt += 1) {
			const job = (await (await fetch(`${base}/api/job/${jobId}`)).json()) as {
				progress?: { stage?: string };
				libraryFilename?: string | null;
			};
			stage = job.progress?.stage ?? '';
			libraryFilename = job.libraryFilename ?? null;
			if (stage !== 'ready') await Bun.sleep(200);
		}
		expect(stage).toBe('ready');
		expect(libraryFilename).not.toBeNull();
		expect(await readdir(libraryDir)).toEqual([libraryFilename as string]);
	}, 60_000);

	test('cancelling a library job that is still waiting leaves the library untouched', async () => {
		const { base, jobId } = await start();
		const cancel = await fetch(`${base}/api/job/${jobId}/cancel`, {
			method: 'POST',
		});
		expect(cancel.ok).toBe(true);
		expect(await readdir(libraryDir)).toEqual([]);
	}, 60_000);
});
