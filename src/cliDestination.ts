import { existsSync } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveDownloadedAudio } from './archiveAudio';
import type { AudioProcessor } from './audioProcessor';
import { parseOutputBitrateKbps } from './audioProcessor';
import { type FileTransfer, placeIntoDirectory } from './safeTransfer';
import type { Metadata } from './types';

const DOWNLOADS_DIR = './downloads';

export type CliFormat = 'mp3' | 'm4a-aac' | 'flac' | 'original';

const CLI_FORMATS: readonly CliFormat[] = [
	'mp3',
	'm4a-aac',
	'flac',
	'original',
];

/**
 * Parse `SC_GATE_DL_CLI_FORMAT` and, only for `mp3` and `m4a-aac`, the shared
 * `SC_GATE_DL_BITRATE`. Unset format means `mp3`.
 */
export function cliFormatFromEnv(
	formatValue: string | undefined,
	bitrateValue: string | undefined,
): { format: CliFormat; bitrateKbps: number } {
	const trimmed = formatValue?.trim();
	const format = trimmed ? trimmed : 'mp3';
	if (!CLI_FORMATS.includes(format as CliFormat)) {
		throw new Error(
			`SC_GATE_DL_CLI_FORMAT=${formatValue} is not supported. Use one of: ${CLI_FORMATS.join(', ')}`,
		);
	}
	const cliFormat = format as CliFormat;
	const bitrateKbps =
		cliFormat === 'mp3' || cliFormat === 'm4a-aac'
			? parseOutputBitrateKbps(bitrateValue, cliFormat)
			: 320;
	return { format: cliFormat, bitrateKbps };
}

/**
 * Final CLI output folder from `SC_GATE_DL_CLI_DIR`. Unset means `./downloads`.
 * `~user` is rejected because only the current user's home is expanded.
 */
export function cliDirFromEnv(value = process.env.SC_GATE_DL_CLI_DIR): string {
	const trimmed = value?.trim();
	if (!trimmed) return resolve(DOWNLOADS_DIR);
	if (trimmed === '~' || trimmed.startsWith('~/')) {
		return join(homedir(), trimmed.slice(1));
	}
	if (trimmed.startsWith('~')) {
		throw new Error(
			`SC_GATE_DL_CLI_DIR=${trimmed} is not supported: ~user paths are not supported. Use an absolute path or ~/...`,
		);
	}
	return resolve(trimmed);
}

/** Every CLI output setting, validated before any gate is opened. */
export function cliOutputFromEnv(
	env: Partial<Record<string, string>> = process.env,
): { format: CliFormat; bitrateKbps: number; destinationDir: string } {
	const { format, bitrateKbps } = cliFormatFromEnv(
		env.SC_GATE_DL_CLI_FORMAT,
		env.SC_GATE_DL_BITRATE,
	);
	return {
		format,
		bitrateKbps,
		destinationDir: cliDirFromEnv(env.SC_GATE_DL_CLI_DIR),
	};
}

async function isInDirectory(path: string, dir: string): Promise<boolean> {
	return (await realpath(dirname(path))) === (await realpath(dir));
}

/** Put a file into `dir` under a free name, removing the original only after the copy. */
async function placeIn(
	path: string,
	dir: string,
	transfer?: FileTransfer,
): Promise<string> {
	if (await isInDirectory(path, dir)) return resolve(path);
	return placeIntoDirectory({ sourcePath: path, dir, transfer });
}

/**
 * Deliver the finished CLI output into `destinationDir` and return the final
 * paths. A retained source (`removeSource: false`) is delivered too. A removed
 * source is deleted only after the output is in place. On failure, the error
 * names every file that still exists so the user can recover it.
 */
export async function deliverCliOutput(options: {
	outputPath: string;
	sourcePath: string;
	removeSource: boolean;
	destinationDir: string;
	transfer?: FileTransfer;
}): Promise<string[]> {
	const { outputPath, sourcePath, removeSource, destinationDir, transfer } =
		options;
	const delivered: string[] = [];
	try {
		await mkdir(destinationDir, { recursive: true });
		delivered.push(await placeIn(outputPath, destinationDir, transfer));
		if (resolve(sourcePath) !== resolve(outputPath)) {
			if (removeSource) {
				await rm(sourcePath, { force: true });
			} else {
				delivered.push(await placeIn(sourcePath, destinationDir, transfer));
			}
		}
	} catch (error) {
		const survivors = [outputPath, sourcePath, ...delivered]
			.map((path) => resolve(path))
			.filter((path) => existsSync(path));
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Delivery to ${resolve(destinationDir)} failed: ${message}. Files kept: ${[...new Set(survivors)].join(', ')}`,
		);
	}
	return delivered;
}

/**
 * Finish one CLI download: extract a ZIP payload, then either deliver the
 * selected audio as-is (`original`) or process it into the chosen format and
 * deliver the result. Lossy and unknown sources are never re-encoded.
 */
export async function finishCliDownload(options: {
	downloadFilename: string;
	output: { format: CliFormat };
	losslessHandling: 'prompt' | 'always' | 'never';
	destinationDir: string;
	soundcloudUrl: string;
	audioProcessor: AudioProcessor;
	steps: {
		fetchArtwork: () => Promise<{ buffer: ArrayBuffer; fileName: string }>;
		promptMetadata: (filename: string) => Promise<{
			metadata: Metadata;
			retag: boolean;
		}>;
		confirmRemoveSource: (filename: string) => Promise<boolean>;
	};
}): Promise<{
	delivered: string[];
	sourceRemoved: boolean;
	sourcePath: string;
}> {
	const { output, destinationDir, audioProcessor, steps } = options;
	const filename = await resolveDownloadedAudio(options.downloadFilename);
	const sourcePath = join(DOWNLOADS_DIR, filename);

	if (output.format === 'original') {
		const delivered = await deliverCliOutput({
			outputPath: sourcePath,
			sourcePath,
			removeSource: false,
			destinationDir,
		});
		return { delivered, sourceRemoved: false, sourcePath };
	}

	const artwork = await steps.fetchArtwork();
	const { metadata, retag } = await steps.promptMetadata(filename);
	let outputPath: string;
	try {
		outputPath = await audioProcessor.processAudio(
			filename,
			metadata,
			artwork,
			'never',
			output.format,
			options.soundcloudUrl,
			retag,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Conversion of ${sourcePath} failed: ${message}. Files kept: ${resolve(sourcePath)}`,
		);
	}

	const removeSource =
		outputPath !== sourcePath &&
		(options.losslessHandling === 'always' ||
			(options.losslessHandling === 'prompt' &&
				(await steps.confirmRemoveSource(filename))));

	const delivered = await deliverCliOutput({
		outputPath,
		sourcePath,
		removeSource,
		destinationDir,
	});
	return { delivered, sourceRemoved: removeSource, sourcePath };
}
