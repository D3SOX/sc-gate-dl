import type { Cookie } from 'puppeteer';
import type { AccessState } from './accessCheck';
import { checkSpotifyCookies } from './accessSetup';
import { launchAppBrowser } from './browserLaunch';
import { setEnvValues } from './envFile';
import { timeout, writeBrowserCookies } from './utils';

export type LoginProvider = 'soundcloud' | 'spotify';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const SOUNDCLOUD_HOST_RE = /(^|\.)soundcloud\.com$/i;
const SPOTIFY_HOST_RE = /(^|\.)spotify\.com$/i;
const hostOf = (cookie: Cookie) => cookie.domain.replace(/^\./, '');

/** What a SoundCloud web login yields: the values `.env` needs. */
export interface SoundcloudSession {
	clientId: string;
	refreshToken: string;
}

/** The web client id is only seen in request URLs; the refresh token is a cookie. */
export function clientIdFromUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!SOUNDCLOUD_HOST_RE.test(parsed.hostname)) return null;
		return parsed.searchParams.get('client_id') || null;
	} catch {
		return null;
	}
}

function safeDecode(value: string): string {
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
	const refresh = cookies.find(
		(cookie) =>
			cookie.name === 'oauth_refresh_token' &&
			SOUNDCLOUD_HOST_RE.test(hostOf(cookie)),
	)?.value;
	return clientId && refresh
		? { clientId, refreshToken: safeDecode(refresh) }
		: null;
}

/** `sp_dc` is Spotify's long-lived login cookie; it only exists after a login. */
export function pickSpotifyCookies(cookies: Cookie[]): Cookie[] | null {
	const own = cookies.filter((cookie) => SPOTIFY_HOST_RE.test(hostOf(cookie)));
	return own.some((cookie) => cookie.name === 'sp_dc') ? own : null;
}

async function waitFor<T>(poll: () => Promise<T | null>): Promise<T> {
	const deadline = Date.now() + LOGIN_TIMEOUT_MS;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await poll();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await timeout(1000);
	}
	throw new Error(
		`Timed out waiting for the login in the browser${lastError instanceof Error ? ` (last error: ${lastError.message})` : ''}.`,
	);
}

/** Opens a visible browser (the shared browser-data profile) for one login. */
async function withLoginBrowser<T>(
	run: (browser: Awaited<ReturnType<typeof launchAppBrowser>>) => Promise<T>,
): Promise<T> {
	const browser = await launchAppBrowser({
		headless: false,
		userDataDir: './browser-data',
	});
	try {
		return await run(browser);
	} finally {
		await browser.close().catch(() => {});
	}
}

/** Visible browser login; the client id is read from the page's own API requests. */
export function browserSoundcloudLogin(): Promise<SoundcloudSession> {
	return withLoginBrowser(async (browser) => {
		const page = await browser.newPage();
		let clientId: string | null = null;
		page.on('request', (request) => {
			clientId = clientIdFromUrl(request.url()) ?? clientId;
		});
		await page.goto('https://soundcloud.com/');
		const context = browser.defaultBrowserContext();
		const session = await waitFor(async () =>
			pickSoundcloudSession(await context.cookies(), clientId),
		);
		const cookies = (await context.cookies()).filter((cookie) =>
			SOUNDCLOUD_HOST_RE.test(hostOf(cookie)),
		);
		await writeBrowserCookies(cookies);
		return session;
	});
}

/** Visible browser login; saves the Spotify cookies once `sp_dc` exists. */
export function browserSpotifyLogin(): Promise<void> {
	return withLoginBrowser(async (browser) => {
		const page = await browser.newPage();
		await page.goto('https://accounts.spotify.com/login');
		const context = browser.defaultBrowserContext();
		await waitFor(async () => pickSpotifyCookies(await context.cookies()));
		// Let the account page set its remaining cookies before they are saved.
		await page.goto('https://accounts.spotify.com/account/overview');
		await timeout(3000);
		const cookies = pickSpotifyCookies(await context.cookies());
		if (!cookies) throw new Error('Spotify login was lost before saving.');
		await writeBrowserCookies(cookies, 'spotify-cookies.json');
	});
}

export interface GuidedLoginInput {
	providers: LoginProvider[];
	env: Partial<Record<string, string>>;
	envPath: string;
	log: (line: string) => void;
	soundcloudLogin: () => Promise<SoundcloudSession>;
	spotifyLogin: () => Promise<void>;
	/** Renews the new refresh token into an access token and saves the pair. */
	checkSoundcloud: (
		log: (line: string) => void,
	) => Promise<{ state: AccessState }>;
	checkSpotify?: () => ReturnType<typeof checkSpotifyCookies>;
}

/**
 * Walk the user through the logins that need it. One provider failing never
 * stops the other, and no token value is ever logged.
 */
export async function runGuidedLogins(input: GuidedLoginInput): Promise<void> {
	const { log } = input;
	for (const provider of input.providers) {
		try {
			if (provider === 'soundcloud') {
				log('SoundCloud: log in in the browser window that just opened...');
				const session = await input.soundcloudLogin();
				const values = {
					SC_CLIENT_ID: session.clientId,
					SC_REFRESH_TOKEN: session.refreshToken,
				};
				await setEnvValues(input.envPath, values);
				// The running process reads these; the old access token is blanked in
				// memory only, so the check renews it and a failed renewal keeps the
				// token stored in .env.
				Object.assign(input.env, values, { SC_OAUTH_TOKEN: '' });
				const result = await input.checkSoundcloud(log);
				log(
					result.state === 'valid'
						? 'SoundCloud: login saved to .env.'
						: `SoundCloud: login captured but the check says "${result.state}".`,
				);
			} else {
				log('Spotify: log in in the browser window that just opened...');
				await input.spotifyLogin();
				const status = await (input.checkSpotify ?? checkSpotifyCookies)();
				log(
					status.state === 'present'
						? 'Spotify: login saved to spotify-cookies.json.'
						: 'Spotify: login was not saved.',
				);
			}
		} catch (error) {
			log(
				`${provider === 'soundcloud' ? 'SoundCloud' : 'Spotify'}: guided login failed (${error instanceof Error ? error.message : 'unknown error'}).`,
			);
		}
	}
}
