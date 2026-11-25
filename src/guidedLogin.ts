import { readFile } from 'node:fs/promises';
import type { Browser, Cookie } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { setEnvValues } from './envFile';
import {
	hasSoundcloudLogin,
	SoundcloudClient,
	type SoundcloudLoginState,
} from './soundcloud';
import { saveSoundcloudLogin, signInToSoundcloud } from './soundcloudLogin';
import { SPOTIFY_COOKIES_FILE } from './spotifyAuth';
import { timeout, writeBrowserCookies } from './utils';

export type LoginProvider = 'soundcloud' | 'spotify';
export type SpotifyLoginState = 'present' | 'missing' | 'invalid' | 'expired';

const LABELS: Record<LoginProvider, string> = {
	soundcloud: 'SoundCloud',
	spotify: 'Spotify',
};
const LOGIN_HINT = 'Run `bun start --login` to log in.';
const SOUNDCLOUD_HOST_RE = /(^|\.)soundcloud\.com$/i;
const SPOTIFY_HOST_RE = /(^|\.)spotify\.com$/i;
const isCookieOf = (host: RegExp) => (cookie: Cookie) =>
	host.test(cookie.domain.replace(/^\./, ''));

/** `bun start [--login] [url]`; unknown flags are an error. */
export function parseCliArgs(args: string[]): {
	login: boolean;
	url: string | undefined;
} {
	const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--login');
	if (unknown) {
		throw new Error(
			`Unknown option ${unknown}. Usage: bun start [--login] [url]`,
		);
	}
	return {
		login: args.includes('--login'),
		url: args.find((arg) => !arg.startsWith('--')),
	};
}

export async function checkSoundcloudLogin(): Promise<SoundcloudLoginState> {
	return hasSoundcloudLogin() ? new SoundcloudClient().checkLogin() : 'missing';
}

/**
 * Offline check of the saved Spotify login: the file must hold an `sp_dc`
 * cookie that has not passed its expiry. A login Spotify revoked on its side
 * still shows as present.
 */
export async function checkSpotifyCookies(
	path = SPOTIFY_COOKIES_FILE,
	now: () => number = Date.now,
): Promise<SpotifyLoginState> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch {
		return 'missing';
	}
	try {
		const cookies = JSON.parse(text) as unknown;
		if (!Array.isArray(cookies)) return 'invalid';
		const login = (
			cookies as { name?: unknown; expirationDate?: unknown }[]
		).find((cookie) => cookie?.name === 'sp_dc');
		if (!login) return 'invalid';
		return typeof login.expirationDate === 'number' &&
			login.expirationDate * 1000 <= now()
			? 'expired'
			: 'present';
	} catch {
		return 'invalid';
	}
}

/** What a SoundCloud web login yields for `.env`. */
export interface SoundcloudSession {
	clientId: string;
	refreshToken: string;
	accessToken: string | null;
}

/** The web client id only shows up in SoundCloud's request URLs. */
export function clientIdFromUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!SOUNDCLOUD_HOST_RE.test(parsed.hostname)) return null;
		return parsed.searchParams.get('client_id') || null;
	} catch {
		return null;
	}
}

function decodeCookie(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function pickSoundcloudSession(
	cookies: Cookie[],
	clientId: string | null,
): SoundcloudSession | null {
	const own = cookies.filter(isCookieOf(SOUNDCLOUD_HOST_RE));
	const value = (name: string) =>
		own.find((cookie) => cookie.name === name && cookie.value)?.value;
	const refreshToken = value('oauth_refresh_token');
	const accessToken = value('oauth_token');
	return clientId && refreshToken
		? {
				clientId,
				refreshToken: decodeCookie(refreshToken),
				accessToken: accessToken ? decodeCookie(accessToken) : null,
			}
		: null;
}

/** `sp_dc` is Spotify's long-lived login cookie; it only exists after a login. */
export function pickSpotifyCookies(cookies: Cookie[]): Cookie[] | null {
	const own = cookies.filter(isCookieOf(SPOTIFY_HOST_RE));
	return own.some((cookie) => cookie.name === 'sp_dc') ? own : null;
}

async function waitFor<T>(
	what: string,
	poll: () => Promise<T | null>,
	timeoutMs: number,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await poll().catch(() => null);
		if (value) return value;
		await timeout(1_000);
	}
	throw new Error(`Timed out waiting for ${what}.`);
}

/**
 * Signs the browser in like Initialize logins (which also saves
 * soundcloud-cookies.json), then reads the API login from it.
 */
export async function loginToSoundcloud(
	browser: Browser,
): Promise<SoundcloudSession> {
	const context = browser.defaultBrowserContext();
	// An old refresh cookie may be one SoundCloud already rotated away.
	const stale = (await context.cookies()).filter(
		(cookie) =>
			cookie.name === 'oauth_refresh_token' &&
			isCookieOf(SOUNDCLOUD_HOST_RE)(cookie),
	);
	if (stale.length > 0) await context.deleteCookie(...stale);
	await signInToSoundcloud(browser);

	const page = await browser.newPage();
	try {
		let clientId: string | null = null;
		page.on('request', (request) => {
			clientId ??= clientIdFromUrl(request.url());
		});
		await page.goto('https://soundcloud.com/you/library', {
			waitUntil: 'domcontentloaded',
		});
		const session = await waitFor(
			'the SoundCloud client id and refresh token',
			async () => pickSoundcloudSession(await context.cookies(), clientId),
			60_000,
		);
		await saveSoundcloudLogin(context);
		return session;
	} finally {
		await page.close().catch(() => {});
	}
}

/** Waits for a fresh Spotify login and saves its cookies. */
export async function loginToSpotify(browser: Browser): Promise<void> {
	const context = browser.defaultBrowserContext();
	// Ask for a new login instead of copying a session that may be dead.
	const old = (await context.cookies()).filter(
		(cookie) => cookie.name === 'sp_dc' && isCookieOf(SPOTIFY_HOST_RE)(cookie),
	);
	if (old.length > 0) await context.deleteCookie(...old);

	const page = await browser.newPage();
	try {
		await page.goto('https://accounts.spotify.com/login', {
			waitUntil: 'domcontentloaded',
		});
		console.log('Sign in to Spotify in the browser window...');
		await waitFor(
			'Spotify sign-in',
			async () => pickSpotifyCookies(await context.cookies()),
			10 * 60_000,
		);
		// Let the account page set its remaining cookies before saving them.
		await page
			.goto('https://accounts.spotify.com/account/overview', {
				waitUntil: 'networkidle2',
				timeout: 30_000,
			})
			.catch(() => {});
		const cookies = pickSpotifyCookies(await context.cookies());
		if (!cookies) throw new Error('The Spotify login was lost before saving.');
		await writeBrowserCookies(cookies, SPOTIFY_COOKIES_FILE);
	} finally {
		await page.close().catch(() => {});
	}
}

/**
 * The guided login is the only writer of these `.env` values. Rotated tokens
 * stay in soundcloud-token.json, because SC_REFRESH_TOKEN is the seed that
 * file is matched against. An access token from an older login is blanked.
 */
export async function saveSoundcloudSession(
	session: SoundcloudSession,
	envPath: string,
	env: Partial<Record<string, string>>,
): Promise<void> {
	const values = {
		SC_CLIENT_ID: session.clientId,
		SC_REFRESH_TOKEN: session.refreshToken,
		SC_OAUTH_TOKEN: session.accessToken ?? '',
	};
	await setEnvValues(envPath, values);
	Object.assign(env, values);
}

export interface GuidedLoginOptions {
	openBrowser?: () => Promise<Browser>;
	soundcloud?: (browser: Browser) => Promise<SoundcloudSession>;
	spotify?: (browser: Browser) => Promise<void>;
	envPath?: string;
	env?: Partial<Record<string, string>>;
	log?: (line: string) => void;
}

/**
 * Logs in to each provider in a visible browser with the shared
 * `./browser-data` profile. One provider failing does not stop the other.
 * Returns the providers that logged in. Never logs a token.
 */
export async function runGuidedLogin(
	providers: LoginProvider[],
	{
		openBrowser = () =>
			launchAppBrowser({ headless: false, userDataDir: './browser-data' }),
		soundcloud = loginToSoundcloud,
		spotify = loginToSpotify,
		envPath = '.env',
		env = process.env,
		log = console.log,
	}: GuidedLoginOptions = {},
): Promise<LoginProvider[]> {
	const done: LoginProvider[] = [];
	let browser: Browser;
	try {
		browser = await openBrowser();
	} catch (error) {
		log(`Could not open the login browser: ${errorMessage(error)}`);
		return done;
	}
	try {
		for (const provider of providers) {
			try {
				if (provider === 'soundcloud') {
					await saveSoundcloudSession(await soundcloud(browser), envPath, env);
					log(
						`✓ SoundCloud: saved the login to ${envPath}. Restart a running sc-gate-dl server to use it.`,
					);
				} else {
					await spotify(browser);
					log(`✓ Spotify: saved the login to ${SPOTIFY_COOKIES_FILE}.`);
				}
				done.push(provider);
			} catch (error) {
				log(`${LABELS[provider]} login failed: ${errorMessage(error)}`);
			}
		}
	} finally {
		await browser.close().catch(() => {});
	}
	return done;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface CliLoginOptions {
	/** `--login`: log in to what is broken and offer to redo the rest. */
	force: boolean;
	interactive: boolean;
	checkSoundcloud?: () => Promise<SoundcloudLoginState>;
	checkSpotify?: () => Promise<SpotifyLoginState>;
	login?: (providers: LoginProvider[]) => Promise<unknown>;
	confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
	log?: (line: string) => void;
}

/**
 * CLI start check. A broken SoundCloud login offers the guided login; Spotify
 * is only needed by some gates, so a missing Spotify login is just a warning.
 */
export async function prepareCliLogins({
	force,
	interactive,
	checkSoundcloud = checkSoundcloudLogin,
	checkSpotify = () => checkSpotifyCookies(),
	login = (providers) => runGuidedLogin(providers),
	confirm,
	log = console.log,
}: CliLoginOptions): Promise<void> {
	const check = async () => {
		const [soundcloud, spotify] = await Promise.all([
			checkSoundcloud(),
			checkSpotify(),
		]);
		log(`SoundCloud login: ${soundcloud} | Spotify login: ${spotify}`);
		return { soundcloud, spotify };
	};
	const before = await check();
	const broken = {
		soundcloud:
			before.soundcloud === 'missing' || before.soundcloud === 'invalid',
		spotify: before.spotify !== 'present',
	};
	const ask = (message: string, defaultValue: boolean) =>
		interactive ? confirm(message, defaultValue) : defaultValue;

	const providers: LoginProvider[] = [];
	if (force) {
		for (const provider of ['soundcloud', 'spotify'] as const) {
			if (
				broken[provider] ||
				(await ask(
					`${LABELS[provider]} login: ${before[provider]}. Log in again anyway?`,
					false,
				))
			) {
				providers.push(provider);
			}
		}
	} else if (broken.soundcloud) {
		if (!interactive) {
			log(`SoundCloud login is ${before.soundcloud}. ${LOGIN_HINT}`);
		} else if (
			await ask('Log in to SoundCloud now in a browser window?', true)
		) {
			providers.push('soundcloud');
		}
	}

	if (providers.length > 0) {
		await login(providers);
		const after = await check();
		if (after.spotify !== 'present') {
			log(`Spotify gates need a Spotify login. ${LOGIN_HINT}`);
		}
	} else if (broken.spotify) {
		log(`Spotify gates need a Spotify login. ${LOGIN_HINT}`);
	}
}
