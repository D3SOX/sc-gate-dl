import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import type { SoundcloudTrack } from 'soundcloud.ts';
import {
	pickUniqueDownloadFilename,
	withDownloadRenameLock,
} from './downloadRename';
import { planAudioOutput } from './outputFormat';
import type { Metadata, OutputFormat } from './types';
import {
	getDefaultMetadata,
	isLosslessFormat,
	isMp3Format,
	REPO_URL,
} from './utils';

const ARTWORK_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

export function artworkExtension(fileName: string): string {
	const extension = extname(fileName).slice(1).toLowerCase();
	return ARTWORK_EXTENSIONS.has(extension) ? extension : 'jpg';
}

type FfprobeResult = {
	format?: { tags?: Record<string, string>; bit_rate?: string };
	streams?: Array<{
		tags?: Record<string, string>;
		codec_type?: string;
		codec_name?: string;
		bit_rate?: string;
		disposition?: { attached_pic?: number };
	}>;
};

type Artwork = { buffer: ArrayBuffer; fileName: string };

export type ProcessAudioOptions = {
	/** New cover. Without one, an embedded cover of the source is kept. */
	artwork?: Artwork | null;
	losslessHandling?: 'prompt' | 'always' | 'never';
	outputFormat?: Exclude<OutputFormat, 'original'>;
	/** Written to the comment tag so the file links back to the track. */
	sourceUrl?: string;
};

type TagOptions = {
	metadata: Metadata;
	sourceUrl?: string;
	artworkPath: string | null;
};

/** FFmpeg inputs, maps and tags shared by every conversion and retag. */
function ffmpegTagArgs(
	inputPath: string,
	audioCodec: string[],
	{ metadata, sourceUrl, artworkPath }: TagOptions,
	coverDisposition: string[] = [],
): string[] {
	const args = ['-i', inputPath];
	if (artworkPath) args.push('-i', artworkPath);
	args.push('-map', '0:a', ...audioCodec);
	if (artworkPath) {
		args.push(
			'-map',
			'1:v',
			'-c:v',
			'copy',
			...coverDisposition,
			'-metadata:s:v',
			'title=Album cover',
			'-metadata:s:v',
			'comment=Cover (front)',
		);
	}
	for (const key of ['title', 'artist', 'album', 'genre'] as const) {
		if (metadata[key]) args.push('-metadata', `${key}=${metadata[key]}`);
	}
	if (sourceUrl) args.push('-metadata', `comment=${sourceUrl}`);
	return args;
}

/** Output bitrate in kbps from `SC_GATE_DL_BITRATE`. Unset or blank means 320. */
export function outputBitrateFromEnv(
	value = process.env.SC_GATE_DL_BITRATE,
): number {
	const text = value?.trim();
	if (!text) return 320;
	const kbps = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (!(kbps >= 64 && kbps <= 320)) {
		throw new Error(
			`SC_GATE_DL_BITRATE=${text} is not a valid bitrate. Use a number of kbps from 64 to 320, or leave it unset for 320.`,
		);
	}
	return kbps;
}

export function isLosslessCodec(codecName: string | null): boolean {
	const codec = codecName?.toLowerCase() ?? '';
	return (
		['alac', 'flac', 'wavpack', 'ape', 'tta'].includes(codec) ||
		codec.startsWith('pcm_') ||
		codec.startsWith('dsd_')
	);
}

function replaceExtension(filename: string, extension: string): string {
	return `${basename(filename, extname(filename))}${extension}`;
}

export class AudioProcessor {
	constructor(
		private readonly ffmpegBin: string,
		private readonly ffprobeBin: string,
		/** MP3/AAC bitrate for lossless sources, from `SC_GATE_DL_BITRATE`. */
		private readonly bitrateKbps = 320,
	) {}

	/** Run a binary with argv (no shell); throws on non-zero exit. */
	private async run(
		bin: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string }> {
		const proc = Bun.spawn([bin, ...args], {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) {
			throw new Error(
				stderr.trim() || `${basename(bin)} exited with code ${exitCode}`,
			);
		}
		return { stdout, stderr };
	}

	async readMp3Metadata(inputPath: string): Promise<Metadata | null> {
		const probeData = await this.runFfprobe(inputPath);
		if (!probeData) {
			return null;
		}

		const streamTags = (probeData.streams ?? [])
			.filter((stream) => stream.codec_type === 'audio')
			.map((stream) => stream.tags)
			.filter((value): value is Record<string, string> => Boolean(value));
		const tagSources = [...streamTags, probeData.format?.tags].filter(
			(value): value is Record<string, string> => Boolean(value),
		);
		if (tagSources.length === 0) {
			return null;
		}
		const tags = Object.assign({}, ...tagSources);

		// MP3 metadata can be in different cases
		const getTag = (key: string): string | undefined => {
			return tags[key] || tags[key.toUpperCase()];
		};

		return {
			title: getTag('title'),
			artist: getTag('artist'),
			album: getTag('album'),
			genre: getTag('genre'),
		};
	}

	/** Extract embedded cover art (MP3 APIC, FLAC picture, M4A covr). */
	async extractCoverArt(
		inputPath: string,
		/** Keeps oversized covers out of the job store; retagging passes Infinity. */
		maxCoverBytes = 10 * 1024 * 1024,
	): Promise<{ buffer: ArrayBuffer; fileName: string } | null> {
		const probeData = await this.runFfprobe(inputPath);
		const coverStream = (probeData?.streams ?? []).find(
			(stream) =>
				stream.codec_type === 'video' &&
				(stream.disposition?.attached_pic === 1 ||
					stream.codec_name === 'mjpeg' ||
					stream.codec_name === 'png'),
		);
		if (!coverStream) {
			return null;
		}

		const extension = coverStream.codec_name === 'png' ? 'png' : 'jpg';
		const outputPath = join(
			'./downloads',
			`.existing-cover-${crypto.randomUUID()}.${extension}`,
		);

		try {
			await this.run(this.ffmpegBin, [
				'-i',
				inputPath,
				'-an',
				'-vcodec',
				'copy',
				'-y',
				outputPath,
			]);
			const file = Bun.file(outputPath);
			if (!(await file.exists()) || file.size === 0) {
				return null;
			}
			if (file.size > maxCoverBytes) {
				console.warn(
					`Skipping embedded cover art: ${file.size} bytes exceeds ${maxCoverBytes}`,
				);
				return null;
			}
			return {
				buffer: await file.arrayBuffer(),
				fileName: `existing-cover.${extension}`,
			};
		} catch (error) {
			console.warn(
				`Failed to extract cover art: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		} finally {
			await Bun.file(outputPath)
				.unlink()
				.catch(() => {});
		}
	}

	async promptForMetadata(
		track: SoundcloudTrack,
		filename: string,
	): Promise<Metadata> {
		// if file is MP3, show existing metadata and ask if user wants to retag
		if (isMp3Format(filename)) {
			const inputPath = join('./downloads', filename);

			const fileExists = await Bun.file(inputPath).exists();
			if (fileExists) {
				const existingMetadata = await this.readMp3Metadata(inputPath);

				if (existingMetadata) {
					console.log('\nCurrent MP3 metadata:');
					console.log('  Title:', existingMetadata.title || '(not set)');
					console.log('  Artist:', existingMetadata.artist || '(not set)');
					console.log('  Album:', existingMetadata.album || '(not set)');
					console.log('  Genre:', existingMetadata.genre || '(not set)');
					console.log();

					const wantToRetag = await confirm({
						message: 'Do you want to retag this MP3 file?',
						default: true,
					});

					if (!wantToRetag) {
						return {};
					}
				}
			}
		}

		const { title, artist, album, genre } = getDefaultMetadata(track);

		console.log('\nFetched metadata:');
		console.log('  Title:', title || '(not set)');
		console.log('  Artist:', artist || '(not set)');
		console.log('  Album:', album || '(not set)');
		console.log('  Genre:', genre || '(not set)');
		console.log();

		console.log(
			'Now you can correct the metadata for the resulting MP3 file. All fields are optional and will be used if provided.',
		);

		const correctedTitle = await input({
			message: 'Check and correct the title',
			default: title,
			prefill: 'editable',
		});
		const correctedArtist = await input({
			message: 'Check and correct the artist',
			default: artist,
			prefill: 'editable',
		});
		const correctedAlbum = await input({
			message: 'Check and correct the album',
			default: album,
			prefill: 'editable',
		});
		const correctedGenre = await input({
			message: 'Check and correct the genre',
			default: genre,
			prefill: 'editable',
		});

		return {
			title: correctedTitle.trim(),
			artist: correctedArtist.trim(),
			album: correctedAlbum.trim(),
			genre: correctedGenre.trim(),
		};
	}

	async processAudio(
		filename: string,
		metadata: Metadata,
		options: ProcessAudioOptions = {},
	): Promise<string> {
		const {
			losslessHandling = 'prompt',
			outputFormat = 'mp3-320',
			sourceUrl,
		} = options;
		const inputPath = join('./downloads', filename);
		const { codecName, bitrateKbps } = await this.probeAudioStream(inputPath);
		const lossless = codecName
			? isLosslessCodec(codecName)
			: isLosslessFormat(filename) || null;
		const plan = planAudioOutput(filename, lossless, outputFormat);
		if (plan === 'unsupported') {
			console.warn(
				`Unsupported file type: ${filename}. Leaving as is... If you want support for this file type, please create an issue about this on ${REPO_URL}/issues`,
			);
			return inputPath;
		}
		const hasMetadata =
			metadata.title || metadata.artist || metadata.album || metadata.genre;
		// A declined retag leaves the file byte-identical.
		if (plan === 'retag' && !hasMetadata) return inputPath;

		// Without new artwork, keep the cover the download already has.
		const artwork = options.artwork?.buffer.byteLength
			? options.artwork
			: await this.extractCoverArt(inputPath, Number.POSITIVE_INFINITY);
		// The artwork name may come from a client upload, so never use it as a path.
		const artworkPath = artwork
			? join(
					'./downloads',
					`.artwork-${crypto.randomUUID()}.${artworkExtension(artwork.fileName)}`,
				)
			: null;
		const tags = { metadata, sourceUrl, artworkPath };
		try {
			if (artwork && artworkPath) await Bun.write(artworkPath, artwork.buffer);
			if (plan === 'retag') return await this.retag(inputPath, tags);

			if (lossless === false && plan === 'flac') {
				console.warn(
					`Source codec ${codecName ?? 'unknown'} is lossy; FLAC conversion cannot restore lost audio quality.`,
				);
			}
			// Lossy sources keep their own rate, so a 128k stream never becomes fake 320k.
			const targetKbps = lossless
				? this.bitrateKbps
				: Math.min(this.bitrateKbps, Math.max(32, bitrateKbps ?? 192));
			const { extension, codec, label, coverDisposition } = {
				flac: {
					extension: '.flac',
					codec: ['-c:a', 'flac', '-compression_level', '8'],
					label: 'FLAC',
					coverDisposition: ['-disposition:v', 'attached_pic'],
				},
				mp3: {
					extension: '.mp3',
					codec: [
						'-c:a',
						'libmp3lame',
						'-b:a',
						`${targetKbps}k`,
						'-id3v2_version',
						'3',
					],
					label: `MP3 (${targetKbps}kbps)`,
					coverDisposition: [],
				},
				'm4a-aac': {
					extension: '.m4a',
					codec: ['-c:a', 'aac', '-b:a', `${targetKbps}k`],
					label: `M4A/AAC (${targetKbps}kbps)`,
					coverDisposition: ['-disposition:v', 'attached_pic'],
				},
			}[plan];

			console.log(`Converting to ${label}...`);
			const converted = await this.writeWithFfmpeg(
				ffmpegTagArgs(inputPath, codec, tags, coverDisposition),
				extension,
			);
			return await this.placeConverted(
				converted,
				inputPath,
				replaceExtension(filename, extension),
				losslessHandling,
			);
		} finally {
			// clean up temporary artwork file
			if (artworkPath) {
				await Bun.file(artworkPath)
					.unlink()
					.catch(() => {});
			}
		}
	}

	/** Run FFmpeg into a hidden temporary file in downloads/ and return its path. */
	private async writeWithFfmpeg(
		args: string[],
		extension: string,
	): Promise<string> {
		const outputPath = join(
			'./downloads',
			`.converting-${crypto.randomUUID()}${extension}`,
		);
		try {
			await this.run(this.ffmpegBin, [...args, '-y', outputPath]);
		} catch (error) {
			await rm(outputPath, { force: true });
			throw error;
		}
		return outputPath;
	}

	/**
	 * Give a converted file its final name and remove the source when wanted.
	 * When both share a name, the source is replaced only if it is removed
	 * anyway; otherwise the converted file gets a free name.
	 */
	private async placeConverted(
		convertedPath: string,
		inputPath: string,
		desiredFilename: string,
		losslessHandling: 'prompt' | 'always' | 'never',
	): Promise<string> {
		const sourceFilename = basename(inputPath);
		try {
			const removeSource =
				losslessHandling === 'prompt'
					? await confirm({
							message: `Do you want to remove the ${isLosslessFormat(sourceFilename) ? 'lossless' : 'source'} file now?`,
							default: true,
						})
					: losslessHandling === 'always';
			const outputPath = await withDownloadRenameLock(async () => {
				const finalName = pickUniqueDownloadFilename({
					desiredFilename,
					currentFilename: removeSource ? sourceFilename : '',
					jobId: crypto.randomUUID(),
					exists: (name) => existsSync(join('./downloads', name)),
					isOwnedByOtherJob: () => false,
				});
				const path = join('./downloads', finalName);
				await rename(convertedPath, path);
				return path;
			});
			if (removeSource && outputPath !== inputPath) {
				await rm(inputPath);
				console.log(`✓ Removed ${inputPath}`);
			}
			console.log(`✓ Converted to ${outputPath}`);
			return outputPath;
		} finally {
			await rm(convertedPath, { force: true });
		}
	}

	/** Rewrite the tags of an MP3 or AAC file without re-encoding it. */
	private async retag(inputPath: string, tags: TagOptions): Promise<string> {
		const mp3 = isMp3Format(inputPath);
		const extension = mp3 ? '.mp3' : '.m4a';
		console.log(`Retagging ${mp3 ? 'MP3' : 'M4A'}...`);
		// Existing tags stay; only the fields given here are replaced.
		const retagged = await this.writeWithFfmpeg(
			ffmpegTagArgs(
				inputPath,
				mp3 ? ['-c:a', 'copy', '-id3v2_version', '3'] : ['-c:a', 'copy'],
				tags,
				mp3 ? [] : ['-disposition:v', 'attached_pic'],
			),
			extension,
		);
		if (extname(inputPath).toLowerCase() === extension) {
			await rename(retagged, inputPath);
			console.log(`✓ Retagged ${inputPath}`);
			return inputPath;
		}
		// A raw .aac stream cannot hold tags, so it moves into an .m4a.
		return this.placeConverted(
			retagged,
			inputPath,
			replaceExtension(basename(inputPath), extension),
			'always',
		);
	}

	private async runFfprobe(inputPath: string): Promise<FfprobeResult | null> {
		try {
			const { stdout } = await this.run(this.ffprobeBin, [
				'-v',
				'quiet',
				'-print_format',
				'json',
				'-show_format',
				'-show_streams',
				inputPath,
			]);
			return JSON.parse(stdout) as FfprobeResult;
		} catch (error) {
			console.warn(
				`Failed to probe audio: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	private parseBitrateKbps(raw: string | undefined): number | null {
		if (!raw) return null;
		const bps = Number(raw);
		if (!Number.isFinite(bps) || bps <= 0) return null;
		return Math.round(bps / 1000);
	}

	/** Probe audio bitrate (kbps) and codec; null bitrate when unknown. */
	private async probeAudioStream(
		inputPath: string,
	): Promise<{ bitrateKbps: number | null; codecName: string | null }> {
		const probeData = await this.runFfprobe(inputPath);
		if (!probeData) {
			return { bitrateKbps: null, codecName: null };
		}

		const audioStream = probeData.streams?.find(
			(stream) => stream.codec_type === 'audio',
		);
		const bitrateKbps =
			this.parseBitrateKbps(audioStream?.bit_rate) ??
			this.parseBitrateKbps(probeData.format?.bit_rate);

		return {
			bitrateKbps,
			codecName: audioStream?.codec_name ?? null,
		};
	}

	/** Detect whether the downloaded audio codec is lossless. */
	async isLosslessAudio(inputPath: string): Promise<boolean | null> {
		const { codecName } = await this.probeAudioStream(inputPath);
		if (!codecName) return null;
		return isLosslessCodec(codecName);
	}
}
