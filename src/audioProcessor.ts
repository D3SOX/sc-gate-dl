import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import type { SoundcloudTrack } from 'soundcloud.ts';
import {
	pickUniqueDownloadFilename,
	withDownloadRenameLock,
} from './downloadRename';
import type { Metadata, OutputFormat } from './types';
import {
	getDefaultMetadata,
	isLosslessFormat,
	isMp3Format,
	REPO_URL,
	toFlacFilename,
	toM4aFilename,
	toMp3Filename,
} from './utils';

const ARTWORK_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const PASSTHROUGH_TAG_EXTENSIONS = new Set(['.m4a', '.ogg', '.aac']);

/** Covers ffmpeg cannot copy into an m4a as-is are transcoded to mjpeg. */
export function m4aCoverCodec(artworkPath: string): 'mjpeg' | 'copy' {
	return /\.(webp|gif)$/i.test(artworkPath) ? 'mjpeg' : 'copy';
}

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

/** Codec names (from ffprobe) that carry lossless audio, regardless of container. */
export function isLosslessCodec(codecName: string): boolean {
	const codec = codecName.toLowerCase();
	return (
		codec === 'alac' ||
		codec === 'flac' ||
		codec === 'wavpack' ||
		codec === 'ape' ||
		codec === 'tta' ||
		codec.startsWith('pcm_') ||
		codec.startsWith('dsd_')
	);
}

const MP3_BITRATES_KBPS = [
	32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const AAC_BITRATE_RANGE_KBPS = { min: 64, max: 320 };

/**
 * Parse the shared `SC_GATE_DL_BITRATE` for a configurable `mp3` or `m4a-aac`
 * output. Unset means 320. Rejects anything that is not a supported whole number.
 */
export function parseOutputBitrateKbps(
	raw: string | undefined,
	format: 'mp3' | 'm4a-aac',
): number {
	if (raw === undefined) return 320;
	const text = raw.trim();
	const value = /^\d+$/.test(text) ? Number(text) : NaN;

	if (format === 'mp3') {
		if (MP3_BITRATES_KBPS.includes(value)) return value;
		throw new Error(
			`SC_GATE_DL_BITRATE=${raw} is not valid for mp3 output. Use one of: ${MP3_BITRATES_KBPS.join(', ')}`,
		);
	}
	const { min, max } = AAC_BITRATE_RANGE_KBPS;
	if (value >= min && value <= max) return value;
	throw new Error(
		`SC_GATE_DL_BITRATE=${raw} is not valid for m4a-aac output. Use a whole number from ${min} to ${max}`,
	);
}

export class AudioProcessor {
	private ffmpegBin: string;
	private ffprobeBin: string;
	private bitrateSetting: string | undefined;

	constructor(ffmpegBin: string, ffprobeBin: string, bitrateSetting?: string) {
		this.ffmpegBin = ffmpegBin;
		this.ffprobeBin = ffprobeBin;
		this.bitrateSetting = bitrateSetting;
	}

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

	/** Extract embedded cover art from an MP3 (APIC / attached picture). */
	async extractMp3CoverArt(
		inputPath: string,
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
			// Bound memory: keep oversized embedded covers out of the job store.
			const maxCoverBytes = 10 * 1024 * 1024;
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
		artwork: { buffer: ArrayBuffer; fileName: string },
		losslessHandling: 'prompt' | 'always' | 'never' = 'prompt',
		outputFormat: Exclude<OutputFormat, 'original'> = 'mp3-320',
		sourceUrl?: string,
	): Promise<string> {
		const inputPath = join('./downloads', filename);
		const bitrateKbps =
			outputFormat === 'mp3' || outputFormat === 'm4a-aac'
				? parseOutputBitrateKbps(this.bitrateSetting, outputFormat)
				: 320;

		// The artwork name may come from a client upload, so never use it as a path.
		const artworkPath = join(
			'./downloads',
			`.artwork-${crypto.randomUUID()}.${artworkExtension(artwork.fileName)}`,
		);
		try {
			await Bun.write(artworkPath, artwork.buffer);
			// Only a probed lossless codec is converted; lossy and unknown (null) are never re-encoded.
			const lossless = await this.isLosslessAudio(inputPath);
			if (lossless === true) {
				if (outputFormat === 'flac') {
					const outputPath = await this.convertToFlac(
						inputPath,
						artworkPath,
						metadata,
						filename,
						losslessHandling,
						sourceUrl,
					);
					await this.maybeRemoveSource(
						inputPath,
						outputPath,
						filename,
						losslessHandling,
					);
					return outputPath;
				}

				if (outputFormat === 'm4a-aac') {
					const outputPath = await this.convertToM4a(
						inputPath,
						artworkPath,
						metadata,
						filename,
						losslessHandling,
						bitrateKbps,
						sourceUrl,
					);
					await this.maybeRemoveSource(
						inputPath,
						outputPath,
						filename,
						losslessHandling,
					);
					return outputPath;
				}

				const outputPath = await this.convertToMp3(
					inputPath,
					artworkPath,
					metadata,
					filename,
					bitrateKbps,
					sourceUrl,
				);

				await this.maybeRemoveSource(
					inputPath,
					outputPath,
					filename,
					losslessHandling,
				);
				return outputPath;
			}

			// otherwise if it is an MP3, we retag it with the correct metadata
			// if metadata is empty, skip retagging
			const hasMetadata =
				metadata.title ||
				metadata.artist ||
				metadata.album ||
				metadata.genre ||
				sourceUrl;
			if (isMp3Format(filename)) {
				if (hasMetadata) {
					await this.retagMp3(inputPath, artworkPath, metadata, sourceUrl);
				}
			} else if (
				lossless === false &&
				PASSTHROUGH_TAG_EXTENSIONS.has(extname(filename).toLowerCase())
			) {
				if (hasMetadata) {
					await this.retagLossy(
						inputPath,
						artworkPath,
						metadata,
						artwork.buffer.byteLength > 0,
						sourceUrl,
					);
				}
			} else {
				console.warn(
					`Unsupported file type: ${filename}. Leaving as is... If you want support for this file type, please create an issue about this on ${REPO_URL}/issues`,
				);
			}
			return inputPath;
		} finally {
			// clean up temporary artwork file
			try {
				await Bun.file(artworkPath).unlink();
			} catch {
				// ignore cleanup errors
			}
		}
	}

	private async maybeRemoveSource(
		inputPath: string,
		outputPath: string,
		filename: string,
		losslessHandling: 'prompt' | 'always' | 'never',
	): Promise<void> {
		if (inputPath === outputPath) return;

		let removeSourceFile = losslessHandling !== 'never';
		if (losslessHandling === 'prompt') {
			removeSourceFile = await confirm({
				message: `Do you want to remove the ${isLosslessFormat(filename) ? 'lossless' : 'source'} file now?`,
				default: true,
			});
		}
		if (removeSourceFile) {
			await Bun.file(inputPath).unlink();
			console.log(`✓ Removed ${inputPath}`);
		}
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

	/** Nominal audio-stream bitrate in kbps, not the container's; null when unknown. */
	private async probeAudioBitrateKbps(path: string): Promise<number | null> {
		const probeData = await this.runFfprobe(path);
		const audioStream = probeData?.streams?.find(
			(stream) => stream.codec_type === 'audio',
		);
		const bps = Number(audioStream?.bit_rate);
		return Number.isFinite(bps) && bps > 0 ? Math.round(bps / 1000) : null;
	}

	/** Probed audio codec name; null when the probe fails or finds no audio stream. */
	private async probeCodecName(inputPath: string): Promise<string | null> {
		const probeData = await this.runFfprobe(inputPath);
		const audioStream = probeData?.streams?.find(
			(stream) => stream.codec_type === 'audio',
		);
		return audioStream?.codec_name ?? null;
	}

	/** Detect whether the downloaded audio codec is lossless. */
	async isLosslessAudio(inputPath: string): Promise<boolean | null> {
		const codecName = await this.probeCodecName(inputPath);
		if (!codecName) return null;
		return isLosslessCodec(codecName);
	}

	/** Pick a free MP3 destination and reserve it on disk before FFmpeg runs. */
	private async allocateMp3OutputPath(
		inputPath: string,
		filename: string,
	): Promise<string> {
		const downloadsDir = './downloads';
		const desiredFilename = toMp3Filename(filename);
		const currentFilename = basename(inputPath);

		return withDownloadRenameLock(async () => {
			const finalName = pickUniqueDownloadFilename({
				desiredFilename,
				currentFilename,
				jobId: crypto.randomUUID(),
				exists: (name) => existsSync(join(downloadsDir, name)),
				isOwnedByOtherJob: () => false,
			});
			const outputPath = join(downloadsDir, finalName);
			// Reserve the name so concurrent converts cannot pick the same path.
			if (finalName !== currentFilename && !existsSync(outputPath)) {
				await Bun.write(outputPath, new Uint8Array());
			}
			return outputPath;
		});
	}

	private async convertToMp3(
		inputPath: string,
		artworkPath: string,
		metadata: Metadata,
		filename: string,
		bitrateKbps: number,
		sourceUrl?: string,
	): Promise<string> {
		const outputPath = await this.allocateMp3OutputPath(inputPath, filename);

		const args: string[] = [
			'-i',
			inputPath,
			'-i',
			artworkPath,
			'-map',
			'0:a',
			'-c:a',
			'libmp3lame',
			'-b:a',
			`${bitrateKbps}k`,
			'-id3v2_version',
			'3',
			'-map',
			'1:v',
			'-c:v',
			'copy',
			'-metadata:s:v',
			'title=Album cover',
			'-metadata:s:v',
			'comment=Cover (front)',
		];

		if (metadata.title) {
			args.push('-metadata', `title=${metadata.title}`);
		}
		if (metadata.artist) {
			args.push('-metadata', `artist=${metadata.artist}`);
		}
		if (metadata.album) {
			args.push('-metadata', `album=${metadata.album}`);
		}
		if (metadata.genre) {
			args.push('-metadata', `genre=${metadata.genre}`);
		}
		if (sourceUrl) {
			args.push('-metadata', `comment=${sourceUrl}`);
		}

		args.push('-y', outputPath);

		console.log(`Converting to MP3 (${bitrateKbps}kbps)...`);
		try {
			await this.run(this.ffmpegBin, args);
		} catch (error) {
			// Drop the empty reservation if conversion failed.
			if (existsSync(outputPath) && (await Bun.file(outputPath).size) === 0) {
				await Bun.file(outputPath)
					.unlink()
					.catch(() => {});
			}
			throw error;
		}
		const actualKbps = await this.probeAudioBitrateKbps(outputPath);
		if (actualKbps !== null && actualKbps !== bitrateKbps) {
			console.warn(
				`Requested ${bitrateKbps}kbps MP3 but the encoder wrote ${actualKbps}kbps: ${outputPath}`,
			);
		}
		console.log(`✓ Converted to ${outputPath}`);
		return outputPath;
	}

	private async convertToFlac(
		inputPath: string,
		artworkPath: string,
		metadata: Metadata,
		filename: string,
		losslessHandling: 'prompt' | 'always' | 'never',
		sourceUrl?: string,
	): Promise<string> {
		const replacingFlac =
			extname(filename).toLowerCase() === '.flac' &&
			losslessHandling === 'always';
		const outputPath = replacingFlac
			? join('./downloads', `.converting-${crypto.randomUUID()}.flac`)
			: await withDownloadRenameLock(async () => {
					const desiredFilename = toFlacFilename(filename);
					const finalName = pickUniqueDownloadFilename({
						desiredFilename,
						currentFilename: '',
						jobId: crypto.randomUUID(),
						exists: (name) => existsSync(join('./downloads', name)),
						isOwnedByOtherJob: () => false,
					});
					const path = join('./downloads', finalName);
					if (!existsSync(path)) await Bun.write(path, new Uint8Array());
					return path;
				});

		const args = [
			'-i',
			inputPath,
			'-i',
			artworkPath,
			'-map',
			'0:a',
			'-map',
			'1:v',
			'-c:a',
			'flac',
			'-compression_level',
			'8',
			'-c:v',
			'copy',
			'-disposition:v',
			'attached_pic',
			'-metadata:s:v',
			'title=Album cover',
			'-metadata:s:v',
			'comment=Cover (front)',
		];

		if (metadata.title) args.push('-metadata', `title=${metadata.title}`);
		if (metadata.artist) args.push('-metadata', `artist=${metadata.artist}`);
		if (metadata.album) args.push('-metadata', `album=${metadata.album}`);
		if (metadata.genre) args.push('-metadata', `genre=${metadata.genre}`);
		if (sourceUrl) args.push('-metadata', `comment=${sourceUrl}`);
		args.push('-y', outputPath);

		console.log('Converting to FLAC...');
		try {
			await this.run(this.ffmpegBin, args);
			if (replacingFlac) {
				await rename(outputPath, inputPath);
				console.log(`✓ Converted to ${inputPath}`);
				return inputPath;
			}
		} catch (error) {
			await Bun.file(outputPath)
				.unlink()
				.catch(() => {});
			throw error;
		}

		console.log(`✓ Converted to ${outputPath}`);
		return outputPath;
	}

	private async convertToM4a(
		inputPath: string,
		artworkPath: string,
		metadata: Metadata,
		filename: string,
		losslessHandling: 'prompt' | 'always' | 'never',
		bitrateKbps: number,
		sourceUrl?: string,
	): Promise<string> {
		const replacingM4a =
			extname(filename).toLowerCase() === '.m4a' &&
			losslessHandling === 'always';
		const outputPath = replacingM4a
			? join('./downloads', `.converting-${crypto.randomUUID()}.m4a`)
			: await withDownloadRenameLock(async () => {
					const desiredFilename = toM4aFilename(filename);
					const finalName = pickUniqueDownloadFilename({
						desiredFilename,
						currentFilename: '',
						jobId: crypto.randomUUID(),
						exists: (name) => existsSync(join('./downloads', name)),
						isOwnedByOtherJob: () => false,
					});
					const path = join('./downloads', finalName);
					if (!existsSync(path)) await Bun.write(path, new Uint8Array());
					return path;
				});

		const coverCodec = m4aCoverCodec(artworkPath);
		const args = [
			'-i',
			inputPath,
			'-i',
			artworkPath,
			'-map',
			'0:a',
			'-map',
			'1:v',
			'-c:a',
			'aac',
			'-profile:a',
			'aac_low',
			'-b:a',
			`${bitrateKbps}k`,
			'-c:v',
			coverCodec,
			'-disposition:v',
			'attached_pic',
			'-metadata:s:v',
			'title=Album cover',
			'-metadata:s:v',
			'comment=Cover (front)',
			'-movflags',
			'+faststart',
		];

		if (metadata.title) args.push('-metadata', `title=${metadata.title}`);
		if (metadata.artist) args.push('-metadata', `artist=${metadata.artist}`);
		if (metadata.album) args.push('-metadata', `album=${metadata.album}`);
		if (metadata.genre) args.push('-metadata', `genre=${metadata.genre}`);
		if (sourceUrl) args.push('-metadata', `comment=${sourceUrl}`);
		args.push('-y', outputPath);

		console.log(`Converting to M4A (AAC ${bitrateKbps}kbps)...`);
		try {
			const { stderr } = await this.run(this.ffmpegBin, args);
			if (/clamping to max/.test(stderr)) {
				console.warn(
					`AAC target ${bitrateKbps}kbps was capped by the encoder for this sample rate and channel count: ${outputPath}`,
				);
			}
			if (replacingM4a) {
				await rename(outputPath, inputPath);
				console.log(`✓ Converted to ${inputPath}`);
				return inputPath;
			}
		} catch (error) {
			await Bun.file(outputPath)
				.unlink()
				.catch(() => {});
			throw error;
		}

		console.log(`✓ Converted to ${outputPath}`);
		return outputPath;
	}

	private async retagMp3(
		inputPath: string,
		artworkPath: string,
		metadata: Metadata,
		sourceUrl?: string,
	): Promise<void> {
		const filename = basename(inputPath);
		const outputPath = join(
			'./downloads',
			filename.replace(/\.mp3$/i, '_retagged.mp3'),
		);

		const args: string[] = [
			'-i',
			inputPath,
			'-i',
			artworkPath,
			'-map',
			'0:a',
			'-c:a',
			'copy',
			'-id3v2_version',
			'3',
			'-map',
			'1:v',
			'-c:v',
			'copy',
			'-metadata:s:v',
			'title=Album cover',
			'-metadata:s:v',
			'comment=Cover (front)',
		];

		if (metadata.title) {
			args.push('-metadata', `title=${metadata.title}`);
		}
		if (metadata.artist) {
			args.push('-metadata', `artist=${metadata.artist}`);
		}
		if (metadata.album) {
			args.push('-metadata', `album=${metadata.album}`);
		}
		if (metadata.genre) {
			args.push('-metadata', `genre=${metadata.genre}`);
		}
		if (sourceUrl) {
			args.push('-metadata', `comment=${sourceUrl}`);
		}

		args.push('-y', outputPath);

		console.log('Retagging MP3...');
		await this.run(this.ffmpegBin, args);

		// replace the original file with the retagged one
		await Bun.write(inputPath, Bun.file(outputPath));
		await Bun.file(outputPath).unlink();
		console.log(`✓ Retagged ${inputPath}`);
	}

	/** Copy the audio of a lossy m4a/ogg/aac and rewrite its tags; only m4a carries a cover. */
	private async retagLossy(
		inputPath: string,
		artworkPath: string,
		metadata: Metadata,
		hasArtwork: boolean,
		sourceUrl?: string,
	): Promise<void> {
		const extension = extname(inputPath).toLowerCase();
		const outputPath = join(
			'./downloads',
			`.retagging-${crypto.randomUUID()}${extension}`,
		);
		const withCover = extension === '.m4a' && hasArtwork;
		const coverCodec = m4aCoverCodec(artworkPath);
		const args: string[] = ['-i', inputPath];
		if (withCover) args.push('-i', artworkPath);
		args.push('-map', '0:a', '-c:a', 'copy');
		if (withCover) {
			args.push(
				'-map',
				'1:v',
				'-c:v',
				coverCodec,
				'-disposition:v',
				'attached_pic',
				'-metadata:s:v',
				'title=Album cover',
				'-metadata:s:v',
				'comment=Cover (front)',
			);
		}
		if (extension === '.m4a') args.push('-movflags', '+faststart');
		// ADTS drops ID3 tags unless the muxer writes them
		if (extension === '.aac') args.push('-write_id3v2', '1', '-f', 'adts');

		if (metadata.title) args.push('-metadata', `title=${metadata.title}`);
		if (metadata.artist) args.push('-metadata', `artist=${metadata.artist}`);
		if (metadata.album) args.push('-metadata', `album=${metadata.album}`);
		if (metadata.genre) args.push('-metadata', `genre=${metadata.genre}`);
		if (sourceUrl) args.push('-metadata', `comment=${sourceUrl}`);
		args.push('-y', outputPath);

		console.log(`Retagging ${extension.slice(1).toUpperCase()}...`);
		try {
			await this.run(this.ffmpegBin, args);
			await rename(outputPath, inputPath);
		} catch (error) {
			await Bun.file(outputPath)
				.unlink()
				.catch(() => {});
			throw error;
		}
		console.log(`✓ Retagged ${inputPath}`);
	}
}
