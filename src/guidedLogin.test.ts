import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Cookie } from 'puppeteer';
import {
	type CliLoginOptions,
	checkSpotifyCookies,
	clientIdFromUrl,
	type LoginProvider,
	parseCliArgs,
	pickSoundcloudSession,
	pickSpotifyCookies,
	prepareCliLogins,
	runGuidedLogin,
	type SpotifyLoginState,
} from './guidedLogin';
import type { SoundcloudLoginState } from './soundcloud';

const NOW = 1_800_000_000_000;
const cookie = (name: string, value: string, domain: string) =>
	({ name, value, domain }) as Cookie;

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'sc-gate-login-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('parseCliArgs', () => {
	test('reads --login and the URL in any order', () => {
		expect(parseCliArgs([])).toEqual({ login: false, url: undefined });
		expect(parseCliArgs(['https://soundcloud.com/a/b', '--login'])).toEqual({
			login: true,
			url: 'https://soundcloud.com/a/b',
		});
	});

	test('rejects unknown flags', () => {
		expect(() => parseCliArgs(['--logn'])).toThrow('Unknown option --logn');
	});
});

describe('checkSpotifyCookies', () => {
	const check = async (content?: string) => {
		const file = join(dir, 'spotify-cookies.json');
		if (content !== undefined) await writeFile(file, content);
		return checkSpotifyCookies(file, () => NOW);
	};

	test('needs an sp_dc cookie that has not expired', async () => {
		expect(await check()).toBe('missing');
		expect(await check('not json')).toBe('invalid');
		expect(await check('[{"name":"sp_t","value":"1"}]')).toBe('invalid');
		expect(
			await check(
				JSON.stringify([{ name: 'sp_dc', expirationDate: NOW / 1000 - 1 }]),
			),
		).toBe('expired');
		expect(
			await check(
				JSON.stringify([{ name: 'sp_dc', expirationDate: NOW / 1000 + 60 }]),
			),
		).toBe('present');
		expect(await check('[{"name":"sp_dc","value":"1"}]')).toBe('present');
	});
});

describe('login capture', () => {
	test('client id comes only from SoundCloud hosts', () => {
		expect(
			clientIdFromUrl('https://api-v2.soundcloud.com/me?client_id=abc'),
		).toBe('abc');
		expect(clientIdFromUrl('https://evil.test/?client_id=abc')).toBeNull();
		expect(clientIdFromUrl('not a url')).toBeNull();
	});

	test('session needs the client id and the refresh cookie', () => {
		const refresh = cookie('oauth_refresh_token', '1%3Aabc', '.soundcloud.com');
		expect(pickSoundcloudSession([refresh], 'cid')).toEqual({
			clientId: 'cid',
			refreshToken: '1:abc',
			accessToken: null,
		});
		expect(
			pickSoundcloudSession(
				[refresh, cookie('oauth_token', '2-access', 'soundcloud.com')],
				'cid',
			)?.accessToken,
		).toBe('2-access');
		expect(pickSoundcloudSession([refresh], null)).toBeNull();
		expect(
			pickSoundcloudSession(
				[cookie('oauth_refresh_token', 'x', 'evil.test')],
				'cid',
			),
		).toBeNull();
	});

	test('Spotify needs sp_dc and keeps only Spotify cookies', () => {
		expect(pickSpotifyCookies([cookie('x', '1', '.spotify.com')])).toBeNull();
		expect(
			pickSpotifyCookies([
				cookie('sp_dc', '1', '.spotify.com'),
				cookie('other', '1', '.example.com'),
			]),
		).toHaveLength(1);
	});
});

describe('runGuidedLogin', () => {
	const browser = { close: async () => {} } as unknown as Browser;

	test('writes the new seed to .env and blanks an old access token', async () => {
		const envPath = join(dir, '.env');
		await writeFile(
			envPath,
			'# keep\nSC_COMMENT=hi\nSC_CLIENT_ID=old\nSC_REFRESH_TOKEN=old\nSC_OAUTH_TOKEN=old-account\n',
		);
		const env: Record<string, string> = { SC_OAUTH_TOKEN: 'old-account' };
		const logs: string[] = [];

		const done = await runGuidedLogin(['soundcloud'], {
			openBrowser: async () => browser,
			soundcloud: async () => ({
				clientId: 'new-client',
				refreshToken: 'secret-refresh',
				accessToken: null,
			}),
			envPath,
			env,
			log: (line) => logs.push(line),
		});

		expect(done).toEqual(['soundcloud']);
		expect(await readFile(envPath, 'utf8')).toBe(
			'# keep\nSC_COMMENT=hi\nSC_CLIENT_ID=new-client\nSC_REFRESH_TOKEN=secret-refresh\nSC_OAUTH_TOKEN=\n',
		);
		expect(env).toEqual({
			SC_CLIENT_ID: 'new-client',
			SC_REFRESH_TOKEN: 'secret-refresh',
			SC_OAUTH_TOKEN: '',
		});
		expect(logs.join('\n')).toContain('Restart a running sc-gate-dl server');
		expect(logs.join('\n')).not.toContain('secret');
	});

	test('one provider failing does not stop the other', async () => {
		const envPath = join(dir, '.env');
		const logs: string[] = [];
		let spotifyRan = false;
		let closed = false;

		const done = await runGuidedLogin(['soundcloud', 'spotify'], {
			openBrowser: async () =>
				({
					close: async () => {
						closed = true;
					},
				}) as unknown as Browser,
			soundcloud: async () => {
				throw new Error('SoundCloud blocked this browser or network.');
			},
			spotify: async () => {
				spotifyRan = true;
			},
			envPath,
			env: {},
			log: (line) => logs.push(line),
		});

		expect(done).toEqual(['spotify']);
		expect(spotifyRan).toBe(true);
		expect(closed).toBe(true);
		expect(logs[0]).toContain('SoundCloud login failed: SoundCloud blocked');
		expect(await Bun.file(envPath).exists()).toBe(false);
	});
});

describe('prepareCliLogins', () => {
	function run(
		options: Partial<CliLoginOptions> & {
			soundcloud?: SoundcloudLoginState;
			spotify?: SpotifyLoginState;
			answers?: boolean[];
		},
	) {
		const logs: string[] = [];
		const questions: string[] = [];
		const logins: LoginProvider[][] = [];
		const answers = [...(options.answers ?? [])];
		return prepareCliLogins({
			force: false,
			interactive: true,
			checkSoundcloud: async () => options.soundcloud ?? 'valid',
			checkSpotify: async () => options.spotify ?? 'present',
			login: async (providers) => {
				logins.push(providers);
			},
			confirm: async (message, defaultValue) => {
				questions.push(message);
				return answers.shift() ?? defaultValue;
			},
			log: (line) => logs.push(line),
			...options,
		}).then(() => ({ logs, questions, logins }));
	}

	test('prints one status line and asks nothing when all is fine', async () => {
		const result = await run({});
		expect(result.logs).toEqual([
			'SoundCloud login: valid | Spotify login: present',
		]);
		expect(result.questions).toEqual([]);
		expect(result.logins).toEqual([]);
	});

	test('a missing Spotify login only warns', async () => {
		const result = await run({ spotify: 'missing' });
		expect(result.logs).toEqual([
			'SoundCloud login: valid | Spotify login: missing',
			'Spotify gates need a Spotify login. Run `bun start --login` to log in.',
		]);
		expect(result.questions).toEqual([]);
		expect(result.logins).toEqual([]);
	});

	test('offers a SoundCloud login, yes by default, and checks again', async () => {
		const result = await run({ soundcloud: 'invalid' });
		expect(result.questions).toEqual([
			'Log in to SoundCloud now in a browser window?',
		]);
		expect(result.logins).toEqual([['soundcloud']]);
		expect(result.logs).toHaveLength(2);
	});

	test('a declined offer continues without a login', async () => {
		const result = await run({ soundcloud: 'missing', answers: [false] });
		expect(result.logins).toEqual([]);
	});

	test('an unverifiable SoundCloud login is not treated as broken', async () => {
		const result = await run({ soundcloud: 'unverifiable' });
		expect(result.questions).toEqual([]);
		expect(result.logins).toEqual([]);
	});

	test('without a terminal it prints the hint and continues', async () => {
		const result = await run({ soundcloud: 'missing', interactive: false });
		expect(result.logs).toContain(
			'SoundCloud login is missing. Run `bun start --login` to log in.',
		);
		expect(result.logins).toEqual([]);
	});

	test('--login asks before replacing a working login', async () => {
		const kept = await run({ force: true });
		expect(kept.questions).toEqual([
			'SoundCloud login: valid. Log in again anyway?',
			'Spotify login: present. Log in again anyway?',
		]);
		expect(kept.logins).toEqual([]);

		const redone = await run({ force: true, answers: [false, true] });
		expect(redone.logins).toEqual([['spotify']]);
	});

	test('--login logs in to broken providers without asking', async () => {
		const result = await run({
			force: true,
			soundcloud: 'missing',
			spotify: 'expired',
		});
		expect(result.questions).toEqual([]);
		expect(result.logins).toEqual([['soundcloud', 'spotify']]);
	});
});
