import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type Subprocess, spawn } from 'bun';

const FIXTURE = 'cover-preserve.mp3';
const FIXTURE_PATH = join('downloads', FIXTURE);

async function ffmpeg(args: string[]): Promise<void> {
	const proc = spawn(['ffmpeg', '-v', 'error', '-y', ...args], {
		stdout: 'ignore',
		stderr: 'pipe',
	});
	if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed: ${args[0]}`);
}

async function probe(path: string) {
	const proc = spawn(
		[
			'ffprobe',
			'-v',
			'error',
			'-print_format',
			'json',
			'-show_streams',
			'-show_format',
			path,
		],
		{ stdout: 'pipe', stderr: 'ignore' },
	);
	return JSON.parse(await new Response(proc.stdout).text()) as {
		streams?: Array<{
			codec_type?: string;
			disposition?: { attached_pic?: number };
		}>;
		format?: { tags?: Record<string, string> };
	};
}

describe('an existing MP3 cover survives an unattended metadata save', () => {
	let base = '';
	let jobId = '';
	let server: Subprocess | undefined;

	beforeAll(async () => {
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
			FIXTURE_PATH,
		]);
		const free = Bun.serve({ port: 0, fetch: () => new Response('') });
		const port = free.port ?? 0;
		free.stop(true);
		base = `http://127.0.0.1:${port}`;
		server = spawn(['bun', 'run', './src/server.ts'], {
			env: {
				...(process.env as Record<string, string>),
				SC_COMMENT: 'test-comment',
				SC_GATE_DL_PORT: String(port),
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

	test('retags the title and keeps the embedded cover', async () => {
		const form = new FormData();
		form.set('title', 'Kept Cover');
		form.set('nameAsArtistTitle', 'false');
		const post = await fetch(`${base}/api/job/${jobId}/metadata`, {
			method: 'POST',
			body: form,
		});
		expect(post.status).toBe(200);
		let tagged = false;
		for (let attempt = 0; attempt < 150 && !tagged; attempt += 1) {
			const info = await probe(FIXTURE_PATH);
			tagged = info.format?.tags?.title === 'Kept Cover';
			if (!tagged) await Bun.sleep(200);
		}
		expect(tagged).toBe(true);
		const info = await probe(FIXTURE_PATH);
		expect(
			info.streams?.some(
				(s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1,
			),
		).toBe(true);
	}, 90_000);
});
