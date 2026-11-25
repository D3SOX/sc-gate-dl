import { rm } from 'node:fs/promises';
import type { CookieData } from 'puppeteer';
import { type AccessibleNode, accessibleNodes, atspiAvailable } from './atspi';
import {
	createFirefoxProfile,
	findFirefox,
	stopFirefox,
	writeFirefoxCookies,
} from './firefoxLogin';
import { timeout } from './utils';
import { type Point, X11Input } from './x11Input';

/**
 * Reposts a SoundCloud track in a plain Firefox: no automation protocol and
 * no developer tools, which SoundCloud's bot protection (DataDome) detects.
 * The page is read through the accessibility bus and clicked with X11 input,
 * like a person with a screen reader and a mouse; that includes DataDome's
 * slider when it asks for one. Needs Linux with an X11 display.
 */

const center = (node: AccessibleNode): Point => ({
	x: node.x + node.width / 2,
	y: node.y + node.height / 2,
});

const visible = (node: AccessibleNode) => node.width > 0 && node.height > 0;

export type RepostButton =
	| { state: 'repost'; at: Point }
	| { state: 'reposted' }
	| null;

/** SoundCloud's Repost button; it reads "Unpost / Edit repost" once reposted. */
export function findRepostButton(
	nodes: AccessibleNode[],
	captchaDoc?: number,
): RepostButton {
	const buttons = nodes.filter(
		(node) =>
			node.role === 'button' && visible(node) && node.doc !== captchaDoc,
	);
	if (
		buttons.some((node) =>
			/^(unpost|unrepost)\b|edit repost/i.test(node.name),
		) ||
		// The caption dialog after a repost hides the rest of the page.
		nodes.some(
			(node) => node.role === 'dialog' && /^you reposted\b/i.test(node.name),
		)
	)
		return { state: 'reposted' };
	const repost = buttons.find((node) => /^repost$/i.test(node.name.trim()));
	return repost ? { state: 'repost', at: center(repost) } : null;
}

export interface Captcha {
	doc: number;
	/** The slider's handle and where it has to go. */
	slider?: { from: Point; to: Point };
	retry?: Point;
}

/**
 * DataDome's challenge frame, found by its reload button. Its slider is a
 * handle below the "Slide right" status line, which spans the whole track.
 */
export function findCaptcha(nodes: AccessibleNode[]): Captcha | null {
	const reload = nodes.find(
		(node) =>
			node.role === 'button' && /reload the verification/i.test(node.name),
	);
	if (!reload) return null;
	const own = nodes.filter((node) => node.doc === reload.doc && visible(node));
	const captcha: Captcha = { doc: reload.doc };
	const retry = own.find(
		(node) => node.role === 'button' && /^retry$/i.test(node.name.trim()),
	);
	if (retry) captcha.retry = center(retry);
	const track = own.find((node) => node.role === 'status bar');
	const handle =
		track &&
		own.find(
			(node) =>
				node.role === 'section' &&
				Math.abs(node.x - track.x) <= 2 &&
				node.y >= track.y + track.height - 2 &&
				node.width < track.width / 2,
		);
	if (track && handle) {
		const from = center(handle);
		// The handle has to cover the target box at the end of the track,
		// which reaches a few pixels past the status line.
		captcha.slider = {
			from,
			to: { x: track.x + track.width - handle.width / 2 + 6, y: from.y },
		};
	}
	return captcha;
}

/** SoundCloud turned the browser or network away instead of asking for a slide. */
export class SoundcloudBlockedError extends Error {}

const pref = (name: string, value: string | number | boolean) =>
	`user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`;

/**
 * Firefox settings for the gate browser's proxy (`CLOAKBROWSER_PROXY` or
 * `PROXY_URL`): none without one, null when Firefox cannot use it. Its
 * settings have no place for a proxy login.
 */
export function firefoxProxyPrefs(
	proxy: string | undefined = process.env.CLOAKBROWSER_PROXY?.trim() ||
		process.env.PROXY_URL?.trim() ||
		undefined,
): string[] | null {
	if (!proxy) return [];
	let url: URL;
	try {
		url = new URL(proxy);
	} catch {
		return null;
	}
	if (url.username || url.password || !url.hostname || !url.port) return null;
	const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
	const port = Number(url.port);
	const socks = /^socks(4|5)h?:$/.exec(url.protocol);
	if (socks) {
		return [
			pref('network.proxy.type', 1),
			pref('network.proxy.socks', host),
			pref('network.proxy.socks_port', port),
			pref('network.proxy.socks_version', Number(socks[1])),
			pref('network.proxy.socks_remote_dns', true),
		];
	}
	if (url.protocol === 'http:') {
		return [
			pref('network.proxy.type', 1),
			pref('network.proxy.http', host),
			pref('network.proxy.http_port', port),
			pref('network.proxy.ssl', host),
			pref('network.proxy.ssl_port', port),
		];
	}
	return null;
}

/**
 * The Firefox to repost with, or null when this machine cannot: it needs
 * AT-SPI, an X11 session (XTest does not reach Wayland windows) and a proxy
 * setting Firefox can take over.
 */
export function firefoxRepostAvailable(): string | null {
	const firefox = findFirefox();
	if (!firefox || !atspiAvailable() || process.env.WAYLAND_DISPLAY) return null;
	if (!firefoxProxyPrefs()) return null;
	const input = X11Input.open();
	if (!input) return null;
	input.close();
	return firefox;
}

export interface FirefoxRepostOptions {
	/** SoundCloud's own answer, when the API is set up. */
	isReposted?: () => Promise<boolean>;
	log?: (line: string) => void;
	timeoutMs?: number;
}

/**
 * Opens `trackUrl` in a fresh Firefox signed in with `cookies` (SoundCloud's
 * session, without DataDome's cookie of another browser), reposts it and
 * closes Firefox again.
 */
export async function repostInFirefox(
	firefox: string,
	trackUrl: string,
	cookies: CookieData[],
	{
		isReposted = async () => false,
		log = console.log,
		timeoutMs = 4 * 60_000,
	}: FirefoxRepostOptions = {},
): Promise<void> {
	const input = X11Input.open();
	if (!input) throw new Error('No X11 display to click in Firefox.');
	const proxyPrefs = firefoxProxyPrefs();
	if (!proxyPrefs) throw new Error('Firefox cannot use the configured proxy.');
	const profile = await createFirefoxProfile(undefined, proxyPrefs);
	let firefoxProcess: ReturnType<typeof Bun.spawn> | null = null;
	try {
		await writeFirefoxCookies(firefox, profile, cookies);
		firefoxProcess = Bun.spawn(
			[
				firefox,
				'--new-instance',
				'--no-remote',
				'--profile',
				profile,
				'--width',
				'1440',
				'--height',
				'900',
				trackUrl,
			],
			{
				// Firefox only joins the accessibility bus when asked to.
				env: { ...process.env, GNOME_ACCESSIBILITY: '1' },
				stdin: 'ignore',
				stdout: 'ignore',
				stderr: 'ignore',
			},
		);
		const pid = firefoxProcess.pid;
		const running = () => firefoxProcess?.exitCode === null;
		const deadline = Date.now() + timeoutMs;

		// DataDome can also challenge the page load, before the button shows.
		let ready = false;
		let clicks = 0;
		let lastClick = 0;
		let lastApiCheck = Date.now();
		let repostedSince = 0;
		let captchaSince = 0;
		while (running() && Date.now() < deadline) {
			const nodes = accessibleNodes(pid);
			const captcha = findCaptcha(nodes);
			if (captcha) {
				repostedSince = 0;
				captchaSince ||= Date.now();
				if (captcha.retry) {
					log('Firefox: DataDome wants another try.');
					await input.click(captcha.retry);
					await timeout(3_000);
				} else if (captcha.slider) {
					log("Firefox: sliding DataDome's slider...");
					await input.drag(captcha.slider.from, captcha.slider.to);
					await timeout(4_000);
				} else if (Date.now() - captchaSince > 30_000) {
					throw new SoundcloudBlockedError(
						'SoundCloud blocked this browser or network ("You have been blocked"), so the repost was not saved. Wait a while or use another network, then retry.',
					);
				}
				await timeout(1_000);
				continue;
			}
			captchaSince = 0;

			const current = findRepostButton(nodes);
			if (!ready) {
				if (!current) {
					await timeout(1_000);
					continue;
				}
				if (
					current.state === 'reposted' ||
					(await isReposted().catch(() => false))
				) {
					log('Firefox: the track is already reposted.');
					return;
				}
				// A repost clicked the moment the page loads looks automated; stay
				// on the track a few seconds first, like a listener.
				await timeout(4_000 + Math.random() * 4_000);
				ready = true;
				lastApiCheck = Date.now();
				continue;
			}
			if (current?.state === 'reposted') {
				// The button flips before SoundCloud answers; a rejected repost
				// brings up the challenge within a few seconds.
				repostedSince ||= Date.now();
				if (Date.now() - repostedSince >= 6_000) {
					log('Firefox: SoundCloud repost saved.');
					return;
				}
			} else if (current?.state === 'repost') {
				repostedSince = 0;
				if (clicks < 3 && Date.now() - lastClick > 10_000) {
					await input.click(current.at);
					clicks++;
					lastClick = Date.now();
					log('Firefox: clicked Repost.');
				}
			}
			if (Date.now() - lastApiCheck > 10_000) {
				lastApiCheck = Date.now();
				if (await isReposted().catch(() => false)) {
					log('Firefox: SoundCloud repost saved.');
					return;
				}
			}
			await timeout(1_000);
		}
		throw new Error(
			!running()
				? 'Firefox closed before the repost finished.'
				: ready
					? 'Timed out reposting the track in Firefox.'
					: 'The SoundCloud track never showed its Repost button in Firefox.',
		);
	} finally {
		input.close();
		if (firefoxProcess) await stopFirefox(firefoxProcess);
		await rm(profile, { recursive: true, force: true });
	}
}
