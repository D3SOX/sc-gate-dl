import { useCallback, useRef, useState } from 'react';
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
	const [isLoading, setIsLoading] = useState(false);
	const cleanupToastShownRef = useRef(false);
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

	// Create job with SoundCloud URL
	const handleSoundcloudSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!soundcloudUrl.trim()) return;

		setIsLoading(true);
		setJob((prev) => ({ ...prev, error: null }));

		try {
			const response = await fetch(`${API_BASE}/api/job`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					soundcloudUrl,
					skipAutomaticHypedditFetch,
					outputFormat,
				}),
			});

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to create job');
			}

			setJob({
				...job,
				jobId: data.jobId,
				track: data.track,
				hypedditUrl: data.hypedditUrl,
				defaultMetadata: data.defaultMetadata,
				existingMetadata: null,
				outputFormat,
				error: null,
			});

			// Pre-fill metadata
			if (data.defaultMetadata) {
				setMetadata(data.defaultMetadata);
			}

			if (skipAutomaticHypedditFetch || data.needsHypedditUrl) {
				setStep('hypeddit');
			} else {
				// Auto-start download
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
	};

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

	// Start download process
	const startDownload = useCallback(
		async (jobId: string) => {
			setStep('progress');
			cleanupToastShownRef.current = false;

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
						setJob((prev) => ({ ...prev, error: progress.message }));
					}
				};

				eventSource.onerror = () => {
					eventSource.close();
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
					body: JSON.stringify({ preserveMetadata: true }),
				});
			} else if (customArtwork) {
				const formData = new FormData();
				formData.append('title', metadata.title || '');
				formData.append('artist', metadata.artist || '');
				formData.append('album', metadata.album || '');
				formData.append('genre', metadata.genre || '');
				formData.append('artwork', customArtwork);

				response = await fetch(`${API_BASE}/api/job/${job.jobId}/metadata`, {
					method: 'POST',
					body: formData,
				});
			} else {
				response = await fetch(`${API_BASE}/api/job/${job.jobId}/metadata`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(metadata),
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

	// Reset and start over
	const handleReset = () => {
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
					</div>
				)}

				{/* Step 4: Metadata */}
				{step === 'metadata' && (
					<form
						onSubmit={handleMetadataSubmit}
						className="form metadata-form animate-slide-up"
					>
						{job.existingMetadata && (
							<div className="existing-metadata">
								<div>
									<h3>Existing MP3 Metadata</h3>
									<p>
										Copy these values into the form, or keep the file unchanged.
									</p>
								</div>
								<dl>
									<dt>Title</dt>
									<dd>{job.existingMetadata.title || 'Not set'}</dd>
									<dt>Artist</dt>
									<dd>{job.existingMetadata.artist || 'Not set'}</dd>
									<dt>Album</dt>
									<dd>{job.existingMetadata.album || 'Not set'}</dd>
									<dt>Genre</dt>
									<dd>{job.existingMetadata.genre || 'Not set'}</dd>
								</dl>
								<div className="existing-metadata-actions">
									<button
										type="button"
										className="btn-secondary"
										disabled={isLoading}
										onClick={() => setMetadata(job.existingMetadata || {})}
									>
										Use Existing Values
									</button>
									<button
										type="button"
										className="btn-secondary"
										disabled={isLoading}
										onClick={() => void processMetadata(true)}
									>
										Leave Metadata As-Is
									</button>
								</div>
							</div>
						)}
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
										onChange={(e) =>
											setCustomArtwork(e.target.files?.[0] || null)
										}
									/>
									<span>Change Artwork</span>
								</label>
							</div>

							<div className="fields-section">
								<div className="form-group">
									<label htmlFor="meta-title">Title</label>
									<input
										id="meta-title"
										type="text"
										value={metadata.title || ''}
										onChange={(e) =>
											setMetadata((prev) => ({
												...prev,
												title: e.target.value,
											}))
										}
										placeholder="Track title"
									/>
								</div>
								<div className="form-group">
									<label htmlFor="meta-artist">Artist</label>
									<input
										id="meta-artist"
										type="text"
										value={metadata.artist || ''}
										onChange={(e) =>
											setMetadata((prev) => ({
												...prev,
												artist: e.target.value,
											}))
										}
										placeholder="Artist name"
									/>
								</div>
								<div className="form-group">
									<label htmlFor="meta-album">Album</label>
									<input
										id="meta-album"
										type="text"
										value={metadata.album || ''}
										onChange={(e) =>
											setMetadata((prev) => ({
												...prev,
												album: e.target.value,
											}))
										}
										placeholder="Album name"
									/>
								</div>
								<div className="form-group">
									<label htmlFor="meta-genre">Genre</label>
									<input
										id="meta-genre"
										type="text"
										value={metadata.genre || ''}
										onChange={(e) =>
											setMetadata((prev) => ({
												...prev,
												genre: e.target.value,
											}))
										}
										placeholder="Genre"
									/>
								</div>
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
						href="https://github.com/D3SOX/hypeddit-soundcloud-downloader"
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
