import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Subprocess, spawn } from 'bun';

const SOUNDCLOUD_URL =
	'https://soundcloud.com/lister_aus/lister-nik-sitz-anavax-dj-got';
let PORT = 0;
let BASE = '';
let server: Subprocess | undefined;

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
		},
		stdout: 'ignore',
		stderr: 'ignore',
	});
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

describe('POST /api/job/:id/cancel over HTTP', () => {
	beforeAll(startServer);
	afterAll(stopServer);

	test('answers 404 for an unknown job', async () => {
		const response = await fetch(`${BASE}/api/job/does-not-exist/cancel`, {
			method: 'POST',
		});
		expect(response.status).toBe(404);
	});

	test('cancels a created job and reports it as cancelled', async () => {
		const created = await fetch(`${BASE}/api/job`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				soundcloudUrl: SOUNDCLOUD_URL,
				outputFormat: 'mp3',
			}),
		});
		const { jobId } = (await created.json()) as { jobId: string };
		expect(jobId).toBeTruthy();

		const cancelled = await fetch(`${BASE}/api/job/${jobId}/cancel`, {
			method: 'POST',
		});
		expect(cancelled.status).toBe(200);
		expect(((await cancelled.json()) as { success: boolean }).success).toBe(
			true,
		);
	}, 120_000);
});
