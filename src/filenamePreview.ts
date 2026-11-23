/** Lossless extensions that always mean lossless; .caf and .m4a can hold lossy AAC, so they need the probe. */
export const LOSSLESS_EXTENSIONS = [
	'.wav',
	'.aiff',
	'.aif',
	'.flac',
	'.ape',
	'.wv',
	'.tta',
	'.dsf',
	'.caf',
	'.w64',
] as const;

/** Sanitize filename parts. */
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

const PREVIEW_LOSSLESS_HINT = LOSSLESS_EXTENSIONS.filter(
	(ext) => ext !== '.caf',
);

function hasExtension(
	filename: string,
	extensions: readonly string[],
): boolean {
	const lower = filename.toLowerCase();
	return extensions.some((ext) => lower.endsWith(ext));
}

function extensionOf(filename: string): string {
	return filename.match(/\.[^./\\]+$/)?.[0] ?? '';
}

function replaceExtension(filename: string, extension: string): string {
	return filename.replace(/\.[^./\\]+$/, '') + extension;
}

function previewExtension(
	outputFormat: 'mp3' | 'mp3-320' | 'm4a-aac' | 'flac' | 'original' | undefined,
): string {
	if (outputFormat === 'flac') return '.flac';
	if (outputFormat === 'm4a-aac') return '.m4a';
	return '.mp3';
}

/** Predicted output name for the metadata step. */
export function previewProcessedFilename(
	downloadFilename: string,
	options: {
		nameAsArtistTitle: boolean;
		artist?: string;
		title?: string;
		outputFormat?: 'mp3' | 'mp3-320' | 'm4a-aac' | 'flac' | 'original';
		/** Probed lossless state; without a probe, an unambiguous lossless extension decides. */
		sourceIsLossless?: boolean | null;
	},
): string {
	const lossless =
		options.sourceIsLossless ??
		hasExtension(downloadFilename, PREVIEW_LOSSLESS_HINT);
	const keepsSource = options.outputFormat === 'original' || !lossless;
	const extension = keepsSource
		? extensionOf(downloadFilename)
		: previewExtension(options.outputFormat);
	if (options.nameAsArtistTitle) {
		return artistTitleFilename(options.artist, options.title, extension);
	}
	if (keepsSource) {
		return downloadFilename;
	}
	return replaceExtension(downloadFilename, extension);
}
