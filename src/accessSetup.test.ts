import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSpotifyCookies, ensureSoundcloudAccess } from './accessSetup';

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'sc-gate-access-'));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const jwt = (expSeconds: number) =>
	`h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.s`;

function input(over: Record<string, unknown> = {}) {
	const logs: string[] = [];
	return {
		logs,
		value: {
			envPath: join(dir, '.env'),
			clientId: 'cid',
			oauthToken: jwt(NOW / 1000 - 10),
			refreshToken: 'old-refresh',
			now: () => NOW,
			interactive: false,
			log: (line: string) => logs.push(line),
			fetchMe: async () => ({ ok: true, status: 200 }),
			refresh: async () => ({
				accessToken: 'new-access',
				refreshToken: 'new-refresh',
			}),
			...over,
		},
	};
}

describe('ensureSoundcloudAccess', () => {
	test('a valid login changes nothing and writes no file', async () => {
		const { value } = input({ oauthToken: jwt(NOW / 1000 + 86_400) });
		const result = await ensureSoundcloudAccess(value as never);
		expect(result.state).toBe('valid');
		expect(await Bun.file(join(dir, '.env')).exists()).toBe(false);
	});

	test('a renewed login is saved to .env, keeping the other lines', async () => {
		await writeFile(
			join(dir, '.env'),
			'# keep\nSC_COMMENT=hi there\nSC_REFRESH_TOKEN=old-refresh\n',
		);
		const { value } = input();
		const result = await ensureSoundcloudAccess(value as never);
		expect(result.state).toBe('valid');
		expect(result.renewed).toBe(true);
		const text = await readFile(join(dir, '.env'), 'utf8');
		expect(text).toContain('# keep\nSC_COMMENT=hi there\n');
		expect(text).toContain('SC_REFRESH_TOKEN=new-refresh');
		expect(text).toContain('SC_OAUTH_TOKEN=new-access');
	});

	test('a failed save never loses the rotated token: it is reported to stderr-safe log without its value', async () => {
		const { value, logs } = input({
			envPath: join(dir, 'no-such-dir', '.env'),
		});
		const result = await ensureSoundcloudAccess(value as never);
		expect(result.state).toBe('valid');
		expect(logs.join('\n')).toContain('could not be saved');
		expect(logs.join('\n')).not.toContain('new-refresh');
		expect(logs.join('\n')).not.toContain('new-access');
	});

	test('an unusable login tells the user what to do and never throws', async () => {
		const { value, logs } = input({
			refresh: async () => {
				throw new Error('HTTP 400');
			},
		});
		const result = await ensureSoundcloudAccess(value as never);
		expect(result.state).toBe('expired');
		expect(logs.join('\n')).toContain('log in');
	});

	test('an unreachable provider is reported but keeps the stored login', async () => {
		await writeFile(join(dir, '.env'), 'SC_REFRESH_TOKEN=old-refresh\n');
		const { value } = input({
			oauthToken: jwt(NOW / 1000 + 86_400),
			fetchMe: async () => {
				throw new Error('offline');
			},
		});
		const result = await ensureSoundcloudAccess(value as never);
		expect(result.state).toBe('unverifiable');
		expect(await readFile(join(dir, '.env'), 'utf8')).toBe(
			'SC_REFRESH_TOKEN=old-refresh\n',
		);
	});
});

describe('checkSpotifyCookies', () => {
	test('missing Spotify cookies are optional and block nothing', async () => {
		const result = await checkSpotifyCookies(join(dir, 'spotify-cookies.json'));
		expect(result.state).toBe('missing');
		expect(result.required).toBe(false);
	});

	test('a readable cookie file is reported as present', async () => {
		const path = join(dir, 'spotify-cookies.json');
		await writeFile(
			path,
			'[{"name":"sp_dc","value":"x","domain":".spotify.com"}]',
		);
		expect((await checkSpotifyCookies(path)).state).toBe('present');
	});

	test('a broken cookie file is reported as invalid without printing it', async () => {
		const path = join(dir, 'spotify-cookies.json');
		await writeFile(path, 'not json SECRET');
		const result = await checkSpotifyCookies(path);
		expect(result.state).toBe('invalid');
		expect(JSON.stringify(result)).not.toContain('SECRET');
	});
});
