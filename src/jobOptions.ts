import { type BrowserMode, isBrowserMode, type JobDestination } from './types';

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
	return { browserMode, reviewTags: body.reviewTags === true };
}
