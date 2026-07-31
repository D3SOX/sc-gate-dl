import { confirm, input, select } from '@inquirer/prompts';
import { AudioProcessor } from './audioProcessor';
import { loadConfig, saveConfig } from './config';
import { DownloadgaterDownloader } from './downloadgater';
import { DroploudDownloader } from './droploud';
import { GaterushDownloader } from './gaterush';
import { HypedditDownloader } from './hypeddit';
import { HypedditHttpDownloader } from './hypedditHttp';
import { SoundcloudClient } from './soundcloud';
import {
	getFfmpegBin,
	getFfprobeBin,
	resolveGateProviderUrl,
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
					name: 'Enter a Hypeddit / Droploud / GateRush / DownloadGater / Bandcamp URL',
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
					'Enter the Hypeddit, Droploud, GateRush, DownloadGater, or Bandcamp URL',
				validate: (value) => {
					const resolved = resolveGateProviderUrl(value);
					if (!resolved || resolved.provider === 'soundcloud') {
						return 'A valid Hypeddit, Droploud, GateRush, DownloadGater, or Bandcamp URL is required';
					}
					return true;
				},
			});
			const resolved = resolveGateProviderUrl(gateUrl);
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
			'A valid Hypeddit, Droploud, GateRush, DownloadGater, Bandcamp, or SoundCloud URL is required',
		);
	}

	const isYtDlp =
		gate.provider === 'bandcamp' || gate.provider === 'soundcloud';

	const headless = isYtDlp
		? true
		: config
			? config.headless
			: await confirm({
					message: 'Run headless? (no browser window)',
					default: true,
				});

	const initializeLogins = isYtDlp
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
		headless,
	};

	let downloadFilename: string | null = null;
	let usedBrowser = false;

	if (gate.provider === 'bandcamp' || gate.provider === 'soundcloud') {
		const sourceLabel =
			gate.provider === 'bandcamp' ? 'Bandcamp' : 'SoundCloud';
		const ytDlpDownloader = new YtDlpDownloader(sourceLabel);
		downloadFilename = await ytDlpDownloader.downloadAudio(gateUrl, {
			matchTitle: track.title,
		});
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
