// Shared by the server, the CLI and the Web UI, so it must stay browser-safe.
import type { OutputFormat } from './types';

const LOSSLESS_EXTENSIONS = [
	'.wav',
	'.aiff',
	'.aif',
	'.flac',
	'.ape',
	'.wv',
	'.alac',
	'.tta',
] as const;
/** Lossy containers that are converted or, for AAC, retagged. */
const LOSSY_EXTENSIONS = ['.m4a', '.aac', '.ogg', '.opus', '.webm'] as const;

function hasExtension(
	filename: string,
	extensions: readonly string[],
): boolean {
	const lower = filename.toLowerCase();
	return extensions.some((ext) => lower.endsWith(ext));
}

export function isLosslessFormat(filename: string): boolean {
	return hasExtension(filename, LOSSLESS_EXTENSIONS);
}

export function isMp3Format(filename: string): boolean {
	return filename.toLowerCase().endsWith('.mp3');
}

/** True for audio the MP3, M4A/AAC and FLAC outputs can convert. */
export function needsMp3Conversion(filename: string): boolean {
	return isLosslessFormat(filename) || hasExtension(filename, LOSSY_EXTENSIONS);
}

export type AudioPlan = 'retag' | 'mp3' | 'm4a-aac' | 'flac' | 'unsupported';

/**
 * What happens to a download for an output format. Lossy MP3 and AAC play
 * everywhere, so they are only retagged and never re-encoded; other lossy
 * formats and lossless sources are converted. [sourceIsLossless] is the codec
 * probe, or null when it is unknown.
 */
export function planAudioOutput(
	filename: string,
	sourceIsLossless: boolean | null,
	outputFormat: Exclude<OutputFormat, 'original'>,
): AudioPlan {
	if (!isMp3Format(filename) && !needsMp3Conversion(filename)) {
		return 'unsupported';
	}
	if (outputFormat === 'flac') return 'flac';
	if (
		isMp3Format(filename) ||
		(sourceIsLossless !== true && hasExtension(filename, ['.m4a', '.aac']))
	) {
		return 'retag';
	}
	return outputFormat === 'm4a-aac' ? 'm4a-aac' : 'mp3';
}

const PLAN_EXTENSIONS: Record<AudioPlan, string | null> = {
	retag: null,
	unsupported: null,
	mp3: '.mp3',
	'm4a-aac': '.m4a',
	flac: '.flac',
};

/** File extension after processing, with the dot. */
export function processedExtension(
	filename: string,
	sourceIsLossless: boolean | null,
	outputFormat: OutputFormat,
): string {
	const own = filename.match(/\.[^.]+$/)?.[0] ?? '';
	if (outputFormat === 'original') return own;
	const planned =
		PLAN_EXTENSIONS[planAudioOutput(filename, sourceIsLossless, outputFormat)];
	// A raw .aac stream is moved into an .m4a when it is tagged.
	return planned ?? (own.toLowerCase() === '.aac' ? '.m4a' : own);
}

/** Strip characters that are unsafe or awkward in filenames. */
export function sanitizeFilenamePart(value: string): string {
	return value
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** `Artist - Title` (+ extension) from metadata fields. */
export function artistTitleFilename(
	artist?: string,
	title?: string,
	extension = '.mp3',
): string {
	const safeArtist = sanitizeFilenamePart(artist || '') || 'Unknown Artist';
	const safeTitle = sanitizeFilenamePart(title || '') || 'Unknown Title';
	const ext = extension.startsWith('.') ? extension : `.${extension}`;
	return `${safeArtist} - ${safeTitle}${ext}`;
}

/** Predicted output name for the metadata step. */
export function previewProcessedFilename(
	downloadFilename: string,
	options: {
		nameAsArtistTitle: boolean;
		artist?: string;
		title?: string;
		outputFormat?: OutputFormat;
		sourceIsLossless?: boolean | null;
	},
): string {
	const extension = processedExtension(
		downloadFilename,
		options.sourceIsLossless ?? null,
		options.outputFormat ?? 'mp3-320',
	);
	if (options.nameAsArtistTitle) {
		return artistTitleFilename(options.artist, options.title, extension);
	}
	return downloadFilename.replace(/(\.[^.]+)?$/, extension);
}
