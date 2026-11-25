import type { Browser, BrowserContext, CookieData, Page } from 'puppeteer';
import {
	findFirefox,
	firefoxDisabled,
	signInWithFirefox,
} from './firefoxLogin';
import Selectors from './selectors';
import { timeout, writeBrowserCookies } from './utils';

const SOUNDCLOUD_HOST_RE = /(^|\.)soundcloud\.com$/i;
// SoundCloud has used both orders.
export const LOGIN_COPY_RE =
	/sign in or create an account|create an account or sign in/i;

export const FIREFOX_MISSING_WARNING =
	"⚠ Firefox was not found, so the SoundCloud sign-in happens in CloakBrowser instead. SoundCloud's bot protection (DataDome) blocks CloakBrowser more often; install Firefox (or point SC_GATE_DL_FIREFOX at it) for a more reliable sign-in.";

/** Enough of a cookie for these checks; Puppeteer and Firefox cookies fit. */
type CookieLike = { name: string; value: string; domain?: string };
const isSoundcloudCookie = (cookie: CookieLike) =>
	SOUNDCLOUD_HOST_RE.test((cookie.domain ?? '').replace(/^\./, ''));

export function hasSoundcloudRefreshToken(cookies: CookieLike[]): boolean {
	return cookies.some(
		(cookie) =>
			cookie.name === 'oauth_refresh_token' &&
			cookie.value !== '' &&
			isSoundcloudCookie(cookie),
	);
}

/**
 * The sign-in session of a SoundCloud login, without its tokens. Another
 * browser holding it gets its own tokens without a second sign-in. DataDome's
 * cookie belongs to the browser it was issued to, so it stays behind too.
 */
export function pickSoundcloudSignInCookies<T extends CookieLike>(
	cookies: T[],
): T[] {
	const keep = new Set(['oauth_token', 'oauth_refresh_token', 'datadome']);
	return cookies.filter(
		(cookie) => isSoundcloudCookie(cookie) && !keep.has(cookie.name),
	);
}

/**
 * Signs in to SoundCloud in a fresh Firefox, which SoundCloud's bot
 * protection treats as an ordinary visitor, and returns its cookies.
 */
export async function signInToSoundcloudInFirefox(
	firefox: string,
	signIn: typeof signInWithFirefox = signInWithFirefox,
	log: (line: string) => void = console.log,
): Promise<CookieData[]> {
	log(
		'Sign in to SoundCloud in the Firefox window that opens. If SoundCloud says "You have been blocked", reload the page.',
	);
	const { result, cookies } = await signIn(firefox, {
		url: 'https://soundcloud.com/signin',
		what: 'the SoundCloud sign-in',
		done: (cookies) => (hasSoundcloudRefreshToken(cookies) ? cookies : null),
	});
	// The read after closing Firefox is the most complete one.
	return hasSoundcloudRefreshToken(cookies) ? cookies : result;
}

export interface FirefoxSignInOptions {
	/** Defaults to `findFirefox`. */
	firefox?: () => string | null;
	firefoxSignIn?: (firefox: string) => Promise<CookieData[]>;
	log?: (line: string) => void;
}

/**
 * The SoundCloud sign-in session from a Firefox sign-in. Null without Firefox
 * or when that sign-in fails; the caller's browser window remains as the way
 * to sign in.
 */
async function sessionFromFirefox({
	firefox = findFirefox,
	firefoxSignIn,
	log = console.log,
}: FirefoxSignInOptions): Promise<CookieData[] | null> {
	const path = firefox();
	if (!path) {
		if (!firefoxDisabled()) log(FIREFOX_MISSING_WARNING);
		return null;
	}
	try {
		const cookies = await (
			firefoxSignIn ??
			((path: string) =>
				signInToSoundcloudInFirefox(path, signInWithFirefox, log))
		)(path);
		return pickSoundcloudSignInCookies(cookies);
	} catch (error) {
		log(
			`The Firefox sign-in did not finish (${error instanceof Error ? error.message : String(error)}). Sign in in the browser window instead.`,
		);
		return null;
	}
}

function isSoundcloudHost(pageUrl: string): boolean {
	try {
		return SOUNDCLOUD_HOST_RE.test(new URL(pageUrl).hostname);
	} catch {
		return false;
	}
}

export function isSoundcloudLoginDocument(
	pageUrl: string,
	text: string,
	hasApproval: boolean,
): boolean {
	return isSoundcloudHost(pageUrl) && LOGIN_COPY_RE.test(text) && !hasApproval;
}

/** DataDome shows a hard block (`t=bv`) in its captcha frame, not in the page text. */
function isDatadomeBlockFrame(frameUrl: string): boolean {
	try {
		const url = new URL(frameUrl);
		return (
			url.hostname === 'geo.captcha-delivery.com' &&
			url.searchParams.get('t') === 'bv'
		);
	} catch {
		return false;
	}
}

export function isSoundcloudBlocked(
	pageUrl: string,
	text: string,
	frameUrls: string[] = [],
): boolean {
	return (
		isSoundcloudHost(pageUrl) &&
		(/\byou have been blocked\b/i.test(text) ||
			frameUrls.some(isDatadomeBlockFrame))
	);
}

/** SoundCloud's block page never turns into a login, so stop instead of waiting. */
export function throwIfSoundcloudBlocked(
	pageUrl: string,
	text: string,
	frameUrls: string[] = [],
): void {
	if (isSoundcloudBlocked(pageUrl, text, frameUrls)) {
		throw new Error(
			'SoundCloud blocked this browser or network. Resolve the block with SoundCloud (or use another network) before retrying.',
		);
	}
}

export async function isSoundcloudPageBlocked(page: Page): Promise<boolean> {
	const text = await page
		.evaluate(() => document.body?.innerText || '')
		.catch(() => '');
	return isSoundcloudBlocked(
		page.url(),
		text,
		page.frames().map((frame) => frame.url()),
	);
}

/**
 * For a sign-in someone is doing in the window: a block can clear when the
 * page is reloaded, so say that once per block and keep waiting.
 */
export function soundcloudBlockHint(
	page: Page,
	log: (line: string) => void = console.log,
): () => Promise<void> {
	let shown = false;
	return async () => {
		const blocked = await isSoundcloudPageBlocked(page);
		if (blocked && !shown) {
			log(
				'SoundCloud blocked the sign-in. Reload the page in the browser window to try again.',
			);
		}
		shown = blocked;
	};
}

export async function isSoundcloudLoginPage(page: Page): Promise<boolean> {
	if (page.isClosed()) return false;
	const documentState = await page
		.evaluate(() => ({
			text: document.body?.innerText || '',
			hasApproval:
				!!document.querySelector('button#submit_approval') ||
				!!document.querySelector('button[name="accept"]') ||
				Array.from(document.querySelectorAll('button')).some((button) =>
					/^(allow|accept|connect|authorize)$/i.test(
						(button.textContent || '').trim(),
					),
				),
		}))
		.catch(() => null);
	// The block frame shows even when the page itself cannot be read.
	throwIfSoundcloudBlocked(
		page.url(),
		documentState?.text ?? '',
		page.frames().map((frame) => frame.url()),
	);
	return documentState
		? isSoundcloudLoginDocument(
				page.url(),
				documentState.text,
				documentState.hasApproval,
			)
		: false;
}

type SoundcloudLoginWaitOptions = FirefoxSignInOptions & {
	interactive: boolean;
	onWaiting: () => void;
	timeoutMs?: number;
};

export async function saveSoundcloudLogin(
	context: BrowserContext,
): Promise<void> {
	const cookies = (await context.cookies()).filter((cookie) =>
		SOUNDCLOUD_HOST_RE.test(cookie.domain.replace(/^\./, '')),
	);
	if (cookies.length > 0) await writeBrowserCookies(cookies);
}

/** Wait for a user to finish a SoundCloud login in a visible browser. */
export async function waitForSoundcloudLogin(
	page: Page,
	options: SoundcloudLoginWaitOptions,
): Promise<boolean> {
	if (!(await isSoundcloudLoginPage(page))) return false;
	if (!options.interactive) {
		throw new Error(
			'SoundCloud is not logged in. Use visible headed mode or run Initialize Logins first.',
		);
	}

	const context = page.browserContext();
	options.onWaiting();
	// Sign in in Firefox and hand the session to this page; its own window
	// stays usable when that does not work out.
	const session = await sessionFromFirefox(options);
	if (session && session.length > 0) {
		await context.setCookie(...session);
		await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
	}
	await page.bringToFront().catch(() => {});
	const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
	while (Date.now() < deadline) {
		if (page.isClosed() || !(await isSoundcloudLoginPage(page))) {
			await saveSoundcloudLogin(context);
			return true;
		}
		await timeout(500);
	}

	throw new Error('Timed out waiting for SoundCloud login in the browser.');
}

async function hasSoundcloudSession(context: BrowserContext): Promise<boolean> {
	return (await context.cookies()).some(
		(cookie) =>
			cookie.name === 'oauth_token' &&
			cookie.value !== '' &&
			SOUNDCLOUD_HOST_RE.test(cookie.domain.replace(/^\./, '')),
	);
}

/**
 * Initialize Logins: signs the browser in to SoundCloud and saves the cookies.
 *
 * Gates authorize through secure.soundcloud.com, which keeps its own session.
 * An old `oauth_token` cookie still makes soundcloud.com look logged in when
 * that session is gone, so drop it and start from SoundCloud's sign-in page.
 * The sign-in happens in Firefox when it is available, and the browser takes
 * over its session, which continues on its own; otherwise the user signs in
 * in the browser window.
 */
export async function signInToSoundcloud(
	browser: Browser,
	options: FirefoxSignInOptions & {
		solveCaptcha?: (page: Page) => Promise<void>;
		timeoutMs?: number;
		/** A session from an earlier sign-in; skips the Firefox sign-in. */
		signInCookies?: CookieData[];
	} = {},
): Promise<void> {
	const log = options.log ?? console.log;
	const session =
		options.signInCookies ?? (await sessionFromFirefox(options)) ?? [];
	const context = browser.defaultBrowserContext();
	const staleSession = (await context.cookies()).filter(
		(cookie) =>
			cookie.name === 'oauth_token' &&
			SOUNDCLOUD_HOST_RE.test(cookie.domain.replace(/^\./, '')),
	);
	if (staleSession.length > 0) await context.deleteCookie(...staleSession);
	if (session.length > 0) await context.setCookie(...session);

	const page = await browser.newPage();
	try {
		await page.setViewport({ width: 1920, height: 1080 });
		await page.goto('https://soundcloud.com/signin', {
			waitUntil: 'domcontentloaded',
		});
		const captcha = await page
			.waitForSelector(Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER, {
				timeout: 5_000,
			})
			.catch(() => null);
		if (captcha) {
			log(
				'SoundCloud captcha present during login; solve it in the browser window if needed.',
			);
			await options.solveCaptcha?.(page);
		}

		// The page header links the library even when logged out, so wait for
		// the session cookie that sign-in sets instead.
		log(
			session.length > 0
				? 'Waiting for SoundCloud to sign in the browser with that session (sign in there only if it asks)...'
				: 'Sign in to SoundCloud in the browser window...',
		);
		const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
		const hintIfBlocked = soundcloudBlockHint(page, log);
		while (!(await hasSoundcloudSession(context))) {
			if (Date.now() > deadline) {
				throw new Error('Timed out waiting for SoundCloud sign-in.');
			}
			await hintIfBlocked();
			await timeout(1_000);
		}
		await page.goto('https://soundcloud.com/you/library', {
			waitUntil: 'domcontentloaded',
		});
		await saveSoundcloudLogin(context);
	} finally {
		await page.close().catch(() => {});
	}
}
