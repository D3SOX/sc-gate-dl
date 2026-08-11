import { launch, launchPersistentContext } from 'cloakbrowser/puppeteer';
import type { Browser } from 'puppeteer';
import type { BrowserMode, HypedditConfig } from './types';

export type AppBrowserLaunchOptions = {
	headless?: boolean;
	/** Run headed Chromium inside an invisible Xvfb display. */
	xvfb?: boolean;
	userDataDir?: string;
	/** Extra Chromium/CloakBrowser flags merged onto the defaults. */
	args?: string[];
	/** Passed through to Puppeteer via cloakbrowser `launchOptions`. */
	defaultViewport?: { width: number; height: number } | null;
	humanize?: boolean;
};

export type XvfbProcess = {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill: () => void;
};

export type XvfbSession = {
	display: string;
	process: XvfbProcess;
	users: number;
};

export const DEFAULT_BROWSER_ARGS = [
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--mute-audio',
	'--hide-crash-restore-bubble',
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-restore-session-state',
	'--window-size=1920,1080',
];

export function getGpuWorkaroundArgs(
	env: Record<string, string | undefined> = process.env,
): string[] {
	const enabled = (value: string | undefined) =>
		value?.trim().toLowerCase() === 'true' || value?.trim() === '1';
	const args: string[] = [];
	if (enabled(env.SC_GATE_DL_DISABLE_GPU)) args.push('--disable-gpu');
	if (enabled(env.SC_GATE_DL_DISABLE_DEV_SHM)) {
		args.push('--disable-dev-shm-usage');
	}
	return args;
}

export function browserModeToLaunchOptions(
	browserMode: BrowserMode,
): Pick<AppBrowserLaunchOptions, 'headless' | 'xvfb'> {
	return {
		headless: browserMode === 'headless',
		xvfb: browserMode === 'xvfb',
	};
}

export function isXvfbSupported(platform = process.platform): boolean {
	return platform === 'linux';
}

export function launchConfiguredBrowser(
	config: HypedditConfig,
): Promise<Browser> {
	return launchAppBrowser({
		...browserModeToLaunchOptions(config.browserMode),
		userDataDir: config.userDataDir ?? './browser-data',
	});
}

export function buildXvfbBrowserEnv(
	display: string,
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries({
			...env,
			DISPLAY: display,
			WAYLAND_DISPLAY: undefined,
			XDG_SESSION_TYPE: 'x11',
			OZONE_PLATFORM: 'x11',
		}).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string',
		),
	);
}

export async function readXvfbDisplay(
	stdout: ReadableStream<Uint8Array>,
): Promise<string> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let output = '';

	while (!output.includes('\n')) {
		const { done, value } = await reader.read();
		if (done) break;
		output += decoder.decode(value, { stream: true });
	}

	reader.releaseLock();
	const displayNumber = output.trim();
	if (!/^\d+$/.test(displayNumber)) {
		throw new Error(
			`Xvfb returned an invalid display number: ${output.trim()}`,
		);
	}
	return `:${displayNumber}`;
}

async function startXvfb(): Promise<XvfbSession> {
	let process: XvfbProcess;
	try {
		process = Bun.spawn(
			[
				'Xvfb',
				'-displayfd',
				'1',
				'-screen',
				'0',
				'1920x1080x24',
				'-nolisten',
				'tcp',
			],
			{ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
		);
	} catch (error) {
		throw new Error(
			`Could not start Xvfb. Install it or disable the Xvfb option. ${error instanceof Error ? error.message : ''}`.trim(),
		);
	}

	let startTimeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const display = await Promise.race([
			readXvfbDisplay(process.stdout),
			new Promise<never>((_, reject) => {
				startTimeout = setTimeout(
					() => reject(new Error('Xvfb did not start within 5 seconds')),
					5_000,
				);
			}),
			process.exited.then(async (exitCode) => {
				const stderr = await new Response(process.stderr).text();
				throw new Error(
					`Xvfb exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
				);
			}),
		]);
		return { display, process, users: 0 };
	} catch (error) {
		process.kill();
		throw error;
	} finally {
		if (startTimeout) clearTimeout(startTimeout);
	}
}

export function createXvfbManager(
	start: () => Promise<XvfbSession> = startXvfb,
): () => Promise<{ display: string; release: () => void }> {
	let activeSession: XvfbSession | null = null;
	let startPromise: Promise<XvfbSession> | null = null;

	return async function acquireXvfb() {
		let session: XvfbSession;
		while (true) {
			if (!startPromise) {
				startPromise = start()
					.then((started) => {
						activeSession = started;
						return started;
					})
					.catch((error) => {
						startPromise = null;
						throw error;
					});
			}

			const candidate = await startPromise;
			if (activeSession === candidate) {
				session = candidate;
				session.users += 1;
				break;
			}
		}

		let released = false;
		return {
			display: session.display,
			release: () => {
				if (released) return;
				released = true;
				session.users -= 1;
				if (session.users === 0 && activeSession === session) {
					session.process.kill();
					activeSession = null;
					startPromise = null;
				}
			},
		};
	};
}

const acquireXvfb = createXvfbManager();

/**
 * Launch CloakBrowser (stealth Chromium) for all automation.
 * Optional `CLOAKBROWSER_PROXY` / `PROXY_URL` for residential egress when an IP is hard-blocked.
 * Proxy GeoIP matching is enabled by default and can be disabled with `CLOAKBROWSER_GEOIP=false`.
 */
export async function launchAppBrowser(
	options: AppBrowserLaunchOptions = {},
): Promise<Browser> {
	process.env.CLOAKBROWSER_SUPPRESS_FONT_WARNING ??= '1';

	const proxy =
		process.env.CLOAKBROWSER_PROXY?.trim() ||
		process.env.PROXY_URL?.trim() ||
		undefined;

	const geoip = Boolean(proxy) && process.env.CLOAKBROWSER_GEOIP !== 'false';
	const useXvfb = options.xvfb ?? false;
	if (useXvfb && !isXvfbSupported()) {
		throw new Error('Xvfb browser mode is only available on Linux');
	}
	const xvfb = useXvfb ? await acquireXvfb() : null;

	const args = [
		...DEFAULT_BROWSER_ARGS,
		...getGpuWorkaroundArgs(),
		...(options.args ?? []),
		// Plasma Wayland otherwise lets Chromium bypass DISPLAY and open visibly.
		...(useXvfb ? ['--ozone-platform=x11'] : []),
	];

	const launchOpts = {
		// Xvfb keeps the browser invisible while preserving headed-mode signals.
		headless: useXvfb ? false : (options.headless ?? true),
		humanize: options.humanize ?? true,
		stealthArgs: true,
		...(proxy ? { proxy, ...(geoip ? { geoip: true } : {}) } : {}),
		args,
		launchOptions: {
			...(xvfb
				? {
						env: buildXvfbBrowserEnv(xvfb.display),
					}
				: {}),
			...(options.defaultViewport !== undefined
				? { defaultViewport: options.defaultViewport }
				: {}),
		},
	};

	try {
		const browser = options.userDataDir
			? await launchPersistentContext({
					...launchOpts,
					userDataDir: options.userDataDir,
				})
			: await launch(launchOpts);

		const appBrowser = browser as Browser;
		if (xvfb) appBrowser.once('disconnected', xvfb.release);
		return appBrowser;
	} catch (error) {
		xvfb?.release();
		throw error;
	}
}
