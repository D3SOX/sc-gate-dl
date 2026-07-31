import { launch, launchPersistentContext } from 'cloakbrowser/puppeteer';
import type { Browser } from 'puppeteer';

export type AppBrowserLaunchOptions = {
	headless?: boolean;
	userDataDir?: string;
	args?: string[];
	/** Passed through to Puppeteer via cloakbrowser `launchOptions`. */
	defaultViewport?: { width: number; height: number } | null;
	humanize?: boolean;
};

const DEFAULT_ARGS = [
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--mute-audio',
	'--hide-crash-restore-bubble',
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-restore-session-state',
	'--window-size=1920,1080',
];

/**
 * Launch CloakBrowser (stealth Chromium) for all automation.
 * Optional `CLOAKBROWSER_PROXY` / `PROXY_URL` for residential egress when an IP is hard-blocked.
 * Set `CLOAKBROWSER_GEOIP=true` (requires `bun add mmdb-lib`) to match timezone to the proxy.
 */
export async function launchAppBrowser(
	options: AppBrowserLaunchOptions = {},
): Promise<Browser> {
	process.env.CLOAKBROWSER_SUPPRESS_FONT_WARNING ??= '1';

	const proxy =
		process.env.CLOAKBROWSER_PROXY?.trim() ||
		process.env.PROXY_URL?.trim() ||
		undefined;

	const geoip = Boolean(proxy) && process.env.CLOAKBROWSER_GEOIP === 'true';

	const launchOpts = {
		headless: options.headless ?? true,
		humanize: options.humanize ?? true,
		stealthArgs: true,
		...(proxy ? { proxy, ...(geoip ? { geoip: true } : {}) } : {}),
		args: options.args ?? DEFAULT_ARGS,
		launchOptions: {
			...(options.defaultViewport !== undefined
				? { defaultViewport: options.defaultViewport }
				: {}),
		},
	};

	const browser = options.userDataDir
		? await launchPersistentContext({
				...launchOpts,
				userDataDir: options.userDataDir,
			})
		: await launch(launchOpts);

	return browser as Browser;
}
