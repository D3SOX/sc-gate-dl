export interface LocalCookieData {
	name: string;
	value: string;
	domain: string;
	path?: string;
	expirationDate?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: string;
}

export type BrowserMode = 'headless' | 'xvfb' | 'headed';

export function isBrowserMode(value: unknown): value is BrowserMode {
	return value === 'headless' || value === 'xvfb' || value === 'headed';
}

export interface HypedditConfig {
	/** Optional — only needed for Hypeddit/GateRush email gates that ask for a name. */
	name?: string;
	/** Optional — only needed for Hypeddit/GateRush email gates. */
	email?: string;
	comment: string;
	browserMode: BrowserMode;
	/** Persistent Chromium profile. Defaults to `./browser-data`. */
	userDataDir?: string;
}

export interface Metadata {
	title?: string;
	artist?: string;
	album?: string;
	genre?: string;
}

export type OutputFormat = 'original' | 'mp3-320' | 'flac';

// Job system types for Web UI
export type JobStage =
	| 'pending'
	| 'fetching_track'
	| 'waiting_hypeddit'
	| 'waiting_bandcamp_track'
	| 'initializing_browser'
	| 'preparing_logins'
	| 'handling_gates'
	| 'downloading'
	| 'processing_audio'
	| 'ready'
	| 'error'
	| 'cancelled';

/** Candidate track on a Bandcamp album when auto title-match fails. */
export interface BandcampAlbumTrackChoice {
	title: string;
	url: string;
	/** 0–1 fuzzy score against the SoundCloud title (0 when no title to match). */
	score: number;
}

export interface JobProgress {
	stage: JobStage;
	message: string;
	percent: number;
	currentGate?: string;
	downloadBytes?: number;
	totalBytes?: number;
	// True when the download was handled without a browser. Such downloads never
	// touch the SoundCloud account, so the UI can skip the cleanup prompt.
	browserless?: boolean;
	/** Present while stage is `waiting_bandcamp_track`. */
	bandcampAlbumTracks?: BandcampAlbumTrackChoice[];
}

export interface Job {
	id: string;
	soundcloudUrl: string;
	hypedditUrl: string | null;
	/** Candidates when Bandcamp album auto-match fails (cleared after pick). */
	bandcampAlbumTracks: BandcampAlbumTrackChoice[] | null;
	browserMode: BrowserMode;
	outputFormat: OutputFormat;
	/** Set when the user cancels; download loop should stop and close the browser. */
	cancelled: boolean;
	track: {
		title: string;
		artworkUrl: string | null;
		purchaseUrl?: string;
		description?: string;
		user: {
			username: string;
			fullName?: string;
			avatarUrl: string;
		};
		publisherMetadata?: {
			artist?: string;
			albumTitle?: string;
		};
		genre?: string;
	} | null;
	defaultMetadata: Metadata | null;
	existingMetadata: Metadata | null;
	progress: JobProgress;
	downloadFilename: string | null;
	outputFilename: string | null;
	/** Whether the downloaded source codec is lossless, when probed for FLAC output. */
	sourceIsLossless: boolean | null;
	artworkBuffer: ArrayBuffer | null;
	artworkFileName: string | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
}
