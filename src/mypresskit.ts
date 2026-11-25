import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Browser, CookieData, Page } from 'puppeteer';
import {
	browserModeToLaunchOptions,
	CancellableBrowserLaunch,
} from './browserLaunch';
import { filenameFromContentDisposition } from './contentDisposition';
import { reserveDownloadFilename } from './downloadRename';
import {
	downloadProgressReporter,
	saveDownloadStream,
	withContentTypeExtension,
	withHeaderTimeout,
} from './downloadStream';
import type { ProgressCallback } from './hypeddit';
import { safeFetch } from './safeOutboundUrl';
import { signInToSoundcloud, waitForSoundcloudLogin } from './soundcloudLogin';
import {
	completeSpotifyAuthorization,
	findSpotifyAuthorizePage,
	injectSpotifyCookies,
	missingSpotifyCookiesError,
} from './spotifyAuth';
import type { HypedditConfig } from './types';
import {
	loadCookies,
	safeDecodeURIComponent,
	sanitizeFilenamePart,
	timeout,
} from './utils';

const SC_AUTHORIZE_RE = /secure\.soundcloud\.com\/authorize/i;
const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

type GateStep = {
	index: number;
	type: string;
	targetUrl: string | null;
	required: boolean;
};

type VerifyBody = {
	unlockState?: { unlocked?: boolean; remaining?: number[]; total?: number };
	completedStepIndexes?: number[];
	downloadToken?: string | null;
	capturedEmail?: string | null;
};

function safePageUrl(page: Page): string {
	try {
		if (page.isClosed()) return '';
		return page.url();
	} catch {
		return '';
	}
}

export class MypresskitDownloader {
	private browser!: Browser;
	private readonly browserLaunch = new CancellableBrowserLaunch();
	private config: HypedditConfig;
	private progressCallback: ProgressCallback | null = null;
	private readonly downloadAbortController = new AbortController();
	private spotifyCookiesLoaded = false;

	constructor(config: HypedditConfig) {
		this.config = config;
	}

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

	async initialize() {
		this.browser = await this.browserLaunch.launch({
			...browserModeToLaunchOptions(this.config.browserMode),
			userDataDir: this.config.userDataDir ?? './browser-data',
			// SC OAuth authorize popup shares session cookies more reliably with this.
			args: ['--fingerprint-allow-3p-cookies'],
		});

		const browserContext = this.browser.defaultBrowserContext();
		const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
		await browserContext.setCookie(...soundCloudCookies);
		this.spotifyCookiesLoaded = await injectSpotifyCookies(this.browser);
	}

	/** `signInCookies`: a session from `soundcloudSessionFromFirefox`. */
	async prepareLogins(signInCookies?: CookieData[]) {
		await signInToSoundcloud(this.browser, { signInCookies });
	}

	async downloadAudio(url: string): Promise<string | null> {
		console.log('Navigating to MyPressKit gate...');
		this.emitProgress('handling_gates', 'Navigating to MyPressKit gate...', 25);

		const page = await this.browser.newPage();
		try {
			await page.setViewport({ width: 1920, height: 1080 });
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
			try {
				await page.waitForNetworkIdle({ timeout: 15_000, idleTime: 10 });
			} catch {
				// continue
			}

			await this.dismissCookies(page);
			const gate = await this.parseGate(page);
			if (gate.availability && gate.availability !== 'available') {
				throw new Error(
					`MyPressKit gate is ${gate.availability} and does not offer the download right now.`,
				);
			}
			if (!gate.id) {
				throw new Error('MyPressKit: could not determine gate id from page.');
			}
			console.log(
				`MyPressKit gate ${gate.id} (${gate.handle ?? 'unknown'}) — ${gate.steps.length} steps`,
			);

			const stepsByIndex = new Map(gate.steps.map((s) => [s.index, s]));
			for (let round = 0; round < 12; round++) {
				const verify = await this.readVerify(page, gate.id);
				if (verify.downloadToken && verify.unlockState?.unlocked) {
					console.log('MyPressKit unlocked');
					return await this.downloadWithToken(
						page,
						gate.id,
						verify.downloadToken,
						url,
					);
				}

				const remaining = (verify.unlockState?.remaining ?? []).map(Number);
				if (remaining.length === 0) {
					if (verify.downloadToken) {
						return await this.downloadWithToken(
							page,
							gate.id,
							verify.downloadToken,
							url,
						);
					}
					break;
				}

				const stepIndex = remaining[0];
				if (stepIndex === undefined) break;
				const step = stepsByIndex.get(stepIndex) ?? {
					index: stepIndex,
					type: 'soundcloud-follow',
					targetUrl: null,
					required: true,
				};
				console.log(
					`MyPressKit remaining=${JSON.stringify(remaining)} → step ${step.index} (${step.type})`,
				);
				this.emitProgress(
					'handling_gates',
					`MyPressKit: ${step.type}...`,
					35 + Math.min(40, round * 5),
					{
						currentGate: step.type.startsWith('soundcloud-')
							? 'sc'
							: step.type.startsWith('spotify-')
								? 'sp'
								: 'social',
					},
				);

				await this.runStep(page, gate.id, step);
				await this.waitForStepProgress(page, gate.id, step.index, verify);
			}

			const finalVerify = await this.readVerify(page, gate.id);
			if (finalVerify.downloadToken) {
				return await this.downloadWithToken(
					page,
					gate.id,
					finalVerify.downloadToken,
					url,
				);
			}
			throw new Error(
				'MyPressKit download never unlocked after completing gate steps.',
			);
		} finally {
			if (!page.isClosed()) {
				await page.close().catch(() => {});
			}
		}
	}

	async close() {
		this.downloadAbortController.abort();
		await this.browserLaunch.close();
	}

	private async dismissCookies(page: Page) {
		await page
			.evaluate(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const accept = buttons.find((b) =>
					/accept all/i.test((b.textContent || '').trim()),
				);
				accept?.click();
			})
			.catch(() => {});
	}

	private async parseGate(page: Page): Promise<{
		id: string | null;
		handle: string | null;
		availability: string | null;
		steps: GateStep[];
	}> {
		await page
			.waitForFunction(
				() =>
					!!document.querySelector('audio[src*="/api/download-gates/"]') ||
					Array.from(document.querySelectorAll('button')).some((b) =>
						/follow on soundcloud|repost track|like track|comment on track|complete all steps/i.test(
							(b.textContent || '').trim(),
						),
					),
				{ timeout: 30_000 },
			)
			.catch(() => {});

		return page.evaluate(() => {
			const html = document.documentElement.innerHTML;
			const handle = location.pathname.match(/\/gate\/([^/?#]+)/)?.[1] ?? null;
			const fromAudio = document
				.querySelector('audio[src*="/api/download-gates/"]')
				?.getAttribute('src')
				?.match(/\/api\/download-gates\/(\d+)\//)?.[1];
			const fromHtml = html.match(/\/api\/download-gates\/(\d+)\//)?.[1];
			const fromJson = html.match(/"id":(\d+),"handle":"[^"]+","title":/)?.[1];
			const id = fromAudio || fromHtml || fromJson || null;
			// `availability.state`: available, paused, expired or full.
			const availability =
				html.match(/\\?"availability\\?":\{\\?"state\\?":\\?"([a-z-]+)/)?.[1] ??
				null;

			let steps: GateStep[] = [];
			const rawCandidates = [
				...html.matchAll(/\\"gateSteps\\":(\[[\s\S]*?\])/g),
				...html.matchAll(/"gateSteps":(\[[\s\S]*?\])/g),
			];
			for (const match of rawCandidates) {
				let raw = match[1];
				if (!raw) continue;
				if (raw.includes('\\"')) {
					raw = raw
						.replace(/\\"/g, '"')
						.replace(/\\\\/g, '\\')
						.replace(/\\n/g, '\n');
				}
				try {
					const parsed = JSON.parse(raw) as GateStep[];
					if (Array.isArray(parsed) && parsed.length > 0) {
						steps = parsed;
						break;
					}
				} catch {
					// try next
				}
			}

			return { id, handle, availability, steps };
		});
	}

	private async readVerify(page: Page, gateId: string): Promise<VerifyBody> {
		const result = await page.evaluate(async (id) => {
			const res = await fetch(
				`/api/download-gates/${encodeURIComponent(id)}/verify-step`,
				{ credentials: 'include', signal: AbortSignal.timeout(15_000) },
			);
			if (!res.ok) {
				return { ok: false as const, status: res.status };
			}
			return { ok: true as const, body: (await res.json()) as VerifyBody };
		}, gateId);
		if (!result.ok) {
			throw new Error(`MyPressKit verify-step failed (${result.status})`);
		}
		return result.body;
	}

	private async runStep(page: Page, gateId: string, step: GateStep) {
		if (step.type === 'email-capture') {
			await this.submitEmail(page, gateId, step.index);
			return;
		}

		if (step.type.startsWith('soundcloud-')) {
			await this.runOauthStep(page, gateId, step);
			return;
		}

		if (step.type.startsWith('spotify-')) {
			// The gate UI posts track-step for Spotify steps like for any other
			// social link (it only opens OAuth for SoundCloud). The server also has
			// a Spotify OAuth flow that really follows / saves; use it when the
			// honor-system click doesn't count.
			const tracked = await this.trackStep(page, gateId, step.index);
			if (tracked.ok && (await this.isStepDone(page, gateId, step.index))) {
				return;
			}
			console.log(
				`MyPressKit track-step for ${step.type} not accepted (${tracked.status}) — using Spotify OAuth`,
			);
			await this.runSpotifyOauthStep(page, gateId, step);
			return;
		}

		// Honor-system steps (instagram-follow, facebook-follow, tiktok-follow,
		// twitter-follow, youtube-subscribe, youtube-like): the gate UI opens the
		// target link and records the click via track-step.
		const tracked = await this.trackStep(page, gateId, step.index);
		if (!tracked.ok) {
			throw new Error(
				`MyPressKit rejected ${step.type} step ${step.index} (${tracked.status}).`,
			);
		}
	}

	private async trackStep(
		page: Page,
		gateId: string,
		stepIndex: number,
	): Promise<{ ok: boolean; status: number }> {
		return page.evaluate(
			async (id, index) => {
				const res = await fetch(
					`/api/download-gates/${encodeURIComponent(id)}/track-step`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						credentials: 'include',
						body: JSON.stringify({ stepIndex: index }),
						signal: AbortSignal.timeout(15_000),
					},
				);
				return { ok: res.ok, status: res.status };
			},
			gateId,
			stepIndex,
		);
	}

	private async isStepDone(page: Page, gateId: string, stepIndex: number) {
		const verify = await this.readVerify(page, gateId);
		return (
			!!verify.unlockState?.unlocked ||
			(verify.completedStepIndexes ?? []).map(Number).includes(stepIndex) ||
			!(verify.unlockState?.remaining ?? []).map(Number).includes(stepIndex)
		);
	}

	/**
	 * Same popup the gate's own OAuth handler opens
	 * (`/api/download-gates/oauth/spotify/start`, scopes user-follow-modify and
	 * user-library-modify); its callback completes the step server-side.
	 */
	private async runSpotifyOauthStep(
		page: Page,
		gateId: string,
		step: GateStep,
	) {
		if (!this.spotifyCookiesLoaded) {
			throw missingSpotifyCookiesError('MyPressKit');
		}
		await page.evaluate(
			(id, index) => {
				const params = new URLSearchParams({
					gate: id,
					step: String(index),
					popup: '1',
				});
				window.open(
					`/api/download-gates/oauth/spotify/start?${params}`,
					'mpk-gate-oauth',
					'width=520,height=720',
				);
			},
			gateId,
			step.index,
		);

		// An already authorized app redirects straight back to the callback, so
		// the consent page may never show up.
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			if (await findSpotifyAuthorizePage(this.browser)) {
				const result = await completeSpotifyAuthorization(this.browser);
				console.log(`MyPressKit: Spotify authorization ${result}`);
				return;
			}
			if (await this.isStepDone(page, gateId, step.index)) return;
			await timeout(500);
		}
		throw new Error(
			`MyPressKit Spotify authorization for ${step.type} never opened.`,
		);
	}

	private async submitEmail(page: Page, gateId: string, stepIndex: number) {
		const email = this.config.email?.trim();
		if (!email) {
			throw new Error(
				'This MyPressKit gate requires an email. Set HYPEDDIT_EMAIL in your .env file.',
			);
		}
		await page.evaluate(
			async (id, index, value) => {
				const input = document.querySelector(
					'input[type="email"]',
				) as HTMLInputElement | null;
				if (input) {
					const setter = Object.getOwnPropertyDescriptor(
						HTMLInputElement.prototype,
						'value',
					)?.set;
					setter?.call(input, value);
					input.dispatchEvent(new Event('input', { bubbles: true }));
					input.dispatchEvent(new Event('change', { bubbles: true }));
				}
				await fetch(`/api/download-gates/${encodeURIComponent(id)}/email`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'include',
					body: JSON.stringify({ email: value, stepIndex: index }),
					signal: AbortSignal.timeout(15_000),
				});
			},
			gateId,
			stepIndex,
			email,
		);
	}

	private async runOauthStep(page: Page, gateId: string, step: GateStep) {
		const comment = this.config.comment.trim();
		if (step.type === 'soundcloud-comment' && comment.length < 2) {
			throw new Error(
				'This MyPressKit gate requires SC_COMMENT (at least 2 characters).',
			);
		}

		const popupPromise = new Promise<Page | null>((resolve) => {
			const onTarget = async (target: { page: () => Promise<Page | null> }) => {
				const p = await target.page().catch(() => null);
				if (!p) return;
				clearTimeout(timer);
				this.browser.off('targetcreated', onTarget);
				resolve(p);
			};
			const timer = setTimeout(() => {
				this.browser.off('targetcreated', onTarget);
				resolve(null);
			}, 20_000);
			this.browser.on('targetcreated', onTarget);
		});

		// Always the per-step start URL the gate's own step buttons open
		// (`ee()` in the gate bundle). Gates with combineSoundCloudSteps only show
		// one combined button (`combo=1`), which did not complete the steps live.
		await page.evaluate(
			(stepIndex, stepType, text, id) => {
				const params = new URLSearchParams({
					gate: id,
					step: String(stepIndex),
					popup: '1',
				});
				if (stepType === 'soundcloud-comment') params.set('comment', text);
				window.open(
					`/api/download-gates/oauth/soundcloud/start?${params}`,
					`mpk-gate-oauth-${stepIndex}`,
					'width=520,height=720',
				);
			},
			step.index,
			step.type,
			comment,
			gateId,
		);
		console.log(`MyPressKit OAuth open for step ${step.index} (${step.type})`);

		let oauthPage = await popupPromise;
		if (!oauthPage) oauthPage = await this.findSoundcloudOauthPage();
		if (oauthPage) {
			await this.completeSoundcloudOauth(oauthPage);
		} else {
			console.log('MyPressKit: no OAuth popup — polling verify-step');
		}
	}

	private async waitForStepProgress(
		page: Page,
		gateId: string,
		stepIndex: number,
		before: VerifyBody,
	) {
		const beforeSet = new Set((before.completedStepIndexes ?? []).map(Number));
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			const verify = await this.readVerify(page, gateId);
			if (verify.downloadToken && verify.unlockState?.unlocked) return;
			const completed = new Set(
				(verify.completedStepIndexes ?? []).map(Number),
			);
			if (completed.has(stepIndex) && !beforeSet.has(stepIndex)) {
				console.log(`MyPressKit step ${stepIndex} complete`);
				return;
			}
			const remaining = (verify.unlockState?.remaining ?? []).map(Number);
			if (!remaining.includes(stepIndex)) {
				console.log(`MyPressKit step ${stepIndex} no longer remaining`);
				return;
			}
			await timeout(1000);
		}
		throw new Error(
			`MyPressKit timed out waiting for step ${stepIndex} to complete.`,
		);
	}

	private async findSoundcloudOauthPage(): Promise<Page | null> {
		for (const candidate of await this.browser.pages()) {
			if (candidate.isClosed()) continue;
			if (SC_AUTHORIZE_RE.test(safePageUrl(candidate))) return candidate;
		}
		return null;
	}

	private async completeSoundcloudOauth(startPage: Page) {
		const hardDeadline = Date.now() + 12 * 60_000;
		let deadline = Date.now() + 180_000;
		let lastAllowAt = 0;
		let sawAuthorize = false;
		let allowClicks = 0;

		while (Date.now() < deadline) {
			const oauthPage =
				(await this.findSoundcloudOauthPage()) ??
				(SC_AUTHORIZE_RE.test(safePageUrl(startPage)) && !startPage.isClosed()
					? startPage
					: null);

			if (oauthPage && !oauthPage.isClosed()) {
				sawAuthorize = true;
				const canRetry = Date.now() - lastAllowAt > 3_000;
				if (lastAllowAt === 0 || canRetry) {
					const allowed = await this.clickSoundcloudOauthAllow(oauthPage);
					if (allowed) {
						deadline = Math.min(
							hardDeadline,
							Math.max(deadline, Date.now() + 120_000),
						);
						allowClicks += 1;
						lastAllowAt = Date.now();
						console.log(
							`MyPressKit: SoundCloud Allow clicked (${allowClicks})`,
						);
						await timeout(1_500);
						continue;
					}
				}
				await timeout(400);
				continue;
			}

			if (sawAuthorize || startPage.isClosed()) {
				await timeout(800);
				return;
			}
			await timeout(400);
		}

		throw new Error(
			'Timed out waiting for SoundCloud OAuth Allow / MyPressKit callback.',
		);
	}

	private async clickSoundcloudOauthAllow(oauthPage: Page): Promise<boolean> {
		await oauthPage.bringToFront().catch(() => {});

		await waitForSoundcloudLogin(oauthPage, {
			interactive: this.config.browserMode === 'headed',
			onWaiting: () => {
				this.emitProgress(
					'handling_gates',
					'Waiting for SoundCloud login in browser…',
					50,
					{
						currentGate: 'soundcloud',
						browserActive: true,
						requiresAttention: true,
					},
				);
			},
		});

		const clicked = await oauthPage
			.evaluate(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const allow = buttons.find((b) =>
					/^(allow|connect|authorize|accept)$/i.test(
						(b.textContent || '').trim(),
					),
				);
				if (allow) {
					(allow as HTMLButtonElement).click();
					return true;
				}
				const byId = document.querySelector(
					'button#submit_approval, button[name="accept"]',
				) as HTMLButtonElement | null;
				if (byId) {
					byId.click();
					return true;
				}
				return false;
			})
			.catch(() => false);

		return clicked;
	}

	private async downloadWithToken(
		page: Page,
		gateId: string,
		token: string,
		referer: string,
	): Promise<string> {
		this.emitProgress('handling_gates', 'Preparing MyPressKit download...', 75);
		const downloadUrl = `https://www.mypresskit.info/api/download-gates/${encodeURIComponent(gateId)}/download?token=${encodeURIComponent(token)}`;
		const cookies = await page.cookies(downloadUrl);
		const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

		await mkdir('./downloads', { recursive: true });
		this.emitProgress('downloading', 'Downloading MyPressKit file...', 0);

		const { response, url: finalUrl } = await withHeaderTimeout(
			this.downloadAbortController.signal,
			120_000,
			(signal) =>
				safeFetch(downloadUrl, {
					headers: {
						Cookie: cookieHeader,
						Referer: referer,
						'User-Agent': USER_AGENT,
						Accept: '*/*',
					},
					signal,
				}),
		);

		if (!response.ok || !response.body) {
			throw new Error(
				`MyPressKit file download failed (${response.status} ${response.statusText}) from ${finalUrl}`,
			);
		}

		const fromHeader = filenameFromContentDisposition(
			response.headers.get('content-disposition'),
		);
		let suggested = withContentTypeExtension(
			sanitizeFilenamePart(basename(fromHeader || '')) ||
				sanitizeFilenamePart(
					safeDecodeURIComponent(basename(new URL(finalUrl).pathname)),
				) ||
				`mypresskit-${gateId}`,
			response.headers.get('content-type'),
		);
		suggested = await reserveDownloadFilename('./downloads', suggested);

		const target = join('./downloads', suggested);
		const totalBytes = Number(response.headers.get('content-length')) || 0;
		const received = await saveDownloadStream(response.body, target, {
			totalBytes,
			signal: this.downloadAbortController.signal,
			onProgress: downloadProgressReporter(this.progressCallback),
		});
		this.emitProgress('downloading', 'Download complete', 100, {
			downloadBytes: received,
			...(totalBytes > 0 && { totalBytes }),
		});

		console.log('MyPressKit saved:', target);
		return suggested;
	}
}
