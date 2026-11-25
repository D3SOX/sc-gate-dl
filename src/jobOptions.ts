import {
	type BrowserMode,
	isBrowserMode,
	isOutputFormat,
	type JobDestination,
	type OutputFormat,
} from './types';

/** A requested browser mode, or the error message for a 400 response. */
export function parseBrowserMode(
	value: unknown,
	availableModes: readonly BrowserMode[],
): BrowserMode | string {
	if (!isBrowserMode(value)) return 'Invalid browser mode';
	if (!availableModes.includes(value)) {
		return 'Xvfb browser mode is only available on Linux';
	}
	return value;
}

/** A requested output format, or the error message for a 400 response. */
export function parseOutputFormat(value: unknown): OutputFormat | string {
	if (!isOutputFormat(value)) {
		return 'outputFormat must be "original", "mp3", "mp3-320", "m4a-aac", or "flac"';
	}
	return value;
}

/** Every non-original format converts, so the source must be probed first. */
export function needsSourceLosslessProbe(outputFormat: OutputFormat): boolean {
	return outputFormat !== 'original';
}

export interface UnattendedJobOptions {
	/** Omitted keeps the server default from `BROWSER_HEADLESS`. */
	browserMode?: BrowserMode;
	reviewTags: boolean;
}

/**
 * The `browserMode` and `reviewTags` fields of `POST /api/job`, or the error
 * message for a 400 response.
 */
export function parseUnattendedJobOptions(
	body: { browserMode?: unknown; reviewTags?: unknown },
	destination: JobDestination | null,
	availableModes: readonly BrowserMode[],
	reviewTagsDefault = false,
): UnattendedJobOptions | string {
	let browserMode: BrowserMode | undefined;
	if (body.browserMode !== undefined) {
		const parsed = parseBrowserMode(body.browserMode, availableModes);
		if (!isBrowserMode(parsed)) return parsed;
		browserMode = parsed;
	}
	if (body.reviewTags !== undefined && typeof body.reviewTags !== 'boolean') {
		return 'reviewTags must be true or false';
	}
	if (body.reviewTags && !destination) {
		return 'reviewTags needs a destination. Web UI jobs always stop for tags';
	}
	const reviewTags =
		body.reviewTags ?? (destination ? reviewTagsDefault : false);
	return { browserMode, reviewTags: reviewTags === true };
}

/** `SC_GATE_DL_REVIEW_TAGS`: unset means automatic processing (false). */
export function parseReviewTagsSetting(value: string | undefined): boolean {
	if (value === undefined) return false;
	const text = value.trim().toLowerCase();
	if (text === 'true') return true;
	if (text === 'false') return false;
	throw new Error(
		`SC_GATE_DL_REVIEW_TAGS=${value} is not valid. Use true or false, or leave it unset for false.`,
	);
}
