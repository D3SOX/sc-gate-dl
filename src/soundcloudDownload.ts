import type { SoundcloudTrack } from 'soundcloud.ts';

/** Whether SoundCloud currently exposes the creator-enabled download button. */
export function isSoundcloudDownloadEnabled(
	track: Pick<SoundcloudTrack, 'downloadable' | 'has_downloads_left'>,
): boolean {
	return track.downloadable && track.has_downloads_left;
}
