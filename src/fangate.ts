import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Browser, Page } from 'puppeteer';
import {
	browserModeToLaunchOptions,
	CancellableBrowserLaunch,
} from './browserLaunch';
import { filenameFromContentDisposition } from './contentDisposition';
import { reserveDownloadFilename } from './downloadRename';
import type { ProgressCallback } from './hypeddit';
import { safeFetch } from './safeOutboundUrl';
import { waitForSoundcloudLogin } from './soundcloudLogin';
import type { HypedditConfig } from './types';
import { loadCookies, sanitizeFilenamePart } from './utils';

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

export type FangatePlannedStep = {
	key: string;
	platform: string;
	action: 'skip' | 'oauth';
};

const UID_RE = /\/download\/([0-9a-f-]{36})(?:[/?#]|$)/i;

export function sessionUidFromUrl(url: string): string | null {
	return url.match(UID_RE)?.[1] ?? null;
}

/**
 * Decide how to handle every open step. A visit step the gate lets us skip is
 * skipped; SoundCloud OAuth is done through the browser. Anything else stops
 * the download with the step named, so no step is passed over silently.
 */
export function planFangateSteps(
	session: FangateSession,
): FangatePlannedStep[] {
	const plan: FangatePlannedStep[] = [];
	for (const step of session.steps) {
		if (step.completed) continue;
		if (step.type === 'visit' && step.skippable) {
			plan.push({ key: step.key, platform: step.platform, action: 'skip' });
		} else if (step.type === 'oauth' && step.platform === 'soundcloud') {
			plan.push({ key: step.key, platform: step.platform, action: 'oauth' });
		} else {
			throw new Error(
				`fangate.eu step "${step.key}" (${step.type} on ${step.platform}) is not supported yet.`,
			);
		}
	}
	return plan;
}

export interface FangateApi {
	createSession(slug: string): Promise<FangateSession>;
	getSession(uid: string): Promise<FangateSession>;
	logAction(uid: string, stepKey: string): Promise<void>;
	downloadLink(uid: string): Promise<string>;
}

/**
 * Walk a gate session to its download link. `oauth` opens the SoundCloud
 * login in the browser; it must complete the step or the run fails.
 */
export async function runFangateSession(
	api: FangateApi,
	oauth: (uid: string) => Promise<void>,
	slug: string,
): Promise<string> {
	const session = await api.createSession(slug);
	for (const step of planFangateSteps(session)) {
		if (step.action === 'skip') {
			await api.logAction(session.uid, step.key);
		} else {
			await oauth(session.uid);
			const after = await api.getSession(session.uid);
			if (!after.steps.find((s) => s.key === step.key)?.completed) {
				throw new Error(
					`fangate.eu step "${step.key}" did not complete after the SoundCloud login.`,
				);
			}
		}
	}
	return api.downloadLink(session.uid);
}
const API = 'https://api.fangate.eu/api';
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

export function gateSlugFromUrl(url: string): string | null {
	return url.match(/\/tracks\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${API}${path}`, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			'User-Agent': USER_AGENT,
			...init?.headers,
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`fangate.eu API ${path} answered HTTP ${response.status}.`);
	}
	return (await response.json()) as T;
}

export const httpFangateApi: FangateApi = {
	createSession: (slug) =>
		apiJson<FangateSession>('/download_sessions/', {
			method: 'POST',
			body: JSON.stringify({
				download_gate_slug: slug,
				user_agent: USER_AGENT,
			}),
		}),
	getSession: (uid) => apiJson<FangateSession>(`/download_sessions/${uid}/`),
	logAction: async (uid, stepKey) => {
		await apiJson(`/download_sessions/${uid}/log_action/`, {
			method: 'POST',
			body: JSON.stringify({ action: stepKey }),
		});
	},
	downloadLink: async (uid) =>
		(await apiJson<{ url: string }>(`/download_sessions/${uid}/download_link/`))
			.url,
};

export class FangateDownloader {
	private browser!: Browser;
	private readonly browserLaunch = new CancellableBrowserLaunch();

	private progress: ProgressCallback | null = null;

	constructor(private readonly config: HypedditConfig) {}

	setProgressCallback(callback: ProgressCallback): void {
		this.progress = callback;
	}

	async initialize() {
		this.browser = await this.browserLaunch.launch({
			...browserModeToLaunchOptions(this.config.browserMode),
			userDataDir: this.config.userDataDir ?? './browser-data',
		});
		const context = this.browser.defaultBrowserContext();
		await context.setCookie(...(await loadCookies('soundcloud-cookies.json')));
	}

	async prepareLogins() {
		const page = await this.browser.newPage();
		await page.goto('https://soundcloud.com/messages');
		await page.close();
	}

	async close() {
		await this.browser?.close().catch(() => {});
	}

	/**
	 * The gate's return page only accepts a login that its own download page
	 * started (it stores the session in localStorage), so the login is started
	 * by clicking the step there rather than by opening the authorize URL.
	 */
	private async oauth(uid: string): Promise<void> {
		const page = await this.browser.newPage();
		try {
			await page.goto(`https://www.fangate.eu/download/${uid}`, {
				waitUntil: 'domcontentloaded',
				timeout: 60_000,
			});
			await page.waitForFunction(
				() =>
					Array.from(document.querySelectorAll('button')).some((b) =>
						/log in on soundcloud/i.test(b.textContent ?? ''),
					),
				{ timeout: 30_000 },
			);
			await page.evaluate(() => {
				const button = Array.from(document.querySelectorAll('button')).find(
					(b) => /log in on soundcloud/i.test(b.textContent ?? ''),
				);
				(button as HTMLButtonElement | undefined)?.click();
			});
			await page.waitForFunction(
				() => location.hostname.includes('soundcloud.com'),
				{
					timeout: 30_000,
				},
			);
			await waitForSoundcloudLogin(page, {
				interactive: this.config.browserMode !== 'headless',
				onWaiting: () => {},
			});
			await this.clickAllow(page);
			await this.waitForStepDone(uid);
		} finally {
			if (!page.isClosed()) await page.close().catch(() => {});
		}
	}

	/** The return page confirms the login with the API; wait until it shows. */
	private async waitForStepDone(uid: string): Promise<void> {
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			const session = await httpFangateApi.getSession(uid);
			if (session.steps.some((s) => s.type === 'oauth' && s.completed)) return;
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}

	private async clickAllow(page: Page): Promise<void> {
		await page.waitForSelector('button#submit_approval', {
			timeout: 30_000,
		});
		await page.click('button#submit_approval');
	}

	async downloadAudio(url: string): Promise<string | null> {
		const slug = gateSlugFromUrl(url);
		if (!slug) throw new Error(`fangate.eu: no gate slug in ${url}.`);
		this.progress?.('handling_gates', 'Walking the fangate.eu gate...', 40);
		const link = await runFangateSession(
			httpFangateApi,
			(uid) => this.oauth(uid),
			slug,
		);
		return saveFangateFile(link, url);
	}
}

async function saveFangateFile(link: string, referer: string): Promise<string> {
	await mkdir('./downloads', { recursive: true });
	const { response, url: finalUrl } = await safeFetch(link, {
		headers: { Referer: referer, 'User-Agent': USER_AGENT, Accept: '*/*' },
		signal: AbortSignal.timeout(300_000),
	});
	if (!response.ok || !response.body) {
		throw new Error(
			`fangate.eu file download failed (HTTP ${response.status}).`,
		);
	}
	const fromHeader = filenameFromContentDisposition(
		response.headers.get('content-disposition'),
	);
	let name =
		sanitizeFilenamePart(basename(fromHeader || '')) ||
		sanitizeFilenamePart(basename(new URL(finalUrl).pathname)) ||
		'fangate-download';
	if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = `${name}.wav`;
	name = await reserveDownloadFilename('./downloads', name);
	const target = join('./downloads', name);
	const writer = Bun.file(target).writer();
	const reader = response.body.getReader();
	let received = 0;
	let completed = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > MAX_DOWNLOAD_BYTES) {
				await reader.cancel();
				throw new Error('fangate.eu download is too large.');
			}
			writer.write(value);
		}
		await writer.end();
		completed = true;
	} finally {
		if (!completed) {
			await Promise.resolve(writer.end()).catch(() => {});
			await rm(target, { force: true }).catch(() => {});
		}
	}
	return name;
}
