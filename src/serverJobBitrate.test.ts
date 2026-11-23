import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Subprocess, spawn } from 'bun';

const PORT = 3900 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const SOUNDCLOUD_URL = 'https://soundcloud.com/artist/track';

let server: Subprocess | undefined;

async function startServer(bitrate: string | undefined): Promise<void> {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		SC_COMMENT: 'test comment',
		SC_GATE_DL_PORT: String(PORT),
	};
	if (bitrate === undefined) delete env.SC_GATE_DL_BITRATE;
	else env.SC_GATE_DL_BITRATE = bitrate;
	server = spawn(['bun', 'run', './src/server.ts'], {
		env,
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

async function postJob(outputFormat: string) {
	const response = await fetch(`${BASE}/api/job`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ soundcloudUrl: SOUNDCLOUD_URL, outputFormat }),
	});
	const body = (await response.json()) as { error?: string };
	return { status: response.status, error: body.error ?? '' };
}

async function stopServer(): Promise<void> {
	server?.kill();
	await server?.exited;
	server = undefined;
}

describe('POST /api/job bitrate validation', () => {
	describe('with an invalid SC_GATE_DL_BITRATE of 63', () => {
		beforeAll(() => startServer('63'));
		afterAll(stopServer);

		test('rejects configurable mp3 with a 400 that names the setting', async () => {
			const { status, error } = await postJob('mp3');
			expect(status).toBe(400);
			expect(error).toContain('SC_GATE_DL_BITRATE=63 is not valid for mp3');
		});

		test('rejects configurable m4a-aac with a 400 that names the setting', async () => {
			const { status, error } = await postJob('m4a-aac');
			expect(status).toBe(400);
			expect(error).toContain('SC_GATE_DL_BITRATE=63 is not valid for m4a-aac');
		});

		test('does not let the invalid value block flac or fixed mp3-320', async () => {
			for (const format of ['flac', 'mp3-320']) {
				const { error } = await postJob(format);
				expect(error).not.toContain('SC_GATE_DL_BITRATE');
			}
		});
	});

	describe('with an unset SC_GATE_DL_BITRATE', () => {
		beforeAll(() => startServer(undefined));
		afterAll(stopServer);

		test('accepts configurable mp3 and fixed mp3-320 without a bitrate error', async () => {
			for (const format of ['mp3', 'mp3-320']) {
				const { error } = await postJob(format);
				expect(error).not.toContain('SC_GATE_DL_BITRATE');
			}
		});
	});
});
