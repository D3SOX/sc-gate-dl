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

export interface HypedditConfig {
	/** Optional — only needed for Hypeddit/GateRush email gates that ask for a name. */
	name?: string;
	/** Optional — only needed for Hypeddit/GateRush email gates. */
	email?: string;
	comment: string;
	headless: boolean;
	/** Persistent Chromium profile. Defaults to `./browser-data`. */
	userDataDir?: string;
}

export interface Metadata {
	title?: string;
	artist?: string;
	album?: string;
	genre?: string;
}

// Job system types for Web UI
export type JobStage =
	| 'pending'
	| 'fetching_track'
	| 'waiting_hypeddit'
	| 'initializing_browser'
	| 'preparing_logins'
	| 'handling_gates'
	| 'downloading'
	| 'processing_audio'
	| 'ready'
	| 'error';

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
}

export interface Job {
	id: string;
	soundcloudUrl: string;
	hypedditUrl: string | null;
	/** Whether browser automation runs headless. Defaults to true. */
	headless: boolean;
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
	progress: JobProgress;
	downloadFilename: string | null;
	outputFilename: string | null;
	artworkBuffer: ArrayBuffer | null;
	artworkFileName: string | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
}
