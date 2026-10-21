import { useCallback, useEffect, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import type {
	BrowserMode,
	OutputFormat,
	SearchResponse,
	SearchResult,
} from '../../../src/types';
import './App.css';
import { resolveApiBase } from './apiBase';
import {
	parseAvailableBrowserModes,
	parseBrowserViewUrl,
	readRequestedBrowserMode,
	readRequestedOutputFormat,
	readStoredBrowserMode,
	readStoredOutputFormat,
	shouldAutoStartDeepLink,
	shouldUseEmbeddedLayout,
} from './deepLink';
import { GateAttentionMessage } from './GateAttentionMessage';
import { RecordSleeve } from './RecordSleeve';
import { RemoteBrowserPanel } from './RemoteBrowserPanel';
import { REMOTE_POINTER_RELEASE_EVENT } from './remoteBrowser';
import {
	appendSearchResults,
	formatDuration,
	isTrackUrlInput,
	SEARCH_SOURCE_LABELS,
	searchThumbnailUrl,
} from './trackSearch';

type Step = 'url' | 'gate' | 'download' | 'metadata' | 'complete';

interface Metadata {
	title?: string;
	artist?: string;
	album?: string;
	genre?: string;
}

interface TrackInfo {
	title: string;
	artworkUrl: string | null;
	user: { username: string; fullName?: string; avatarUrl: string };
	genre?: string;
}

interface JobProgress {
	stage: string;
	message: string;
	percent: number;
	currentGate?: string;
	downloadBytes?: number;
	totalBytes?: number;
	browserless?: boolean;
	browserActive?: boolean;
	requiresAttention?: boolean;
	attentionId?: string;
	bandcampAlbumTracks?: BandcampAlbumTrackChoice[];
	queuePosition?: number;
}

const GATE_PROGRESS_STAGES = new Set([
	'queued',
	'initializing_browser',
	'preparing_logins',
	'handling_gates',
	'waiting_bandcamp_track',
	'cancelling',
]);

const ACTIVE_JOB_STAGES = new Set([
	'queued',
	'initializing_browser',
	'preparing_logins',
	'handling_gates',
	'waiting_bandcamp_track',
	'downloading',
	'processing_audio',
	'cancelling',
]);

interface BandcampAlbumTrackChoice {
	title: string;
	url: string;
	score: number;
}

interface SearchState {
	query: string;
	results: SearchResult[];
	nextOffset: number | null;
}

interface JobState {
	jobId: string | null;
	track: TrackInfo | null;
	hypedditUrl: string | null;
	defaultMetadata: Metadata | null;
	existingMetadata: Metadata | null;
	hasExistingArtwork: boolean;
	outputFormat: OutputFormat;
	progress: JobProgress | null;
	downloadFilename: string | null;
	outputFilename: string | null;
	sourceIsLossless: boolean | null;
	warning: string | null;
	error: string | null;
}

const API_BASE = resolveApiBase(
	typeof window === 'undefined' ? undefined : window.location,
	import.meta.env.PUBLIC_API_BASE_URL,
);
const BROWSER_MODE_STORAGE_KEY = 'sc-gate-dl-browser-mode';
const OUTPUT_FORMAT_STORAGE_KEY = 'sc-gate-dl-output-format';
const BROWSER_MODE_LABELS: Record<BrowserMode, string> = {
	headless: 'Headless',
	xvfb: 'Hidden window (Xvfb)',
	headed: 'Visible window',
};
const BROWSER_MODE_HINTS: Record<BrowserMode, string> = {
	headless: 'Runs without a window.',
	xvfb: 'Runs a real window on a virtual display. Gates detect it less often than headless.',
	headed: 'Opens a window you can watch and take over when a gate needs you.',
};
const BROWSER_MODE_RETRY_LABELS: Record<BrowserMode, string> = {
	headless: 'Retry headless',
	xvfb: 'Retry in a hidden window',
	headed: 'Retry in a visible window',
};

const OUTPUT_FORMAT_OPTIONS: {
	value: OutputFormat;
	label: string;
	hint: string;
}[] = [
	{
		value: 'mp3-320',
		label: 'MP3 320',
		hint: 'Converts to MP3 at 320 kbps, then lets you check the tags.',
	},
	{
		value: 'flac',
		label: 'FLAC',
		hint: 'Converts to FLAC, then lets you check the tags. A lossy source stays lossy.',
	},
	{
		value: 'original',
		label: 'Original',
		hint: 'Keeps the file as downloaded, with no conversion or tag editing.',
	},
];

const STEPS: { id: Step; label: string }[] = [
	{ id: 'url', label: 'Link' },
	{ id: 'gate', label: 'Gate' },
	{ id: 'download', label: 'Download' },
	{ id: 'metadata', label: 'Tags' },
	{ id: 'complete', label: 'Done' },
];

const GATE_STEP_LABELS: Record<string, string> = {
	sc: 'SoundCloud',
	soundcloud: 'SoundCloud',
	ig: 'Instagram',
	tt: 'TikTok',
	yt: 'YouTube',
	fb: 'Facebook',
	sp: 'Spotify',
	bc: 'Bandcamp',
	dl: 'Download',
};

function gateStepLabel(gate: string): string {
	return (
		GATE_STEP_LABELS[gate.toLowerCase()] ??
		gate.charAt(0).toUpperCase() + gate.slice(1)
	);
}

/** How far the record has slid out of its sleeve for the current step. */
function recordOutFor(step: Step, progress: JobProgress | null): number {
	if (step === 'url') return 0;
	if (step === 'gate') return 0.14;
	if (step === 'download') {
		if (typeof progress?.totalBytes !== 'number') return 0.3;
		return 0.14 + 0.86 * Math.min(1, (progress.percent || 0) / 100);
	}
	return 1;
}

const ALLOWED_HOST_ORIGINS = new Set([
	'https://soundcloud.com',
	'https://www.soundcloud.com',
	'https://m.soundcloud.com',
	'http://localhost:4321',
	'http://127.0.0.1:4321',
]);

function notifyParent(
	type: 'file-download' | 'new-download' | 'job' | 'cancelled' | 'ready',
	payload?: { jobId?: string },
) {
	if (window.parent === window) return;
	window.parent.postMessage({ source: 'sc-gate-dl', type, ...payload }, '*');
}

/** Promo fluff often glued onto SoundCloud / gate titles. */
const PROMO_TAG = String.raw`free\s*d(?:own)?l(?:oad)?s?|free[\s._-]*dl|freedl|out\s*now|premiere|exclusive`;

export function cleanPromoTags(value: string): string {
	if (!value) return value;

	let result = value;
	result = result.replace(
		new RegExp(
			String.raw`\s*[\[\(\{]\s*(?:${PROMO_TAG})\s*[\]\)\}]\s*(?:[-–—|/:·•]+\s*)?`,
			'gi',
		),
		' ',
	);
	result = result.replace(
		new RegExp(
			String.raw`(?:\s*[-–—|/·•*]+\s*|\s+)(?:${PROMO_TAG})(?:\s*\*+)?\s*$`,
			'gi',
		),
		'',
	);
	result = result.replace(
		new RegExp(String.raw`(?:${PROMO_TAG})\s*$`, 'gi'),
		'',
	);
	result = result.replace(
		new RegExp(String.raw`^\s*(?:${PROMO_TAG})(?:\s*[-–—|/·•]+\s*|\s+)`, 'gi'),
		'',
	);
	result = result.replace(/\s{2,}/g, ' ');
	result = result.replace(/^[\s\-–—|/·•]+|[\s\-–—|/·•]+$/g, '');
	return result.trim();
}

export function shouldActivateBrowserView(
	browserMode: BrowserMode,
	progress: Pick<JobProgress, 'browserActive'>,
	browserViewUrl: string | null,
): boolean {
	return (
		browserMode === 'headed' &&
		progress.browserActive === true &&
		Boolean(browserViewUrl)
	);
}

export function shouldAutoCloseBrowserView(
	stage: JobProgress['stage'],
	alreadyClosed: boolean,
): boolean {
	return stage === 'downloading' && !alreadyClosed;
}

function normalizedArtistCredits(value: string): string[] {
	return value
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLocaleLowerCase()
		.replace(/\b(?:featuring|feat|ft|with|versus|vs)\.?\b/gu, '&')
		.split(/\s*(?:,|&|\+|×)\s*|\s+and\s+/u)
		.map((credit) => credit.replace(/[^\p{L}\p{N}]+/gu, ''))
		.filter(Boolean)
		.sort();
}

function artistCreditsMatch(left: string, right: string): boolean {
	const leftCredits = normalizedArtistCredits(left);
	const rightCredits = normalizedArtistCredits(right);
	return (
		leftCredits.length > 0 &&
		leftCredits.length === rightCredits.length &&
		leftCredits.every((credit, index) => credit === rightCredits[index])
	);
}

/** Strip a leading/trailing artist credit even when its separators differ. */
export function stripDuplicateArtistFromTitle(
	title: string,
	artist: string,
): string {
	const trimmedArtist = artist.trim();
	const trimmedTitle = title.trim();
	if (!trimmedArtist || !trimmedTitle) return trimmedTitle;

	for (const separator of trimmedTitle.matchAll(/\s+[-–—|:]\s+/gu)) {
		const index = separator.index;
		const left = trimmedTitle.slice(0, index).trim();
		const right = trimmedTitle.slice(index + separator[0].length).trim();
		if (artistCreditsMatch(left, trimmedArtist)) return right;
		if (artistCreditsMatch(right, trimmedArtist)) return left;
	}

	return trimmedTitle;
}

export function cleanMetadataFields(meta: Metadata): Metadata {
	const artist = cleanPromoTags(meta.artist || '');
	const title = stripDuplicateArtistFromTitle(
		cleanPromoTags(meta.title || ''),
		artist,
	);
	return {
		title,
		artist,
		album: cleanPromoTags(meta.album || ''),
		genre: cleanPromoTags(meta.genre || ''),
	};
}

function metadataNeedsCleanup(meta: Metadata): boolean {
	const cleaned = cleanMetadataFields(meta);
	return (
		(meta.title || '') !== (cleaned.title || '') ||
		(meta.artist || '') !== (cleaned.artist || '') ||
		(meta.album || '') !== (cleaned.album || '') ||
		(meta.genre || '') !== (cleaned.genre || '')
	);
}

function sanitizeFilenamePart(value: string): string {
	return value
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function artistTitleFilename(
	artist?: string,
	title?: string,
	extension = '.mp3',
): string {
	const safeArtist = sanitizeFilenamePart(artist || '') || 'Unknown Artist';
	const safeTitle = sanitizeFilenamePart(title || '') || 'Unknown Title';
	return `${safeArtist} - ${safeTitle}${extension}`;
}

function needsMp3Conversion(filename: string): boolean {
	const lower = filename.toLowerCase();
	return (
		lower.endsWith('.wav') ||
		lower.endsWith('.aiff') ||
		lower.endsWith('.aif') ||
		lower.endsWith('.flac') ||
		lower.endsWith('.m4a') ||
		lower.endsWith('.aac') ||
		lower.endsWith('.ogg') ||
		lower.endsWith('.opus') ||
		lower.endsWith('.webm')
	);
}

function previewProcessedFilename(
	downloadFilename: string | null,
	options: {
		nameAsArtistTitle: boolean;
		artist?: string;
		title?: string;
		outputFormat: OutputFormat;
	},
): string {
	if (!downloadFilename) return '';
	const extension = options.outputFormat === 'flac' ? '.flac' : '.mp3';
	if (options.nameAsArtistTitle) {
		return artistTitleFilename(options.artist, options.title, extension);
	}
	if (options.outputFormat === 'flac') {
		return downloadFilename.replace(/\.[^.]+$/i, '.flac');
	}
	if (needsMp3Conversion(downloadFilename)) {
		return downloadFilename.replace(
			/\.(wav|aiff|aif|flac|m4a|aac|ogg|opus|webm)$/i,
			'.mp3',
		);
	}
	return downloadFilename;
}

export default function App() {
	const [step, setStep] = useState<Step>('url');
	const [soundcloudUrl, setSoundcloudUrl] = useState('');
	const [hypedditUrlInput, setHypedditUrlInput] = useState('');
	const [skipAutomaticHypedditFetch, setSkipAutomaticHypedditFetch] =
		useState(false);
	const [browserMode, setBrowserMode] = useState<BrowserMode>('headless');
	const [lastAttemptedBrowserMode, setLastAttemptedBrowserMode] =
		useState<BrowserMode | null>(null);
	const [availableBrowserModes, setAvailableBrowserModes] = useState<
		BrowserMode[]
	>(['headless', 'headed']);
	const [browserModeHydrated, setBrowserModeHydrated] = useState(false);
	const [browserViewUrl, setBrowserViewUrl] = useState<string | null>(null);
	const [browserViewActive, setBrowserViewActive] = useState(false);
	const [browserViewOpen, setBrowserViewOpen] = useState(false);
	const [embedded, setEmbedded] = useState(false);
	const [outputFormat, setOutputFormat] = useState<OutputFormat>('mp3-320');
	const [job, setJob] = useState<JobState>({
		jobId: null,
		track: null,
		hypedditUrl: null,
		defaultMetadata: null,
		existingMetadata: null,
		hasExistingArtwork: false,
		outputFormat: 'mp3-320',
		progress: null,
		downloadFilename: null,
		outputFilename: null,
		sourceIsLossless: null,
		warning: null,
		error: null,
	});
	const [metadata, setMetadata] = useState<Metadata>({
		title: '',
		artist: '',
		album: '',
		genre: '',
	});

	useEffect(() => {
		let cancelled = false;
		setEmbedded(shouldUseEmbeddedLayout(window.location.search));

		const hydrateBrowserModes = async () => {
			let modes: BrowserMode[] = ['headless', 'headed'];
			let viewUrl: string | null = null;
			try {
				const response = await fetch(`${API_BASE}/api/capabilities`);
				if (response.ok) {
					const capabilities = await response.json();
					modes = parseAvailableBrowserModes(capabilities);
					viewUrl = parseBrowserViewUrl(capabilities, window.location.hostname);
				}
			} catch {
				// Keep the portable modes when the API is unavailable.
			}

			if (cancelled) return;
			setAvailableBrowserModes(modes);
			setBrowserViewUrl(viewUrl);
			const requestedMode = readRequestedBrowserMode(window.location.search);
			let storedMode: BrowserMode | null = null;
			let storedFormat: ReturnType<typeof readStoredOutputFormat> = null;
			try {
				storedMode = readStoredBrowserMode(
					localStorage,
					BROWSER_MODE_STORAGE_KEY,
				);
				storedFormat = readStoredOutputFormat(
					localStorage,
					OUTPUT_FORMAT_STORAGE_KEY,
				);
			} catch {
				// Storage may be blocked when the Web UI is embedded cross-origin.
			}
			const preferredMode =
				requestedMode && modes.includes(requestedMode)
					? requestedMode
					: storedMode && modes.includes(storedMode)
						? storedMode
						: null;
			if (preferredMode) {
				setBrowserMode(preferredMode);
				if (requestedMode === preferredMode) {
					try {
						localStorage.setItem(BROWSER_MODE_STORAGE_KEY, preferredMode);
					} catch {
						// The requested mode still applies for this session.
					}
				}
			}
			const requestedFormat = readRequestedOutputFormat(window.location.search);
			const preferredFormat = requestedFormat ?? storedFormat;
			if (preferredFormat) {
				setOutputFormat(preferredFormat);
				if (requestedFormat === preferredFormat) {
					try {
						localStorage.setItem(OUTPUT_FORMAT_STORAGE_KEY, preferredFormat);
					} catch {
						// The requested format still applies for this session.
					}
				}
			}
			setBrowserModeHydrated(true);
		};

		void hydrateBrowserModes();
		return () => {
			cancelled = true;
		};
	}, []);

	const updateBrowserMode = (mode: BrowserMode) => {
		setBrowserMode(mode);
		if (mode !== 'headed') {
			setBrowserViewOpen(false);
			setBrowserViewActive(false);
		}
		try {
			localStorage.setItem(BROWSER_MODE_STORAGE_KEY, mode);
		} catch {
			// Keep the in-memory selection when persistent storage is unavailable.
		}
	};

	const updateOutputFormat = (format: OutputFormat) => {
		setOutputFormat(format);
		try {
			localStorage.setItem(OUTPUT_FORMAT_STORAGE_KEY, format);
		} catch {
			// Keep the in-memory selection when persistent storage is unavailable.
		}
	};
	const [customArtwork, setCustomArtwork] = useState<File | null>(null);
	const [customArtworkUrl, setCustomArtworkUrl] = useState<string | null>(null);
	useEffect(() => {
		if (!customArtwork) {
			setCustomArtworkUrl(null);
			return;
		}
		const url = URL.createObjectURL(customArtwork);
		setCustomArtworkUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [customArtwork]);
	const [nameAsArtistTitle, setNameAsArtistTitle] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [search, setSearch] = useState<SearchState | null>(null);
	const [searchLoading, setSearchLoading] = useState<'new' | 'more' | null>(
		null,
	);
	const artworkInputRef = useRef<HTMLInputElement>(null);
	const cleanupToastShownRef = useRef(false);
	const browserViewAutoClosedRef = useRef(false);
	const browserViewAutoOpenedRef = useRef(false);
	const autoStartedFromQueryRef = useRef(false);
	const eventSourceRef = useRef<EventSource | null>(null);
	const cancelRequestedRef = useRef(false);
	const unloadJobRef = useRef<{ jobId: string | null; stage?: string }>({
		jobId: null,
	});
	const formatPercent = (value?: number) => Math.round(value ?? 0);

	useEffect(() => {
		unloadJobRef.current = {
			jobId: job.jobId,
			stage: job.progress?.stage,
		};
	}, [job.jobId, job.progress?.stage]);

	useEffect(() => {
		const cancelJobOnUnload = () => {
			if (cancelRequestedRef.current) return;
			const { jobId, stage } = unloadJobRef.current;
			if (!jobId || !stage || !ACTIVE_JOB_STAGES.has(stage)) return;
			cancelRequestedRef.current = true;
			const url = `${API_BASE}/api/job/${encodeURIComponent(jobId)}/cancel`;
			// Prefer keepalive fetch: sendBeacon is easy to drop for cross-origin
			// POSTs, and pagehide is more reliable than beforeunload for iframes/tabs.
			void fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
		};
		window.addEventListener('pagehide', cancelJobOnUnload);
		window.addEventListener('beforeunload', cancelJobOnUnload);
		return () => {
			window.removeEventListener('pagehide', cancelJobOnUnload);
			window.removeEventListener('beforeunload', cancelJobOnUnload);
		};
	}, []);

	const showCleanupSoundcloudToast = useCallback(() => {
		toast('Clean up your SoundCloud account?', {
			description:
				'This unfollows, unlikes, and deletes comments and reposts on the account the gates use.',
			closeButton: false,
			duration: Infinity,
			action: {
				label: 'Clean up',
				onClick: async () => {
					const toastId = toast.loading('Cleaning up SoundCloud');

					try {
						const response = await fetch(`${API_BASE}/api/soundcloud/cleanup`, {
							method: 'POST',
						});
						const data = await response.json();

						if (!response.ok) {
							throw new Error(
								data.error || 'The server could not clean up the account.',
							);
						}

						const parts: string[] = [];
						if (data.unfollowed > 0) {
							parts.push(
								`${data.unfollowed} unfollow${data.unfollowed === 1 ? '' : 's'}`,
							);
						}
						if (data.unliked > 0) {
							parts.push(
								`${data.unliked} unlike${data.unliked === 1 ? '' : 's'}`,
							);
						}
						if (data.deletedComments > 0) {
							parts.push(
								`${data.deletedComments} comment${data.deletedComments === 1 ? '' : 's'} deleted`,
							);
						}
						if (data.deletedReposts > 0) {
							parts.push(
								`${data.deletedReposts} repost${data.deletedReposts === 1 ? '' : 's'} deleted`,
							);
						}

						const description =
							parts.length > 0
								? parts.join(', ')
								: 'Nothing needed cleaning up.';

						toast.success('SoundCloud cleaned up', {
							id: toastId,
							description,
						});
					} catch (err) {
						toast.error('Cleanup failed', {
							id: toastId,
							description:
								err instanceof Error ? err.message : 'Check the server log.',
						});
					}
				},
			},
			cancel: {
				label: 'Cancel',
				onClick: () => {},
			},
		});
	}, []);

	// Start download process
	const startDownload = useCallback(
		async (jobId: string, retryBrowserMode?: BrowserMode) => {
			const effectiveBrowserMode = retryBrowserMode ?? browserMode;
			setLastAttemptedBrowserMode(effectiveBrowserMode);
			cancelRequestedRef.current = false;
			browserViewAutoClosedRef.current = false;
			browserViewAutoOpenedRef.current = false;
			setStep('gate');
			setJob((prev) => ({
				...prev,
				error: null,
				progress: {
					stage: 'handling_gates',
					message: 'Opening the gate',
					percent: 0,
				},
			}));
			cleanupToastShownRef.current = false;
			eventSourceRef.current?.close();
			eventSourceRef.current = null;
			notifyParent('job', { jobId });

			try {
				const response = await fetch(`${API_BASE}/api/job/${jobId}/start`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						browserMode: effectiveBrowserMode,
					}),
				});

				if (!response.ok) {
					const data = await response.json();
					throw new Error(
						data.error || 'The server could not start the download.',
					);
				}

				// Connect to SSE for progress updates
				const eventSource = new EventSource(
					`${API_BASE}/api/job/${jobId}/events`,
				);
				eventSourceRef.current = eventSource;

				eventSource.onmessage = (event) => {
					const progress: JobProgress = JSON.parse(event.data);
					setJob((prev) => ({ ...prev, progress }));
					if (
						progress.stage !== 'downloading' &&
						!browserViewAutoOpenedRef.current &&
						shouldActivateBrowserView(
							effectiveBrowserMode,
							progress,
							browserViewUrl,
						)
					) {
						browserViewAutoOpenedRef.current = true;
						setBrowserViewActive(true);
						setBrowserViewOpen(true);
					}

					if (progress.stage === 'downloading') {
						if (
							shouldAutoCloseBrowserView(
								progress.stage,
								browserViewAutoClosedRef.current,
							)
						) {
							browserViewAutoClosedRef.current = true;
							setBrowserViewOpen(false);
						}
						setStep('download');
					} else if (progress.stage === 'processing_audio') {
						setStep('metadata');
					} else if (GATE_PROGRESS_STAGES.has(progress.stage)) {
						setStep('gate');
					}

					// Browserless downloads never touch the SoundCloud account, so there
					// is nothing to clean up afterwards.
					if (
						progress.stage === 'downloading' &&
						(progress.downloadBytes || progress.totalBytes) &&
						!progress.browserless &&
						!cleanupToastShownRef.current
					) {
						showCleanupSoundcloudToast();
						cleanupToastShownRef.current = true;
					}

					if (progress.stage === 'ready') {
						setBrowserViewOpen(false);
						setBrowserViewActive(false);
						eventSource.close();
						eventSourceRef.current = null;
						notifyParent('ready');
						fetch(`${API_BASE}/api/job/${jobId}`)
							.then((res) => res.json())
							.then((data) => {
								setJob((prev) => ({
									...prev,
									downloadFilename: data.downloadFilename,
									outputFilename: data.outputFilename,
									existingMetadata: data.existingMetadata,
									hasExistingArtwork: !!data.hasExistingArtwork,
									outputFormat: data.outputFormat,
									sourceIsLossless: data.sourceIsLossless,
								}));
								setStep(
									data.outputFormat === 'original' ? 'complete' : 'metadata',
								);
							})
							.catch((err) => {
								setJob((prev) => ({
									...prev,
									error:
										err instanceof Error
											? err.message
											: 'Could not load the finished job. Reload the page to try again.',
								}));
							});
					} else if (progress.stage === 'waiting_bandcamp_track') {
						setJob((prev) => ({
							...prev,
							progress,
							error: null,
						}));
					} else if (progress.stage === 'error') {
						setBrowserViewOpen(false);
						setBrowserViewActive(false);
						eventSource.close();
						eventSourceRef.current = null;
						setJob((prev) => ({ ...prev, error: progress.message }));
					} else if (progress.stage === 'cancelled') {
						setBrowserViewOpen(false);
						setBrowserViewActive(false);
						eventSource.close();
						eventSourceRef.current = null;
						setJob((prev) => ({
							...prev,
							progress,
							error: null,
						}));
						setStep('url');
						notifyParent('cancelled');
					}
				};

				eventSource.onerror = () => {
					if (eventSource.readyState === EventSource.CONNECTING) return;
					eventSource.close();
					if (eventSourceRef.current === eventSource) {
						eventSourceRef.current = null;
					}
					setJob((prev) => ({
						...prev,
						error:
							'Lost the connection to the server. Check that it is running, then start again.',
					}));
				};
			} catch (err) {
				setJob((prev) => ({
					...prev,
					error:
						err instanceof Error
							? err.message
							: 'The request failed. Try again.',
					progress: {
						stage: 'error',
						message:
							err instanceof Error
								? err.message
								: 'The request failed. Try again.',
						percent: 0,
					},
				}));
			}
		},
		[browserMode, browserViewUrl, showCleanupSoundcloudToast],
	);

	const cancelDownload = useCallback(async () => {
		const jobId = job.jobId;
		if (!jobId || cancelRequestedRef.current) return;
		cancelRequestedRef.current = true;

		try {
			const response = await fetch(`${API_BASE}/api/job/${jobId}/cancel`, {
				method: 'POST',
			});
			if (!response.ok) {
				cancelRequestedRef.current = false;
				const data = await response.json().catch(() => ({}));
				setJob((prev) => ({
					...prev,
					error:
						(data as { error?: string }).error ||
						'The server did not cancel the download. Try again.',
				}));
				return;
			}
		} catch (err) {
			cancelRequestedRef.current = false;
			setJob((prev) => ({
				...prev,
				error:
					err instanceof Error
						? err.message
						: 'The server did not cancel the download. Try again.',
			}));
			return;
		}

		eventSourceRef.current?.close();
		eventSourceRef.current = null;

		setJob((prev) => ({
			...prev,
			progress: {
				stage: 'cancelled',
				message: 'Download cancelled',
				percent: prev.progress?.percent ?? 0,
			},
			error: null,
		}));
		setStep('url');
		setBrowserViewOpen(false);
		setBrowserViewActive(false);
		notifyParent('cancelled');
	}, [job.jobId]);

	// Parent userscript panel X → cancel in-progress job
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!ALLOWED_HOST_ORIGINS.has(event.origin)) return;
			const data = event.data;
			if (data?.source !== 'sc-gate-dl-host') return;
			if (data.type === 'cancel') {
				void cancelDownload();
			} else if (data.type === 'release-remote-pointer') {
				window.dispatchEvent(new Event(REMOTE_POINTER_RELEASE_EVENT));
			}
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [cancelDownload]);

	const createJob = useCallback(
		async (url: string, formatOverride?: OutputFormat) => {
			const trimmed = url.trim();
			if (!trimmed) return;

			const format = formatOverride ?? outputFormat;

			setIsLoading(true);
			setJob((prev) => ({ ...prev, warning: null, error: null }));

			try {
				const response = await fetch(`${API_BASE}/api/job`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						soundcloudUrl: trimmed,
						skipAutomaticHypedditFetch,
						outputFormat: format,
					}),
				});

				const data = await response.json();

				if (!response.ok) {
					throw new Error(
						data.error || 'Could not look up this track. Check the link.',
					);
				}

				setJob((prev) => ({
					...prev,
					jobId: data.jobId,
					track: data.track,
					hypedditUrl: data.hypedditUrl,
					defaultMetadata: data.defaultMetadata,
					existingMetadata: null,
					hasExistingArtwork: false,
					outputFormat: format,
					warning: data.soundcloudDownloadWarning ?? null,
					error: null,
				}));

				if (data.defaultMetadata) {
					setMetadata(data.defaultMetadata);
				}

				if (skipAutomaticHypedditFetch || data.needsHypedditUrl) {
					setStep('gate');
				} else {
					startDownload(data.jobId);
				}
			} catch (err) {
				setJob((prev) => ({
					...prev,
					error:
						err instanceof Error
							? err.message
							: 'The request failed. Try again.',
				}));
			} finally {
				setIsLoading(false);
			}
		},
		[skipAutomaticHypedditFetch, outputFormat, startDownload],
	);

	const runSearch = async (query: string, offset = 0) => {
		setSearchLoading(offset > 0 ? 'more' : 'new');
		setJob((prev) => ({ ...prev, error: null }));

		try {
			const params = new URLSearchParams({ q: query, offset: String(offset) });
			const response = await fetch(`${API_BASE}/api/search?${params}`);
			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'The search failed. Try again.');
			}

			const page = data as SearchResponse;
			setSearch((prev) => ({
				query,
				results:
					offset > 0 && prev
						? appendSearchResults(prev.results, page.results)
						: page.results,
				nextOffset: page.nextOffset,
			}));
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error:
					err instanceof Error ? err.message : 'The request failed. Try again.',
			}));
		} finally {
			setSearchLoading(null);
		}
	};

	// Fetch a SoundCloud URL, or search for anything else
	const handleSoundcloudSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const value = soundcloudUrl.trim();
		if (isTrackUrlInput(value)) {
			void createJob(value);
		} else if (value) {
			void runSearch(value);
		}
	};

	const loadMoreSearchResults = () => {
		if (search && search.nextOffset !== null) {
			void runSearch(search.query, search.nextOffset);
		}
	};

	const handleSearchResultSelect = (result: SearchResult) => {
		// The gate step's yt-dlp fallback downloads this URL.
		setSoundcloudUrl(result.url);
		void createJob(result.url);
	};

	// Userscript / deep-link: ?url=&outputFormat= pre-fills and starts a job
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		let queryUrl = params.get('url') || params.get('soundcloudUrl');
		if (
			!shouldAutoStartDeepLink(
				browserModeHydrated,
				autoStartedFromQueryRef.current,
				queryUrl,
			)
		) {
			return;
		}
		autoStartedFromQueryRef.current = true;

		// New SC listen layout may pass /n/artist/track — normalize to /artist/track
		try {
			const parsed = new URL(queryUrl);
			const parts = parsed.pathname.split('/').filter(Boolean);
			if (parts[0] === 'n' && parts.length >= 3) {
				parsed.pathname = `/${parts[1]}/${parts[2]}`;
				parsed.search = '';
				parsed.hash = '';
				queryUrl = parsed.toString();
			}
		} catch {
			// keep queryUrl as-is
		}

		// Format is already hydrated from the query/localStorage before this runs.
		const format =
			readRequestedOutputFormat(window.location.search) ?? undefined;
		setSoundcloudUrl(queryUrl);
		void createJob(queryUrl, format);
	}, [browserModeHydrated, createJob]);

	// Set Hypeddit URL and start download
	const handleHypedditSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!hypedditUrlInput.trim() || !job.jobId) return;

		setIsLoading(true);

		try {
			const response = await fetch(
				`${API_BASE}/api/job/${job.jobId}/hypeddit`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ hypedditUrl: hypedditUrlInput }),
				},
			);

			const data = await response.json();

			if (!response.ok) {
				throw new Error(
					data.error || 'The server did not accept this gate link.',
				);
			}

			setJob((prev) => ({ ...prev, hypedditUrl: hypedditUrlInput }));
			startDownload(job.jobId);
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error:
					err instanceof Error ? err.message : 'The request failed. Try again.',
			}));
		} finally {
			setIsLoading(false);
		}
	};

	/** No gate found — download the SoundCloud track itself via yt-dlp. */
	const handleYtdlpSoundcloudDownload = async () => {
		if (!job.jobId || !soundcloudUrl.trim()) return;

		setIsLoading(true);
		setJob((prev) => ({ ...prev, error: null }));

		try {
			const response = await fetch(
				`${API_BASE}/api/job/${job.jobId}/hypeddit`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ hypedditUrl: soundcloudUrl }),
				},
			);

			const data = await response.json();

			if (!response.ok) {
				throw new Error(
					data.error || 'The server could not start the yt-dlp download.',
				);
			}

			setJob((prev) => ({ ...prev, hypedditUrl: soundcloudUrl }));
			startDownload(job.jobId);
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error:
					err instanceof Error ? err.message : 'The request failed. Try again.',
			}));
		} finally {
			setIsLoading(false);
		}
	};

	const handleBandcampTrackSelect = async (trackUrl: string) => {
		if (!job.jobId) return;

		setIsLoading(true);
		setJob((prev) => ({ ...prev, error: null }));

		try {
			const response = await fetch(
				`${API_BASE}/api/job/${job.jobId}/bandcamp-track`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ trackUrl }),
				},
			);
			const data = await response.json();
			if (!response.ok) {
				throw new Error(
					data.error || 'The server did not accept this Bandcamp track.',
				);
			}
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error:
					err instanceof Error ? err.message : 'The request failed. Try again.',
			}));
		} finally {
			setIsLoading(false);
		}
	};

	// Process metadata and finalize
	const processMetadata = async (preserveMetadata = false) => {
		if (!job.jobId) return;

		setIsLoading(true);

		try {
			let response: Response;

			if (preserveMetadata) {
				response = await fetch(`${API_BASE}/api/job/${job.jobId}/metadata`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						preserveMetadata: true,
						nameAsArtistTitle,
						title: metadata.title,
						artist: metadata.artist,
						album: metadata.album,
						genre: metadata.genre,
					}),
				});
			} else if (customArtwork) {
				const formData = new FormData();
				formData.append('title', metadata.title || '');
				formData.append('artist', metadata.artist || '');
				formData.append('album', metadata.album || '');
				formData.append('genre', metadata.genre || '');
				formData.append('nameAsArtistTitle', String(nameAsArtistTitle));
				formData.append('artwork', customArtwork);

				response = await fetch(`${API_BASE}/api/job/${job.jobId}/metadata`, {
					method: 'POST',
					body: formData,
				});
			} else {
				response = await fetch(`${API_BASE}/api/job/${job.jobId}/metadata`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ...metadata, nameAsArtistTitle }),
				});
			}

			const data = await response.json();

			if (!response.ok) {
				throw new Error(
					data.error || 'The server could not write the tags. Try again.',
				);
			}

			setJob((prev) => ({ ...prev, outputFilename: data.outputFilename }));
			setStep('complete');
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error:
					err instanceof Error ? err.message : 'The request failed. Try again.',
			}));
		} finally {
			setIsLoading(false);
		}
	};

	const handleMetadataSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		void processMetadata();
	};

	const defaultMetadataValues: Metadata = job.defaultMetadata ?? {
		title: '',
		artist: '',
		album: '',
		genre: '',
	};
	const canCleanupMetadata = metadataNeedsCleanup(metadata);
	const inputIsTrackUrl = isTrackUrlInput(soundcloudUrl);
	const outputFilenamePreview = previewProcessedFilename(job.downloadFilename, {
		nameAsArtistTitle,
		artist: metadata.artist,
		title: metadata.title,
		outputFormat: job.outputFormat,
	});
	const isHandlingGate =
		step === 'gate' && GATE_PROGRESS_STAGES.has(job.progress?.stage ?? '');
	const isCancelling = job.progress?.stage === 'cancelling';
	const existingTagRows = (
		[
			{ key: 'title', label: 'Title' },
			{ key: 'artist', label: 'Artist' },
			{ key: 'album', label: 'Album' },
			{ key: 'genre', label: 'Genre' },
		] as const
	)
		.map(({ key, label }) => ({
			key,
			label,
			existingValue: job.existingMetadata?.[key]?.trim() || '',
		}))
		.filter(({ existingValue }) => existingValue);
	const hasExistingMetadata =
		existingTagRows.length > 0 || job.hasExistingArtwork;
	const stepIndex = STEPS.findIndex(({ id }) => id === step);
	const showTrack = Boolean(job.track) && step !== 'url';
	const trackArtist = job.track
		? job.track.user.fullName || job.track.user.username
		: '';
	const trackArtworkUrl = job.track
		? (job.track.artworkUrl || job.track.user.avatarUrl).replace(
				'large',
				't500x500',
			)
		: null;
	const isEditingTags = step === 'metadata' || step === 'complete';
	const labelTitle = isEditingTags
		? metadata.title || ''
		: metadata.title || job.track?.title || '';
	const labelArtist = isEditingTags
		? metadata.artist || ''
		: metadata.artist || trackArtist;
	const outputFormatHint =
		OUTPUT_FORMAT_OPTIONS.find(({ value }) => value === outputFormat)?.hint ??
		'';
	const hasDownloadTotal = typeof job.progress?.totalBytes === 'number';
	const downloadPercent = formatPercent(job.progress?.percent);
	const toMegabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

	const copyExistingArtwork = async () => {
		if (!job.jobId || !job.hasExistingArtwork) return;
		try {
			const response = await fetch(
				`${API_BASE}/api/job/${job.jobId}/existing-artwork`,
			);
			if (!response.ok) {
				throw new Error('The server did not return the cover.');
			}
			const blob = await response.blob();
			const extension = blob.type === 'image/png' ? 'png' : 'jpg';
			setCustomArtwork(
				new File([blob], `existing-cover.${extension}`, {
					type: blob.type || 'image/jpeg',
				}),
			);
		} catch (err) {
			toast.error('Could not copy the cover', {
				description: err instanceof Error ? err.message : 'Try again.',
			});
		}
	};

	// Reset and start over
	const handleReset = () => {
		cancelRequestedRef.current = false;
		notifyParent('new-download');
		// Return to the last search so another result can be picked.
		setSoundcloudUrl(search?.query ?? '');
		setHypedditUrlInput('');
		setSkipAutomaticHypedditFetch(false);
		setJob({
			jobId: null,
			track: null,
			hypedditUrl: null,
			defaultMetadata: null,
			existingMetadata: null,
			hasExistingArtwork: false,
			outputFormat,
			progress: null,
			downloadFilename: null,
			outputFilename: null,
			sourceIsLossless: null,
			warning: null,
			error: null,
		});
		setMetadata({ title: '', artist: '', album: '', genre: '' });
		setCustomArtwork(null);
		if (artworkInputRef.current) {
			artworkInputRef.current.value = '';
		}
		setNameAsArtistTitle(false);
		setBrowserViewOpen(false);
		setBrowserViewActive(false);
		setStep('url');
	};

	const handleInitializeLogins = async () => {
		toast('Initialize logins?', {
			description:
				'Opens a browser on the server to sign in to SoundCloud and Spotify. Use the remote browser button to watch it or solve a captcha.',
			closeButton: false,
			duration: Infinity,
			action: {
				label: 'Initialize',
				onClick: async () => {
					if (browserViewUrl) {
						setBrowserViewActive(true);
						setBrowserViewOpen(true);
					}
					const toastId = toast.loading('Initializing logins');

					try {
						const response = await fetch(`${API_BASE}/api/logins/initialize`, {
							method: 'POST',
						});
						const data = await response.json();

						if (!response.ok) {
							throw new Error(
								data.error || 'The server could not initialize the logins.',
							);
						}

						toast.success('Logins initialized', {
							id: toastId,
						});
					} catch (err) {
						toast.error('Login initialization failed', {
							id: toastId,
							description:
								err instanceof Error ? err.message : 'Check the server log.',
						});
					} finally {
						setBrowserViewOpen(false);
						setBrowserViewActive(false);
					}
				},
			},
			cancel: {
				label: 'Cancel',
				onClick: () => {},
			},
		});
	};

	return (
		<div className={`app${embedded ? ' is-embedded' : ''}`}>
			<Toaster richColors closeButton theme="dark" />
			{browserViewUrl && browserViewActive ? (
				<RemoteBrowserPanel
					open={browserViewOpen}
					viewUrl={browserViewUrl}
					onOpen={() => setBrowserViewOpen(true)}
					onClose={() => setBrowserViewOpen(false)}
				/>
			) : null}

			<div className="app-object">
				<RecordSleeve
					out={recordOutFor(step, job.progress)}
					spinning={
						step === 'download' && job.progress?.stage === 'downloading'
					}
					artworkUrl={showTrack ? (customArtworkUrl ?? trackArtworkUrl) : null}
					title={labelTitle}
					artist={labelArtist}
					catalogNumber={
						job.jobId ? `SCG-${job.jobId.slice(0, 4).toUpperCase()}` : null
					}
				/>
			</div>

			<div className="app-notes">
				{!embedded && (
					<header className="masthead">
						<p className="masthead-name">sc-gate-dl</p>
						<p className="masthead-tagline">
							Unlocks gated SoundCloud downloads and tags them.
						</p>
					</header>
				)}

				<div className="title-block">
					{showTrack && job.track ? (
						<>
							<h1 className="title">{job.track.title}</h1>
							<p className="title-artist">{trackArtist}</p>
						</>
					) : (
						<h1 className="title">Get a free download</h1>
					)}
				</div>

				<ol className="tracklist" aria-label="Steps">
					{STEPS.map(({ id, label }, index) => (
						<li
							key={id}
							className={`tracklist-item${index < stepIndex ? ' is-done' : ''}${index === stepIndex ? ' is-current' : ''}`}
							aria-current={index === stepIndex ? 'step' : undefined}
						>
							<span className="tracklist-number">{index + 1}</span>
							<span className="tracklist-label">{label}</span>
						</li>
					))}
				</ol>

				<GateAttentionMessage
					attention={
						job.progress?.requiresAttention && job.progress.attentionId
							? { id: job.progress.attentionId, message: job.progress.message }
							: undefined
					}
					onShowBrowser={
						browserViewUrl && browserMode === 'headed'
							? () => setBrowserViewOpen(true)
							: undefined
					}
				/>
				{job.error && (
					<div className="banner banner-error" role="alert">
						<span className="banner-icon" aria-hidden="true">
							!
						</span>
						<p className="banner-message">{job.error}</p>
						<div className="banner-actions">
							{job.jobId && job.progress?.stage === 'error'
								? availableBrowserModes
										.filter(
											(mode) =>
												mode !== (lastAttemptedBrowserMode ?? browserMode),
										)
										.map((mode) => (
											<button
												type="button"
												key={mode}
												className="btn-secondary btn-small"
												onClick={() => {
													updateBrowserMode(mode);
													void startDownload(job.jobId as string, mode);
												}}
											>
												{BROWSER_MODE_RETRY_LABELS[mode]}
											</button>
										))
								: null}
							<button
								type="button"
								className="btn-text"
								onClick={() => setJob((prev) => ({ ...prev, error: null }))}
							>
								Dismiss
							</button>
						</div>
					</div>
				)}

				{job.warning && (
					<div className="banner banner-warning" role="status">
						<span className="banner-icon" aria-hidden="true">
							!
						</span>
						<p className="banner-message">{job.warning}</p>
						<div className="banner-actions">
							<button
								type="button"
								className="btn-text"
								onClick={() => setJob((prev) => ({ ...prev, warning: null }))}
							>
								Dismiss
							</button>
						</div>
					</div>
				)}

				<div className="notes">
					{/* Step 1: SoundCloud link or search */}
					{step === 'url' && (
						<form onSubmit={handleSoundcloudSubmit} className="step-block">
							<div className="field">
								<label htmlFor="soundcloud-url">
									SoundCloud track link or search
								</label>
								<input
									id="soundcloud-url"
									type="text"
									name="soundcloud-track-url"
									value={soundcloudUrl}
									onChange={(e) => setSoundcloudUrl(e.target.value)}
									placeholder="https://soundcloud.com/artist/track or artist - title"
									autoComplete="off"
									required
									disabled={isLoading}
								/>
							</div>
							<fieldset className="field">
								<legend>Format</legend>
								<div className="choices">
									{OUTPUT_FORMAT_OPTIONS.map(({ value, label }) => (
										<label key={value} className="choice">
											<input
												type="radio"
												name="output-format"
												value={value}
												checked={outputFormat === value}
												onChange={() => updateOutputFormat(value)}
												disabled={isLoading || isCancelling}
											/>
											<span>{label}</span>
										</label>
									))}
								</div>
								<p className="field-hint">{outputFormatHint}</p>
							</fieldset>
							<BrowserOptions
								name="browser-mode"
								browserMode={browserMode}
								availableBrowserModes={availableBrowserModes}
								disabled={isLoading}
								onChange={updateBrowserMode}
								summaryExtra={
									skipAutomaticHypedditFetch ? 'gate link by hand' : undefined
								}
							>
								<label className="checkbox-row" htmlFor="skip-hypeddit-fetch">
									<input
										id="skip-hypeddit-fetch"
										type="checkbox"
										checked={skipAutomaticHypedditFetch}
										onChange={(e) =>
											setSkipAutomaticHypedditFetch(e.target.checked)
										}
										disabled={isLoading}
									/>
									<span>
										Enter the gate link myself
										<span className="checkbox-hint">
											Skips the automatic search on the SoundCloud page.
										</span>
									</span>
								</label>
							</BrowserOptions>
							<button
								type="submit"
								className="btn-primary"
								disabled={isLoading || searchLoading !== null}
							>
								{isLoading ? (
									<>
										<span className="spinner" aria-hidden="true" />
										Looking up the track
									</>
								) : searchLoading === 'new' ? (
									<>
										<span className="spinner" aria-hidden="true" />
										Searching
									</>
								) : inputIsTrackUrl ? (
									'Get download'
								) : (
									'Search'
								)}
							</button>
						</form>
					)}
					{step === 'url' && search && (
						<section className="search-results" aria-label="Search results">
							<h2 className="step-heading search-results-heading">
								{search.results.length > 0
									? `Results for “${search.query}”`
									: `No tracks found for “${search.query}”`}
							</h2>
							{search.results.length > 0 ? (
								<ul className="search-result-list">
									{search.results.map((result) => (
										<li key={result.id}>
											<button
												type="button"
												className="search-result"
												disabled={isLoading}
												onClick={() => handleSearchResultSelect(result)}
											>
												{result.artworkUrl ? (
													<img
														src={searchThumbnailUrl(
															API_BASE,
															result.artworkUrl,
														)}
														alt=""
														className="search-result-artwork"
														loading="lazy"
													/>
												) : (
													<span className="search-result-artwork" />
												)}
												<span className="search-result-info">
													<span className="search-result-title">
														{result.title}
													</span>
													<span className="search-result-artist">
														{result.artist}
													</span>
												</span>
												<span className="search-result-meta">
													{SEARCH_SOURCE_LABELS[result.source] ? (
														<span
															className={`search-result-source search-result-source-${result.source}`}
														>
															{SEARCH_SOURCE_LABELS[result.source]}
														</span>
													) : null}
													<span className="search-result-duration">
														{formatDuration(result.durationMs)}
													</span>
												</span>
											</button>
										</li>
									))}
								</ul>
							) : (
								<p className="step-text">
									Try other words, or paste the track link.
								</p>
							)}
							{search.nextOffset !== null ? (
								<button
									type="button"
									className="btn-secondary"
									disabled={isLoading || searchLoading !== null}
									onClick={loadMoreSearchResults}
								>
									{searchLoading === 'more' ? (
										<>
											<span className="spinner" aria-hidden="true" />
											Loading
										</>
									) : (
										'Load more results'
									)}
								</button>
							) : null}
						</section>
					)}

					{/* Step 2: gate link, when none was found */}
					{step === 'gate' && !isHandlingGate && (
						<div className="step-block">
							<div>
								<h2 className="step-heading">
									{job.progress?.stage === 'error'
										? 'Try another way'
										: 'Add the gate link'}
								</h2>
								<p className="step-text">
									{job.progress?.stage === 'error'
										? 'Paste a different gate link, or download the SoundCloud stream with yt-dlp.'
										: skipAutomaticHypedditFetch
											? 'Automatic lookup is off. Paste the gate link, or download the SoundCloud stream with yt-dlp instead.'
											: 'Could not find a gate link on this track. Paste one from Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit or Bandcamp, or a direct file link. You can also download the SoundCloud stream with yt-dlp.'}
								</p>
							</div>
							<form onSubmit={handleHypedditSubmit} className="step-block">
								<div className="field">
									<label htmlFor="hypeddit-url">Gate link</label>
									<input
										id="hypeddit-url"
										type="url"
										name="hypeddit-url"
										value={hypedditUrlInput}
										onChange={(e) => setHypedditUrlInput(e.target.value)}
										placeholder="https://hypeddit.com/…"
										autoComplete="off"
										required
										disabled={isLoading}
									/>
								</div>
								<BrowserOptions
									name="browser-mode-gate"
									browserMode={browserMode}
									availableBrowserModes={availableBrowserModes}
									disabled={isLoading}
									onChange={updateBrowserMode}
								/>
								<button
									type="submit"
									className="btn-primary"
									disabled={isLoading}
								>
									{isLoading ? (
										<>
											<span className="spinner" aria-hidden="true" />
											Starting
										</>
									) : (
										'Start download'
									)}
								</button>
							</form>
							<p className="or" aria-hidden="true">
								or
							</p>
							<button
								type="button"
								className="btn-secondary"
								disabled={isLoading || !soundcloudUrl.trim()}
								onClick={handleYtdlpSoundcloudDownload}
							>
								{isLoading ? (
									<>
										<span className="spinner" aria-hidden="true" />
										Starting
									</>
								) : (
									'Download the SoundCloud stream with yt-dlp'
								)}
							</button>
						</div>
					)}

					{/* Steps 2–3: gate handling, then download progress */}
					{(isHandlingGate || step === 'download') && (
						<div className="step-block">
							{job.progress?.stage === 'waiting_bandcamp_track' ? (
								<>
									<div>
										<h2 className="step-heading">Pick the track</h2>
										<p className="step-text">
											{job.progress.message ||
												'No track on this Bandcamp album matched. Pick the one to download.'}
										</p>
									</div>
									<ol className="picklist">
										{(job.progress.bandcampAlbumTracks ?? []).map((track) => (
											<li key={track.url}>
												<button
													type="button"
													className="picklist-option"
													disabled={isLoading}
													onClick={() =>
														void handleBandcampTrackSelect(track.url)
													}
												>
													<span className="picklist-title">{track.title}</span>
													{track.score > 0 ? (
														<span className="picklist-score">
															{Math.round(track.score * 100)}% match
														</span>
													) : null}
												</button>
											</li>
										))}
									</ol>
									<button
										type="button"
										className="btn-secondary"
										onClick={() => void cancelDownload()}
										disabled={isLoading || isCancelling}
									>
										Cancel download
									</button>
								</>
							) : (
								<>
									<div>
										<h2 className="step-heading" aria-live="polite">
											{job.progress?.requiresAttention &&
											job.progress.attentionId
												? 'Waiting for you'
												: job.progress?.message ||
													(job.progress?.downloadBytes !== undefined
														? 'Downloading'
														: 'Starting')}
										</h2>
										{job.progress?.currentGate && (
											<p className="step-text">
												Gate: {gateStepLabel(job.progress.currentGate)}
											</p>
										)}
									</div>
									{isHandlingGate && (
										<div
											className="meter"
											role="progressbar"
											aria-label="Gate progress"
											aria-valuetext={job.progress?.message || 'Handling gate'}
										>
											<div className="meter-fill is-indeterminate" />
										</div>
									)}
									{step === 'download' && (
										<div className="meter-group">
											{hasDownloadTotal ? (
												<div
													className="meter"
													role="progressbar"
													aria-label="Download progress"
													aria-valuemin={0}
													aria-valuemax={100}
													aria-valuenow={downloadPercent}
												>
													<div
														className="meter-fill"
														style={{ width: `${job.progress?.percent || 0}%` }}
													/>
												</div>
											) : (
												<div
													className="meter"
													role="progressbar"
													aria-label="Download progress"
													aria-valuetext={
														job.progress?.message || 'Downloading'
													}
												>
													<div className="meter-fill is-indeterminate" />
												</div>
											)}
											<p className="meter-stats">
												{hasDownloadTotal ? (
													<span>{downloadPercent}%</span>
												) : null}
												{job.progress?.downloadBytes !== undefined && (
													<span>
														{toMegabytes(job.progress.downloadBytes)}
														{typeof job.progress.totalBytes === 'number'
															? ` of ${toMegabytes(job.progress.totalBytes)}`
															: ''}{' '}
														MB
													</span>
												)}
											</p>
										</div>
									)}
									<button
										type="button"
										className="btn-secondary"
										onClick={() => void cancelDownload()}
										disabled={isCancelling}
									>
										Cancel download
									</button>
								</>
							)}
						</div>
					)}

					{/* Step 4: tags */}
					{step === 'metadata' &&
						job.progress?.stage === 'processing_audio' && (
							<div className="step-block">
								<h2 className="step-heading" aria-live="polite">
									{job.progress.message}
								</h2>
								<div
									className="meter"
									role="progressbar"
									aria-label="Processing audio"
									aria-valuetext={job.progress.message}
								>
									<div className="meter-fill is-indeterminate" />
								</div>
							</div>
						)}
					{step === 'metadata' &&
						job.progress?.stage !== 'processing_audio' && (
							<form onSubmit={handleMetadataSubmit} className="step-block">
								<h2 className="step-heading">Check the tags</h2>
								{job.outputFormat === 'flac' &&
								job.sourceIsLossless === false ? (
									<p className="note">
										The downloaded source is lossy. Saving it as FLAC cannot
										bring back the lost quality.
									</p>
								) : null}
								{hasExistingMetadata ? (
									<section
										className="existing"
										aria-labelledby="existing-tags-heading"
									>
										<div>
											<h3 id="existing-tags-heading">
												The file already has tags
											</h3>
											<p className="step-text">
												Copy a tag or the cover into the form, or keep the
												file's own tags and finish.
											</p>
										</div>
										<ul className="existing-list">
											{existingTagRows.map(({ key, label, existingValue }) => (
												<li key={key} className="existing-row">
													<span className="existing-label">{label}</span>
													<span className="existing-value">
														{existingValue}
													</span>
													<button
														type="button"
														className="btn-icon"
														disabled={isLoading}
														title={`Copy ${label.toLowerCase()} into the form`}
														aria-label={`Copy ${label.toLowerCase()} into the form`}
														onClick={() =>
															setMetadata((prev) => ({
																...prev,
																[key]: existingValue,
															}))
														}
													>
														<CopyIcon />
													</button>
												</li>
											))}
											{job.hasExistingArtwork && job.jobId ? (
												<li className="existing-row">
													<span className="existing-label">Cover</span>
													<span className="existing-value">
														<img
															src={`${API_BASE}/api/job/${job.jobId}/existing-artwork`}
															alt="Existing cover art"
															className="existing-cover"
														/>
													</span>
													<button
														type="button"
														className="btn-icon"
														disabled={isLoading}
														title="Copy cover art into the form"
														aria-label="Copy cover art into the form"
														onClick={() => void copyExistingArtwork()}
													>
														<CopyIcon />
													</button>
												</li>
											) : null}
										</ul>
										<button
											type="button"
											className="btn-secondary"
											disabled={isLoading}
											onClick={() => void processMetadata(true)}
										>
											Keep the file's tags and finish
										</button>
									</section>
								) : null}

								{canCleanupMetadata ? (
									<div className="cleanup">
										<p className="step-text">
											The tags contain promo text like [FREE DL] or a repeated
											artist name.
										</p>
										<button
											type="button"
											className="btn-secondary btn-small"
											disabled={isLoading}
											title="Remove promo tags like [FREE DL] or [PREMIERE] and duplicate Artist - / - Artist from the title"
											onClick={() =>
												setMetadata((prev) => cleanMetadataFields(prev))
											}
										>
											Remove promo text
										</button>
									</div>
								) : null}

								<div className="artwork-row">
									<div className="artwork-thumb">
										{customArtworkUrl ? (
											<img src={customArtworkUrl} alt="Custom artwork" />
										) : job.jobId ? (
											<img
												src={`${API_BASE}/api/job/${job.jobId}/artwork`}
												alt="Track artwork"
											/>
										) : (
											<span>No artwork</span>
										)}
									</div>
									<div className="artwork-actions">
										<label className="btn-secondary btn-small artwork-upload">
											<input
												ref={artworkInputRef}
												type="file"
												accept="image/*"
												disabled={isLoading}
												onChange={(e) =>
													setCustomArtwork(e.target.files?.[0] || null)
												}
											/>
											<span>Change artwork</span>
										</label>
										{customArtwork ? (
											<button
												type="button"
												className="btn-text"
												disabled={isLoading}
												onClick={() => {
													setCustomArtwork(null);
													if (artworkInputRef.current) {
														artworkInputRef.current.value = '';
													}
												}}
											>
												Reset artwork
											</button>
										) : null}
									</div>
								</div>

								<div className="tag-fields">
									{(
										[
											{
												key: 'title',
												label: 'Title',
												placeholder: 'Track title',
											},
											{
												key: 'artist',
												label: 'Artist',
												placeholder: 'Artist name',
											},
											{
												key: 'album',
												label: 'Album',
												placeholder: 'Album name',
											},
											{ key: 'genre', label: 'Genre', placeholder: 'Genre' },
										] as const
									).map(({ key, label, placeholder }) => {
										const currentValue = metadata[key] || '';
										const defaultValue = defaultMetadataValues[key] || '';
										const isDirty = currentValue !== defaultValue;
										return (
											<div className={`field field-${key}`} key={key}>
												<label htmlFor={`meta-${key}`}>{label}</label>
												<div
													className={`field-with-reset${isDirty ? ' has-reset' : ''}`}
												>
													<input
														id={`meta-${key}`}
														type="text"
														value={currentValue}
														disabled={isLoading}
														onChange={(e) =>
															setMetadata((prev) => ({
																...prev,
																[key]: e.target.value,
															}))
														}
														placeholder={placeholder}
													/>
													{isDirty ? (
														<button
															type="button"
															className="btn-reset-field"
															disabled={isLoading}
															title={`Reset ${label.toLowerCase()} to the original`}
															aria-label={`Reset ${label.toLowerCase()} to the original`}
															onClick={() =>
																setMetadata((prev) => ({
																	...prev,
																	[key]: defaultValue,
																}))
															}
														>
															<svg
																viewBox="0 0 24 24"
																width="16"
																height="16"
																aria-hidden="true"
																fill="none"
																stroke="currentColor"
																strokeWidth="2"
																strokeLinecap="round"
																strokeLinejoin="round"
															>
																<path d="M3 12a9 9 0 1 0 3-6.7" />
																<path d="M3 4v5h5" />
															</svg>
														</button>
													) : null}
												</div>
											</div>
										);
									})}
								</div>

								<div className="filename-block">
									<label
										className="checkbox-row"
										htmlFor="name-as-artist-title"
									>
										<input
											id="name-as-artist-title"
											type="checkbox"
											checked={nameAsArtistTitle}
											disabled={isLoading}
											onChange={(e) => setNameAsArtistTitle(e.target.checked)}
										/>
										<span>Name the file "Artist - Title"</span>
									</label>
									<div className="field">
										<label htmlFor="output-filename-preview">Filename</label>
										<input
											id="output-filename-preview"
											type="text"
											className="filename-preview"
											value={outputFilenamePreview}
											readOnly
										/>
									</div>
								</div>

								<button
									type="submit"
									className="btn-primary"
									disabled={isLoading}
								>
									{isLoading ? (
										<>
											<span className="spinner" aria-hidden="true" />
											Writing tags
										</>
									) : (
										'Write tags'
									)}
								</button>
							</form>
						)}

					{/* Step 5: done */}
					{step === 'complete' && (
						<div className="step-block">
							<div>
								<h2 className="step-heading">Your file is ready</h2>
								<p className="filename">
									{job.outputFilename || job.downloadFilename}
								</p>
							</div>
							<div className="actions">
								{/* Navigate independently of the panel; the API serves an attachment. */}
								<a
									href={`${API_BASE}/api/job/${job.jobId}/file`}
									target="_blank"
									rel="noopener noreferrer"
									className="btn-primary"
									onClick={() => notifyParent('file-download')}
								>
									{job.outputFormat === 'original'
										? 'Download original'
										: job.outputFormat === 'flac'
											? 'Download FLAC'
											: 'Download MP3'}
								</a>
								<button
									type="button"
									onClick={handleReset}
									className="btn-secondary"
								>
									Get another track
								</button>
							</div>
						</div>
					)}
				</div>

				{!embedded && (
					<footer className="credits">
						<div className="credits-actions">
							<button
								type="button"
								className="btn-secondary btn-small"
								onClick={handleInitializeLogins}
							>
								Initialize logins
							</button>
							<button
								type="button"
								className="btn-secondary btn-small"
								onClick={showCleanupSoundcloudToast}
							>
								Clean up SoundCloud
							</button>
						</div>
						<p>
							Works with Hypeddit, Droploud, GateRush, DownloadGater, StillHype,
							PumpYourSound, MyPressKit, Bandcamp and direct file links.
						</p>
						<p>
							Built for personal use.{' '}
							<a
								href="https://github.com/D3SOX/sc-gate-dl"
								target="_blank"
								rel="noopener noreferrer"
							>
								Source on GitHub
							</a>
						</p>
					</footer>
				)}
			</div>
		</div>
	);
}

function CopyIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="9" y="9" width="13" height="13" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</svg>
	);
}

type BrowserOptionsProps = {
	name: string;
	browserMode: BrowserMode;
	availableBrowserModes: BrowserMode[];
	disabled: boolean;
	onChange: (mode: BrowserMode) => void;
	summaryExtra?: string;
	children?: React.ReactNode;
};

/** Browser mode (and extra settings) tucked behind a disclosure that shows the current choice. */
function BrowserOptions({
	name,
	browserMode,
	availableBrowserModes,
	disabled,
	onChange,
	summaryExtra,
	children,
}: BrowserOptionsProps) {
	return (
		<details className="options">
			<summary>
				<span className="options-title">Browser options</span>
				<span className="options-current">
					{BROWSER_MODE_LABELS[browserMode]}
					{summaryExtra ? `, ${summaryExtra}` : ''}
				</span>
			</summary>
			<div className="options-body">
				<fieldset className="field">
					<legend>Browser</legend>
					<div className="modes">
						{availableBrowserModes.map((mode) => (
							<label key={mode} className="mode">
								<input
									type="radio"
									name={name}
									value={mode}
									checked={browserMode === mode}
									onChange={() => onChange(mode)}
									disabled={disabled}
								/>
								<span>
									{BROWSER_MODE_LABELS[mode]}
									<span className="mode-hint">{BROWSER_MODE_HINTS[mode]}</span>
								</span>
							</label>
						))}
					</div>
				</fieldset>
				{children}
			</div>
		</details>
	);
}
