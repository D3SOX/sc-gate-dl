import type { SoundcloudTrack } from 'soundcloud.ts';
import { canAccessSoundcloudOriginalDownload } from './ytdlp';

/** Whether SoundCloud currently exposes the creator-enabled download button. */
export function isSoundcloudDownloadEnabled(
	track: Pick<SoundcloudTrack, 'downloadable' | 'has_downloads_left'>,
): boolean {
	return track.downloadable && track.has_downloads_left;
}

export const CREATOR_DOWNLOAD_WARNING =
	'This track has a creator-enabled SoundCloud download, but yt-dlp could not access it. Add or refresh soundcloud-cookies.json to use the original download; continuing with the gate instead.';

/**
 * A creator-enabled SoundCloud download is the preferred source: it bypasses
 * gates and lets yt-dlp select the original `download` format. `available`
 * says whether to use it; `warning` explains why an enabled one can't be.
 */
export async function checkCreatorDownload(
	track: Pick<SoundcloudTrack, 'downloadable' | 'has_downloads_left'>,
	url: string,
	canAccess: (url: string) => Promise<boolean> = (url) =>
		canAccessSoundcloudOriginalDownload(url),
): Promise<{ available: boolean; warning: string | null }> {
	if (!isSoundcloudDownloadEnabled(track)) {
		return { available: false, warning: null };
	}
	return (await canAccess(url))
		? { available: true, warning: null }
		: { available: false, warning: CREATOR_DOWNLOAD_WARNING };
}
