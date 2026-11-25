import { confirm, input, select } from '@inquirer/prompts';
import { checkSpotifyCookies } from './accessSetup';
import { AudioProcessor } from './audioProcessor';
import { cliOutputFromEnv, finishCliDownload } from './cliDestination';
import { type AppConfig, loadConfig, saveConfig } from './config';
import { DirectDownloader } from './directDownload';
import { DownloadgaterDownloader } from './downloadgater';
import { DroploudDownloader } from './droploud';
import { FangateDownloader } from './fangate';
import { GaterushDownloader } from './gaterush';
import {
	browserSoundcloudLogin,
	browserSpotifyLogin,
	type LoginProvider,
	runGuidedLogins,
} from './guidedLogin';
import { HypedditDownloader } from './hypeddit';
import { HypedditHttpDownloader } from './hypedditHttp';
import { parseReviewTagsSetting } from './jobOptions';
import { MypresskitDownloader } from './mypresskit';
import { PumpyoursoundDownloader } from './pumpyoursound';
import {
	checkConfiguredSoundcloudAccess,
	SoundcloudClient,
} from './soundcloud';
import { StillhypeDownloader } from './stillhype';
import type { HypedditConfig } from './types';
import {
	getDefaultMetadata,
	getFfmpegBin,
	getFfprobeBin,
	isLosslessFormat,
	resolveGateUrlOrFollow,
	validateSoundcloudUrl,
} from './utils';
import { YtDlpDownloader, type YtDlpDownloadOptions } from './ytdlp';

export type CliDeps = {
	env: Partial<Record<string, string>>;
	argv: string[];
	loadConfig: () => Promise<AppConfig | null>;
	saveConfig: (config: AppConfig) => Promise<void>;
	createSoundcloudClient: () => SoundcloudClient;
	checkSoundcloudAccess: (log: (line: string) => void) => Promise<unknown>;
	checkSpotifyAccess?: () => Promise<{ state: string }>;
	guidedLogin?: (
		providers: LoginProvider[],
		log: (line: string) => void,
	) => Promise<void>;
	createDirectDownloader: () => Pick<DirectDownloader, 'downloadAudio'>;
	createFangateDownloader: (
		config: HypedditConfig,
	) => Pick<
		FangateDownloader,
		'initialize' | 'prepareLogins' | 'downloadAudio' | 'close'
	>;
	createDroploudDownloader: (
		config: HypedditConfig,
	) => Pick<
		DroploudDownloader,
		'initialize' | 'prepareLogins' | 'downloadAudio' | 'close'
	>;
	createAudioProcessor: (
		ffmpegBin: string,
		ffprobeBin: string,
		bitrateSetting: string | undefined,
	) => AudioProcessor;
};

export const defaultCliDeps: CliDeps = {
	env: process.env,
	argv: process.argv,
	loadConfig,
	saveConfig,
	createSoundcloudClient: () => new SoundcloudClient(),
	checkSoundcloudAccess: (log) => checkConfiguredSoundcloudAccess(log),
	checkSpotifyAccess: () => checkSpotifyCookies(),
	guidedLogin: (providers, log) =>
		runGuidedLogins({
			providers,
			env: process.env,
			envPath: process.env.SC_GATE_DL_ENV_FILE ?? '.env',
			log,
			soundcloudLogin: browserSoundcloudLogin,
			spotifyLogin: browserSpotifyLogin,
			checkSoundcloud: (l) => checkConfiguredSoundcloudAccess(l),
		}),
	createDirectDownloader: () => new DirectDownloader(),
	createDroploudDownloader: (config) => new DroploudDownloader(config),
	createFangateDownloader: (config) => new FangateDownloader(config),
	createAudioProcessor: (ffmpegBin, ffprobeBin, bitrateSetting) =>
		new AudioProcessor(ffmpegBin, ffprobeBin, bitrateSetting),
};

export async function runCli(deps: CliDeps): Promise<void> {
	const { env, argv } = deps;
	const ffmpegBin = await getFfmpegBin();
	const ffprobeBin = await getFfprobeBin();

	const SC_COMMENT = env.SC_COMMENT;
	if (!SC_COMMENT) {
		throw new Error('SC_COMMENT is required. Please set it in your .env file.');
	}
	if (SC_COMMENT.trim().length < 2) {
		throw new Error(
			'SC_COMMENT must be at least 2 characters (Droploud disables Connect otherwise).',
		);
	}
	// Optional — only required when a gate actually asks for name/email.
	const HYPEDDIT_NAME = env.HYPEDDIT_NAME;
	const HYPEDDIT_EMAIL = env.HYPEDDIT_EMAIL;

	const reviewTags = parseReviewTagsSetting(env.SC_GATE_DL_REVIEW_TAGS);
	const config = await deps.loadConfig();
	const cliOutput = cliOutputFromEnv(env);

	const forceLogin = argv.slice(2).includes('--login');
	const unknownFlag = argv
		.slice(2)
		.find((arg) => arg.startsWith('--') && arg !== '--login');
	if (unknownFlag)
		throw new Error(`Unknown option ${unknownFlag}. Use --login.`);
	const soundcloudArg = argv.slice(2).find((arg) => !arg.startsWith('--'));
	const soundcloudArgValidation = soundcloudArg
		? validateSoundcloudUrl(soundcloudArg)
		: true;

	if (soundcloudArg && soundcloudArgValidation !== true) {
		console.log(soundcloudArgValidation);
	}
	const log = (line: string) => console.log(line);
	const logFailure = (what: string) => (error: unknown) => {
		log(
			`${what} check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
		);
		return null;
	};
	const scAccess = (await deps
		.checkSoundcloudAccess(log)
		.catch(logFailure('SoundCloud'))) as {
		state?: string;
	} | null;
	const spotifyAccess = await deps
		.checkSpotifyAccess?.()
		.catch(logFailure('Spotify'));
	log(
		`SoundCloud login: ${scAccess?.state ?? 'unknown'} | Spotify login: ${spotifyAccess?.state ?? 'unknown'}`,
	);
	const scNeedsLogin = (state?: string) =>
		state === 'missing' || state === 'expired' || state === 'invalid';
	const broken: LoginProvider[] = [];
	if (scNeedsLogin(scAccess?.state)) broken.push('soundcloud');
	if (spotifyAccess && spotifyAccess.state !== 'present') {
		broken.push('spotify');
	}
	// --login on a working login asks first; the default is to keep it.
	const redo: LoginProvider[] = [];
	if (forceLogin && deps.guidedLogin && process.stdin.isTTY) {
		for (const provider of ['soundcloud', 'spotify'] as const) {
			if (
				!broken.includes(provider) &&
				(await confirm({
					message: `${provider === 'soundcloud' ? 'SoundCloud' : 'Spotify'} login is working. Log in again anyway?`,
					default: false,
				}))
			) {
				redo.push(provider);
			}
		}
	}
	const needsLogin = [...broken, ...redo];
	if (deps.guidedLogin && needsLogin.length > 0) {
		if (!process.stdin.isTTY) {
			throw new Error(
				`Login needed for ${broken.join(' and ')}. Run \`bun start --login\` in a terminal.`,
			);
		}
		if (
			forceLogin ||
			(await confirm({
				message: `Log in now to ${needsLogin.join(' and ')}?${needsLogin.includes('soundcloud') ? ' SoundCloud tokens are saved to .env automatically.' : ''}`,
				default: true,
			}))
		) {
			await deps.guidedLogin(needsLogin, log);
		}
		// Both logins are mandatory: a gate would otherwise fail halfway through.
		const stillBroken: string[] = [];
		if (broken.includes('soundcloud')) {
			const after = (await deps
				.checkSoundcloudAccess(() => {})
				.catch(logFailure('SoundCloud'))) as { state?: string } | null;
			if (scNeedsLogin(after?.state)) stillBroken.push('SoundCloud');
		}
		if (broken.includes('spotify')) {
			const after = await deps
				.checkSpotifyAccess?.()
				.catch(logFailure('Spotify'));
			if (after?.state !== 'present') stillBroken.push('Spotify');
		}
		if (stillBroken.length > 0) {
			throw new Error(
				`${stillBroken.join(' and ')} login is still missing or invalid. Run \`bun start --login\` and finish the login.`,
			);
		}
	}

	const soundcloudUrl =
		soundcloudArg && soundcloudArgValidation === true
			? soundcloudArg
			: await input({
					message: 'Enter the URL of the SoundCloud track',
					validate: validateSoundcloudUrl,
				});

	const soundcloudClient = deps.createSoundcloudClient();
	const track = await soundcloudClient.getTrack(soundcloudUrl);

	let gate = await soundcloudClient.getGateURL(track);
	let gateUrl = gate?.url ?? null;

	if (!gateUrl) {
		const fallback = await select({
			message: 'No gate / Bandcamp URL found on this track. What next?',
			choices: [
				{
					name: 'Download via yt-dlp from SoundCloud',
					value: 'ytdlp' as const,
				},
				{
					name: 'Enter a gate / Bandcamp / direct download / resolvable URL',
					value: 'manual' as const,
				},
			],
		});

		if (fallback === 'ytdlp') {
			gateUrl = soundcloudUrl;
			gate = { url: gateUrl, provider: 'soundcloud', type: 'purchase_url' };
		} else {
			gateUrl = await input({
				message:
					'Enter a Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit, Bandcamp, direct download, or smart-link URL',
				validate: async (value) => {
					const resolved = await resolveGateUrlOrFollow(value);
					if (!resolved || resolved.provider === 'soundcloud') {
						return 'A valid Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit, Bandcamp, direct download, or resolvable gate URL is required';
					}
					return true;
				},
			});
			const resolved = await resolveGateUrlOrFollow(gateUrl);
			gate =
				resolved && resolved.provider !== 'soundcloud'
					? {
							url: resolved.url,
							provider: resolved.provider,
							type: 'purchase_url',
						}
					: null;
			if (gate) {
				gateUrl = gate.url;
			}
		}
	}

	if (!gateUrl || !gate) {
		throw new Error(
			'A valid Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit, Bandcamp, direct download, or SoundCloud URL is required',
		);
	}

	const isBrowserless =
		gate.provider === 'bandcamp' ||
		gate.provider === 'soundcloud' ||
		gate.provider === 'direct';

	const headless = isBrowserless
		? true
		: config
			? config.headless
			: await confirm({
					message: 'Run headless? (no browser window)',
					default: true,
				});
	const xvfb =
		!isBrowserless && headless
			? config
				? config.xvfb
				: await confirm({
						message:
							'Use Xvfb for stronger anti-bot protection? (invisible headed browser)',
						default: false,
					})
			: false;

	const initializeLogins = isBrowserless
		? false
		: config
			? config.initializeLogins
			: await confirm({
					message:
						"Do you want to initialize logins? This is required for the first run. You can skip it for subsequent runs. If you don't use the tool for a while it might be required again.",
					default: false,
				});

	const gateConfig = {
		name: HYPEDDIT_NAME,
		email: HYPEDDIT_EMAIL,
		comment: SC_COMMENT,
		browserMode: xvfb
			? ('xvfb' as const)
			: headless
				? ('headless' as const)
				: ('headed' as const),
	};

	const selectBandcampTrack: NonNullable<
		YtDlpDownloadOptions['onAlbumMatchFailed']
	> = async (error) => {
		const selected = await select({
			message: error.matchTitle
				? `Could not match “${error.matchTitle}”. Pick a Bandcamp album track:`
				: 'Pick a track from the Bandcamp album:',
			choices: error.tracks.map((t) => ({
				name:
					t.score > 0
						? `${t.title} (${Math.round(t.score * 100)}% match)`
						: t.title,
				value: t.url,
			})),
		});
		return selected;
	};

	let downloadFilename: string | null = null;
	let usedBrowser = false;

	if (gate.provider === 'bandcamp' || gate.provider === 'soundcloud') {
		const sourceLabel =
			gate.provider === 'bandcamp' ? 'Bandcamp' : 'SoundCloud';
		const ytDlpDownloader = new YtDlpDownloader(sourceLabel);
		downloadFilename = await ytDlpDownloader.downloadAudio(gateUrl, {
			matchTitle: track.title,
			onAlbumMatchFailed: selectBandcampTrack,
		});
	} else if (gate.provider === 'direct') {
		const directDownloader = deps.createDirectDownloader();
		downloadFilename = await directDownloader.downloadAudio(gateUrl);
	} else if (gate.provider === 'droploud') {
		usedBrowser = true;
		const droploudDownloader = deps.createDroploudDownloader(gateConfig);
		try {
			await droploudDownloader.initialize();
			if (initializeLogins) {
				await droploudDownloader.prepareLogins();
				if (config) {
					await deps.saveConfig({ ...config, initializeLogins: false });
					console.log('✓ Updated config.json: initializeLogins set to false');
				}
			}
			downloadFilename = await droploudDownloader.downloadAudio(gateUrl);
		} finally {
			await droploudDownloader.close();
		}
	} else if (gate.provider === 'gaterush') {
		usedBrowser = true;
		const gaterushDownloader = new GaterushDownloader(gateConfig);
		try {
			await gaterushDownloader.initialize();
			if (initializeLogins) {
				await gaterushDownloader.prepareLogins();
				if (config) {
					await deps.saveConfig({ ...config, initializeLogins: false });
					console.log('✓ Updated config.json: initializeLogins set to false');
				}
			}
			downloadFilename = await gaterushDownloader.downloadAudio(gateUrl);
		} finally {
			await gaterushDownloader.close();
		}
	} else if (gate.provider === 'downloadgater') {
		usedBrowser = true;
		const downloadgaterDownloader = new DownloadgaterDownloader(gateConfig);
		try {
			await downloadgaterDownloader.initialize();
			if (initializeLogins) {
				await downloadgaterDownloader.prepareLogins();
				if (config) {
					await deps.saveConfig({ ...config, initializeLogins: false });
					console.log('✓ Updated config.json: initializeLogins set to false');
				}
			}
			downloadFilename = await downloadgaterDownloader.downloadAudio(gateUrl);
		} finally {
			await downloadgaterDownloader.close();
		}
	} else if (gate.provider === 'stillhype') {
		usedBrowser = true;
		const stillhypeDownloader = new StillhypeDownloader(gateConfig);
		try {
			await stillhypeDownloader.initialize();
			if (initializeLogins) {
				await stillhypeDownloader.prepareLogins();
				if (config) {
					await deps.saveConfig({ ...config, initializeLogins: false });
					console.log('✓ Updated config.json: initializeLogins set to false');
				}
			}
			downloadFilename = await stillhypeDownloader.downloadAudio(gateUrl);
		} finally {
			await stillhypeDownloader.close();
		}
	} else if (gate.provider === 'pumpyoursound') {
		usedBrowser = true;
		const pumpyoursoundDownloader = new PumpyoursoundDownloader(gateConfig);
		try {
			await pumpyoursoundDownloader.initialize();
			if (initializeLogins) {
				await pumpyoursoundDownloader.prepareLogins();
				if (config) {
					await deps.saveConfig({ ...config, initializeLogins: false });
					console.log('✓ Updated config.json: initializeLogins set to false');
				}
			}
			downloadFilename = await pumpyoursoundDownloader.downloadAudio(gateUrl, {
				matchTitle: track.title,
				onAlbumMatchFailed: selectBandcampTrack,
			});
		} finally {
			await pumpyoursoundDownloader.close();
		}
	} else if (gate.provider === 'fangate') {
		usedBrowser = true;
		const fangateDownloader = deps.createFangateDownloader(gateConfig);
		try {
			await fangateDownloader.initialize();
			if (initializeLogins) {
				await fangateDownloader.prepareLogins();
				if (config) {
					await deps.saveConfig({ ...config, initializeLogins: false });
					console.log('✓ Updated config.json: initializeLogins set to false');
				}
			}
			downloadFilename = await fangateDownloader.downloadAudio(gateUrl);
		} finally {
			await fangateDownloader.close();
		}
	} else if (gate.provider === 'mypresskit') {
		usedBrowser = true;
		const mypresskitDownloader = new MypresskitDownloader(gateConfig);
		try {
			await mypresskitDownloader.initialize();
			if (initializeLogins) {
				await mypresskitDownloader.prepareLogins();
				if (config) {
					await deps.saveConfig({ ...config, initializeLogins: false });
					console.log('✓ Updated config.json: initializeLogins set to false');
				}
			}
			downloadFilename = await mypresskitDownloader.downloadAudio(gateUrl);
		} finally {
			await mypresskitDownloader.close();
		}
	} else {
		// Hypeddit: always try plain HTTP first (email + social skip gates).
		const httpDownloader = new HypedditHttpDownloader(gateConfig);
		downloadFilename = await httpDownloader.tryDownload(gateUrl);

		// HTTP first. Fall back to the browser (headless or headful) when needed.
		if (!downloadFilename) {
			usedBrowser = true;
			const hypedditDownloader = new HypedditDownloader(gateConfig);
			try {
				await hypedditDownloader.initialize();

				if (initializeLogins) {
					await hypedditDownloader.prepareLogins();
					if (config) {
						await deps.saveConfig({ ...config, initializeLogins: false });
						console.log('✓ Updated config.json: initializeLogins set to false');
					}
				}

				downloadFilename = await hypedditDownloader.downloadAudio(gateUrl, {
					matchTitle: track.title,
					onAlbumMatchFailed: selectBandcampTrack,
				});
			} finally {
				await hypedditDownloader.close();
			}
		}
	}

	// The browserless path never touches the SoundCloud account (it only declares
	// the gates as skipped to Hypeddit), so cleanup is only relevant when the
	// browser flow actually ran.
	if (usedBrowser) {
		if (config) {
			if (config.cleanupSoundCloudAccount) {
				await soundcloudClient.cleanup(false);
			}
		} else {
			await soundcloudClient.cleanup();
		}
	}

	if (downloadFilename) {
		const audioProcessor = deps.createAudioProcessor(
			ffmpegBin,
			ffprobeBin,
			env.SC_GATE_DL_BITRATE,
		);
		const losslessHandling = config
			? config.deleteLosslessAfterConversion
				? 'always'
				: 'never'
			: 'prompt';

		const { delivered, sourceRemoved, sourcePath } = await finishCliDownload({
			downloadFilename,
			output: { format: cliOutput.format },
			losslessHandling,
			destinationDir: cliOutput.destinationDir,
			soundcloudUrl,
			audioProcessor,
			steps: {
				fetchArtwork: () =>
					soundcloudClient.fetchArtwork(soundcloudClient.getArtworkUrl(track)),
				promptMetadata: reviewTags
					? (filename) => audioProcessor.promptForMetadata(track, filename)
					: async () => ({ metadata: getDefaultMetadata(track), retag: true }),
				confirmRemoveSource: (filename) =>
					confirm({
						message: `Do you want to remove the ${isLosslessFormat(filename) ? 'lossless' : 'source'} file now?`,
						default: true,
					}),
			},
		});
		for (const path of delivered) {
			console.log(`✓ Saved ${path}`);
		}
		if (sourceRemoved) {
			console.log(`✓ Removed ${sourcePath}`);
		}
	}
}
