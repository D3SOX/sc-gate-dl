import type { Browser, Page } from 'puppeteer';
import { CancellableBrowserLaunch } from './browserLaunch';
import { DirectDownloader } from './directDownload';
import type { ProgressCallback } from './hypeddit';
import Selectors from './selectors';
import {
	saveSoundcloudLogin,
	signInToSoundcloud,
	waitForSoundcloudLogin,
} from './soundcloudLogin';
import type { HypedditConfig } from './types';
import { loadCookies, timeout } from './utils';

export interface FangateStep {
	key: string;
	type: string;
	platform: string;
	url?: string;
	skippable: boolean;
	completed: boolean;
}

export interface FangateSession {
	uid: string;
	completed: boolean;
	steps: FangateStep[];
}

export interface FangateApi {
	createSession(slug: string): Promise<FangateSession>;
	getSession(uid: string): Promise<FangateSession>;
	logAction(uid: string, stepKey: string): Promise<void>;
	downloadLink(uid: string): Promise<string>;
}

export type FangateStepAction = 'skip' | 'oauth';

const API = 'https://api.fangate.eu/api';
const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FANGATE_HOSTS = new Set([
	'fangate.eu',
	'app.fangate.eu',
	'www.fangate.eu',
]);
/** Gates may add steps once SoundCloud is connected; stop a session that never ends. */
const MAX_STEPS = 20;
const OAUTH_TIMEOUT_MS = 120_000;

/** The gate slug from a `fangate.eu/tracks/{slug}` URL. */
export function gateSlugFromUrl(value: string): string | null {
	try {
		const url = new URL(value);
		if (!FANGATE_HOSTS.has(url.hostname.toLowerCase())) return null;
		return url.pathname.match(/^\/tracks\/([A-Za-z0-9_-]+)\/?$/)?.[1] ?? null;
	} catch {
		return null;
	}
}

/**
 * A visit step the gate lets us skip is skipped; SoundCloud OAuth runs in the
 * browser. Anything else stops the download with the step named, so no step is
 * passed over silently.
 */
export function fangateStepAction(step: FangateStep): FangateStepAction {
	if (step.type === 'visit' && step.skippable) return 'skip';
	if (step.type === 'oauth' && step.platform === 'soundcloud') return 'oauth';
	throw new Error(
		`fangate.eu step "${step.key}" (${step.type} on ${step.platform}) is not supported yet.`,
	);
}

/**
 * Walk a gate session to its download link. The session is read again after
 * every step, so steps that only appear after the SoundCloud login are
 * handled too.
 */
export async function runFangateSession(
	api: FangateApi,
	slug: string,
	handlers: {
		oauth: (uid: string) => Promise<void>;
		onStep?: (step: FangateStep, action: FangateStepAction) => void;
	},
): Promise<string> {
	let session = await api.createSession(slug);
	const handled = new Set<string>();
	for (let round = 0; round < MAX_STEPS; round++) {
		const step = session.completed
			? undefined
			: session.steps.find((s) => !s.completed && !handled.has(s.key));
		if (!step) return api.downloadLink(session.uid);

		const action = fangateStepAction(step);
		handled.add(step.key);
		handlers.onStep?.(step, action);
		if (action === 'skip') {
			await api.logAction(session.uid, step.key);
		} else {
			await handlers.oauth(session.uid);
		}

		session = await api.getSession(session.uid);
		if (
			action === 'oauth' &&
			!session.steps.find((s) => s.key === step.key)?.completed
		) {
			throw new Error(
				`fangate.eu step "${step.key}" did not complete after the SoundCloud login.`,
			);
		}
	}
	throw new Error(
		`fangate.eu session still had open steps after ${MAX_STEPS} steps.`,
	);
}

/** The fangate.eu session JSON API; `signal` aborts every request. */
export function createFangateApi(signal?: AbortSignal): FangateApi {
	const request = async <T>(path: string, body?: unknown): Promise<T> => {
		const response = await fetch(`${API}${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				'User-Agent': USER_AGENT,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: 'error',
			signal: AbortSignal.any([
				...(signal ? [signal] : []),
				AbortSignal.timeout(30_000),
			]),
		});
		if (!response.ok) {
			const detail = (await response.text().catch(() => '')).slice(0, 200);
			throw new Error(
				`fangate.eu API ${path} answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
			);
		}
		return (await response.json()) as T;
	};
	const session = (uid: string) =>
		`/download_sessions/${encodeURIComponent(uid)}/`;

	return {
		createSession: (slug) =>
			request('/download_sessions/', {
				download_gate_slug: slug,
				user_agent: USER_AGENT,
			}),
		getSession: (uid) => request(session(uid)),
		logAction: async (uid, stepKey) => {
			await request(`${session(uid)}log_action/`, { action: stepKey });
		},
		downloadLink: async (uid) => {
			const { url } = await request<{ url?: unknown }>(
				`${session(uid)}download_link/`,
			);
			if (typeof url !== 'string' || !url) {
				throw new Error('fangate.eu did not return a download link.');
			}
			return url;
		},
	};
}

export class FangateDownloader {
	private browser!: Browser;
	private readonly browserLaunch = new CancellableBrowserLaunch();
	private readonly abortController = new AbortController();
	private fileDownloader: DirectDownloader | null = null;
	private progressCallback: ProgressCallback | null = null;

	constructor(private readonly config: HypedditConfig) {}

	setProgressCallback(callback: ProgressCallback): void {
		this.progressCallback = callback;
	}

	private emitProgress(
		stage: Parameters<ProgressCallback>[0],
		message: string,
		percent: number,
		extra?: Parameters<ProgressCallback>[3],
	): void {
		this.progressCallback?.(stage, message, percent, extra);
	}

	private throwIfCancelled(): void {
		if (this.abortController.signal.aborted) {
			throw new Error('Download cancelled');
		}
	}

	async initialize() {
		this.browser = await this.browserLaunch.launchConfigured(this.config);
		const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
		await this.browser.defaultBrowserContext().setCookie(...soundCloudCookies);
	}

	async prepareLogins() {
		await signInToSoundcloud(this.browser);
	}

	async close() {
		this.abortController.abort();
		await this.fileDownloader?.close();
		await this.browserLaunch.close();
	}

	async downloadAudio(url: string): Promise<string | null> {
		const slug = gateSlugFromUrl(url);
		if (!slug) throw new Error(`Not a fangate.eu gate URL: ${url}`);
		console.log('Opening fangate.eu gate...');
		this.emitProgress('handling_gates', 'Opening fangate.eu gate...', 25);

		const api = createFangateApi(this.abortController.signal);
		const link = await runFangateSession(api, slug, {
			oauth: (uid) => this.connectSoundcloud(api, uid),
			onStep: (step, action) => {
				if (action !== 'skip') return;
				console.log(`fangate.eu: skipping ${step.key}`);
				this.emitProgress(
					'handling_gates',
					`Skipping the ${step.platform} step...`,
					40,
					{ currentGate: step.platform },
				);
			},
		});
		this.throwIfCancelled();

		const direct = new DirectDownloader();
		this.fileDownloader = direct;
		// The gate used the SoundCloud account; keep offering cleanup.
		direct.setProgressCallback((stage, message, percent, extra) =>
			this.emitProgress(stage, message, percent, {
				...extra,
				browserless: false,
			}),
		);
		return direct.downloadAudio(link);
	}

	/**
	 * The gate's return page only accepts a login that its own download page
	 * started, so the login starts from the step's button there rather than
	 * from the authorize URL.
	 */
	private async connectSoundcloud(api: FangateApi, uid: string) {
		const browserActive = this.config.browserMode === 'headed';
		this.emitProgress('handling_gates', 'Connecting SoundCloud...', 50, {
			currentGate: 'soundcloud',
			browserActive,
		});
		const page = await this.browser.newPage();
		try {
			await page.setViewport({ width: 1920, height: 1080 });
			await page.goto(
				`https://www.fangate.eu/download/${encodeURIComponent(uid)}`,
				{ waitUntil: 'domcontentloaded', timeout: 60_000 },
			);
			// One DOM click: page.click() can double-fire under CloakBrowser humanize.
			await page.waitForFunction(
				() => {
					const button = Array.from(document.querySelectorAll('button')).find(
						(candidate) =>
							/log in on soundcloud/i.test(candidate.textContent ?? ''),
					);
					button?.click();
					return !!button;
				},
				{ timeout: 30_000 },
			);
			await this.completeSoundcloudOauth(api, uid);
		} finally {
			await page.close().catch(() => {});
		}
	}

	/**
	 * SoundCloud opens in a popup or in the same tab, and may ask for a login
	 * before or after its Allow page, so check every tab each round until
	 * fangate.eu reports the step done.
	 */
	private async completeSoundcloudOauth(api: FangateApi, uid: string) {
		const browserActive = this.config.browserMode === 'headed';
		let deadline = Date.now() + OAUTH_TIMEOUT_MS;
		let lastAllowAt = 0;
		while (Date.now() < deadline) {
			this.throwIfCancelled();
			const session = await api.getSession(uid);
			if (
				session.steps.some(
					(step) =>
						step.type === 'oauth' &&
						step.platform === 'soundcloud' &&
						step.completed,
				)
			) {
				await saveSoundcloudLogin(this.browser.defaultBrowserContext());
				console.log('fangate.eu: SoundCloud step completed.');
				return;
			}

			const pages = (await this.browser.pages(true)).filter(
				(candidate) => !candidate.isClosed(),
			);
			let loggedIn = false;
			for (const candidate of pages) {
				loggedIn = await waitForSoundcloudLogin(candidate, {
					interactive: browserActive,
					onWaiting: () =>
						this.emitProgress(
							'handling_gates',
							'Log in to SoundCloud in the browser to continue...',
							50,
							{
								currentGate: 'soundcloud',
								browserActive: true,
								requiresAttention: true,
							},
						),
				});
				if (loggedIn) break;
			}
			if (loggedIn) {
				this.emitProgress('handling_gates', 'Connecting SoundCloud...', 55, {
					currentGate: 'soundcloud',
					browserActive,
				});
				deadline = Date.now() + OAUTH_TIMEOUT_MS;
				continue;
			}

			// Retry Allow only when the form is still up a while later.
			if (Date.now() - lastAllowAt > 4_000) {
				for (const candidate of pages) {
					if (await clickSoundcloudAllow(candidate)) {
						console.log('fangate.eu: clicked SoundCloud Allow');
						lastAllowAt = Date.now();
						break;
					}
				}
			}
			await timeout(1_000);
		}
		throw new Error(
			'Timed out waiting for fangate.eu to confirm the SoundCloud login.',
		);
	}
}

/** Approve SoundCloud's authorize form when `page` shows it. */
async function clickSoundcloudAllow(page: Page): Promise<boolean> {
	let host: string;
	try {
		host = new URL(page.url()).hostname;
	} catch {
		return false;
	}
	if (!/(^|\.)soundcloud\.com$/i.test(host)) return false;
	for (const frame of page.frames()) {
		try {
			const submit = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
			if (!submit) continue;
			await page.bringToFront().catch(() => {});
			// CloakBrowser can ignore a plain DOM click() on this button.
			await Promise.race([submit.click({ delay: 40 }), timeout(4_000)]);
			await submit.dispose().catch(() => {});
			return true;
		} catch {
			// Frame detached while the authorize page navigated.
		}
	}
	return false;
}
