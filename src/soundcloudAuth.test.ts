import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoundcloudTokenRefresher, tokenExpiresAt } from './soundcloudAuth';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

function jwt(expiresAt: number): string {
	const payload = Buffer.from(
		JSON.stringify({ exp: expiresAt / 1000 }),
	).toString('base64url');
	return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

let dir: string;
let file: string;
let requests: URLSearchParams[];

function refresher(
	options: { refreshToken?: string; accessToken?: string } = {},
) {
	return new SoundcloudTokenRefresher({
		clientId: 'client',
		refreshToken: options.refreshToken ?? 'seed',
		accessToken: options.accessToken,
		file,
		now: () => NOW,
		fetch: async (_url, init) => {
			const body = new URLSearchParams(String(init.body));
			requests.push(body);
			return Response.json({
				access_token: jwt(NOW + 24 * HOUR),
				refresh_token: `${body.get('refresh_token')}-next`,
			});
		},
	});
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'sc-auth-'));
	file = join(dir, 'soundcloud-token.json');
	requests = [];
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('SoundcloudTokenRefresher', () => {
	test('refreshes an expiring token and saves the rotated pair', async () => {
		const token = await refresher({
			accessToken: jwt(NOW + HOUR / 2),
		}).accessToken();

		expect(token).toBe(jwt(NOW + 24 * HOUR));
		expect(Object.fromEntries(requests[0] ?? [])).toEqual({
			client_id: 'client',
			grant_type: 'refresh_token',
			refresh_token: 'seed',
		});
		expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
			accessToken: token,
			refreshToken: 'seed-next',
			seed: 'seed',
		});
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});

	test('keeps a fresh token without refreshing', async () => {
		const fresh = jwt(NOW + 2 * HOUR);
		expect(await refresher({ accessToken: fresh }).accessToken()).toBe(fresh);
		expect(requests).toHaveLength(0);
	});

	test('continues the saved chain after a restart', async () => {
		await refresher().accessToken();
		await writeFile(
			file,
			JSON.stringify({
				accessToken: jwt(NOW),
				refreshToken: 'seed-next',
				seed: 'seed',
			}),
		);

		await refresher().accessToken();

		expect(requests.map((body) => body.get('refresh_token'))).toEqual([
			'seed',
			'seed-next',
		]);
	});

	test('starts over when SC_REFRESH_TOKEN changes', async () => {
		await refresher().accessToken();
		await refresher({ refreshToken: 'new-login' }).accessToken();

		expect(requests.map((body) => body.get('refresh_token'))).toEqual([
			'seed',
			'new-login',
		]);
	});

	test('refreshes once for concurrent callers', async () => {
		const auth = refresher();
		await Promise.all([auth.accessToken(), auth.accessToken()]);
		expect(requests).toHaveLength(1);
	});

	test('reports a rejected refresh token', async () => {
		const auth = new SoundcloudTokenRefresher({
			clientId: 'client',
			refreshToken: 'revoked',
			file,
			fetch: async () => new Response('{}', { status: 400 }),
		});
		await expect(auth.accessToken()).rejects.toThrow(
			'SoundCloud token refresh failed with HTTP 400',
		);
	});

	test('takes over the token another process rotated during its own refresh', async () => {
		let valid = 'seed';
		const endpoint = async (_url: string, init: RequestInit) => {
			const used = new URLSearchParams(String(init.body)).get('refresh_token');
			requests.push(new URLSearchParams(String(init.body)));
			if (used !== valid) return new Response('{}', { status: 400 });
			valid = `${used}-next`;
			return Response.json({
				access_token: jwt(NOW + 24 * HOUR),
				refresh_token: valid,
			});
		};
		const startProcess = (
			fetch: (url: string, init: RequestInit) => Promise<Response>,
		) =>
			new SoundcloudTokenRefresher({
				clientId: 'client',
				refreshToken: 'seed',
				file,
				now: () => NOW,
				fetch,
			});
		const other = startProcess(endpoint);
		// This process has read the file; the other one refreshes before its
		// request arrives, so SoundCloud rejects the consumed token.
		const late = startProcess(async (url, init) => {
			await other.accessToken();
			return endpoint(url, init);
		});

		expect(await late.accessToken()).toBe(jwt(NOW + 24 * HOUR));
		expect(requests.map((body) => body.get('refresh_token'))).toEqual([
			'seed',
			'seed',
		]);
	});

	test('a server and a CLI in one folder share the rotating chain', async () => {
		// Like SoundCloud: every refresh revokes the refresh token it used.
		let valid = 'seed';
		let now = NOW;
		const endpoint = async (_url: string, init: RequestInit) => {
			const used = new URLSearchParams(String(init.body)).get('refresh_token');
			if (used !== valid) return new Response('{}', { status: 400 });
			valid = `${used}-next`;
			return Response.json({
				access_token: jwt(now + 24 * HOUR),
				refresh_token: valid,
			});
		};
		const startProcess = () =>
			new SoundcloudTokenRefresher({
				clientId: 'client',
				refreshToken: 'seed',
				file,
				now: () => now,
				fetch: endpoint,
			});
		const server = startProcess();
		const cli = startProcess();

		await server.accessToken();
		now += 24 * HOUR;
		await cli.accessToken();
		now += 24 * HOUR;

		expect(await server.accessToken()).toBe(jwt(now + 24 * HOUR));
		expect(valid).toBe('seed-next-next-next');
	});
});

describe('tokenExpiresAt', () => {
	test('reads JWT expiry and ignores classic tokens', () => {
		expect(tokenExpiresAt(jwt(NOW))).toBe(NOW);
		expect(tokenExpiresAt('2-123456-789-abcdef')).toBeNull();
	});
});
