import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import { execa } from 'execa';
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
	needsMp3Conversion,
	REPO_URL,
	toFlacFilename,
	toMp3Filename,
} from './utils';

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

export class AudioProcessor {
	private ffmpegBin: string;
	private ffprobeBin: string;

	constructor(ffmpegBin: string, ffprobeBin: string) {
		this.ffmpegBin = ffmpegBin;
		this.ffprobeBin = ffprobeBin;
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
			await execa(this.ffmpegBin, [
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
	): Promise<string> {
		const inputPath = join('./downloads', filename);

		// save artwork to temporary file
		const artworkPath = join('./downloads', artwork.fileName);
		const artworkExists = await Bun.file(artworkPath).exists();
		if (!artworkExists) {
			await Bun.write(artworkPath, artwork.buffer);
		}

		try {
			if (outputFormat === 'flac') {
				const outputPath = await this.convertToFlac(
					inputPath,
					artworkPath,
					metadata,
					filename,
				);
				await this.maybeRemoveSource(
					inputPath,
					outputPath,
					filename,
					losslessHandling,
				);
				return outputPath;
			}

			// Convert non-MP3 audio (lossless or lossy containers like m4a) to MP3.
			if (needsMp3Conversion(filename)) {
				const outputPath = await this.convertToMp3(
					inputPath,
					artworkPath,
					metadata,
					filename,
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
			else if (isMp3Format(filename)) {
				// if metadata is empty, skip retagging
				const hasMetadata =
					metadata.title || metadata.artist || metadata.album || metadata.genre;

				if (hasMetadata) {
					await this.retagMp3(inputPath, artworkPath, metadata);
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
			const { stdout } = await execa(this.ffprobeBin, [
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
		const codec = codecName.toLowerCase();
		return (
			codec === 'alac' ||
			codec === 'flac' ||
			codec === 'wavpack' ||
			codec === 'ape' ||
			codec.startsWith('pcm_')
		);
	}

	/**
	 * Target MP3 bitrate: lossless → 320; lossy → source rate (capped at 320).
	 * Never upscales a 128k stream to fake 320.
	 */
	private async resolveMp3BitrateKbps(
		inputPath: string,
		filename: string,
	): Promise<number> {
		const probed = await this.probeAudioStream(inputPath);
		const losslessCodec = probed.codecName?.toLowerCase() === 'alac';
		if (isLosslessFormat(filename) || losslessCodec) {
			return 320;
		}

		if (probed.bitrateKbps == null) {
			return 192;
		}
		return Math.min(320, Math.max(32, probed.bitrateKbps));
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
	): Promise<string> {
		const outputPath = await this.allocateMp3OutputPath(inputPath, filename);
		const bitrateKbps = await this.resolveMp3BitrateKbps(inputPath, filename);

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

		args.push('-y', outputPath);

		console.log(`Converting to MP3 (${bitrateKbps}kbps)...`);
		try {
			await execa(this.ffmpegBin, args);
		} catch (error) {
			// Drop the empty reservation if conversion failed.
			if (existsSync(outputPath) && (await Bun.file(outputPath).size) === 0) {
				await Bun.file(outputPath)
					.unlink()
					.catch(() => {});
			}
			throw error;
		}
		console.log(`✓ Converted to ${outputPath}`);
		return outputPath;
	}

	private async convertToFlac(
		inputPath: string,
		artworkPath: string,
		metadata: Metadata,
		filename: string,
	): Promise<string> {
		const replacingFlac = extname(filename).toLowerCase() === '.flac';
		const outputPath = replacingFlac
			? join('./downloads', `.converting-${crypto.randomUUID()}.flac`)
			: await withDownloadRenameLock(async () => {
					const desiredFilename = toFlacFilename(filename);
					const finalName = pickUniqueDownloadFilename({
						desiredFilename,
						currentFilename: basename(inputPath),
						jobId: crypto.randomUUID(),
						exists: (name) => existsSync(join('./downloads', name)),
						isOwnedByOtherJob: () => false,
					});
					const path = join('./downloads', finalName);
					if (!existsSync(path)) await Bun.write(path, new Uint8Array());
					return path;
				});

		const losslessSource = await this.isLosslessAudio(inputPath);
		if (losslessSource === false) {
			const { codecName } = await this.probeAudioStream(inputPath);
			console.warn(
				`Source codec ${codecName ?? 'unknown'} is lossy; FLAC conversion cannot restore lost audio quality.`,
			);
		}

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
		args.push('-y', outputPath);

		console.log('Converting to FLAC...');
		try {
			await execa(this.ffmpegBin, args);
			if (replacingFlac) {
				await Bun.file(inputPath).unlink();
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
			'-map_metadata',
			'-1', // clear existing metadata
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

		args.push('-y', outputPath);

		console.log('Retagging MP3...');
		await execa(this.ffmpegBin, args);

		// replace the original file with the retagged one
		await Bun.write(inputPath, Bun.file(outputPath));
		await Bun.file(outputPath).unlink();
		console.log(`✓ Retagged ${inputPath}`);
	}
}
