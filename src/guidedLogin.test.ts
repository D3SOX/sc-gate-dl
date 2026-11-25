import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Cookie } from 'puppeteer';
import {
	clientIdFromUrl,
	pickSoundcloudSession,
	pickSpotifyCookies,
	runGuidedLogins,
} from './guidedLogin';

const cookie = (name: string, value: string, domain: string) =>
	({ name, value, domain }) as Cookie;

describe('login capture', () => {
	test('client id comes only from soundcloud hosts', () => {
		expect(
			clientIdFromUrl('https://api-v2.soundcloud.com/me?client_id=abc'),
		).toBe('abc');
		expect(clientIdFromUrl('https://evil.test/?client_id=abc')).toBeNull();
	});

	test('session needs both client id and refresh cookie', () => {
		const cookies = [
			cookie('oauth_refresh_token', '1%3Aabc', '.soundcloud.com'),
		];
		expect(pickSoundcloudSession(cookies, 'cid')).toEqual({
			clientId: 'cid',
			refreshToken: '1:abc',
		});
		expect(pickSoundcloudSession(cookies, null)).toBeNull();
		expect(pickSoundcloudSession([], 'cid')).toBeNull();
	});

	test('spotify needs sp_dc and keeps only spotify cookies', () => {
		expect(pickSpotifyCookies([cookie('x', '1', '.spotify.com')])).toBeNull();
		const picked = pickSpotifyCookies([
			cookie('sp_dc', '1', '.spotify.com'),
			cookie('other', '1', '.example.com'),
		]);
		expect(picked).toHaveLength(1);
	});
});

describe('runGuidedLogins', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sc-gate-guided-'));
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	test('writes the SoundCloud login to .env, keeps other lines, never logs the token', async () => {
		const envPath = join(dir, '.env');
		await writeFile(envPath, '# keep\nSC_COMMENT=hi\nSC_REFRESH_TOKEN=old\n');
		const env: Record<string, string> = {};
		const logs: string[] = [];
		await runGuidedLogins({
			providers: ['soundcloud'],
			env,
			envPath,
			log: (l) => logs.push(l),
			soundcloudLogin: async () => ({
				clientId: 'cid',
				refreshToken: 'secret-r',
			}),
			spotifyLogin: async () => {},
			checkSoundcloud: async () => ({ state: 'valid' }),
		});
		const text = await readFile(envPath, 'utf8');
		expect(text).toContain('# keep\nSC_COMMENT=hi\n');
		expect(text).toContain('SC_REFRESH_TOKEN=secret-r');
		expect(text).toContain('SC_CLIENT_ID=cid');
		expect((await stat(envPath)).mode & 0o777).toBe(0o600);
		expect(env.SC_REFRESH_TOKEN).toBe('secret-r');
		expect(logs.join('\n')).not.toContain('secret-r');
	});

	test('a failing provider is reported and does not stop the next one', async () => {
		const logs: string[] = [];
		let spotify = false;
		await runGuidedLogins({
			providers: ['soundcloud', 'spotify'],
			env: {},
			envPath: join(dir, '.env'),
			log: (l) => logs.push(l),
			soundcloudLogin: async () => {
				throw new Error('Timed out');
			},
			spotifyLogin: async () => {
				spotify = true;
			},
			checkSoundcloud: async () => ({ state: 'valid' }),
			checkSpotify: async () => ({ state: 'present', required: true }),
		});
		expect(spotify).toBe(true);
		expect(
			logs.some((l) => l.includes('SoundCloud: guided login failed')),
		).toBe(true);
	});
});
