import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Cookie, CookieData, Page, Target } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { setEnvValues } from './envFile';
import {
	fetchSoundcloudClientId,
	findFirefox,
	firefoxDisabled,
} from './firefoxLogin';
import {
	hasSoundcloudLogin,
	SoundcloudClient,
	type SoundcloudLoginState,
} from './soundcloud';
import {
	FIREFOX_MISSING_WARNING,
	pickSoundcloudSignInCookies,
	signInToSoundcloud,
	signInToSoundcloudInFirefox,
	soundcloudBlockHint,
} from './soundcloudLogin';
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
/** Enough of a cookie for these checks; Puppeteer and Firefox cookies fit. */
type CookieLike = Pick<Cookie, 'name' | 'value'> & { domain?: string };
const isCookieOf = (host: RegExp) => (cookie: CookieLike) =>
	host.test((cookie.domain ?? '').replace(/^\./, ''));

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

function pickSoundcloudTokens(
	cookies: CookieLike[],
): Omit<SoundcloudSession, 'clientId'> | null {
	const own = cookies.filter(isCookieOf(SOUNDCLOUD_HOST_RE));
	const value = (name: string) =>
		own.find((cookie) => cookie.name === name && cookie.value)?.value;
	const refreshToken = value('oauth_refresh_token');
	const accessToken = value('oauth_token');
	return refreshToken
		? {
				refreshToken: decodeCookie(refreshToken),
				accessToken: accessToken ? decodeCookie(accessToken) : null,
			}
		: null;
}

export function pickSoundcloudSession(
	cookies: CookieLike[],
	clientId: string | null,
): SoundcloudSession | null {
	const tokens = pickSoundcloudTokens(cookies);
	return clientId && tokens ? { clientId, ...tokens } : null;
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
	/** A null client id is read from the gate browser's requests later. */
	session: Omit<SoundcloudSession, 'clientId'> & { clientId: string | null };
	/** See `pickSoundcloudSignInCookies`. */
	signInCookies: CookieData[];
}

export interface ApiLoginOptions {
	firefox?: () => string | null;
	withFirefox?: (firefox: string) => Promise<CapturedSoundcloudLogin>;
	withCloakBrowser?: () => Promise<CapturedSoundcloudLogin>;
	log?: (line: string) => void;
}

/**
 * The API login, in Firefox when it is installed and in CloakBrowser
 * otherwise. Either way the profile is thrown away afterwards, so no browser
 * keeps using the refresh token: SoundCloud rotates it on every renewal, and
 * two users of one token log each other out.
 */
export async function captureSoundcloudApiLogin({
	firefox = findFirefox,
	withFirefox = captureWithFirefox,
	withCloakBrowser = captureWithCloakBrowser,
	log = console.log,
}: ApiLoginOptions = {}): Promise<CapturedSoundcloudLogin> {
	const path = firefox();
	if (path) return withFirefox(path);
	if (!firefoxDisabled()) log(FIREFOX_MISSING_WARNING);
	return withCloakBrowser();
}

/** A sign-in in the user's own Firefox, which DataDome treats as a visitor. */
export async function captureWithFirefox(
	firefox: string,
	signIn: (
		firefox: string,
	) => Promise<CookieData[]> = signInToSoundcloudInFirefox,
	clientIdLookup: () => Promise<string> = fetchSoundcloudClientId,
	log: (line: string) => void = console.log,
): Promise<CapturedSoundcloudLogin> {
	log('This first sign-in is the login for the API.');
	// Looked up meanwhile; a failure must not cost the sign-in.
	const clientId = clientIdLookup().catch(() => null);
	const cookies = await signIn(firefox);
	const tokens = pickSoundcloudTokens(cookies);
	if (!tokens) throw new Error('The SoundCloud login was lost before saving.');
	const session = { ...tokens, clientId: await clientId };
	if (!session.clientId) {
		log(
			"Could not read SoundCloud's client id from soundcloud.com; it is taken from the gate browser's sign-in instead.",
		);
	}
	return { session, signInCookies: pickSoundcloudSignInCookies(cookies) };
}

/** The API login in a throwaway CloakBrowser profile, when Firefox is missing. */
export async function captureWithCloakBrowser(
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
 * sign-in window closed, so only one window waits for the user at a time.
 */
export async function loginToSoundcloud(
	gateBrowser: () => Promise<Browser>,
	captureApiLogin: () => Promise<CapturedSoundcloudLogin> = captureSoundcloudApiLogin,
	signIn: (
		browser: Browser,
		options: { signInCookies: CookieData[] },
	) => Promise<void> = signInToSoundcloud,
): Promise<SoundcloudSession> {
	const { session, signInCookies } = await captureApiLogin();
	console.log('Now the gate browser takes over that SoundCloud session...');
	const browser = await gateBrowser();
	// The gate browser's SoundCloud requests carry the web client id too.
	let seenClientId: string | null = null;
	const watch = (page: Page | null) =>
		page?.on('request', (request) => {
			seenClientId ??= clientIdFromUrl(request.url());
		});
	const onTarget = (target: Target) => {
		target
			.page()
			.then(watch)
			.catch(() => {});
	};
	const needClientId = !session.clientId;
	if (needClientId) browser.on('targetcreated', onTarget);
	try {
		await signIn(browser, { signInCookies });
	} finally {
		if (needClientId) browser.off('targetcreated', onTarget);
	}
	const clientId = session.clientId ?? seenClientId;
	if (!clientId) {
		throw new Error(
			'Could not read the SoundCloud client id. Run `bun start --login` again.',
		);
	}
	return { ...session, clientId };
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
 * Returns the SoundCloud login state after any login.
 */
export async function prepareCliLogins({
	force,
	interactive,
	checkSoundcloud = checkSoundcloudLogin,
	checkSpotify = () => checkSpotifyCookies(),
	login = (providers) => runGuidedLogin(providers),
	confirm,
	log = console.log,
}: CliLoginOptions): Promise<SoundcloudLoginState> {
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
		return after.soundcloud;
	}
	if (broken.spotify) {
		log(`Spotify gates need a Spotify login. ${LOGIN_HINT}`);
	}
	return before.soundcloud;
}
