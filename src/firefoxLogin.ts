import { Database } from 'bun:sqlite';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CookieData } from 'puppeteer';
import { timeout } from './utils';

/**
 * A sign-in in the user's own Firefox, with no automation attached, looks to
 * SoundCloud's bot protection like any other visitor. The cookies are read
 * from the profile on disk; Firefox stores them unencrypted.
 */

export function findFirefox(
	which: (name: string) => string | null = Bun.which,
): string | null {
	return which('firefox');
}

// Skip the first-run pages of the fresh profile; nothing here changes what a
// site can see.
const PROFILE_PREFS = [
	'user_pref("browser.shell.checkDefaultBrowser", false);',
	'user_pref("browser.aboutwelcome.enabled", false);',
	'user_pref("datareporting.policy.firstRunURL", "");',
	'user_pref("browser.startup.homepage_override.mstone", "ignore");',
	'user_pref("browser.tabs.warnOnClose", false);',
].join('\n');

interface MozCookieRow {
	host: string;
	name: string;
	value: string;
	path: string;
	expiry: number;
	isSecure: number;
	isHttpOnly: number;
	sameSite: number;
}

/** Reads a profile's cookies, also while Firefox has the database open. */
export async function readFirefoxCookies(
	profileDir: string,
): Promise<CookieData[]> {
	// Firefox locks cookies.sqlite while it runs; a copy with its write-ahead
	// log holds the current cookies.
	const copy = await mkdtemp(join(tmpdir(), 'sc-gate-dl-cookies-'));
	try {
		await copyFile(
			join(profileDir, 'cookies.sqlite'),
			join(copy, 'cookies.sqlite'),
		);
		await copyFile(
			join(profileDir, 'cookies.sqlite-wal'),
			join(copy, 'cookies.sqlite-wal'),
		).catch(() => {});
		const db = new Database(join(copy, 'cookies.sqlite'));
		try {
			const rows = db
				.query<MozCookieRow, []>(
					`SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
					 FROM moz_cookies WHERE originAttributes = ''`,
				)
				.all();
			return rows.map(toCookieData);
		} finally {
			db.close();
		}
	} finally {
		await rm(copy, { recursive: true, force: true });
	}
}

function toCookieData(row: MozCookieRow): CookieData {
	const secure = row.isSecure === 1;
	// Older Firefox stores the expiry in seconds, newer in milliseconds.
	const expires = row.expiry > 1e11 ? row.expiry / 1000 : row.expiry;
	const sameSite =
		row.sameSite === 1
			? 'Lax'
			: row.sameSite === 2
				? 'Strict'
				: row.sameSite === 0 && secure
					? 'None'
					: undefined;
	return {
		name: row.name,
		value: row.value,
		domain: row.host,
		path: row.path,
		expires,
		secure,
		httpOnly: row.isHttpOnly === 1,
		...(sameSite ? { sameSite } : {}),
	};
}

/** The web app's client id, from the hydration data soundcloud.com ships. */
export function soundcloudClientIdFromPage(html: string): string | null {
	return (
		html.match(/"hydratable":"apiClient","data":\{"id":"(\w+)"/)?.[1] ?? null
	);
}

export async function fetchSoundcloudClientId(
	fetchPage: (url: string) => Promise<Response> = (url) =>
		fetch(url, { signal: AbortSignal.timeout(30_000) }),
): Promise<string> {
	const response = await fetchPage('https://soundcloud.com/');
	const clientId = response.ok
		? soundcloudClientIdFromPage(await response.text())
		: null;
	if (!clientId) {
		throw new Error(
			`Could not read the SoundCloud client id from soundcloud.com (HTTP ${response.status}).`,
		);
	}
	return clientId;
}

export interface FirefoxSignInOptions<T> {
	url: string;
	/** What the wait is for, used in errors. */
	what: string;
	/** Returns a value once the cookies show the sign-in finished. */
	done: (cookies: CookieData[]) => T | null;
	timeoutMs?: number;
	pollMs?: number;
}

/**
 * Opens `url` in a new Firefox with a throwaway profile, waits until `done`
 * accepts its cookies, closes Firefox and deletes the profile. Returns the
 * accepted value and every cookie the profile had at the end.
 */
export async function signInWithFirefox<T>(
	firefox: string,
	{
		url,
		what,
		done,
		timeoutMs = 10 * 60_000,
		pollMs = 1_000,
	}: FirefoxSignInOptions<T>,
): Promise<{ result: T; cookies: CookieData[] }> {
	const profile = await mkdtemp(join(tmpdir(), 'sc-gate-dl-firefox-'));
	let firefoxProcess: ReturnType<typeof Bun.spawn> | null = null;
	try {
		await writeFile(join(profile, 'user.js'), `${PROFILE_PREFS}\n`);
		firefoxProcess = Bun.spawn(
			[firefox, '--new-instance', '--no-remote', '--profile', profile, url],
			{ stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
		);
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const exited = firefoxProcess.exitCode !== null;
			const cookies = await readFirefoxCookies(profile).catch(() => []);
			const result = done(cookies);
			if (result !== null) {
				await stopFirefox(firefoxProcess);
				return {
					result,
					cookies: await readFirefoxCookies(profile).catch(() => cookies),
				};
			}
			if (exited) {
				throw new Error(`Firefox closed before ${what} finished.`);
			}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for ${what}.`);
			}
			await timeout(pollMs);
		}
	} finally {
		if (firefoxProcess) await stopFirefox(firefoxProcess);
		await rm(profile, { recursive: true, force: true });
	}
}

async function stopFirefox(
	firefoxProcess: ReturnType<typeof Bun.spawn>,
): Promise<void> {
	if (firefoxProcess.exitCode !== null) return;
	firefoxProcess.kill('SIGTERM');
	const stopped = await Promise.race([
		firefoxProcess.exited.then(() => true),
		timeout(10_000).then(() => false),
	]);
	if (!stopped) {
		firefoxProcess.kill('SIGKILL');
		await firefoxProcess.exited;
	}
}
