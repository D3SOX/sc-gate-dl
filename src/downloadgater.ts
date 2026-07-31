import { Presets, SingleBar } from 'cli-progress';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import type { ProgressCallback } from './hypeddit';
import Selectors from './selectors';
import type { HypedditConfig } from './types';
import { loadCookies, timeout } from './utils';

export class DownloadgaterDownloader {
	private browser!: Browser;
	private downloadFilename: string | null = null;
	private config: HypedditConfig;
	private progressCallback: ProgressCallback | null = null;

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
		this.browser = await launchAppBrowser({
			headless: this.config.headless,
			userDataDir: './browser-data',
		});

		const browserContext = this.browser.defaultBrowserContext();
		const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
		await browserContext.setCookie(...soundCloudCookies);
	}

	async prepareLogins() {
		const soundCloudPage = await this.browser.newPage();
		soundCloudPage.setViewport({ width: 1920, height: 1080 });
		await soundCloudPage.goto('https://soundcloud.com/messages');

		try {
			await soundCloudPage.waitForSelector(
				Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER,
				{ timeout: 5_000 },
			);
			console.log(
				'DownloadGater: SoundCloud captcha present during login warm-up; solve it in the browser window if needed.',
			);
			await soundCloudPage.waitForSelector(
				Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER,
				{ hidden: true, timeout: 120_000 },
			);
		} catch {
			// no captcha
		}

		await soundCloudPage.waitForSelector(Selectors.SOUNDCLOUD_LIBRARY_LINK, {
			timeout: 30_000,
		});
		await Promise.all([
			soundCloudPage.click(Selectors.SOUNDCLOUD_LIBRARY_LINK),
			soundCloudPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		]);
		await soundCloudPage.waitForFunction(() =>
			window.location.href.includes('/you/library'),
		);
		await soundCloudPage.close();
	}

	async downloadAudio(url: string): Promise<string | null> {
		console.log('Navigating to DownloadGater gate...');
		this.emitProgress(
			'handling_gates',
			'Navigating to DownloadGater gate...',
			25,
		);

		const page = await this.browser.newPage();
		await page.setViewport({ width: 1920, height: 1080 });
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		try {
			await page.waitForNetworkIdle({ timeout: 15_000, idleTime: 10 });
		} catch {
			// continue
		}

		await this.clickFreeDownload(page);

		let soundcloudAttempted = false;
		const deadline = Date.now() + 180_000;
		while (Date.now() < deadline) {
			if (await this.hasDownloadButton(page)) break;

			// Post-OAuth UI can show "Verified unlock" / Finish before Download file.
			await this.clickUnlockFinishIfPresent(page);
			if (await this.hasDownloadButton(page)) break;

			const pane = await this.detectPane(page);
			console.log('DownloadGater pane:', pane);

			if (pane === 'instagram') {
				this.emitProgress(
					'handling_gates',
					'Handling DownloadGater Instagram follows...',
					40,
					{ currentGate: 'ig' },
				);
				await this.handleInstagramStep(page);
				continue;
			}

			if (pane === 'soundcloud') {
				if (soundcloudAttempted) {
					const urlError = await this.readSoundcloudUrlError(page);
					if (urlError) {
						throw new Error(
							`DownloadGater SoundCloud unlock failed: ${urlError}`,
						);
					}
					// Still hydrating unlock → Download file; do not re-click Connect.
					await timeout(500);
					continue;
				}
				soundcloudAttempted = true;
				this.emitProgress(
					'handling_gates',
					'Connecting SoundCloud on DownloadGater...',
					55,
					{ currentGate: 'sc' },
				);
				await this.handleSoundcloudConnect(page);
				continue;
			}

			if (pane === 'spotify') {
				throw new Error(
					'This DownloadGater gate requires Spotify OAuth, which is not supported yet.',
				);
			}

			await timeout(500);
		}

		if (!(await this.hasDownloadButton(page))) {
			throw new Error(
				'DownloadGater download button never appeared after completing gates.',
			);
		}

		await this.handleDownload(page);
		await page.close();
		return this.downloadFilename;
	}

	async close() {
		await this.browser?.close();
	}

	private async clickFreeDownload(page: Page) {
		// GatePage is a lazy SPA chunk — wait for hydration before looking for CTA.
		await page.waitForFunction(
			() => {
				const byClass = document.querySelector<HTMLButtonElement>(
					'button.download-button',
				);
				if (byClass && !byClass.disabled) return true;
				return Array.from(document.querySelectorAll('button')).some((btn) =>
					/free\s*download/i.test((btn.textContent || '').trim()),
				);
			},
			{ timeout: 30_000 },
		);

		const clicked = await page.evaluate(() => {
			const byClass = document.querySelector<HTMLButtonElement>(
				'button.download-button',
			);
			if (byClass && !byClass.disabled) {
				byClass.click();
				return 'class';
			}
			const free = Array.from(document.querySelectorAll('button')).find(
				(btn) =>
					/free\s*download/i.test((btn.textContent || '').trim()) &&
					!(btn as HTMLButtonElement).disabled,
			) as HTMLButtonElement | undefined;
			if (free) {
				free.click();
				return 'text';
			}
			return null;
		});
		if (!clicked) {
			throw new Error('DownloadGater FREE DOWNLOAD button not found.');
		}
		await timeout(800);
	}

	private async detectPane(
		page: Page,
	): Promise<'instagram' | 'soundcloud' | 'spotify' | 'download' | 'unknown'> {
		return page.evaluate(() => {
			const buttons = Array.from(document.querySelectorAll('button'));
			const buttonText = (btn: Element) => (btn.textContent || '').trim();

			if (
				buttons.some((btn) =>
					/^(download file|download zip)$/i.test(buttonText(btn)),
				)
			) {
				return 'download';
			}

			// Unlocked / finishing UI still mentions SoundCloud — not a Connect step.
			const body = document.body?.innerText || '';
			if (
				/verified unlock/i.test(body) ||
				buttons.some((btn) => /^finish$/i.test(buttonText(btn)))
			) {
				return 'download';
			}

			const title =
				document.querySelector('#gate-flow-title')?.textContent?.trim() || '';

			if (
				buttons.some((btn) =>
					/connect.*soundcloud|connect & (follow|repost)/i.test(
						buttonText(btn),
					),
				) ||
				(/^complete soundcloud$/i.test(title) &&
					!!document.querySelector('textarea'))
			) {
				return 'soundcloud';
			}
			if (
				/instagram/i.test(title) ||
				buttons.some((btn) => /follow on instagram/i.test(buttonText(btn)))
			) {
				return 'instagram';
			}
			if (/spotify/i.test(title)) return 'spotify';
			return 'unknown';
		});
	}

	private async hasDownloadButton(page: Page): Promise<boolean> {
		return page.evaluate(() =>
			Array.from(document.querySelectorAll('button')).some((btn) =>
				/^(download file|download zip)$/i.test((btn.textContent || '').trim()),
			),
		);
	}

	private async clickUnlockFinishIfPresent(page: Page): Promise<boolean> {
		return page.evaluate(() => {
			const btn = Array.from(document.querySelectorAll('button')).find(
				(el) =>
					/^finish$/i.test((el.textContent || '').trim()) &&
					!(el as HTMLButtonElement).disabled,
			) as HTMLButtonElement | undefined;
			btn?.click();
			return !!btn;
		});
	}

	private async readSoundcloudUrlError(page: Page): Promise<string | null> {
		try {
			return new URL(page.url()).searchParams.get('soundcloud_error');
		} catch {
			return null;
		}
	}

	/**
	 * Honor-system Instagram: open each target (popup), wait for the 5s unlock
	 * timer, then confirm. Multiple IG targets are served one at a time.
	 */
	private async handleInstagramStep(page: Page) {
		for (let attempt = 0; attempt < 8; attempt++) {
			if ((await this.detectPane(page)) !== 'instagram') return;
			if (await this.hasDownloadButton(page)) return;

			const pagesBefore = new Set(await this.browser.pages(true));

			const followClicked = await page.evaluate(() => {
				const btn = Array.from(document.querySelectorAll('button')).find(
					(el) =>
						/follow on instagram/i.test(el.textContent || '') &&
						!(el as HTMLButtonElement).disabled,
				) as HTMLButtonElement | undefined;
				btn?.click();
				return !!btn;
			});

			if (followClicked) {
				let popup: Page | undefined;
				const started = Date.now();
				while (!popup && Date.now() - started < 8_000) {
					const pages = await this.browser.pages(true);
					popup = pages.find(
						(candidate) =>
							candidate !== page &&
							!pagesBefore.has(candidate) &&
							candidate.url() !== 'about:blank',
					);
					if (!popup) {
						popup = pages.find(
							(candidate) =>
								candidate !== page && /instagram\.com/i.test(candidate.url()),
						);
					}
					if (!popup) await timeout(200);
				}

				// Site unlocks after ~5s with the popup open.
				await timeout(5_500);

				if (popup && !popup.isClosed()) {
					try {
						await popup.close();
					} catch {
						// ignore
					}
				}
			}

			const confirmed = await page.evaluate(() => {
				const btn = Array.from(document.querySelectorAll('button')).find(
					(el) =>
						/^(i followed|i opened it)$/i.test((el.textContent || '').trim()) &&
						!(el as HTMLButtonElement).disabled,
				) as HTMLButtonElement | undefined;
				btn?.click();
				return !!btn;
			});

			if (confirmed) {
				await timeout(800);
			} else {
				await timeout(500);
			}

			if ((await this.detectPane(page)) !== 'instagram') return;
		}

		throw new Error(
			'DownloadGater Instagram step did not advance. Allow popups and retry.',
		);
	}

	private async handleSoundcloudConnect(page: Page) {
		const comment = this.config.comment.trim();
		const needsComment = await page.evaluate(() =>
			Boolean(document.querySelector('textarea')),
		);
		if (needsComment) {
			if (comment.length < 1) {
				throw new Error(
					'This DownloadGater gate requires SC_COMMENT before connecting SoundCloud.',
				);
			}
			await page.focus('textarea');
			await page.evaluate((value) => {
				const el = document.querySelector('textarea');
				if (!el) return;
				const setter = Object.getOwnPropertyDescriptor(
					window.HTMLTextAreaElement.prototype,
					'value',
				)?.set;
				setter?.call(el, value);
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
			}, comment);
			await timeout(300);
		}

		const pagesBefore = new Set(await this.browser.pages(true));

		const clicked = await page.evaluate(() => {
			const btn = Array.from(document.querySelectorAll('button')).find((el) =>
				/connect.*soundcloud|connect & (follow|repost)/i.test(
					el.textContent || '',
				),
			) as HTMLButtonElement | undefined;
			if (!btn || btn.disabled) return false;
			btn.click();
			return true;
		});
		if (!clicked) {
			throw new Error('DownloadGater SoundCloud connect button not found.');
		}

		// Same-tab OAuth (window.location.assign) — keep one loop like the working
		// Nico Chromium flow: wait for authorize → click Allow → wait for unlock.
		// Never treat "still on downloadgater Connecting…" as done, and never click
		// email "Continue".
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			const oauthPage = await this.findSoundcloudOauthPage(page, pagesBefore);
			const active =
				oauthPage ??
				(!page.isClosed() ? page : null) ??
				(await this.findPageWithApprovalButton());

			if (!active || active.isClosed()) {
				await timeout(300);
				continue;
			}

			const url = active.url();

			if (
				/soundcloud\.com|secure\.soundcloud\.com/i.test(url) &&
				!url.includes('downloadgater.com')
			) {
				const allowed = await this.clickSoundcloudOauthAllow(active);
				if (!allowed) {
					// Authorize shell can render before #submit_approval is attached.
					await timeout(400);
				} else {
					await timeout(1_000);
				}
				continue;
			}

			// Gate tab may still be downloadgater while authorize is another target.
			const approvalTab = await this.findPageWithApprovalButton();
			if (approvalTab) {
				await this.clickSoundcloudOauthAllow(approvalTab);
				await timeout(1_000);
				continue;
			}

			if (!url.includes('downloadgater.com')) {
				await timeout(300);
				continue;
			}

			// Still on the OAuth callback endpoint — wait for the gate redirect.
			// Do not navigate away; that drops the unlock token.
			if (/\/api\/soundcloud\/callback/i.test(url)) {
				await timeout(300);
				continue;
			}

			const soundcloudError = await this.readSoundcloudUrlError(active);
			if (soundcloudError) {
				throw new Error(
					`DownloadGater SoundCloud unlock failed: ${soundcloudError}`,
				);
			}

			await this.clickUnlockFinishIfPresent(active);

			if (await this.hasDownloadButton(active)) {
				await timeout(500);
				return;
			}

			// Unlock query is present briefly, then stripped into localStorage by the SPA.
			if (/[?&]unlock=/i.test(url)) {
				await timeout(1_500);
				return;
			}

			if (!page.isClosed()) {
				const pane = await this.detectPane(page);
				if (pane === 'download' || pane === 'instagram') {
					await timeout(500);
					return;
				}
			}

			await timeout(400);
		}

		throw new Error(
			'DownloadGater did not unlock after SoundCloud OAuth. Check Allow was clicked / Initialize Logins.',
		);
	}

	private async findSoundcloudOauthPage(
		gatePage: Page,
		pagesBefore: Set<Page>,
	): Promise<Page | null> {
		const pages = await this.browser.pages(true);

		const byAuthorizeUrl = pages.find((candidate) => {
			if (candidate.isClosed()) return false;
			return /secure\.soundcloud\.com\/authorize|soundcloud\.com\/.*\/?authorize/i.test(
				candidate.url(),
			);
		});
		if (byAuthorizeUrl) return byAuthorizeUrl;

		if (!gatePage.isClosed()) {
			const gateUrl = gatePage.url();
			if (/soundcloud\.com|secure\.soundcloud\.com/i.test(gateUrl)) {
				return gatePage;
			}
		}

		return (
			pages.find((candidate) => {
				if (candidate === gatePage || candidate.isClosed()) return false;
				const candidateUrl = candidate.url();
				return (
					/soundcloud\.com|secure\.soundcloud\.com/i.test(candidateUrl) ||
					(!pagesBefore.has(candidate) &&
						candidateUrl !== 'about:blank' &&
						/soundcloud/i.test(candidateUrl))
				);
			}) ?? null
		);
	}

	private async findPageWithApprovalButton(): Promise<Page | null> {
		for (const candidate of await this.browser.pages(true)) {
			if (candidate.isClosed()) continue;
			try {
				for (const frame of candidate.frames()) {
					const handle = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
					if (handle) {
						await handle.dispose();
						return candidate;
					}
				}
			} catch {
				// page/frame navigated
			}
		}
		return null;
	}

	/** Approve OAuth only — never the sign-in email "Continue". */
	private async clickSoundcloudOauthAllow(oauthPage: Page): Promise<boolean> {
		try {
			await oauthPage.bringToFront();
		} catch {
			// tab may be navigating
		}

		const needsLogin = await oauthPage
			.evaluate(() =>
				/sign in or create an account/i.test(document.body?.innerText || ''),
			)
			.catch(() => false);

		// Trusted pointer click — authorize ignores plain DOM click() under CloakBrowser.
		for (const frame of oauthPage.frames()) {
			try {
				const submit = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
				if (submit) {
					await submit.click({ delay: 40 });
					console.log(
						'DownloadGater: clicked SoundCloud OAuth submit_approval',
					);
					return true;
				}
			} catch {
				// frame detached / navigated
			}
		}

		for (const frame of oauthPage.frames()) {
			try {
				const clicked = await frame.evaluate(() => {
					const approve = Array.from(document.querySelectorAll('button')).find(
						(btn) =>
							/^(connect|allow|authorize|accept)$/i.test(
								(btn.textContent || '').trim(),
							) && !(btn as HTMLButtonElement).disabled,
					) as HTMLButtonElement | undefined;
					if (!approve) return null;
					approve.click();
					return (approve.textContent || '').trim();
				});
				if (clicked) {
					console.log(`DownloadGater: clicked SoundCloud OAuth ${clicked}`);
					return true;
				}
			} catch {
				// frame detached / navigated
			}
		}

		if (needsLogin) {
			throw new Error(
				'SoundCloud is not logged in. Run Initialize Logins (or CLI initializeLogins) first.',
			);
		}

		return false;
	}

	private async handleDownload(page: Page) {
		this.emitProgress('downloading', 'Preparing DownloadGater download...', 75);

		const client = await page.createCDPSession();
		await client.send('Browser.setDownloadBehavior', {
			behavior: 'allow',
			downloadPath: './downloads',
			eventsEnabled: true,
		});

		let downloadGuid: string | null = null;
		let downloadCompleteResolve: (value: string) => void;
		let downloadCompleteReject: (reason: Error) => void;
		const downloadCompletePromise = new Promise<string>((resolve, reject) => {
			downloadCompleteResolve = resolve;
			downloadCompleteReject = reject;
		});
		const downloadTimer = setTimeout(
			() =>
				downloadCompleteReject(
					new Error('DownloadGater download did not complete in time'),
				),
			5 * 60_000,
		);

		const pBar = new SingleBar(
			{
				format:
					'{prefix} {bar} {percentage}% | {current_mb}/{total_mb} MB | ETA: {eta_formatted}',
				hideCursor: true,
			},
			{
				barCompleteChar: '█',
				barIncompleteChar: '░',
				format: Presets.shades_classic.format,
			},
		);

		client.on('Browser.downloadWillBegin', (event) => {
			downloadGuid = event.guid;
			this.downloadFilename = event.suggestedFilename;
			console.log('Download started:', this.downloadFilename);
			this.emitProgress(
				'downloading',
				`Downloading ${this.downloadFilename}...`,
				76,
			);
		});

		client.on('Browser.downloadProgress', (event) => {
			if (event.guid !== downloadGuid || !this.downloadFilename) return;
			if (event.state === 'completed') {
				pBar.stop();
				console.log('Download completed');
				this.emitProgress('downloading', 'Download complete', 85);
				downloadCompleteResolve(this.downloadFilename);
			} else if (event.state === 'inProgress') {
				const { receivedBytes, totalBytes } = event;
				if (pBar.isActive) {
					pBar.update(receivedBytes, {
						total_mb: Number((totalBytes / 1024 / 1024).toFixed(2)),
						current_mb: Number((receivedBytes / 1024 / 1024).toFixed(2)),
					});
				} else {
					pBar.start(totalBytes, receivedBytes, { prefix: 'Downloading' });
				}
				const downloadPercent = totalBytes > 0 ? receivedBytes / totalBytes : 0;
				this.emitProgress(
					'downloading',
					`Downloading... ${(receivedBytes / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
					76 + downloadPercent * 8,
					{ downloadBytes: receivedBytes, totalBytes },
				);
			} else if (event.state === 'canceled') {
				pBar.stop();
				downloadCompleteReject(new Error('Download was canceled'));
			}
		});

		const clickDownload = async () => {
			await page.evaluate(() => {
				const btn = Array.from(document.querySelectorAll('button')).find((el) =>
					/^(download file|download zip)$/i.test((el.textContent || '').trim()),
				) as HTMLButtonElement | undefined;
				btn?.click();
			});
		};

		setTimeout(async () => {
			if (!downloadGuid) {
				console.log(
					'Download not started after 10 seconds, clicking button again...',
				);
				try {
					await clickDownload();
				} catch {
					// ignore
				}
			}
		}, 10_000);

		try {
			await clickDownload();
			await downloadCompletePromise;
		} finally {
			clearTimeout(downloadTimer);
			pBar.stop();
			await client.detach().catch(() => {});
		}
	}
}
