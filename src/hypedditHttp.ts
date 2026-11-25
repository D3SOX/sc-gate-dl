import { rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { filenameFromContentDisposition } from './contentDisposition';
import { createDownloadBar } from './downloadBar';
import { reserveDownloadFilename } from './downloadRename';
import type { ProgressCallback } from './hypeddit';
import { inspectHypedditPage, NoHypedditDownloadError } from './hypedditLinks';
import type { HypedditConfig } from './types';
import { sanitizeFilenamePart } from './utils';

// Steps whose Hypeddit "gate" is purely client-side: clicking through them only
// toggles CSS classes and, on the download request, declares the step as skipped
// via skip_gate_steps[]. The server performs no verification for these, so they
// can be satisfied without a browser. Steps that are actually verified server-side
// (e.g. Spotify `sp`, which needs a real OAuth authorization) are intentionally
// excluded so the caller falls back to the browser flow.
const BROWSERLESS_STEPS = new Set([
	'email',
	'sc',
	'ig',
	'tk',
	'yt',
	'fb',
	'dn',
]);
// Gates whose step markup decides whether they are client-side: X/Twitter is
// either per-account visit buttons (`#twitter_status`, completed by
// `#skipper_tw_next`) or an OAuth connect (`#login_to_tw`) that the page never
// declares as skipped.
const BROWSERLESS_WHEN_MARKUP: Record<string, RegExp> = {
	tw: /\bid\s*=\s*["']twitter_status["']/,
};
// The page's "Skip donation" link only advances the slide; it adds nothing to
// skip_gate_steps[], so neither do we.
const UNDECLARED_STEPS = new Set(['dn']);

/** Config errors must not fall through as "try the browser" — browser fails the same way. */
export class BrowserlessConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BrowserlessConfigError';
	}
}

const HYPEDDIT_ORIGIN = 'https://hypeddit.com';
const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface GateData {
	csrfToken: string;
	gvt: string;
	uid: string;
	/** Flat `#nwSteps`, sent back as `steps` like the page does. */
	steps: string[];
	wrndk: string;
	fanGateId: string;
	isSkippable: string;
	externalId: string;
	duration: number;
}

function matchHiddenInput(html: string, id: string): string | null {
	const patterns = [
		new RegExp(`id=["']${id}["'][^>]*value=["']([^"']*)["']`),
		new RegExp(`value=["']([^"']*)["'][^>]*id=["']${id}["']`),
	];
	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1] !== undefined) {
			return match[1];
		}
	}
	return null;
}

function parseGateData(html: string): GateData | null {
	const csrfToken = html.match(
		/name=["']csrf-token["'][^>]*content=["']([^"']+)["']/,
	)?.[1];
	const gvt = matchHiddenInput(html, 'gvt');
	const uid = matchHiddenInput(html, 'current_download_file_listner');
	const rawSteps = matchHiddenInput(html, 'nwSteps');
	const wrndk = matchHiddenInput(html, 'wrndk');
	const fanGateId = matchHiddenInput(html, 'fan_gate_id');

	if (!csrfToken || !gvt || !uid || !rawSteps || !wrndk || !fanGateId) {
		return null;
	}

	const externalId =
		html.match(/externID["']?\s*:\s*["']([^"']+)["']/)?.[1] ?? '';
	const durationRaw = Number(matchHiddenInput(html, 'duration'));
	const duration =
		Number.isFinite(durationRaw) && durationRaw > 0
			? durationRaw
			: 3 * 60 * 1000;

	return {
		csrfToken,
		gvt,
		uid,
		steps: rawSteps.split(',').filter(Boolean),
		wrndk,
		fanGateId,
		isSkippable: matchHiddenInput(html, 'is_skippable') ?? '0',
		externalId,
		duration,
	};
}

/**
 * Either-or step groups, e.g. `[['email'], ['sc', 'yt', 'sp'], ['ig']]`.
 * `#nwSteps` is flat; `#steps_select` holds the groups the visible steps list
 * shows, after the download slide: `dw,email,sc|yt|sp,ig`. The page's
 * jumpGate() indexes it by the slide's data-group.
 */
export function parseStepGroups(html: string): string[][] {
	const groups = (matchHiddenInput(html, 'steps_select') ?? '')
		.split(',')
		.filter((group) => group && group !== 'dw')
		.map((group) => group.split('|').filter(Boolean));
	if (groups.length) return groups;
	return (matchHiddenInput(html, 'nwSteps') ?? '')
		.split(',')
		.filter(Boolean)
		.map((step) => [step]);
}

export interface BrowserlessPlan {
	/** Alternative picked for each group, in page order. */
	chosen: string[];
	/** What the page would collect in skip_gate_steps[] for these choices. */
	skipGateSteps: string[];
}

/**
 * Pick one browserless alternative per either-or group, or return the groups
 * that need a browser. Email is the last resort in a group so no address is
 * submitted when another alternative works.
 */
export function planBrowserlessGate(
	html: string,
): BrowserlessPlan | { unsupported: string[] } {
	const capable = (step: string) =>
		BROWSERLESS_STEPS.has(step) ||
		(BROWSERLESS_WHEN_MARKUP[step]?.test(html) ?? false);
	const chosen: string[] = [];
	const skipGateSteps: string[] = [];
	const unsupported: string[] = [];
	for (const group of parseStepGroups(html)) {
		const options = group.filter(capable);
		const pick = options.find((step) => step !== 'email') ?? options[0];
		if (!pick) {
			unsupported.push(group.join('|'));
			continue;
		}
		chosen.push(pick);
		// jumpGate() declares the alternatives not taken as skipped, and each
		// client-side step's Next/skip button declares the step itself.
		for (const step of group) {
			if (step === pick && (step === 'email' || UNDECLARED_STEPS.has(step)))
				continue;
			skipGateSteps.push(step);
		}
	}
	return unsupported.length ? { unsupported } : { chosen, skipGateSteps };
}

// Smart-link selection pages list multiple platforms; follow the Hypeddit anchor.
function findSmartLinkHypedditUrl(html: string): string | null {
	const anchor = html.match(
		/<a[^>]*data-type=["']hypeddit["'][^>]*href=["']([^"']+)["']/,
	)?.[1];
	if (anchor) {
		return anchor;
	}
	return (
		html.match(
			/<a[^>]*href=["']([^"']+)["'][^>]*data-type=["']hypeddit["']/,
		)?.[1] ?? null
	);
}

export class HypedditHttpDownloader {
	private readonly config: HypedditConfig;
	private readonly progressCallback: ProgressCallback | null;
	private cookies = new Map<string, string>();
	private csrfToken = '';
	private abortController = new AbortController();

	constructor(config: HypedditConfig, progressCallback?: ProgressCallback) {
		this.config = config;
		this.progressCallback = progressCallback ?? null;
	}

	async close(): Promise<void> {
		this.abortController.abort();
	}

	// Attempts to download the file without a browser. Returns the saved filename,
	// or null if the gate needs real verification and the browser flow must be used.
	async tryDownload(url: string): Promise<string | null> {
		try {
			const { html, finalUrl } = await this.fetchGatePage(url);
			// Link gates grant a destination, not a file. Let the normal browser
			// Unlock action complete before handing that destination to its downloader.
			if (/\bdata-type\s*=\s*["']linkGate["']/i.test(html)) return null;
			const gate = parseGateData(html);
			if (!gate) {
				console.log(
					'Browserless: could not parse gate data, falling back to browser',
				);
				return null;
			}
			this.csrfToken = gate.csrfToken;

			const plan = planBrowserlessGate(html);
			if ('unsupported' in plan) {
				console.log(
					`Browserless: gate has steps requiring a browser (${plan.unsupported.join(', ')}), falling back`,
				);
				return null;
			}
			const needsEmail = plan.chosen.includes('email');

			if (needsEmail && !this.config.email) {
				throw new BrowserlessConfigError(
					'This Hypeddit gate requires an email. Set HYPEDDIT_EMAIL in your .env file.',
				);
			}

			console.log(
				`Browserless: attempting HTTP download for gates [${plan.chosen.join(', ')}]`,
			);
			this.progressCallback?.(
				'handling_gates',
				'Handling gates without browser...',
				40,
			);

			await this.post('/gate/ge', finalUrl, {
				vt: gate.gvt,
				uid: gate.uid,
			});

			if (needsEmail) {
				await this.post('/verifyEmailAddress', finalUrl, {
					validateEmailAddress: this.config.email as string,
					fan_gate_id: gate.fanGateId,
					email_name: this.config.name ?? '',
					adcode: '',
					hypesource: '',
				});
			}

			const downloadUrl = await this.requestDownload(
				gate,
				plan.skipGateSteps,
				needsEmail,
				finalUrl,
			);
			if (!downloadUrl) {
				console.log(
					'Browserless: server did not grant download, falling back to browser',
				);
				return null;
			}

			return await this.saveFile(downloadUrl);
		} catch (error) {
			if (this.abortController.signal.aborted) {
				throw new Error('Download cancelled');
			}
			if (
				error instanceof BrowserlessConfigError ||
				error instanceof NoHypedditDownloadError
			) {
				throw error;
			}
			console.log(
				`Browserless attempt failed (${error instanceof Error ? error.message : 'unknown error'}), falling back to browser`,
			);
			return null;
		}
	}

	private async requestDownload(
		gate: GateData,
		skipGateSteps: string[],
		withEmail: boolean,
		referer: string,
	): Promise<string | null> {
		const body = new URLSearchParams({
			file: gate.uid,
			download_visit: 'true',
			profile_downloads: 'true',
			time: String(Math.floor(Math.random() * gate.duration)),
			sc_comment_text: '',
			yt_comment_text: '',
			page: 'nonsingle',
			is_skippable: gate.isSkippable,
			steps: gate.steps.join(','),
			email: withEmail ? (this.config.email ?? '') : '',
			download_action: 'DOWNLOAD',
			wrndk: gate.wrndk,
			is_mobile: '',
			external_id: gate.externalId,
			hypesource: '',
			adcode: '',
			gvf: '0',
		});
		for (const step of skipGateSteps) body.append('skip_gate_steps[]', step);

		const response = await this.post('/gate/download/ul', referer, body);
		const result = (await response.json()) as {
			download_status?: boolean;
			URL?: string;
		};
		if (result.download_status && result.URL) {
			return result.URL;
		}
		return null;
	}

	private async saveFile(downloadUrl: string): Promise<string> {
		this.progressCallback?.('downloading', 'Downloading file...', 0);
		const response = await fetch(downloadUrl, {
			signal: this.abortController.signal,
		});
		if (!response.ok) {
			throw new Error(`Download request failed: ${response.status}`);
		}

		const suggestedFilename =
			filenameFromContentDisposition(
				response.headers.get('content-disposition'),
			) ??
			filenameFromContentDisposition(
				new URL(downloadUrl).searchParams.get('response-content-disposition'),
			) ??
			'download';
		const filename =
			sanitizeFilenamePart(basename(suggestedFilename)) || 'download';

		const totalBytes = Number(response.headers.get('content-length')) || 0;
		const reservedFilename = await reserveDownloadFilename(
			'./downloads',
			filename,
		);
		const destPath = join('./downloads', reservedFilename);
		const tempPath = `${destPath}.${crypto.randomUUID()}.part`;
		const writer = Bun.file(tempPath).writer();
		const bar = createDownloadBar(totalBytes);
		let receivedBytes = 0;
		let lastEmit = 0;
		let succeeded = false;

		try {
			if (response.body) {
				const reader = response.body.getReader();
				while (true) {
					const { done, value: chunk } = await reader.read();
					if (done) {
						break;
					}
					writer.write(chunk);
					receivedBytes += chunk.byteLength;
					bar.update(receivedBytes);

					// throttle progress events to avoid flooding the SSE stream
					const now = Date.now();
					if (now - lastEmit > 250 && totalBytes > 0) {
						lastEmit = now;
						this.progressCallback?.(
							'downloading',
							`Downloading... ${(receivedBytes / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
							0,
							{ downloadBytes: receivedBytes, totalBytes, browserless: true },
						);
					}
				}
			}
			await writer.end();
			bar.stop();
			if (this.abortController.signal.aborted) {
				throw new Error('Download cancelled');
			}
			await rename(tempPath, destPath);
			succeeded = true;
		} finally {
			if (!succeeded) {
				bar.stop(false);
				try {
					await writer.end();
				} catch {
					// Writer may already be closed or never flushed.
				}
				await rm(tempPath, { force: true }).catch(() => {});
				await rm(destPath, { force: true }).catch(() => {});
			}
		}

		console.log(`Browserless: downloaded ${reservedFilename}`);
		this.progressCallback?.('downloading', 'Download complete', 100);
		return reservedFilename;
	}

	private async fetchGatePage(
		url: string,
	): Promise<{ html: string; finalUrl: string }> {
		this.progressCallback?.('handling_gates', 'Fetching Hypeddit gate...', 30);
		let finalUrl = url;
		let html = await this.get(finalUrl);

		// A custom smartlink button can point to a real Hypeddit gate too.
		const visited = new Set([finalUrl]);
		for (let hop = 0; hop < 5 && !matchHiddenInput(html, 'gvt'); hop++) {
			const smartLinkUrl =
				inspectHypedditPage(html, finalUrl) || findSmartLinkHypedditUrl(html);
			if (smartLinkUrl) {
				if (visited.has(smartLinkUrl))
					throw new Error('Hypeddit smartlink loop detected.');
				visited.add(smartLinkUrl);
				console.log(`Browserless: following smart link to ${smartLinkUrl}`);
				finalUrl = smartLinkUrl;
				html = await this.get(finalUrl);
			} else break;
		}

		return { html, finalUrl };
	}

	private async get(url: string): Promise<string> {
		const response = await fetch(url, {
			headers: { 'User-Agent': USER_AGENT },
			redirect: 'follow',
			signal: this.abortController.signal,
		});
		this.storeCookies(response);
		return await response.text();
	}

	private async post(
		path: string,
		referer: string,
		body: Record<string, string> | URLSearchParams,
	): Promise<Response> {
		const params =
			body instanceof URLSearchParams ? body : new URLSearchParams(body);
		const response = await fetch(`${HYPEDDIT_ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				'User-Agent': USER_AGENT,
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
				Accept: 'application/json, text/javascript, */*; q=0.01',
				'X-Requested-With': 'XMLHttpRequest',
				'X-CSRF-TOKEN': this.csrfToken,
				Origin: HYPEDDIT_ORIGIN,
				Referer: referer,
				Cookie: this.cookieHeader(),
			},
			body: params.toString(),
			signal: this.abortController.signal,
		});
		this.storeCookies(response);
		return response;
	}

	private storeCookies(response: Response): void {
		const setCookie = response.headers.getSetCookie?.() ?? [];
		for (const entry of setCookie) {
			const pair = entry.split(';')[0] ?? '';
			const eq = pair.indexOf('=');
			if (eq > 0) {
				this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
			}
		}
	}

	private cookieHeader(): string {
		return Array.from(this.cookies.entries())
			.map(([name, value]) => `${name}=${value}`)
			.join('; ');
	}
}
