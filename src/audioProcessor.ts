import { basename, join } from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import { execa } from 'execa';
import type { SoundcloudTrack } from 'soundcloud.ts';
import type { Metadata } from './types';
import {
	getDefaultMetadata,
	isLosslessFormat,
	isMp3Format,
	needsMp3Conversion,
	REPO_URL,
	toMp3Filename,
} from './utils';

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

		const tags = probeData.format?.tags || probeData.streams?.[0]?.tags || null;

		if (!tags) {
			return null;
		}

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
	): Promise<string> {
		const inputPath = join('./downloads', filename);

		// save artwork to temporary file
		const artworkPath = join('./downloads', artwork.fileName);
		const artworkExists = await Bun.file(artworkPath).exists();
		if (!artworkExists) {
			await Bun.write(artworkPath, artwork.buffer);
		}

		try {
			// Convert non-MP3 audio (lossless or lossy containers like m4a) to MP3.
			if (needsMp3Conversion(filename)) {
				const outputPath = await this.convertToMp3(
					inputPath,
					artworkPath,
					metadata,
					filename,
				);

				// ask if you want to remove the source file (only prompt for lossless)
				let removeSourceFile = true;
				if (isLosslessFormat(filename)) {
					if (losslessHandling === 'prompt') {
						removeSourceFile = await confirm({
							message: 'Do you want to remove the lossless file now?',
							default: true,
						});
					} else if (losslessHandling === 'always') {
						removeSourceFile = true;
					} else if (losslessHandling === 'never') {
						removeSourceFile = false;
					}
				}
				if (removeSourceFile) {
					await Bun.file(inputPath).unlink();
					console.log(`✓ Removed ${inputPath}`);
				}
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

	private async runFfprobe(inputPath: string): Promise<{
		format?: { tags?: Record<string, string>; bit_rate?: string };
		streams?: Array<{
			tags?: Record<string, string>;
			codec_type?: string;
			bit_rate?: string;
		}>;
	} | null> {
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
			return JSON.parse(stdout) as {
				format?: { tags?: Record<string, string>; bit_rate?: string };
				streams?: Array<{
					tags?: Record<string, string>;
					codec_type?: string;
					bit_rate?: string;
				}>;
			};
		} catch (error) {
			console.warn(
				`Failed to probe audio: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	/** Probe audio bitrate in kbps; null when unknown. */
	private async probeAudioBitrateKbps(
		inputPath: string,
	): Promise<number | null> {
		const probeData = await this.runFfprobe(inputPath);
		if (!probeData) {
			return null;
		}

		const audioStream = probeData.streams?.find(
			(stream) => stream.codec_type === 'audio',
		);
		const raw =
			audioStream?.bit_rate || probeData.format?.bit_rate || undefined;
		if (!raw) return null;

		const bps = Number(raw);
		if (!Number.isFinite(bps) || bps <= 0) return null;
		return Math.round(bps / 1000);
	}

	/**
	 * Target MP3 bitrate: lossless → 320; lossy → source rate (capped at 320).
	 * Never upscales a 128k stream to fake 320.
	 */
	private async resolveMp3BitrateKbps(
		inputPath: string,
		filename: string,
	): Promise<number> {
		if (isLosslessFormat(filename)) {
			return 320;
		}

		const probed = await this.probeAudioBitrateKbps(inputPath);
		if (probed == null) {
			return 192;
		}
		return Math.min(320, Math.max(32, probed));
	}

	private async convertToMp3(
		inputPath: string,
		artworkPath: string,
		metadata: Metadata,
		filename: string,
	): Promise<string> {
		const outputPath = join('./downloads', toMp3Filename(filename));
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
		await execa(this.ffmpegBin, args);
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
