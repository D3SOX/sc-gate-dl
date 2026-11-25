import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Cookie, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { setEnvValues } from './envFile';
import {
	hasSoundcloudLogin,
	SoundcloudClient,
	type SoundcloudLoginState,
} from './soundcloud';
import { signInToSoundcloud, soundcloudBlockHint } from './soundcloudLogin';
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
			cookies as { name?: unknown; value?: unknown; expirationDate?: unknown }[]
		).find(
			(cookie) =>
				cookie?.name === 'sp_dc' &&
				typeof cookie.value === 'string' &&
				cookie.value !== '',
		);
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

/**
 * The sign-in session of a SoundCloud login, without its tokens. Another
 * browser holding it gets its own tokens without a second sign-in. DataDome's
 * cookie belongs to the browser it was issued to, so it stays behind too.
 */
export function pickSoundcloudSignInCookies(cookies: Cookie[]): Cookie[] {
	const keep = new Set(['oauth_token', 'oauth_refresh_token', 'datadome']);
	return cookies.filter(
		(cookie) =>
			isCookieOf(SOUNDCLOUD_HOST_RE)(cookie) && !keep.has(cookie.name),
	);
}

/** `sp_dc` is Spotify's long-lived login cookie; it only exists after a login. */
export function pickSpotifyCookies(cookies: Cookie[]): Cookie[] | null {
	const own = cookies.filter(isCookieOf(SPOTIFY_HOST_RE));
	return own.some((cookie) => cookie.name === 'sp_dc' && cookie.value !== '')
		? own
		: null;
}

/** A closed login window never finishes its login, so stop waiting. */
function throwIfWindowClosed(page: Page, what: string): void {
	if (page.isClosed() || !page.browser().connected) {
		throw new Error(`The browser window closed before ${what} finished.`);
	}
}

async function waitFor<T>(
	page: Page,
	what: string,
	poll: () => Promise<T | null>,
	timeoutMs: number,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		throwIfWindowClosed(page, what);
		const value = await poll().catch(() => null);
		if (value) return value;
		await timeout(1_000);
	}
	throw new Error(`Timed out waiting for ${what}.`);
}

export interface CapturedSoundcloudLogin {
	session: SoundcloudSession;
	/** See `pickSoundcloudSignInCookies`. */
	signInCookies: Cookie[];
}

/**
 * Signs in to SoundCloud in a throwaway browser profile and reads the API
 * login from it. The profile is deleted afterwards, so no browser keeps using
 * the refresh token: SoundCloud rotates it on every renewal, and two users of
 * one token log each other out.
 */
export async function captureSoundcloudApiLogin(
	openBrowser: (userDataDir: string) => Promise<Browser> = (userDataDir) =>
		launchAppBrowser({ headless: false, userDataDir }),
): Promise<CapturedSoundcloudLogin> {
	const profile = await mkdtemp(join(tmpdir(), 'sc-gate-dl-login-'));
	try {
		const browser = await openBrowser(profile);
		try {
			const page = await browser.newPage();
			let clientId: string | null = null;
			page.on('request', (request) => {
				clientId ??= clientIdFromUrl(request.url());
			});
			await page.goto('https://soundcloud.com/signin', {
				waitUntil: 'domcontentloaded',
			});
			console.log(
				'Sign in to SoundCloud in the new browser window (login for the API)...',
			);
			const context = browser.defaultBrowserContext();
			const deadline = Date.now() + 10 * 60_000;
			const hintIfBlocked = soundcloudBlockHint(page);
			for (;;) {
				throwIfWindowClosed(page, 'the SoundCloud sign-in');
				await hintIfBlocked();
				const cookies = await context.cookies().catch(() => []);
				const signedIn = cookies.some(
					(cookie) =>
						cookie.name === 'oauth_refresh_token' &&
						cookie.value !== '' &&
						isCookieOf(SOUNDCLOUD_HOST_RE)(cookie),
				);
				if (signedIn) break;
				if (Date.now() > deadline) {
					throw new Error('Timed out waiting for SoundCloud sign-in.');
				}
				await timeout(1_000);
			}
			// The web client id only shows up in the requests of a loaded page.
			if (!clientId) {
				await page
					.goto('https://soundcloud.com/you/library', {
						waitUntil: 'domcontentloaded',
					})
					.catch(() => {});
			}
			const session = await waitFor(
				page,
				'the SoundCloud client id',
				async () => pickSoundcloudSession(await context.cookies(), clientId),
				60_000,
			);
			return {
				session,
				signInCookies: pickSoundcloudSignInCookies(await context.cookies()),
			};
		} finally {
			await browser.close().catch(() => {});
		}
	} finally {
		await rm(profile, { recursive: true, force: true });
	}
}

/**
 * The API login comes from a throwaway profile. The gate browser then signs
 * in like Initialize logins (which saves soundcloud-cookies.json), reusing the
 * sign-in session so it gets its own tokens without asking again; each keeps
 * its own refresh-token chain. The gate browser opens only after the
 * throwaway one closed: CloakBrowser's free tier kills a second browser
 * running at the same time.
 */
export async function loginToSoundcloud(
	gateBrowser: () => Promise<Browser>,
	captureApiLogin: () => Promise<CapturedSoundcloudLogin> = captureSoundcloudApiLogin,
	signIn: (browser: Browser) => Promise<void> = signInToSoundcloud,
): Promise<SoundcloudSession> {
	const { session, signInCookies } = await captureApiLogin();
	const browser = await gateBrowser();
	if (signInCookies.length > 0) {
		await browser.defaultBrowserContext().setCookie(...signInCookies);
	}
	console.log(
		'Signing in the gate browser with the same SoundCloud session (sign in again only if it asks)...',
	);
	await signIn(browser);
	return session;
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
			page,
			'the Spotify sign-in',
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
	soundcloud?: (
		gateBrowser: () => Promise<Browser>,
	) => Promise<SoundcloudSession>;
	spotify?: (browser: Browser) => Promise<void>;
	envPath?: string;
	env?: Partial<Record<string, string>>;
	log?: (line: string) => void;
}

/**
 * Logs in to each provider in a visible browser with the shared
 * `./browser-data` profile, opened when a provider first needs it. One
 * provider failing does not stop the other. Returns the providers that logged
 * in. Never logs a token.
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
	// Assigned in gateBrowser, so keep TypeScript from narrowing it to null.
	let browser = null as Promise<Browser> | null;
	const gateBrowser = () => {
		browser ??= openBrowser();
		return browser;
	};
	try {
		for (const provider of providers) {
			try {
				if (provider === 'soundcloud') {
					await saveSoundcloudSession(
						await soundcloud(gateBrowser),
						envPath,
						env,
					);
					log(
						`✓ SoundCloud: saved the login to ${envPath}. Restart a running sc-gate-dl server to use it.`,
					);
				} else {
					await spotify(await gateBrowser());
					log(`✓ Spotify: saved the login to ${SPOTIFY_COOKIES_FILE}.`);
				}
				done.push(provider);
			} catch (error) {
				log(`${LABELS[provider]} login failed: ${errorMessage(error)}`);
			}
		}
	} finally {
		await browser?.then((opened) => opened.close()).catch(() => {});
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
