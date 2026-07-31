import { useCallback, useEffect, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import './App.css';

type Step = 'url' | 'hypeddit' | 'progress' | 'metadata' | 'complete';
type OutputFormat = 'original' | 'mp3-320';

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
}

interface JobState {
	jobId: string | null;
	track: TrackInfo | null;
	hypedditUrl: string | null;
	defaultMetadata: Metadata | null;
	existingMetadata: Metadata | null;
	outputFormat: OutputFormat;
	progress: JobProgress | null;
	downloadFilename: string | null;
	outputFilename: string | null;
	error: string | null;
}

const API_BASE = 'http://localhost:3000';

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
const PROMO_TAG =
	String.raw`free\s*d(?:own)?l(?:oad)?s?|free[\s._-]*dl|freedl|out\s*now|premiere|exclusive`;

function cleanPromoTags(value: string): string {
	if (!value) return value;

	let result = value;
	result = result.replace(
		new RegExp(String.raw`\s*[\[\(\{]\s*(?:${PROMO_TAG})\s*[\]\)\}]`, 'gi'),
		' ',
	);
	result = result.replace(
		new RegExp(
			String.raw`(?:\s*[-–—|/·•]+\s*|\s+)(?:${PROMO_TAG})\s*$`,
			'gi',
		),
		'',
	);
	result = result.replace(new RegExp(String.raw`(?:${PROMO_TAG})\s*$`, 'gi'), '');
	result = result.replace(
		new RegExp(
			String.raw`^\s*(?:${PROMO_TAG})(?:\s*[-–—|/·•]+\s*|\s+)`,
			'gi',
		),
		'',
	);
	result = result.replace(/\s{2,}/g, ' ');
	result = result.replace(/^[\s\-–—|/·•]+|[\s\-–—|/·•]+$/g, '');
	return result.trim();
}

/** Strip a leading `Artist - ` / `Artist — ` duplicate from the title. */
function stripDuplicateArtistFromTitle(title: string, artist: string): string {
	const trimmedArtist = artist.trim();
	const trimmedTitle = title.trim();
	if (!trimmedArtist || !trimmedTitle) return trimmedTitle;

	const escaped = trimmedArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return trimmedTitle
		.replace(new RegExp(String.raw`^${escaped}\s*[-–—|:]\s*`, 'i'), '')
		.trim();
}

function cleanMetadataFields(meta: Metadata): Metadata {
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

function artistTitleFilename(artist?: string, title?: string): string {
	const safeArtist = sanitizeFilenamePart(artist || '') || 'Unknown Artist';
	const safeTitle = sanitizeFilenamePart(title || '') || 'Unknown Title';
	return `${safeArtist} - ${safeTitle}.mp3`;
}

function isLosslessFilename(filename: string): boolean {
	const lower = filename.toLowerCase();
	return (
		lower.endsWith('.wav') ||
		lower.endsWith('.aiff') ||
		lower.endsWith('.aif') ||
		lower.endsWith('.flac')
	);
}

function previewProcessedFilename(
	downloadFilename: string | null,
	options: {
		nameAsArtistTitle: boolean;
		artist?: string;
		title?: string;
	},
): string {
	if (!downloadFilename) return '';
	if (options.nameAsArtistTitle) {
		return artistTitleFilename(options.artist, options.title);
	}
	if (isLosslessFilename(downloadFilename)) {
		return downloadFilename
			.replace(/\.wav$/i, '.mp3')
			.replace(/\.aiff$/i, '.mp3')
			.replace(/\.aif$/i, '.mp3')
			.replace(/\.flac$/i, '.mp3');
	}
	return downloadFilename;
}

export default function App() {
	const [step, setStep] = useState<Step>('url');
	const [soundcloudUrl, setSoundcloudUrl] = useState('');
	const [hypedditUrlInput, setHypedditUrlInput] = useState('');
	const [skipAutomaticHypedditFetch, setSkipAutomaticHypedditFetch] =
		useState(false);
	const [headfulMode, setHeadfulMode] = useState(false);
	const [outputFormat, setOutputFormat] = useState<OutputFormat>('mp3-320');
	const [job, setJob] = useState<JobState>({
		jobId: null,
		track: null,
		hypedditUrl: null,
		defaultMetadata: null,
		existingMetadata: null,
		outputFormat: 'mp3-320',
		progress: null,
		downloadFilename: null,
		outputFilename: null,
		error: null,
	});
	const [metadata, setMetadata] = useState<Metadata>({
		title: '',
		artist: '',
		album: '',
		genre: '',
	});
	const [customArtwork, setCustomArtwork] = useState<File | null>(null);
	const [nameAsArtistTitle, setNameAsArtistTitle] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const cleanupToastShownRef = useRef(false);
	const autoStartedFromQueryRef = useRef(false);
	const eventSourceRef = useRef<EventSource | null>(null);
	const formatPercent = (value?: number) => Math.round(value ?? 0);

	const showCleanupSoundcloudToast = useCallback(() => {
		toast('Cleanup your SoundCloud account?', {
			description: 'This will unfollow, unlike, and delete comments/reposts.',
			closeButton: false,
			duration: Infinity,
			action: {
				label: 'Confirm',
				onClick: async () => {
					const toastId = toast.loading('Cleaning up SoundCloud account...');

					try {
						const response = await fetch(`${API_BASE}/api/soundcloud/cleanup`, {
							method: 'POST',
						});
						const data = await response.json();

						if (!response.ok) {
							throw new Error(
								data.error || 'Failed to cleanup SoundCloud account',
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
							parts.length > 0 ? parts.join(', ') : 'No items to clean up.';

						toast.success('SoundCloud account cleanup completed.', {
							id: toastId,
							description,
						});
					} catch (err) {
						toast.error('Cleanup failed', {
							id: toastId,
							description: err instanceof Error ? err.message : 'Unknown error',
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
		async (jobId: string) => {
			setStep('progress');
			cleanupToastShownRef.current = false;
			eventSourceRef.current?.close();
			eventSourceRef.current = null;
			notifyParent('job', { jobId });

			try {
				const response = await fetch(`${API_BASE}/api/job/${jobId}/start`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ headless: !headfulMode }),
				});

				if (!response.ok) {
					const data = await response.json();
					throw new Error(data.error || 'Failed to start download');
				}

				// Connect to SSE for progress updates
				const eventSource = new EventSource(
					`${API_BASE}/api/job/${jobId}/events`,
				);
				eventSourceRef.current = eventSource;

				eventSource.onmessage = (event) => {
					const progress: JobProgress = JSON.parse(event.data);
					setJob((prev) => ({ ...prev, progress }));

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
									outputFormat: data.outputFormat,
								}));
								setStep(
									data.outputFormat === 'original' ? 'complete' : 'metadata',
								);
							})
							.catch((err) => {
								setJob((prev) => ({
									...prev,
									error:
										err instanceof Error ? err.message : 'Failed to load job',
								}));
							});
					} else if (progress.stage === 'error') {
						eventSource.close();
						eventSourceRef.current = null;
						setJob((prev) => ({ ...prev, error: progress.message }));
					} else if (progress.stage === 'cancelled') {
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
						error: 'Lost connection to download progress',
					}));
				};
			} catch (err) {
				setJob((prev) => ({
					...prev,
					error: err instanceof Error ? err.message : 'Unknown error',
				}));
			}
		},
		[headfulMode, showCleanupSoundcloudToast],
	);

	const cancelDownload = useCallback(async () => {
		const jobId = job.jobId;
		if (!jobId) return;

		try {
			const response = await fetch(`${API_BASE}/api/job/${jobId}/cancel`, {
				method: 'POST',
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				setJob((prev) => ({
					...prev,
					error:
						(data as { error?: string }).error || 'Failed to cancel download',
				}));
				return;
			}
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error:
					err instanceof Error ? err.message : 'Failed to cancel download',
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
		notifyParent('cancelled');
	}, [job.jobId]);

	// Parent userscript panel X → cancel in-progress job
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!ALLOWED_HOST_ORIGINS.has(event.origin)) return;
			const data = event.data;
			if (!data || data.source !== 'sc-gate-dl-host') return;
			if (data.type === 'cancel') {
				void cancelDownload();
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
			setJob((prev) => ({ ...prev, error: null }));

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
					throw new Error(data.error || 'Failed to create job');
				}

				setJob((prev) => ({
					...prev,
					jobId: data.jobId,
					track: data.track,
					hypedditUrl: data.hypedditUrl,
					defaultMetadata: data.defaultMetadata,
					existingMetadata: null,
					outputFormat: format,
					error: null,
				}));

				if (data.defaultMetadata) {
					setMetadata(data.defaultMetadata);
				}

				if (skipAutomaticHypedditFetch || data.needsHypedditUrl) {
					setStep('hypeddit');
				} else {
					startDownload(data.jobId);
				}
			} catch (err) {
				setJob((prev) => ({
					...prev,
					error: err instanceof Error ? err.message : 'Unknown error',
				}));
			} finally {
				setIsLoading(false);
			}
		},
		[skipAutomaticHypedditFetch, outputFormat, startDownload],
	);

	// Create job with SoundCloud URL
	const handleSoundcloudSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		void createJob(soundcloudUrl);
	};

	// Userscript / deep-link: ?url=&outputFormat= pre-fills and starts a job
	useEffect(() => {
		if (autoStartedFromQueryRef.current) return;
		const params = new URLSearchParams(window.location.search);
		let queryUrl = params.get('url') || params.get('soundcloudUrl');
		if (!queryUrl) return;
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

		const formatParam = params.get('outputFormat');
		const format: OutputFormat | undefined =
			formatParam === 'original' || formatParam === 'mp3-320'
				? formatParam
				: undefined;
		if (format) {
			setOutputFormat(format);
		}
		setSoundcloudUrl(queryUrl);
		void createJob(queryUrl, format);
	}, [createJob]);

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
				throw new Error(data.error || 'Failed to set Hypeddit URL');
			}

			setJob((prev) => ({ ...prev, hypedditUrl: hypedditUrlInput }));
			startDownload(job.jobId);
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : 'Unknown error',
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
				throw new Error(data.error || 'Failed to start yt-dlp download');
			}

			setJob((prev) => ({ ...prev, hypedditUrl: soundcloudUrl }));
			startDownload(job.jobId);
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : 'Unknown error',
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
				throw new Error(data.error || 'Failed to process audio');
			}

			setJob((prev) => ({ ...prev, outputFilename: data.outputFilename }));
			setStep('complete');
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : 'Unknown error',
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
	const outputFilenamePreview = previewProcessedFilename(job.downloadFilename, {
		nameAsArtistTitle,
		artist: metadata.artist,
		title: metadata.title,
	});
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

	// Reset and start over
	const handleReset = () => {
		notifyParent('new-download');
		setSoundcloudUrl('');
		setHypedditUrlInput('');
		setSkipAutomaticHypedditFetch(false);
		setHeadfulMode(false);
		setJob({
			jobId: null,
			track: null,
			hypedditUrl: null,
			defaultMetadata: null,
			existingMetadata: null,
			outputFormat,
			progress: null,
			downloadFilename: null,
			outputFilename: null,
			error: null,
		});
		setMetadata({ title: '', artist: '', album: '', genre: '' });
		setCustomArtwork(null);
		setNameAsArtistTitle(false);
		setStep('url');
	};

	const handleInitializeLogins = async () => {
		toast('Initialize logins?', {
			description:
				'This will open a browser window (non-headless) to initialize SoundCloud and Spotify logins. You may need to solve a captcha if the built-in solver fails.',
			closeButton: false,
			duration: Infinity,
			action: {
				label: 'Confirm',
				onClick: async () => {
					const toastId = toast.loading('Initializing logins...');

					try {
						const response = await fetch(`${API_BASE}/api/logins/initialize`, {
							method: 'POST',
						});
						const data = await response.json();

						if (!response.ok) {
							throw new Error(data.error || 'Failed to initialize logins');
						}

						toast.success('Logins initialized successfully.', {
							id: toastId,
						});
					} catch (err) {
						toast.error('Login initialization failed', {
							id: toastId,
							description: err instanceof Error ? err.message : 'Unknown error',
						});
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
		<div className="app">
			<Toaster richColors closeButton theme="dark" />
			<header className="header">
				<div className="logo">
					<span className="logo-icon">&#9654;</span>
					<h1>sc-gate-dl</h1>
				</div>
				<p className="tagline">
					Download & tag SoundCloud tracks from Hypeddit, Droploud, GateRush,
					DownloadGater, or Bandcamp
				</p>
			</header>

			{/* Step indicator */}
			<div className="steps">
				<div
					className={`step ${step === 'url' ? 'active' : ''} ${['hypeddit', 'progress', 'metadata', 'complete'].includes(step) ? 'completed' : ''}`}
				>
					<span className="step-number">1</span>
					<span className="step-label">SoundCloud</span>
				</div>
				<div className="step-connector" />
				<div
					className={`step ${step === 'hypeddit' ? 'active' : ''} ${['progress', 'metadata', 'complete'].includes(step) ? 'completed' : ''}`}
				>
					<span className="step-number">2</span>
					<span className="step-label">Gate</span>
				</div>
				<div className="step-connector" />
				<div
					className={`step ${step === 'progress' ? 'active' : ''} ${['metadata', 'complete'].includes(step) ? 'completed' : ''}`}
				>
					<span className="step-number">3</span>
					<span className="step-label">Download</span>
				</div>
				<div className="step-connector" />
				<div
					className={`step ${step === 'metadata' ? 'active' : ''} ${step === 'complete' ? 'completed' : ''}`}
				>
					<span className="step-number">4</span>
					<span className="step-label">Metadata</span>
				</div>
				<div className="step-connector" />
				<div
					className={`step ${step === 'complete' ? 'active completed' : ''}`}
				>
					<span className="step-number">5</span>
					<span className="step-label">Done</span>
				</div>
			</div>

			{/* Error display */}
			{job.error && (
				<div className="error-banner">
					<span className="error-icon">!</span>
					<span>{job.error}</span>
					<button
						type="button"
						onClick={() => setJob((prev) => ({ ...prev, error: null }))}
					>
						Dismiss
					</button>
				</div>
			)}

			{/* Track preview */}
			{job.track && step !== 'url' && (
				<div className="track-preview">
					<img
						src={(job.track.artworkUrl || job.track.user.avatarUrl).replace(
							'large',
							't300x300',
						)}
						alt="Track artwork"
						className="track-artwork"
					/>
					<div className="track-info">
						<h3>{job.track.title}</h3>
						<p>{job.track.user.fullName || job.track.user.username}</p>
					</div>
				</div>
			)}

			{/* Step content */}
			<div className="content">
				{/* Step 1: SoundCloud URL */}
				{step === 'url' && (
					<form
						onSubmit={handleSoundcloudSubmit}
						className="form animate-slide-up"
					>
						<div className="form-group">
							<label htmlFor="soundcloud-url">SoundCloud Track URL</label>
							<input
								id="soundcloud-url"
								type="url"
								name="soundcloud-track-url"
								value={soundcloudUrl}
								onChange={(e) => setSoundcloudUrl(e.target.value)}
								placeholder="https://soundcloud.com/artist/track"
								autoComplete="off"
								required
								disabled={isLoading}
							/>
						</div>
						<div className="url-settings">
							<div className="form-group url-settings-format">
								<label htmlFor="output-format">Output Format</label>
								<select
									id="output-format"
									value={outputFormat}
									onChange={(e) =>
										setOutputFormat(e.target.value as OutputFormat)
									}
									disabled={isLoading}
								>
									<option value="mp3-320">MP3 320 kbps</option>
									<option value="original">Original file</option>
								</select>
							</div>
							<div className="checkbox-settings">
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
									<span>Skip automatic gate link fetching</span>
								</label>
								<label className="checkbox-row" htmlFor="headful-mode">
									<input
										id="headful-mode"
										type="checkbox"
										checked={headfulMode}
										onChange={(e) => setHeadfulMode(e.target.checked)}
										disabled={isLoading}
									/>
									<span>Show browser window (headful)</span>
								</label>
							</div>
						</div>
						<button type="submit" className="btn-primary" disabled={isLoading}>
							{isLoading ? (
								<>
									<span className="spinner" />
									Fetching...
								</>
							) : (
								'Fetch Track'
							)}
						</button>
					</form>
				)}

				{/* Step 2: Gate URL (if needed) */}
				{step === 'hypeddit' && (
					<div className="form animate-slide-up">
						<div className="notice">
							<span className="notice-icon">i</span>
							<p>
								{skipAutomaticHypedditFetch
									? 'Automatic gate lookup is disabled. Enter a gate URL manually, or download the SoundCloud track via yt-dlp.'
									: 'Gate URL not found in track. Enter a Hypeddit, Droploud, GateRush, DownloadGater, or Bandcamp URL, or download via yt-dlp from SoundCloud.'}
							</p>
						</div>
						<form onSubmit={handleHypedditSubmit}>
							<div className="form-group">
								<label htmlFor="hypeddit-url">Gate URL</label>
								<input
									id="hypeddit-url"
									type="url"
									name="hypeddit-url"
									value={hypedditUrlInput}
									onChange={(e) => setHypedditUrlInput(e.target.value)}
									placeholder="https://hypeddit.com/... / droploud.com/gate/... / gaterush.me/... / downloadgater.com/g/... / artist.bandcamp.com/track/..."
									autoComplete="off"
									required
									disabled={isLoading}
								/>
							</div>
							<label className="checkbox-row" htmlFor="headful-mode-gate">
								<input
									id="headful-mode-gate"
									type="checkbox"
									checked={headfulMode}
									onChange={(e) => setHeadfulMode(e.target.checked)}
									disabled={isLoading}
								/>
								<span>Show browser window (headful)</span>
							</label>
							<button
								type="submit"
								className="btn-primary"
								disabled={isLoading}
							>
								{isLoading ? (
									<>
										<span className="spinner" />
										Starting...
									</>
								) : (
									'Start Download'
								)}
							</button>
						</form>
						<div className="form-divider" aria-hidden="true">
							<span>or</span>
						</div>
						<button
							type="button"
							className="btn-secondary btn-full"
							disabled={isLoading || !soundcloudUrl.trim()}
							onClick={handleYtdlpSoundcloudDownload}
						>
							{isLoading ? (
								<>
									<span className="spinner" />
									Starting...
								</>
							) : (
								'Download via yt-dlp from SoundCloud'
							)}
						</button>
					</div>
				)}

				{/* Step 3: Progress */}
				{step === 'progress' && (
					<div className="progress-container animate-slide-up">
						<div className="progress-stage">
							<span className="stage-label">
								{job.progress?.message || 'Initializing...'}
							</span>
							{job.progress?.currentGate && (
								<span className="gate-badge">
									{job.progress.currentGate.toUpperCase()}
								</span>
							)}
						</div>
						<div className="progress-bar">
							<div
								className="progress-fill"
								style={{ width: `${job.progress?.percent || 0}%` }}
							/>
						</div>
						<div className="progress-stats">
							<span>{formatPercent(job.progress?.percent)}%</span>
							{job.progress?.downloadBytes !== undefined &&
								job.progress?.totalBytes !== undefined && (
									<span>
										{(job.progress.downloadBytes / 1024 / 1024).toFixed(1)} /{' '}
										{(job.progress.totalBytes / 1024 / 1024).toFixed(1)} MB
									</span>
								)}
						</div>
						<button
							type="button"
							className="btn-secondary btn-cancel-download"
							onClick={() => void cancelDownload()}
						>
							Cancel download
						</button>
					</div>
				)}

				{/* Step 4: Metadata */}
				{step === 'metadata' && (
					<form
						onSubmit={handleMetadataSubmit}
						className="form metadata-form animate-slide-up"
					>
						{existingTagRows.length > 0 ? (
							<div className="existing-metadata">
								<div>
									<h3>Existing MP3 Metadata</h3>
									<p>
										Copy a tag into the form, or keep the file’s tags unchanged
										for the whole download.
									</p>
								</div>
								<ul className="existing-metadata-list">
									{existingTagRows.map(({ key, label, existingValue }) => (
										<li key={key} className="existing-metadata-row">
											<span className="existing-metadata-label">{label}</span>
											<span className="existing-metadata-value">
												{existingValue}
											</span>
											<button
												type="button"
												className="btn-copy-existing"
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
												<svg
													viewBox="0 0 24 24"
													width="14"
													height="14"
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
											</button>
										</li>
									))}
								</ul>
								<button
									type="button"
									className="btn-secondary"
									disabled={isLoading}
									onClick={() => void processMetadata(true)}
								>
									Use this metadata as-is
								</button>
							</div>
						) : null}
						<div className="metadata-grid">
							<div className="artwork-section">
								<div className="artwork-preview">
									{customArtwork ? (
										<img
											src={URL.createObjectURL(customArtwork)}
											alt="Custom artwork"
										/>
									) : job.jobId ? (
										<img
											src={`${API_BASE}/api/job/${job.jobId}/artwork`}
											alt="Track artwork"
										/>
									) : (
										<div className="artwork-placeholder">No artwork</div>
									)}
								</div>
								<label className="artwork-upload">
									<input
										type="file"
										accept="image/*"
										disabled={isLoading}
										onChange={(e) =>
											setCustomArtwork(e.target.files?.[0] || null)
										}
									/>
									<span>Change Artwork</span>
								</label>
								{canCleanupMetadata ? (
									<button
										type="button"
										className="btn-secondary btn-auto-cleanup"
										disabled={isLoading}
										title="Remove promo tags like [FREE DL] and duplicate Artist - from the title"
										onClick={() =>
											setMetadata((prev) => cleanMetadataFields(prev))
										}
									>
										Auto-Cleanup
									</button>
								) : null}
							</div>

							<div className="fields-section">
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
										{
											key: 'genre',
											label: 'Genre',
											placeholder: 'Genre',
										},
									] as const
								).map(({ key, label, placeholder }) => {
									const currentValue = metadata[key] || '';
									const defaultValue = defaultMetadataValues[key] || '';
									const isDirty = currentValue !== defaultValue;
									return (
										<div className="form-group" key={key}>
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
														title={`Reset ${label.toLowerCase()} to default`}
														aria-label={`Reset ${label.toLowerCase()} to default`}
														onClick={() =>
															setMetadata((prev) => ({
																...prev,
																[key]: defaultValue,
															}))
														}
													>
														<svg
															viewBox="0 0 24 24"
															width="14"
															height="14"
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
						</div>

						<div className="filename-preview">
							<label className="checkbox-row" htmlFor="name-as-artist-title">
								<input
									id="name-as-artist-title"
									type="checkbox"
									checked={nameAsArtistTitle}
									disabled={isLoading}
									onChange={(e) => setNameAsArtistTitle(e.target.checked)}
								/>
								<span>Name file as ARTIST - TITLE</span>
							</label>
							<div className="form-group">
								<label htmlFor="output-filename-preview">Filename</label>
								<input
									id="output-filename-preview"
									type="text"
									className="filename-preview-input mono"
									value={outputFilenamePreview}
									disabled
									readOnly
								/>
							</div>
						</div>

						<button type="submit" className="btn-primary" disabled={isLoading}>
							{isLoading ? (
								<>
									<span className="spinner" />
									Processing...
								</>
							) : (
								'Process & Finalize'
							)}
						</button>
					</form>
				)}

				{/* Step 5: Complete */}
				{step === 'complete' && (
					<div className="complete-container animate-slide-up">
						<div className="success-icon">&#10003;</div>
						<h2>Download Ready!</h2>
						<p className="filename mono">
							{job.outputFilename || job.downloadFilename}
						</p>
						<div className="complete-actions">
							<a
								href={`${API_BASE}/api/job/${job.jobId}/file`}
								download
								className="btn-primary"
								onClick={() => notifyParent('file-download')}
							>
								{job.outputFormat === 'original'
									? 'Download Original'
									: 'Download MP3'}
							</a>
							<button
								type="button"
								onClick={handleReset}
								className="btn-secondary"
							>
								Start New Download
							</button>
						</div>
					</div>
				)}
			</div>

			<footer className="footer">
				<div className="footer-buttons">
					<button
						type="button"
						className="btn-secondary btn-cleanup"
						onClick={handleInitializeLogins}
					>
						Initialize Logins
					</button>
					<button
						type="button"
						className="btn-secondary btn-cleanup"
						onClick={showCleanupSoundcloudToast}
					>
						Cleanup SoundCloud
					</button>
				</div>
				<p>
					Built for personal use &middot;{' '}
					<a
						href="https://github.com/D3SOX/sc-gate-dl"
						target="_blank"
						rel="noopener noreferrer"
					>
						GitHub
					</a>
				</p>
			</footer>
		</div>
	);
}
