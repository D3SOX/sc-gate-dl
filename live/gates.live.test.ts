/**
 * Live tests against real gates, Bandcamp, file hosts and SoundCloud.
 *
 * Run them from a checkout with a working setup (.env, cookies, config.json,
 * browser-data with an initialized SoundCloud login), because they use it:
 *
 *   bun run test:live                       # everything
 *   bun run test:live -t GateRush           # one platform
 *   bun run test:live -t "Smart links"      # resolution only, no downloads
 *   bun run test:live --todo                # also run known-unsupported cases
 *
 * Browser gates run headed on the current display, or under Xvfb without one
 * (LIVE_BROWSER_MODE overrides this), because SoundCloud blocks reposts from
 * headless browsers.
 *
 * A failure starting with LINK OFFLINE means the link was removed: replace it
 * with another live link covering the same steps (see live/cases.ts).
 *
 * Downloads go to ./downloads and are deleted afterwards. Browser gates follow,
 * like, repost and comment with the configured SoundCloud account and submit
 * HYPEDDIT_EMAIL. When config.json enables cleanupSoundCloudAccount, the
 * account is cleaned up after the run, like the CLI does.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDownloadedAudio } from '../src/archiveAudio';
import { isXvfbSupported } from '../src/browserLaunch';
import { loadConfig } from '../src/config';
import {
	DirectDownloader,
	normalizeDirectDownloadUrl,
} from '../src/directDownload';
import { DownloadgaterDownloader } from '../src/downloadgater';
import { DroploudDownloader } from '../src/droploud';
import { GaterushDownloader } from '../src/gaterush';
import { HypedditDownloader } from '../src/hypeddit';
import { HypedditHttpDownloader } from '../src/hypedditHttp';
import { MypresskitDownloader } from '../src/mypresskit';
import { PumpyoursoundDownloader } from '../src/pumpyoursound';
import { SoundcloudClient } from '../src/soundcloud';
import { StillhypeDownloader } from '../src/stillhype';
import {
	type BrowserMode,
	type HypedditConfig,
	isBrowserMode,
} from '../src/types';
import { getFfprobeBin, resolveGateUrlOrFollow } from '../src/utils';
import { YtDlpDownloader, type YtDlpDownloadOptions } from '../src/ytdlp';
import { LIVE_CASES, type LiveCase } from './cases';

const DOWNLOADS_DIR = './downloads';
const TIMEOUT_MS = 10 * 60_000;

const BROWSER_GATES = {
	droploud: DroploudDownloader,
	gaterush: GaterushDownloader,
	downloadgater: DownloadgaterDownloader,
	stillhype: StillhypeDownloader,
	pumpyoursound: PumpyoursoundDownloader,
	mypresskit: MypresskitDownloader,
};

const config = await loadConfig();
let browserGatesRan = false;
let soundcloudClient: SoundcloudClient | undefined;

/**
 * SoundCloud's bot protection rejects reposts from a headless browser, so run
 * headed on the display (on the Pi, the noVNC one, where you can watch), or
 * under Xvfb without one. LIVE_BROWSER_MODE overrides this.
 */
function browserMode(): BrowserMode {
	const override = process.env.LIVE_BROWSER_MODE;
	if (isBrowserMode(override)) return override;
	if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return 'headed';
	return isXvfbSupported() ? 'xvfb' : 'headless';
}

function gateConfig(): HypedditConfig {
	const comment = process.env.SC_COMMENT;
	if (!comment) throw new Error('SC_COMMENT is required in .env');
	return {
		name: process.env.HYPEDDIT_NAME,
		email: process.env.HYPEDDIT_EMAIL,
		comment,
		browserMode: browserMode(),
	};
}

/** A failed auto-match is a regression here, not a reason to ask. */
const failOnAlbumMatch: NonNullable<
	YtDlpDownloadOptions['onAlbumMatchFailed']
> = async (error) => {
	throw new Error(
		`No album track matched; candidates: ${error.tracks.map((t) => t.title).join(', ')}`,
	);
};

/** Same dispatch as the Web UI server, without its job bookkeeping. */
async function download(
	liveCase: LiveCase,
	provider: LiveCase['provider'],
	url: string,
): Promise<string | null> {
	const options = {
		matchTitle: liveCase.matchTitle,
		onAlbumMatchFailed: failOnAlbumMatch,
	};
	if (provider === 'bandcamp' || provider === 'soundcloud') {
		const label = provider === 'bandcamp' ? 'Bandcamp' : 'SoundCloud';
		return new YtDlpDownloader(label).downloadAudio(url, options);
	}
	if (provider === 'direct') {
		return new DirectDownloader().downloadAudio(url);
	}
	if (provider === 'hypeddit') {
		const http = new HypedditHttpDownloader(gateConfig());
		const filename = await http.tryDownload(url);
		if (filename || liveCase.browserless) {
			expect(filename, 'browserless Hypeddit download').toBeTruthy();
			return filename;
		}
	}
	browserGatesRan = true;
	const Downloader =
		provider === 'hypeddit' ? HypedditDownloader : BROWSER_GATES[provider];
	const downloader = new Downloader(gateConfig());
	try {
		await downloader.initialize();
		return await downloader.downloadAudio(url, options);
	} finally {
		await downloader.close();
	}
}

async function audioDuration(path: string): Promise<number> {
	const proc = Bun.spawn(
		[
			await getFfprobeBin(),
			'-v',
			'error',
			'-select_streams',
			'a:0',
			'-show_entries',
			'stream=codec_type:format=duration',
			'-of',
			'json',
			path,
		],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`ffprobe failed: ${stderr.trim()}`);
	const probe = JSON.parse(stdout) as {
		streams?: { codec_type?: string }[];
		format?: { duration?: string };
	};
	if (probe.streams?.[0]?.codec_type !== 'audio') {
		throw new Error(`${path} has no audio stream`);
	}
	return Number(probe.format?.duration ?? 0);
}

const BROWSER_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function offline(liveCase: LiveCase, why: string): Error {
	return new Error(
		`LINK OFFLINE (${why}): ${liveCase.url}\nReplace this case in live/cases.ts with a live link that covers: ${liveCase.covers}`,
	);
}

/**
 * Tells a removed link apart from a code regression. Only clear signs count;
 * anti-bot pages (403, 429, challenges) fall through to the real test.
 */
async function assertOnline(liveCase: LiveCase) {
	const response = await fetch(liveCase.url, {
		headers: { 'User-Agent': BROWSER_UA },
		redirect: 'follow',
		signal: AbortSignal.timeout(30_000),
	}).catch(() => null);
	if (!response) return;
	await response.body?.cancel();
	if (response.status === 404 || response.status === 410) {
		throw offline(liveCase, `HTTP ${response.status}`);
	}
	const finalUrl = new URL(response.url);
	// PumpYourSound sends removed gates to its homepage.
	if (
		finalUrl.hostname.endsWith('pumpyoursound.com') &&
		!finalUrl.pathname.startsWith('/f/')
	) {
		throw offline(liveCase, `redirected to ${response.url}`);
	}
	// Dropbox serves a page for dl=0 links and for removed files alike, so
	// ask for the file itself.
	if (finalUrl.hostname.endsWith('dropbox.com')) {
		const file = await fetch(normalizeDirectDownloadUrl(response.url), {
			headers: { 'User-Agent': BROWSER_UA },
			signal: AbortSignal.timeout(30_000),
		}).catch(() => null);
		const page = file?.headers.get('content-type')?.includes('text/html')
			? await file.text().catch(() => '')
			: '';
		await file?.body?.cancel().catch(() => {});
		// Only Dropbox's own error pages mean removed; anything else, such as an
		// anti-bot page, falls through to the real test.
		const removed = page.match(
			/<title>Dropbox - (Error|Invalid Link|File Deleted)\b/i,
		);
		if (removed) {
			throw offline(liveCase, `Dropbox shows "${removed[1]}"`);
		}
	}
}

async function resolve(liveCase: LiveCase) {
	await assertOnline(liveCase);
	const resolved = await resolveGateUrlOrFollow(liveCase.url);
	expect(resolved?.provider, 'resolved provider').toBe(liveCase.provider);
	if (liveCase.resolvesTo instanceof RegExp) {
		expect(resolved?.url).toMatch(liveCase.resolvesTo);
	} else if (liveCase.resolvesTo) {
		expect(resolved?.url).toBe(liveCase.resolvesTo);
	}
	return resolved as NonNullable<typeof resolved>;
}

async function runCase(liveCase: LiveCase) {
	const { provider, url } = await resolve(liveCase);
	if (liveCase.resolveOnly) return;

	const created = new Set<string>();
	try {
		const filename = await download(liveCase, provider, url);
		expect(filename, 'downloaded filename').toBeTruthy();
		created.add(filename as string);
		const audio = await resolveDownloadedAudio(filename as string);
		created.add(audio);
		const duration = await audioDuration(join(DOWNLOADS_DIR, audio));
		console.log(`✓ ${liveCase.name}: ${audio} (${Math.round(duration)}s)`);
		expect(duration).toBeGreaterThan(5);
	} finally {
		for (const name of created) {
			await rm(join(DOWNLOADS_DIR, name), { force: true, recursive: true });
		}
	}
}

async function checkSoundcloudTrack(liveCase: LiveCase) {
	soundcloudClient ??= new SoundcloudClient();
	const url = liveCase.soundcloud as string;
	const track = await soundcloudClient.getTrack(url).catch((error: unknown) => {
		if (!/Status code 404/.test(String(error))) throw error;
		throw new Error(
			`SOUNDCLOUD TRACK OFFLINE: ${url}\nFind the track that links ${liveCase.url} now, or drop the soundcloud field.`,
		);
	});
	const gate = await soundcloudClient.getGateURL(track);
	expect(gate?.provider, 'gate found on the SoundCloud track').toBe(
		liveCase.provider,
	);
}

describe.skipIf(!process.env.LIVE_TESTS)('live', () => {
	// Track lookups, OAuth gates and cleanup all fail when this does.
	test('SoundCloud account login', async () => {
		soundcloudClient ??= new SoundcloudClient();
		const me = await soundcloudClient.getMe().catch((error: unknown) => {
			throw new Error(
				`SoundCloud API login failed (${error}). Set a fresh SC_REFRESH_TOKEN in .env.`,
			);
		});
		expect(me.username).toBeTruthy();
	});

	for (const [platform, cases] of Object.entries(LIVE_CASES)) {
		describe(platform, () => {
			for (const liveCase of cases) {
				const missingEnv =
					liveCase.requiresEnv?.filter((name) => !process.env[name]) ?? [];
				const register = liveCase.todo
					? test.todo
					: test.skipIf(missingEnv.length > 0);
				const suffix = liveCase.todo
					? ` (todo: ${liveCase.todo})`
					: missingEnv.length
						? ` (needs ${missingEnv.join(', ')})`
						: '';
				register(
					`${liveCase.name}${suffix}`,
					() => runCase(liveCase),
					TIMEOUT_MS,
				);
				if (liveCase.soundcloud) {
					register(
						`${liveCase.name}: SoundCloud track links the gate${suffix}`,
						() => checkSoundcloudTrack(liveCase),
						60_000,
					);
				}
			}
		});
	}

	afterAll(async () => {
		if (!browserGatesRan || !config?.cleanupSoundCloudAccount) return;
		soundcloudClient ??= new SoundcloudClient();
		const result = await soundcloudClient.cleanup(false);
		console.log('SoundCloud cleanup:', result);
	}, TIMEOUT_MS);
});
