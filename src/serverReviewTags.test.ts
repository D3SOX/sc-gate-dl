import { describe, expect, test } from 'bun:test';
import { type Subprocess, spawn } from 'bun';

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
	const port = probe.port ?? 0;
	probe.stop(true);
	return port;
}

async function withServer<T>(
	reviewTags: string | undefined,
	run: (base: string) => Promise<T>,
): Promise<T> {
	const port = await freePort();
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		SC_COMMENT: 'test-comment',
		SC_GATE_DL_PORT: String(port),
	};
	delete env.SC_GATE_DL_REVIEW_TAGS;
	if (reviewTags !== undefined) env.SC_GATE_DL_REVIEW_TAGS = reviewTags;
	const proc: Subprocess = spawn(['bun', 'run', './src/server.ts'], {
		env,
		stdout: 'ignore',
		stderr: 'ignore',
	});
	try {
		const base = `http://127.0.0.1:${port}`;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				if ((await fetch(base)).ok) break;
			} catch {
				// not listening yet
			}
			await Bun.sleep(100);
		}
		return await run(base);
	} finally {
		proc.kill();
		await proc.exited;
	}
}

async function capabilities(base: string) {
	return (await (await fetch(`${base}/api/capabilities`)).json()) as {
		reviewTagsDefault?: boolean;
	};
}

describe('SC_GATE_DL_REVIEW_TAGS on the server', () => {
	test.each([
		[undefined, false],
		['false', false],
		[' TRUE ', true],
	])(
		'reports %p as reviewTagsDefault %p',
		async (value, expected) => {
			await withServer(value, async (base) => {
				expect((await capabilities(base)).reviewTagsDefault).toBe(expected);
			});
		},
		30_000,
	);

	test.each(['', 'maybe'])(
		'rejects %p at startup',
		async (value) => {
			const env: Record<string, string> = {
				...(process.env as Record<string, string>),
				SC_COMMENT: 'test-comment',
				SC_GATE_DL_PORT: String(await freePort()),
				SC_GATE_DL_REVIEW_TAGS: value,
			};
			const proc = spawn(['bun', 'run', './src/server.ts'], {
				env,
				stdout: 'ignore',
				stderr: 'pipe',
			});
			const timer = setTimeout(() => proc.kill(), 8_000);
			const [stderr, code] = await Promise.all([
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			clearTimeout(timer);
			expect(code).not.toBe(0);
			expect(stderr).toContain('SC_GATE_DL_REVIEW_TAGS');
		},
		20_000,
	);
});

describe('the review default decides between waiting and finalizing', () => {
	const FIXTURE = 'review-default.mp3';

	async function stageAfterStart(
		reviewTags: string | undefined,
		request = '1',
	) {
		const { mkdir, rm } = await import('node:fs/promises');
		await mkdir('downloads', { recursive: true });
		const make = Bun.spawn(
			[
				'ffmpeg',
				'-v',
				'error',
				'-y',
				'-f',
				'lavfi',
				'-i',
				'sine=frequency=440:duration=1',
				'-c:a',
				'libmp3lame',
				`downloads/${FIXTURE}`,
			],
			{ stdout: 'ignore', stderr: 'ignore' },
		);
		await make.exited;
		const port = await freePort();
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			SC_COMMENT: 'test-comment',
			SC_GATE_DL_PORT: String(port),
			SC_GATE_DL_ALLOW_TEST_FIXTURES: '1',
			SC_GATE_DL_TEST_FIXTURE_JOB: FIXTURE,
			SC_GATE_DL_TEST_FIXTURE_JOB_FINISH: request,
		};
		delete env.SC_GATE_DL_REVIEW_TAGS;
		if (reviewTags !== undefined) env.SC_GATE_DL_REVIEW_TAGS = reviewTags;
		const proc = spawn(['bun', 'run', './src/server.ts'], {
			env,
			stdout: 'pipe',
			stderr: 'ignore',
		});
		try {
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
			let stage = '';
			for (let attempt = 0; attempt < 50; attempt += 1) {
				const job = (await (
					await fetch(`${base}/api/job/${jobId}`)
				).json()) as {
					progress?: { stage?: string };
				};
				stage = job.progress?.stage ?? '';
				if (stage === 'waiting_metadata' || stage === 'error') break;
				await Bun.sleep(200);
			}
			return stage;
		} finally {
			proc.kill();
			await proc.exited;
			await rm(`downloads/${FIXTURE}`, { force: true });
		}
	}

	test('true makes the job wait for tags', async () => {
		expect(await stageAfterStart('true')).toBe('waiting_metadata');
	}, 60_000);

	test('unset finalizes without waiting', async () => {
		expect(await stageAfterStart(undefined)).not.toBe('waiting_metadata');
	}, 60_000);

	test('an explicit request of false overrides a default of true', async () => {
		expect(await stageAfterStart('true', 'false')).not.toBe('waiting_metadata');
	}, 60_000);

	test('an explicit request of true overrides a default of false', async () => {
		expect(await stageAfterStart('false', 'true')).toBe('waiting_metadata');
	}, 60_000);
});

describe('the test fixture hook stays out of normal operation', () => {
	test('a stray fixture variable alone does not create a job', async () => {
		const port = await freePort();
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			SC_COMMENT: 'test-comment',
			SC_GATE_DL_PORT: String(port),
			SC_GATE_DL_TEST_FIXTURE_JOB: 'stray.mp3',
		};
		delete env.SC_GATE_DL_ALLOW_TEST_FIXTURES;
		const proc = spawn(['bun', 'run', './src/server.ts'], {
			env,
			stdout: 'pipe',
			stderr: 'ignore',
		});
		try {
			const base = `http://127.0.0.1:${port}`;
			for (let attempt = 0; attempt < 100; attempt += 1) {
				try {
					if ((await fetch(base)).ok) break;
				} catch {
					// not listening yet
				}
				await Bun.sleep(100);
			}
			await Bun.sleep(300);
			proc.kill();
			const out = await new Response(proc.stdout).text();
			expect(out).not.toContain('[test-fixture] job');
		} finally {
			proc.kill();
			await proc.exited;
		}
	}, 30_000);
});

describe('account access on the server', () => {
	test('capabilities report the SoundCloud state and Spotify as optional, with no token', async () => {
		await withServer(undefined, async (base) => {
			const body = (await (await fetch(`${base}/api/capabilities`)).json()) as {
				account?: {
					soundcloud?: string;
					spotify?: { state?: string; required?: boolean };
				};
			};
			expect(typeof body.account?.soundcloud).toBe('string');
			expect(body.account?.spotify?.required).toBe(false);
			const text = JSON.stringify(body);
			expect(text).not.toContain(process.env.SC_OAUTH_TOKEN ?? 'no-token-set');
			expect(text).not.toContain(
				process.env.SC_REFRESH_TOKEN ?? 'no-token-set',
			);
		});
	}, 30_000);
});
