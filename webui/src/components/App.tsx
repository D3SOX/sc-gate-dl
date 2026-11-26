import { useCallback, useEffect, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { previewProcessedFilename } from '../../../src/outputFormat';
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
	parseReviewTags,
	parseSignInWarning,
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
	fileSize: number | null;
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
const BROWSER_MODE_RETRY_HINTS: Record<BrowserMode, string> = {
	headless: 'Runs the gate again without a window.',
	xvfb: 'Gates detect a real window less often than headless.',
	headed: 'Watch the gate and step in when it needs you.',
};
/** Retry options, from the one most likely to get past a gate. */
const RETRY_ORDER: BrowserMode[] = ['headed', 'xvfb', 'headless'];
const NAME_AS_ARTIST_TITLE_STORAGE_KEY = 'sc-gate-dl-name-as-artist-title';

const OUTPUT_FORMAT_OPTIONS: {
	value: OutputFormat;
	label: string;
	hint: string;
}[] = [
	{
		value: 'mp3-320',
		label: 'MP3',
		hint: 'Converts to MP3. MP3 and AAC downloads are only retagged.',
	},
	{
		value: 'm4a-aac',
		label: 'M4A (AAC)',
		hint: 'Converts to AAC in an M4A file, like Apple Music. MP3 and AAC downloads are only retagged.',
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

/** What the user sees as progress: each phase spans one or more steps. */
const PHASES: { label: string; steps: Step[] }[] = [
	{ label: 'Find', steps: ['url'] },
	{ label: 'Unlock', steps: ['gate', 'download'] },
	{ label: 'Save', steps: ['metadata'] },
];

function phaseIndexFor(step: Step): number {
	if (step === 'complete') return PHASES.length;
	return PHASES.findIndex(({ steps }) => steps.includes(step));
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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
		// The tag must start a word, or `About Now` would lose `out Now`.
		new RegExp(String.raw`\b(?:${PROMO_TAG})\s*$`, 'gi'),
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

export function metadataNeedsCleanup(meta: Metadata): boolean {
	const cleaned = cleanMetadataFields(meta);
	return (
		(meta.title || '') !== (cleaned.title || '') ||
		(meta.artist || '') !== (cleaned.artist || '') ||
		(meta.album || '') !== (cleaned.album || '') ||
		(meta.genre || '') !== (cleaned.genre || '')
	);
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
		fileSize: null,
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
					reviewTagsRef.current = parseReviewTags(capabilities);
					signInWarningRef.current = parseSignInWarning(capabilities);
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
	useEffect(() => {
		try {
			setNameAsArtistTitle(
				localStorage.getItem(NAME_AS_ARTIST_TITLE_STORAGE_KEY) === 'true',
			);
		} catch {
			// Storage may be blocked when the Web UI is embedded cross-origin.
		}
	}, []);
	const updateNameAsArtistTitle = (value: boolean) => {
		setNameAsArtistTitle(value);
		try {
			localStorage.setItem(NAME_AS_ARTIST_TITLE_STORAGE_KEY, String(value));
		} catch {
			// Keep the in-memory choice when persistent storage is unavailable.
		}
	};
	/** The tags before the promo text was removed, so the removal can be undone. */
	const [promoCleanup, setPromoCleanup] = useState<Metadata | null>(null);
	/** Gate actions reported so far, in order; the last one is running. */
	const [gateLog, setGateLog] = useState<string[]>([]);
	const [startedAt, setStartedAt] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const downloadLinkRef = useRef<HTMLAnchorElement>(null);
	const serverMenuRef = useRef<HTMLDivElement>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [search, setSearch] = useState<SearchState | null>(null);
	const [searchLoading, setSearchLoading] = useState<'new' | 'more' | null>(
		null,
	);
	const artworkInputRef = useRef<HTMLInputElement>(null);
	const cleanupToastShownRef = useRef(false);
	const reviewTagsRef = useRef(true);
	const signInWarningRef = useRef<string | null>(null);
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
			setGateLog([]);
			setStartedAt(Date.now());
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
						progress.stage === 'handling_gates' &&
						progress.message &&
						!progress.requiresAttention
					) {
						setGateLog((prev) =>
							prev.includes(progress.message)
								? prev
								: [...prev, progress.message],
						);
					}
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
									fileSize: data.fileSize ?? null,
									existingMetadata: data.existingMetadata,
									hasExistingArtwork: !!data.hasExistingArtwork,
									outputFormat: data.outputFormat,
									sourceIsLossless: data.sourceIsLossless,
								}));
								setStep(
									data.outputFormat === 'original' ? 'complete' : 'metadata',
								);
								// SC_GATE_DL_REVIEW_TAGS=false saves the SoundCloud tags at once.
								if (
									data.outputFormat !== 'original' &&
									!reviewTagsRef.current
								) {
									void processMetadataRef.current();
								}
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
						eventSource.close();
						eventSourceRef.current = null;
						setJob((prev) => ({ ...prev, error: progress.message }));
					} else if (progress.stage === 'cancelled') {
						setBrowserViewOpen(false);
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
			// 202: teardown is still running. The event stream shows `cancelling`
			// and then delivers `cancelled`, which resets the UI.
			if (response.status === 202 && eventSourceRef.current) return;
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
					// Promo text like [FREE DL] is almost never wanted; undo is one click.
					setMetadata(cleanMetadataFields(data.defaultMetadata));
					setPromoCleanup(
						metadataNeedsCleanup(data.defaultMetadata)
							? data.defaultMetadata
							: null,
					);
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

			setJob((prev) => ({
				...prev,
				outputFilename: data.outputFilename,
				fileSize: data.fileSize ?? null,
			}));
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

	const processMetadataRef = useRef(processMetadata);
	processMetadataRef.current = processMetadata;

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
	const outputFilenamePreview = job.downloadFilename
		? previewProcessedFilename(job.downloadFilename, {
				nameAsArtistTitle,
				artist: metadata.artist,
				title: metadata.title,
				outputFormat: job.outputFormat,
				sourceIsLossless: job.sourceIsLossless,
			})
		: '';
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
	const phaseIndex = phaseIndexFor(step);
	const hasFailed = Boolean(job.jobId) && job.progress?.stage === 'error';
	// Converting the download can fail after the UI reached the save step.
	const showRecovery =
		(step === 'gate' && !isHandlingGate) ||
		((step === 'download' || step === 'metadata') && hasFailed);
	const retryModes = hasFailed
		? RETRY_ORDER.filter(
				(mode) =>
					availableBrowserModes.includes(mode) &&
					mode !== (lastAttemptedBrowserMode ?? browserMode),
			)
		: [];
	const isWorking = isHandlingGate || (step === 'download' && !hasFailed);
	const canWatchBrowser =
		isWorking &&
		Boolean(browserViewUrl) &&
		(lastAttemptedBrowserMode ?? browserMode) === 'headed' &&
		!browserViewOpen;
	const outputExtension =
		(job.outputFilename || job.downloadFilename)
			?.match(/\.([^.]+)$/)?.[1]
			?.toUpperCase() ?? null;
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

	// Tick the elapsed time only while a job is running.
	useEffect(() => {
		if (!isWorking) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [isWorking]);

	// No automatic download, but the button is one key press away.
	useEffect(() => {
		if (step === 'complete') downloadLinkRef.current?.focus();
	}, [step]);

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
			fileSize: null,
			sourceIsLossless: null,
			warning: null,
			error: null,
		});
		setMetadata({ title: '', artist: '', album: '', genre: '' });
		setPromoCleanup(null);
		setGateLog([]);
		setStartedAt(null);
		setCustomArtwork(null);
		if (artworkInputRef.current) {
			artworkInputRef.current.value = '';
		}
		setBrowserViewOpen(false);
		setStep('url');
	};

	const handleInitializeLogins = async () => {
		toast('Initialize logins?', {
			description: [
				'Opens a browser on the server to sign in to SoundCloud and Spotify. Use the remote browser button to watch it or solve a captcha.',
				signInWarningRef.current,
			]
				.filter(Boolean)
				.join(' '),
			closeButton: false,
			duration: Infinity,
			action: {
				label: 'Initialize',
				onClick: async () => {
					if (browserViewUrl) {
						setBrowserViewOpen(true);
					}
					const toastId = toast.loading('Initializing logins');
					let stillRunning = false;

					try {
						const response = await fetch(`${API_BASE}/api/logins/initialize`, {
							method: 'POST',
						});
						const data = await response.json();

						if (response.status === 409) {
							// Still running from an earlier click: show where to finish it.
							stillRunning = true;
							toast.info('Initialize logins is already running', {
								id: toastId,
								description: data.error,
							});
							return;
						}
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
						if (!stillRunning) setBrowserViewOpen(false);
					}
				},
			},
			cancel: {
				label: 'Cancel',
				onClick: () => {},
			},
		});
	};

	const browserOptionsSummary = [
		BROWSER_MODE_LABELS[browserMode],
		skipAutomaticHypedditFetch ? 'gate link by hand' : null,
	]
		.filter(Boolean)
		.join(', ');
	const closeServerMenu = () => serverMenuRef.current?.hidePopover();
	const headerTitle = metadata.title || job.track?.title || '';
	const headerArtist = metadata.artist || trackArtist;

	return (
		<div
			className={`app${embedded ? ' is-embedded' : ''}${step === 'url' ? ' is-start' : ''}`}
		>
			<Toaster richColors closeButton theme="dark" />
			{browserViewUrl ? (
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
						<div className="masthead-text">
							<p className="masthead-name">
								<img
									className="masthead-logo"
									src="/favicon.svg"
									alt=""
									width={24}
									height={24}
								/>
								sc-gate-dl
							</p>
							<p className="masthead-tagline">
								Unlocks gated SoundCloud downloads and tags them.
							</p>
						</div>
						<button
							type="button"
							className="btn-icon masthead-menu-button"
							popoverTarget="server-menu"
							aria-label="Server tools"
							title="Server tools"
						>
							<MoreIcon />
						</button>
						<div
							id="server-menu"
							ref={serverMenuRef}
							popover="auto"
							className="menu"
						>
							<button
								type="button"
								className="menu-item"
								onClick={() => {
									closeServerMenu();
									void handleInitializeLogins();
								}}
							>
								Initialize logins
								<span className="menu-hint">
									Sign in to SoundCloud and Spotify on the server.
								</span>
							</button>
							<button
								type="button"
								className="menu-item"
								onClick={() => {
									closeServerMenu();
									showCleanupSoundcloudToast();
								}}
							>
								Clean up SoundCloud
								<span className="menu-hint">
									Undo the follows, likes, comments and reposts the gates left.
								</span>
							</button>
						</div>
					</header>
				)}

				<div className="title-block">
					{showTrack && job.track ? (
						<>
							<h1 className="title">{headerTitle}</h1>
							<p className="title-artist">{headerArtist}</p>
						</>
					) : (
						<h1 className="title">Get a free download</h1>
					)}
				</div>

				<ol className="tracklist" aria-label="Progress">
					{PHASES.map(({ label }, index) => (
						<li
							key={label}
							className={`tracklist-item${index < phaseIndex ? ' is-done' : ''}${index === phaseIndex ? ' is-current' : ''}`}
							aria-current={index === phaseIndex ? 'step' : undefined}
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
					<Banner
						kind="error"
						message={job.error}
						onDismiss={() => setJob((prev) => ({ ...prev, error: null }))}
					/>
				)}
				{job.warning && (
					<Banner
						kind="warning"
						message={job.warning}
						onDismiss={() => setJob((prev) => ({ ...prev, warning: null }))}
					/>
				)}

				<div className="notes">
					{/* Find: SoundCloud link or search */}
					{step === 'url' && (
						<form onSubmit={handleSoundcloudSubmit} className="step-block">
							<div className="field">
								<label htmlFor="soundcloud-url">
									SoundCloud link or search
								</label>
								<div className="input-row">
									<input
										id="soundcloud-url"
										type="text"
										name="soundcloud-track-url"
										value={soundcloudUrl}
										onChange={(e) => setSoundcloudUrl(e.target.value)}
										placeholder="Track link, or artist and title"
										autoComplete="off"
										required
										disabled={isLoading}
									/>
									<button
										type="submit"
										className="btn-primary"
										disabled={isLoading || searchLoading !== null}
									>
										{isLoading ? (
											<>
												<span className="spinner" aria-hidden="true" />
												Looking up
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
								</div>
							</div>
							<OptionsDisclosure
								title="Options"
								current={`${OUTPUT_FORMAT_OPTIONS.find(({ value }) => value === outputFormat)?.label ?? outputFormat} · ${browserOptionsSummary}`}
							>
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
								<BrowserModeField
									name="browser-mode"
									browserMode={browserMode}
									availableBrowserModes={availableBrowserModes}
									disabled={isLoading}
									onChange={updateBrowserMode}
								/>
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
							</OptionsDisclosure>
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

					{/* Unlock: no gate link found, or the gate failed */}
					{showRecovery && (
						<div className="step-block">
							<div>
								<h2 className="step-heading">
									{hasFailed ? 'Try another way' : 'Add the gate link'}
								</h2>
								<p className="step-text">
									{hasFailed
										? 'These are ordered from the most likely to work.'
										: skipAutomaticHypedditFetch
											? 'Automatic lookup is off. Paste the gate link, or get the SoundCloud stream instead.'
											: 'Could not find a gate link on this track. Paste one from Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit, Fangate or Bandcamp, or a direct file link.'}
								</p>
							</div>
							<ol className="recovery">
								{retryModes.map((mode, index) => (
									<li key={mode} className="recovery-option">
										<div className="recovery-text">
											<p className="recovery-title">
												{BROWSER_MODE_RETRY_LABELS[mode]}
											</p>
											<p className="recovery-hint">
												{BROWSER_MODE_RETRY_HINTS[mode]}
											</p>
										</div>
										<button
											type="button"
											className={index === 0 ? 'btn-primary' : 'btn-secondary'}
											disabled={isLoading}
											onClick={() => {
												updateBrowserMode(mode);
												void startDownload(job.jobId as string, mode);
											}}
										>
											Retry
										</button>
									</li>
								))}
								<li className="recovery-option is-wide">
									<form
										onSubmit={handleHypedditSubmit}
										className="recovery-form"
									>
										<div className="field">
											<label htmlFor="hypeddit-url" className="recovery-title">
												{hasFailed
													? 'Paste a different gate link'
													: 'Paste the gate link'}
											</label>
											<div className="input-row">
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
												<button
													type="submit"
													className={
														retryModes.length > 0
															? 'btn-secondary'
															: 'btn-primary'
													}
													disabled={isLoading}
												>
													{isLoading ? (
														<>
															<span className="spinner" aria-hidden="true" />
															Starting
														</>
													) : (
														'Start'
													)}
												</button>
											</div>
										</div>
										<OptionsDisclosure
											title="Browser options"
											current={BROWSER_MODE_LABELS[browserMode]}
										>
											<BrowserModeField
												name="browser-mode-gate"
												browserMode={browserMode}
												availableBrowserModes={availableBrowserModes}
												disabled={isLoading}
												onChange={updateBrowserMode}
											/>
										</OptionsDisclosure>
									</form>
								</li>
								<li className="recovery-option">
									<div className="recovery-text">
										<p className="recovery-title">
											Get the SoundCloud stream instead
										</p>
										<p className="recovery-hint">
											Skips the gate and saves the audio SoundCloud plays, which
											is usually lower quality than the gated file.
										</p>
									</div>
									<button
										type="button"
										className="btn-secondary"
										disabled={isLoading || !soundcloudUrl.trim()}
										onClick={handleYtdlpSoundcloudDownload}
									>
										Get the stream
									</button>
								</li>
							</ol>
						</div>
					)}

					{/* Unlock: gate handling, then download progress */}
					{(isHandlingGate || step === 'download') && !hasFailed && (
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
												: isHandlingGate &&
														job.progress?.stage === 'handling_gates' &&
														gateLog.length > 0
													? 'Unlocking the download'
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
									{isHandlingGate && gateLog.length > 0 && (
										<ol className="gate-log" aria-label="Gate actions">
											{gateLog.map((entry, index) => {
												const isRunning =
													index === gateLog.length - 1 &&
													job.progress?.stage === 'handling_gates';
												return (
													<li
														key={entry}
														className={`gate-log-item${isRunning ? ' is-running' : ' is-done'}`}
													>
														<span className="gate-log-mark" aria-hidden="true">
															{isRunning ? (
																<span className="spinner" />
															) : (
																<CheckIcon />
															)}
														</span>
														<span>{entry}</span>
														<span className="visually-hidden">
															{isRunning ? ' (running)' : ' (done)'}
														</span>
													</li>
												);
											})}
										</ol>
									)}
									{isHandlingGate && (
										<div className="meter-group">
											<div
												className="meter"
												role="progressbar"
												aria-label="Gate progress"
												aria-valuetext={
													job.progress?.message || 'Handling gate'
												}
											>
												<div className="meter-fill is-indeterminate" />
											</div>
											{startedAt !== null ? (
												<p className="meter-stats">
													<span />
													<span>{formatElapsed(now - startedAt)} elapsed</span>
												</p>
											) : null}
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
												) : (
													<span />
												)}
												<span>
													{job.progress?.downloadBytes !== undefined
														? `${toMegabytes(job.progress.downloadBytes)}${
																typeof job.progress.totalBytes === 'number'
																	? ` of ${toMegabytes(job.progress.totalBytes)}`
																	: ''
															} MB`
														: null}
													{job.progress?.downloadBytes !== undefined &&
													startedAt !== null
														? ' · '
														: null}
													{startedAt !== null
														? `${formatElapsed(now - startedAt)} elapsed`
														: null}
												</span>
											</p>
										</div>
									)}
									<div className="actions">
										{canWatchBrowser ? (
											<button
												type="button"
												className="btn-secondary"
												onClick={() => setBrowserViewOpen(true)}
											>
												Watch the browser
											</button>
										) : null}
										<button
											type="button"
											className="btn-secondary"
											onClick={() => void cancelDownload()}
											disabled={isCancelling}
										>
											Cancel download
										</button>
									</div>
								</>
							)}
						</div>
					)}

					{/* Save: audio processing */}
					{step === 'metadata' &&
						!hasFailed &&
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
					{/* Save: tags */}
					{step === 'metadata' &&
						!hasFailed &&
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
								{promoCleanup ? (
									<div className="cleanup">
										<p className="step-text">
											Removed promo text like [FREE DL] and repeated artist
											names.
										</p>
										<button
											type="button"
											className="btn-secondary btn-small"
											disabled={isLoading}
											onClick={() => {
												setMetadata(promoCleanup);
												setPromoCleanup(null);
											}}
										>
											Undo
										</button>
									</div>
								) : canCleanupMetadata ? (
									<div className="cleanup">
										<p className="step-text">
											The tags contain promo text like [FREE DL] or a repeated
											artist name.
										</p>
										<button
											type="button"
											className="btn-secondary btn-small"
											disabled={isLoading}
											onClick={() => {
												setPromoCleanup(metadata);
												setMetadata(cleanMetadataFields(metadata));
											}}
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
										) : job.hasExistingArtwork && job.jobId ? (
											<button
												type="button"
												className="btn-text existing-cover-button"
												disabled={isLoading}
												onClick={() => void copyExistingArtwork()}
											>
												<img
													src={`${API_BASE}/api/job/${job.jobId}/existing-artwork`}
													alt=""
													className="existing-cover"
												/>
												Use the file's cover
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
										const existingValue =
											existingTagRows.find((row) => row.key === key)
												?.existingValue ?? '';
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
															title={`Reset ${label.toLowerCase()} to SoundCloud's`}
															aria-label={`Reset ${label.toLowerCase()} to SoundCloud's`}
															onClick={() =>
																setMetadata((prev) => ({
																	...prev,
																	[key]: defaultValue,
																}))
															}
														>
															<ResetIcon />
														</button>
													) : null}
												</div>
												{existingValue && existingValue !== currentValue ? (
													<p className="field-existing">
														<span className="field-existing-value">
															In the file: {existingValue}
														</span>
														<button
															type="button"
															className="btn-text"
															disabled={isLoading}
															aria-label={`Use the file's ${label.toLowerCase()}`}
															onClick={() =>
																setMetadata((prev) => ({
																	...prev,
																	[key]: existingValue,
																}))
															}
														>
															Use
														</button>
													</p>
												) : null}
											</div>
										);
									})}
								</div>

								<div className="filename-block">
									<p className="filename-preview">
										<span className="filename-preview-label">Saves as</span>{' '}
										<span className="filename-preview-name">
											{outputFilenamePreview}
										</span>
									</p>
									<label
										className="checkbox-row"
										htmlFor="name-as-artist-title"
									>
										<input
											id="name-as-artist-title"
											type="checkbox"
											checked={nameAsArtistTitle}
											disabled={isLoading}
											onChange={(e) =>
												updateNameAsArtistTitle(e.target.checked)
											}
										/>
										<span>Name the file "Artist - Title"</span>
									</label>
								</div>

								<div className="form-actions">
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
									{hasExistingMetadata ? (
										<button
											type="button"
											className="btn-secondary"
											disabled={isLoading}
											title="Save the file with the tags it came with"
											onClick={() => void processMetadata(true)}
										>
											Keep the file's tags
										</button>
									) : null}
								</div>
							</form>
						)}

					{/* Done */}
					{step === 'complete' && (
						<div className="step-block">
							<div>
								<h2 className="step-heading">Your file is ready</h2>
								<p className="filename">
									{job.outputFilename || job.downloadFilename}
								</p>
								{outputExtension || job.fileSize !== null ? (
									<p className="file-facts">
										{[
											outputExtension,
											job.fileSize !== null
												? formatFileSize(job.fileSize)
												: null,
										]
											.filter(Boolean)
											.join(' · ')}
									</p>
								) : null}
							</div>
							<div className="actions">
								{/* Navigate independently of the panel; the API serves an attachment. */}
								<a
									ref={downloadLinkRef}
									href={`${API_BASE}/api/job/${job.jobId}/file`}
									target="_blank"
									rel="noopener noreferrer"
									className="btn-primary"
									onClick={() => notifyParent('file-download')}
								>
									Download
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

function Banner({
	kind,
	message,
	onDismiss,
}: {
	kind: 'error' | 'warning';
	message: string;
	onDismiss: () => void;
}) {
	return (
		<div
			className={`banner banner-${kind}`}
			role={kind === 'error' ? 'alert' : 'status'}
		>
			<span className="banner-icon" aria-hidden="true">
				!
			</span>
			<p className="banner-message">{message}</p>
			<button
				type="button"
				className="btn-icon banner-dismiss"
				aria-label="Dismiss"
				title="Dismiss"
				onClick={onDismiss}
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
				>
					<path d="M6 6l12 12M18 6L6 18" />
				</svg>
			</button>
		</div>
	);
}

function MoreIcon() {
	return (
		<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
			<circle cx="5" cy="12" r="2" fill="currentColor" />
			<circle cx="12" cy="12" r="2" fill="currentColor" />
			<circle cx="19" cy="12" r="2" fill="currentColor" />
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="16"
			height="16"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M5 12.5l4.5 4.5L19 7.5" />
		</svg>
	);
}

function ResetIcon() {
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
			<path d="M3 12a9 9 0 1 0 3-6.7" />
			<path d="M3 4v5h5" />
		</svg>
	);
}

/** Settings tucked behind a disclosure whose summary shows the current choice. */
function OptionsDisclosure({
	title,
	current,
	children,
}: {
	title: string;
	current: string;
	children: React.ReactNode;
}) {
	return (
		<details className="options">
			<summary>
				<span className="options-title">{title}</span>
				<span className="options-current">{current}</span>
			</summary>
			<div className="options-body">{children}</div>
		</details>
	);
}

type BrowserModeFieldProps = {
	name: string;
	browserMode: BrowserMode;
	availableBrowserModes: BrowserMode[];
	disabled: boolean;
	onChange: (mode: BrowserMode) => void;
};

function BrowserModeField({
	name,
	browserMode,
	availableBrowserModes,
	disabled,
	onChange,
}: BrowserModeFieldProps) {
	return (
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
	);
}
