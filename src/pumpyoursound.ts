import type { Browser, Page } from 'puppeteer';
import { browserModeToLaunchOptions, launchAppBrowser } from './browserLaunch';
import { DirectDownloader } from './directDownload';
import type { ProgressCallback } from './hypeddit';
import Selectors from './selectors';
import type { HypedditConfig } from './types';
import { loadCookies, timeout, trimExtractedUrl } from './utils';

const SC_AUTHORIZE_RE = /secure\.soundcloud\.com\/authorize/i;

/**
 * PumpYourSound fangate downloader.
 *
 * Flow (from live repro):
 * 1. Complete SC Follow via SC.connect popup → Allow →
 *    `/?do=mySoundcloud*` → `/auth/soundcloud-events/`
 * 2. Mark Instagram/YouTube/Facebook via `/auth/...` AJAX (popup can be closed)
 * 3. Optional SC comment via `/auth/sc-comment/`
 * 4. POST free-download form → 303 `/fangate/download/{id}?downloadLink=...`
 * 5. Fetch `downloadLink` / `data-redirect-link` via DirectDownloader
 */
export class PumpyoursoundDownloader {
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
			...browserModeToLaunchOptions(this.config.browserMode),
			userDataDir: this.config.userDataDir ?? './browser-data',
			// SC.connect authorize popup shares session cookies more reliably with this.
			args: ['--fingerprint-allow-3p-cookies'],
		});

		const browserContext = this.browser.defaultBrowserContext();
		const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
		await browserContext.setCookie(...soundCloudCookies);
	}

	async prepareLogins() {
		const soundCloudPage = await this.browser.newPage();
		await soundCloudPage.setViewport({ width: 1920, height: 1080 });
		await soundCloudPage.goto('https://soundcloud.com/messages');

		try {
			await soundCloudPage.waitForSelector(
				Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER,
				{ timeout: 5_000 },
			);
			console.log(
				'PumpYourSound: SoundCloud captcha present during login warm-up; solve it in the browser window if needed.',
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
		console.log('Navigating to PumpYourSound gate...');
		this.emitProgress(
			'handling_gates',
			'Navigating to PumpYourSound gate...',
			25,
		);

		const page = await this.browser.newPage();
		try {
			await page.setViewport({ width: 1920, height: 1080 });
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
			try {
				await page.waitForNetworkIdle({ timeout: 15_000, idleTime: 10 });
			} catch {
				// continue
			}

			await this.dismissOverlays(page);
			await this.completeGateSteps(page);

			const fileUrl = await this.submitAndReadDownloadLink(page);
			console.log('PumpYourSound download link:', fileUrl);
			this.emitProgress(
				'handling_gates',
				'Downloading PumpYourSound file...',
				80,
			);

			const direct = new DirectDownloader();
			if (this.progressCallback) {
				direct.setProgressCallback(this.progressCallback);
			}
			this.downloadFilename = await direct.downloadAudio(fileUrl);
			return this.downloadFilename;
		} finally {
			await page.close().catch(() => {});
		}
	}

	async close() {
		await this.browser?.close();
	}

	private async dismissOverlays(page: Page) {
		await page.evaluate(() => {
			document
				.querySelector<HTMLElement>(
					'#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept',
				)
				?.click();
			for (const btn of document.querySelectorAll('button')) {
				if (/^no$/i.test((btn.textContent || '').trim())) {
					btn.click();
				}
			}
		});
		await timeout(400);
	}

	private async completeGateSteps(page: Page) {
		const deadline = Date.now() + 240_000;
		let loops = 0;
		while (Date.now() < deadline && loops++ < 14) {
			const status = await this.readStepStatus(page);
			console.log('PumpYourSound steps:', status);

			if (status.length > 0 && status.every((s) => s.done)) {
				return;
			}

			const needSc = status.some((s) => s.kind === 'soundcloud' && !s.done);
			const needComment = status.some((s) => s.kind === 'comment' && !s.done);
			const needSocial = status.some(
				(s) =>
					(s.kind === 'instagram' ||
						s.kind === 'facebook' ||
						s.kind === 'youtube' ||
						s.kind === 'twitter') &&
					!s.done,
			);

			if (needSc) {
				this.emitProgress(
					'handling_gates',
					'Connecting SoundCloud on PumpYourSound...',
					40,
					{ currentGate: 'sc' },
				);
				await this.handleSoundcloudFollow(page);
				continue;
			}

			if (needSocial) {
				this.emitProgress(
					'handling_gates',
					'Handling PumpYourSound social step...',
					55,
					{ currentGate: 'social' },
				);
				const clicked = await this.handleSocialMarkComplete(page);
				if (!clicked) {
					throw new Error(
						'PumpYourSound social step is incomplete but no mark-complete control was found.',
					);
				}
				await timeout(1_200);
				continue;
			}

			if (needComment) {
				this.emitProgress(
					'handling_gates',
					'Sending SoundCloud comment on PumpYourSound...',
					65,
					{ currentGate: 'sc' },
				);
				await this.handleComment(page);
				continue;
			}

			// Email-only / unknown remaining UI — try continuing to download.
			if (status.length === 0) {
				return;
			}
			throw new Error(
				`Unsupported PumpYourSound gate steps: ${status
					.filter((s) => !s.done)
					.map((s) => s.kind)
					.join(', ')}`,
			);
		}

		const finalStatus = await this.readStepStatus(page);
		if (!(finalStatus.length > 0 && finalStatus.every((s) => s.done))) {
			throw new Error(
				'PumpYourSound gate steps did not complete in time. Check SoundCloud login / Allow OAuth.',
			);
		}
	}

	private async readStepStatus(
		page: Page,
	): Promise<{ kind: string; done: boolean }[]> {
		return page.evaluate(() => {
			return Array.from(document.querySelectorAll('.fangateStep')).map((el) => {
				const cls = el.className;
				const kind =
					cls.match(/fangateStep--([a-z]+)/i)?.[1]?.toLowerCase() || 'unknown';
				return { kind, done: el.classList.contains('done') };
			});
		});
	}

	private async handleSoundcloudFollow(page: Page) {
		const clicked = await page.evaluate(() => {
			const el = document.querySelector<HTMLElement>(
				'.socBtn__soundcloud.sn-connect-with-soundcloud',
			);
			if (!el) return false;
			el.click();
			return true;
		});
		if (!clicked) {
			throw new Error('PumpYourSound SoundCloud Follow button not found.');
		}
		await this.completeSoundcloudOauth(page, 'soundcloud');
	}

	private async handleComment(page: Page) {
		const comment = this.config.comment.trim();
		if (comment.length < 2) {
			throw new Error(
				'This PumpYourSound gate requires SC_COMMENT (at least 2 characters).',
			);
		}

		await page.evaluate((text) => {
			const input = document.querySelector<HTMLInputElement>(
				'input[name="fangate_comment"], input.fangatex__icomment',
			);
			if (input) {
				input.value = text;
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			}
			const send = document.querySelector<HTMLElement>('#fangate-send-comment');
			const href = send?.getAttribute('data-href');
			if (send && href) {
				const u = new URL(href, location.origin);
				u.searchParams.set('text', text);
				send.setAttribute('data-href', `${u.pathname}${u.search}`);
			}
			if (!send) {
				throw new Error('PumpYourSound comment send button not found.');
			}
			send.click();
		}, comment);

		await this.completeSoundcloudOauth(page, 'comment');
	}

	/**
	 * Wait for authorize + #submit_approval, click Allow, then wait until the
	 * matching fangate step is marked done. Never force-closes the Allow tab.
	 */
	private async completeSoundcloudOauth(
		gatePage: Page,
		expect: 'soundcloud' | 'comment',
	) {
		const deadline = Date.now() + 180_000;
		let lastLog = 0;
		let lastAllowAt = 0;

		while (Date.now() < deadline) {
			if (gatePage.isClosed()) {
				throw new Error(
					'PumpYourSound gate tab closed during SoundCloud OAuth.',
				);
			}

			const done = await gatePage
				.evaluate((kind) => {
					const sel =
						kind === 'comment'
							? '.fangateStep--comment.done'
							: '.fangateStep--soundcloud.done';
					return !!document.querySelector(sel);
				}, expect)
				.catch(() => false);
			if (done) {
				console.log(`PumpYourSound: ${expect} step marked done`);
				return;
			}

			const authorizePage = await this.findAuthorizePageWithAllow();
			if (authorizePage) {
				const canRetry = Date.now() - lastAllowAt > 4_000;
				if (lastAllowAt === 0 || canRetry) {
					const method = await this.clickSoundcloudAllow(authorizePage);
					console.log(
						`PumpYourSound: Allow → ${method} (${authorizePage.url().slice(0, 100)})`,
					);
					if (method !== 'miss') {
						lastAllowAt = Date.now();
						await timeout(2_000);
						continue;
					}
				}
			}

			for (const candidate of await this.browser.pages(true)) {
				if (candidate.isClosed() || candidate === gatePage) continue;
				if (!SC_AUTHORIZE_RE.test(candidate.url())) continue;
				const needsLogin = await candidate
					.evaluate(async () => {
						const loginRe = /sign in or create an account/i;
						if (!loginRe.test(document.body?.innerText || '')) return false;
						await new Promise((r) => setTimeout(r, 1_500));
						const text = document.body?.innerText || '';
						const hasAllow = !!document.querySelector('#submit_approval');
						return loginRe.test(text) && !hasAllow;
					})
					.catch(() => false);
				if (needsLogin) {
					throw new Error(
						'SoundCloud is not logged in for PumpYourSound OAuth. Run Initialize Logins (or CLI initializeLogins) first.',
					);
				}
			}

			if (Date.now() - lastLog > 5_000) {
				const urls = (await this.browser.pages(true)).map((p) =>
					p.isClosed() ? '(closed)' : p.url().slice(0, 100),
				);
				console.log('PumpYourSound OAuth waiting…', urls.join(' | '));
				lastLog = Date.now();
			}

			await timeout(400);
		}

		throw new Error(
			`Timed out waiting for PumpYourSound ${expect} step after SoundCloud OAuth.`,
		);
	}

	private async findAuthorizePageWithAllow(): Promise<Page | null> {
		const pages = (await this.browser.pages(true)).filter((p) => !p.isClosed());
		for (const candidate of [...pages].reverse()) {
			if (!SC_AUTHORIZE_RE.test(candidate.url())) continue;
			try {
				for (const frame of candidate.frames()) {
					const handle = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
					if (handle) {
						await handle.dispose().catch(() => {});
						return candidate;
					}
				}
			} catch {
				// navigated
			}
		}
		return null;
	}

	private async clickSoundcloudAllow(oauthPage: Page): Promise<string> {
		await oauthPage.bringToFront().catch(() => {});
		for (const frame of oauthPage.frames()) {
			try {
				const submit = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
				if (submit) {
					await submit.click({ delay: 40 });
					return 'submit_approval';
				}
			} catch {
				// frame gone
			}
		}
		for (const frame of oauthPage.frames()) {
			try {
				const clicked = await frame.evaluate(() => {
					const btn = Array.from(document.querySelectorAll('button')).find(
						(b) =>
							/^(allow|accept|connect)$/i.test((b.textContent || '').trim()),
					) as HTMLButtonElement | undefined;
					if (!btn) return null;
					btn.click();
					return (btn.textContent || '').trim();
				});
				if (clicked) return clicked;
			} catch {
				// ignore
			}
		}
		return 'miss';
	}

	private async handleSocialMarkComplete(page: Page): Promise<boolean> {
		const href = await page.evaluate(() => {
			const candidates: { sel: string; step: string }[] = [
				{ sel: '#instagram_follow a[data-href]', step: 'instagram' },
				{ sel: '.instagram_follow_box[data-href]', step: 'instagram' },
				{ sel: '#facebook_follow a[data-href]', step: 'facebook' },
				{ sel: 'a[href*="youtube-follow"]', step: 'youtube' },
				{
					sel: 'a[href*="markFacebookStepAsComplete"]',
					step: 'facebook',
				},
			];
			for (const { sel, step } of candidates) {
				const el = document.querySelector<HTMLElement>(sel);
				if (!el) continue;
				const stepEl =
					document.querySelector(`.fangateStep--${step}:not(.done)`) ||
					el.closest('li')?.querySelector('.fangateStep:not(.done)');
				if (!stepEl && step !== 'facebook') {
					// Skip always-present modal links when that step isn't on the fangate.
					if (
						step === 'youtube' &&
						!document.querySelector('.fangateStep--youtube:not(.done)')
					) {
						continue;
					}
				}
				if (
					document.querySelector(`.fangateStep--${step}.done`) &&
					step !== 'facebook'
				) {
					continue;
				}
				if (stepEl?.classList.contains('done')) continue;
				el.click();
				return el.getAttribute('data-href') || el.getAttribute('href');
			}
			return null;
		});
		if (!href) return false;
		console.log('PumpYourSound social mark-complete:', href);
		await timeout(2_000);
		for (const p of await this.browser.pages(true)) {
			if (p === page || p.isClosed()) continue;
			if (/instagram\.com|youtube\.com|facebook\.com/i.test(p.url())) {
				await p.close().catch(() => {});
			}
		}
		return true;
	}

	private async submitAndReadDownloadLink(page: Page): Promise<string> {
		this.emitProgress(
			'handling_gates',
			'Submitting PumpYourSound download...',
			75,
		);

		const emailRequired = await page.$('#frm-freeDownloadForm-email');
		if (emailRequired) {
			const email = this.config.email?.trim();
			if (!email) {
				throw new Error(
					'This PumpYourSound gate requires an email. Set HYPEDDIT_EMAIL in your .env file.',
				);
			}
			await page.evaluate((value) => {
				const modalToggle = document.querySelector<HTMLElement>(
					'a[href="#confirm-email-subscription"]',
				);
				modalToggle?.click();
				const input = document.querySelector<HTMLInputElement>(
					'#frm-freeDownloadForm-email',
				);
				if (input) {
					input.value = value;
					input.dispatchEvent(new Event('input', { bubbles: true }));
				}
			}, email);
			await timeout(400);
		}

		const navigation = page
			.waitForNavigation({
				waitUntil: 'domcontentloaded',
				timeout: 60_000,
			})
			.catch(() => null);

		try {
			await page.evaluate(() => {
				const submit = document.querySelector<HTMLInputElement>(
					'#frm-freeDownloadForm input[type="submit"][name="send"]',
				);
				if (submit) {
					submit.click();
					return;
				}
				document
					.querySelector<HTMLFormElement>('#frm-freeDownloadForm')
					?.requestSubmit();
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				!/Execution context was destroyed|Cannot find context|frame was detached|Navigating frame/i.test(
					message,
				)
			) {
				throw error;
			}
			// Form submit navigated away — expected.
		}

		await navigation;

		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			try {
				const fromUrl = new URL(page.url()).searchParams.get('downloadLink');
				if (fromUrl) return trimExtractedUrl(fromUrl);
			} catch {
				// ignore
			}
			const link = await this.readDownloadLink(page).catch(() => null);
			if (link) return link;
			await timeout(400);
		}

		throw new Error(
			'PumpYourSound download page never exposed a downloadLink after form submit. Incomplete gate steps?',
		);
	}

	private async readDownloadLink(page: Page): Promise<string | null> {
		if (page.isClosed()) return null;
		try {
			const fromUrl = new URL(page.url()).searchParams.get('downloadLink');
			if (fromUrl) return trimExtractedUrl(fromUrl);
		} catch {
			// ignore
		}
		return page
			.evaluate(() => {
				const fromData = document
					.querySelector('.fangateDownload')
					?.getAttribute('data-redirect-link');
				if (fromData) return fromData;
				try {
					const fromQuery = new URL(location.href).searchParams.get(
						'downloadLink',
					);
					return fromQuery;
				} catch {
					return null;
				}
			})
			.then((value) => (value ? trimExtractedUrl(value) : null));
	}
}
