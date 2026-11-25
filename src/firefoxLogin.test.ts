import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	fetchSoundcloudClientId,
	findFirefox,
	readFirefoxCookies,
	signInWithFirefox,
	soundcloudClientIdFromPage,
} from './firefoxLogin';

const MOZ_COOKIES = `CREATE TABLE moz_cookies (
	id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '',
	name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER,
	lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER,
	isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0,
	sameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0)`;

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'sc-gate-firefox-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('readFirefoxCookies', () => {
	test('reads cookies Firefox still holds in its write-ahead log', async () => {
		// Like a running Firefox: WAL mode, connection open, nothing checkpointed.
		const db = new Database(join(dir, 'cookies.sqlite'));
		try {
			db.run('PRAGMA journal_mode = WAL');
			db.run('PRAGMA wal_autocheckpoint = 0');
			db.run(MOZ_COOKIES);
			const insert = db.prepare(
				`INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			insert.run(
				'',
				'oauth_token',
				'a',
				'soundcloud.com',
				'/',
				1_900_000_000,
				1,
				0,
				0,
			);
			insert.run(
				'',
				'_soundcloud_session',
				's',
				'api-auth.soundcloud.com',
				'/',
				1_900_000_000_000,
				1,
				1,
				1,
			);
			insert.run(
				'^userContextId=1',
				'container',
				'x',
				'.soundcloud.com',
				'/',
				1,
				0,
				0,
				0,
			);

			expect(await readFirefoxCookies(dir)).toEqual([
				{
					name: 'oauth_token',
					value: 'a',
					domain: 'soundcloud.com',
					path: '/',
					expires: 1_900_000_000,
					secure: true,
					httpOnly: false,
					sameSite: 'None',
				},
				{
					name: '_soundcloud_session',
					value: 's',
					domain: 'api-auth.soundcloud.com',
					path: '/',
					expires: 1_900_000_000,
					secure: true,
					httpOnly: true,
					sameSite: 'Lax',
				},
			]);
		} finally {
			db.close();
		}
	});
});

describe('SoundCloud client id', () => {
	test('comes from the apiClient hydration data', () => {
		expect(
			soundcloudClientIdFromPage(
				'[{"hydratable":"trackingBrowserTabId","data":"2444c1"},{"hydratable":"apiClient","data":{"id":"abc123","isExpiring":false}}]',
			),
		).toBe('abc123');
		expect(soundcloudClientIdFromPage('<html></html>')).toBeNull();
	});

	test('a page without it fails naming the status', async () => {
		await expect(
			fetchSoundcloudClientId(
				async () => new Response('blocked', { status: 403 }),
			),
		).rejects.toThrow('HTTP 403');
	});
});

test('findFirefox uses SC_GATE_DL_FIREFOX, then firefox on the PATH', () => {
	const which = (name: string) =>
		name.startsWith('/') ? name : `/usr/bin/${name}`;
	expect(findFirefox('', which)).toBe('/usr/bin/firefox');
	expect(findFirefox('/opt/librewolf/librewolf', which)).toBe(
		'/opt/librewolf/librewolf',
	);
	expect(findFirefox('off', which)).toBeNull();
	expect(findFirefox('', () => null)).toBeNull();
});

describe('signInWithFirefox', () => {
	/** A stand-in for Firefox that writes a sign-in cookie into its profile. */
	async function fakeFirefox(behaviour: 'sign in' | 'quit'): Promise<string> {
		const path = join(dir, 'firefox');
		await writeFile(
			path,
			`#!${process.execPath}
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const profile = process.argv[process.argv.indexOf('--profile') + 1];
writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid));
if (${JSON.stringify(behaviour)} === 'quit') process.exit(0);
await Bun.sleep(200);
const db = new Database(join(profile, 'cookies.sqlite'));
db.run(${JSON.stringify(MOZ_COOKIES)});
db.run("INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly) VALUES ('oauth_refresh_token', 'r', 'soundcloud.com', '/', 1900000000, 1, 0)");
db.close();
setInterval(() => {}, 1000);
`,
		);
		await chmod(path, 0o755);
		return path;
	}

	test('waits for the sign-in, then closes Firefox and deletes the profile', async () => {
		const { result, cookies } = await signInWithFirefox(
			await fakeFirefox('sign in'),
			{
				url: 'https://soundcloud.com/signin',
				what: 'the test sign-in',
				done: (cookies) =>
					cookies.find((cookie) => cookie.name === 'oauth_refresh_token')
						?.value ?? null,
				pollMs: 50,
			},
		);
		expect(result).toBe('r');
		expect(cookies.map((cookie) => cookie.name)).toEqual([
			'oauth_refresh_token',
		]);
		const pid = Number(await readFile(join(dir, 'pid'), 'utf8'));
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test('stops when Firefox is closed before the sign-in', async () => {
		await expect(
			signInWithFirefox(await fakeFirefox('quit'), {
				url: 'https://soundcloud.com/signin',
				what: 'the test sign-in',
				done: () => null,
				pollMs: 50,
			}),
		).rejects.toThrow('Firefox closed before the test sign-in finished.');
	});
});
