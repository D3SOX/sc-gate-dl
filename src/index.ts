import { confirm, input, select } from '@inquirer/prompts';
import { AudioProcessor } from './audioProcessor';
import { loadConfig, saveConfig } from './config';
import { DirectDownloader } from './directDownload';
import { DownloadgaterDownloader } from './downloadgater';
import { DroploudDownloader } from './droploud';
import { GaterushDownloader } from './gaterush';
import { HypedditDownloader } from './hypeddit';
import { HypedditHttpDownloader } from './hypedditHttp';
import { MypresskitDownloader } from './mypresskit';
import { PumpyoursoundDownloader } from './pumpyoursound';
import { SoundcloudClient } from './soundcloud';
import { StillhypeDownloader } from './stillhype';
import {
	getFfmpegBin,
	getFfprobeBin,
	resolveGateUrlOrFollow,
	validateSoundcloudUrl,
} from './utils';
import { YtDlpDownloader } from './ytdlp';

try {
	const ffmpegBin = await getFfmpegBin();
	const ffprobeBin = await getFfprobeBin();

	const SC_COMMENT = process.env.SC_COMMENT;
	if (!SC_COMMENT) {
		throw new Error('SC_COMMENT is required. Please set it in your .env file.');
	}
	if (SC_COMMENT.trim().length < 2) {
		throw new Error(
			'SC_COMMENT must be at least 2 characters (Droploud disables Connect otherwise).',
		);
	}
	// Optional — only required when a gate actually asks for name/email.
	const HYPEDDIT_NAME = process.env.HYPEDDIT_NAME;
	const HYPEDDIT_EMAIL = process.env.HYPEDDIT_EMAIL;

	const config = await loadConfig();

	const soundcloudArg = process.argv[2];
	const soundcloudArgValidation = soundcloudArg
		? validateSoundcloudUrl(soundcloudArg)
		: true;

	if (soundcloudArg && soundcloudArgValidation !== true) {
		console.log(soundcloudArgValidation);
	}
	const soundcloudUrl =
		soundcloudArg && soundcloudArgValidation === true
			? soundcloudArg
			: await input({
					message: 'Enter the URL of the SoundCloud track',
					validate: validateSoundcloudUrl,
				});

	const soundcloudClient = new SoundcloudClient();
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

	let downloadFilename: string | null = null;
	let usedBrowser = false;

	if (gate.provider === 'bandcamp' || gate.provider === 'soundcloud') {
		const sourceLabel =
			gate.provider === 'bandcamp' ? 'Bandcamp' : 'SoundCloud';
		const ytDlpDownloader = new YtDlpDownloader(sourceLabel);
		downloadFilename = await ytDlpDownloader.downloadAudio(gateUrl, {
			matchTitle: track.title,
			onAlbumMatchFailed: async (error) => {
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
			},
		});
	} else if (gate.provider === 'direct') {
		const directDownloader = new DirectDownloader();
		downloadFilename = await directDownloader.downloadAudio(gateUrl);
	} else if (gate.provider === 'droploud') {
		usedBrowser = true;
		const droploudDownloader = new DroploudDownloader(gateConfig);
		try {
			await droploudDownloader.initialize();
			if (initializeLogins) {
				await droploudDownloader.prepareLogins();
				if (config) {
					await saveConfig({ ...config, initializeLogins: false });
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
					await saveConfig({ ...config, initializeLogins: false });
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
					await saveConfig({ ...config, initializeLogins: false });
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
					await saveConfig({ ...config, initializeLogins: false });
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
					await saveConfig({ ...config, initializeLogins: false });
					console.log('✓ Updated config.json: initializeLogins set to false');
				}
			}
			downloadFilename = await pumpyoursoundDownloader.downloadAudio(gateUrl);
		} finally {
			await pumpyoursoundDownloader.close();
		}
	} else if (gate.provider === 'mypresskit') {
		usedBrowser = true;
		const mypresskitDownloader = new MypresskitDownloader(gateConfig);
		try {
			await mypresskitDownloader.initialize();
			if (initializeLogins) {
				await mypresskitDownloader.prepareLogins();
				if (config) {
					await saveConfig({ ...config, initializeLogins: false });
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
						await saveConfig({ ...config, initializeLogins: false });
						console.log('✓ Updated config.json: initializeLogins set to false');
					}
				}

				downloadFilename = await hypedditDownloader.downloadAudio(gateUrl);
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
		const artworkUrl = soundcloudClient.getArtworkUrl(track);
		const artwork = await soundcloudClient.fetchArtwork(artworkUrl);

		const audioProcessor = new AudioProcessor(ffmpegBin, ffprobeBin);
		const metadata = await audioProcessor.promptForMetadata(
			track,
			downloadFilename,
		);

		const losslessHandling = config
			? config.deleteLosslessAfterConversion
				? 'always'
				: 'never'
			: 'prompt';

		await audioProcessor.processAudio(
			downloadFilename,
			metadata,
			artwork,
			losslessHandling,
		);
	}
} catch (error) {
	if (error instanceof Error && error.name === 'ExitPromptError') {
		console.log('\nAborted by user.');
		process.exit(0);
	}
	throw error;
}
