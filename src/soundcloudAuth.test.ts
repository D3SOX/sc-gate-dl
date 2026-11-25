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
});

describe('tokenExpiresAt', () => {
	test('reads JWT expiry and ignores classic tokens', () => {
		expect(tokenExpiresAt(jwt(NOW))).toBe(NOW);
		expect(tokenExpiresAt('2-123456-789-abcdef')).toBeNull();
	});
});

describe('onRefreshed', () => {
	test('reports every rotated pair so it can be mirrored to .env', async () => {
		const seen: Array<{ accessToken: string; refreshToken: string }> = [];
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-auth-'));
		try {
			const refresher = new SoundcloudTokenRefresher({
				clientId: 'cid',
				refreshToken: 'seed',
				file: join(dir, 'token.json'),
				onRefreshed: async (pair) => {
					seen.push(pair);
				},
				fetch: async () =>
					new Response(
						JSON.stringify({ access_token: 'a1', refresh_token: 'r1' }),
						{ status: 200 },
					),
			});
			await refresher.accessToken();
			expect(seen).toEqual([{ accessToken: 'a1', refreshToken: 'r1' }]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('a failing onRefreshed never loses the rotated login', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-auth-'));
		try {
			const refresher = new SoundcloudTokenRefresher({
				clientId: 'cid',
				refreshToken: 'seed',
				file: join(dir, 'token.json'),
				onRefreshed: async () => {
					throw new Error('disk full');
				},
				fetch: async () =>
					new Response(
						JSON.stringify({ access_token: 'a2', refresh_token: 'r2' }),
						{ status: 200 },
					),
			});
			expect(await refresher.accessToken()).toBe('a2');
			const saved = JSON.parse(await readFile(join(dir, 'token.json'), 'utf8'));
			expect(saved.refreshToken).toBe('r2');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
