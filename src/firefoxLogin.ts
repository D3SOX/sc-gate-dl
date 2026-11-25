import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CookieData } from 'puppeteer';
import { timeout } from './utils';

/**
 * A sign-in in the user's own Firefox, with no automation attached, looks to
 * SoundCloud's bot protection like any other visitor. The cookies are read
 * from the profile on disk; Firefox stores them unencrypted.
 */

/** `SC_GATE_DL_FIREFOX=off` keeps every sign-in in CloakBrowser. */
export function firefoxDisabled(
	setting: string | undefined = process.env.SC_GATE_DL_FIREFOX,
): boolean {
	return setting?.trim().toLowerCase() === 'off';
}

/**
 * The Firefox to sign in with: `SC_GATE_DL_FIREFOX` (a path or command, such
 * as a Firefox fork) or `firefox` on the PATH.
 */
export function findFirefox(
	setting: string | undefined = process.env.SC_GATE_DL_FIREFOX,
	which: (name: string) => string | null = Bun.which,
): string | null {
	if (firefoxDisabled(setting)) return null;
	return which(setting?.trim() || 'firefox');
}

// Skip the first-run pages and notification bars of the fresh profile;
// nothing here changes what a site can see.
const PROFILE_PREFS = [
	'user_pref("browser.shell.checkDefaultBrowser", false);',
	'user_pref("browser.aboutwelcome.enabled", false);',
	'user_pref("datareporting.policy.firstRunURL", "");',
	'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
	'user_pref("media.webspeech.synth.dont_notify_on_error", true);',
	'user_pref("browser.startup.homepage_override.mstone", "ignore");',
	'user_pref("browser.tabs.warnOnClose", false);',
].join('\n');

/** A fresh, empty Firefox profile; the caller deletes it. */
export async function createFirefoxProfile(
	profileRoot: string = firefoxProfileRoot(),
	extraPrefs: string[] = [],
): Promise<string> {
	await mkdir(profileRoot, { recursive: true });
	const profile = await mkdtemp(join(profileRoot, 'sc-gate-dl-firefox-'));
	await writeFile(
		join(profile, 'user.js'),
		`${[PROFILE_PREFS, ...extraPrefs].join('\n')}\n`,
	);
	return profile;
}

function hasCookieTable(profileDir: string): boolean {
	const path = join(profileDir, 'cookies.sqlite');
	if (!existsSync(path)) return false;
	const db = new Database(path);
	try {
		return !!db
			.query("SELECT 1 FROM sqlite_master WHERE name = 'moz_cookies'")
			.get();
	} finally {
		db.close();
	}
}

/**
 * Puts cookies into a profile Firefox is not running on. A short headless
 * start first creates the cookie database, so its layout is the one this
 * Firefox version expects.
 */
export async function writeFirefoxCookies(
	firefox: string,
	profileDir: string,
	cookies: CookieData[],
): Promise<void> {
	for (let attempt = 0; !hasCookieTable(profileDir); attempt++) {
		if (attempt === 3) {
			throw new Error('Firefox did not create its cookie database.');
		}
		const warmup = Bun.spawn(
			[
				firefox,
				'--new-instance',
				'--no-remote',
				'--headless',
				'--profile',
				profileDir,
				'about:blank',
			],
			{ stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
		);
		const deadline = Date.now() + 30_000;
		while (
			!existsSync(join(profileDir, 'cookies.sqlite')) &&
			warmup.exitCode === null &&
			Date.now() < deadline
		) {
			await timeout(250);
		}
		// Give Firefox a moment to create the tables in the new file.
		await timeout(2_000);
		await stopFirefox(warmup);
	}
	const db = new Database(join(profileDir, 'cookies.sqlite'));
	try {
		const now = Date.now() * 1_000;
		const insert = db.prepare(
			`INSERT OR REPLACE INTO moz_cookies
			 (originAttributes, name, value, host, path, expiry, lastAccessed, creationTime, isSecure, isHttpOnly, sameSite, schemeMap)
			 VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		db.transaction(() => {
			for (const cookie of cookies) {
				// Session cookies get a day, enough for one run.
				const expires =
					cookie.expires && cookie.expires > 0
						? cookie.expires * 1_000
						: Date.now() + 24 * 60 * 60_000;
				insert.run(
					cookie.name,
					cookie.value,
					cookie.domain ?? '',
					cookie.path ?? '/',
					Math.round(expires),
					now,
					now,
					cookie.secure ? 1 : 0,
					cookie.httpOnly ? 1 : 0,
					cookie.sameSite === 'Strict' ? 2 : cookie.sameSite === 'Lax' ? 1 : 0,
					// Set over HTTPS.
					2,
				);
			}
		})();
	} finally {
		db.close();
	}
}

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

/**
 * The configured proxy, when Bun's fetch can use it: it takes HTTP(S)
 * proxies but not SOCKS.
 */
export function fetchProxy(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const proxy =
		env.SC_API_PROXY?.trim() ||
		env.CLOAKBROWSER_PROXY?.trim() ||
		env.PROXY_URL?.trim();
	return proxy && /^https?:\/\//i.test(proxy) ? proxy : undefined;
}

export async function fetchSoundcloudClientId(
	fetchPage: (url: string) => Promise<Response> = (url) =>
		fetch(url, {
			signal: AbortSignal.timeout(30_000),
			proxy: fetchProxy(),
		}),
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

/**
 * Ubuntu's Snap Firefox cannot read the host's /tmp; its own folder in the
 * home directory works for it and for any other Firefox.
 */
export function firefoxProfileRoot(
	home: string = homedir(),
	exists: (path: string) => boolean = existsSync,
): string {
	const snapFolder = join(home, 'snap', 'firefox', 'common');
	// Snap creates its folder on the first launch, so check for the snap too.
	return exists('/snap/bin/firefox') || exists(snapFolder)
		? snapFolder
		: tmpdir();
}

export interface FirefoxSignInOptions<T> {
	url: string;
	/** What the wait is for, used in errors. */
	what: string;
	/** Returns a value once the cookies show the sign-in finished. */
	done: (cookies: CookieData[]) => T | null;
	timeoutMs?: number;
	pollMs?: number;
	/** Where the temporary profile goes; see `firefoxProfileRoot`. */
	profileRoot?: string;
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
		profileRoot = firefoxProfileRoot(),
	}: FirefoxSignInOptions<T>,
): Promise<{ result: T; cookies: CookieData[] }> {
	const profile = await createFirefoxProfile(profileRoot);
	let firefoxProcess: ReturnType<typeof Bun.spawn> | null = null;
	try {
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

export async function stopFirefox(
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
