import type { Job, JobProgress, JobStage, OutputFormat } from './types';

type ProgressListener = (progress: JobProgress) => void;
type BandcampTrackResolver = (url: string | null) => void;

/**
 * In-memory job store for single-user Web UI
 */
class JobStore {
	private jobs: Map<string, Job> = new Map();
	private listeners: Map<string, Set<ProgressListener>> = new Map();
	/** Pending Bandcamp album-track picks (mid-download pause). */
	private bandcampTrackResolvers: Map<string, BandcampTrackResolver> =
		new Map();

	/**
	 * Creates a new job and returns its ID
	 */
	create(soundcloudUrl: string, outputFormat: OutputFormat): Job {
		const id = crypto.randomUUID();
		const now = new Date();
		const job: Job = {
			id,
			soundcloudUrl,
			hypedditUrl: null,
			bandcampAlbumTracks: null,
			browserMode:
				process.env.BROWSER_HEADLESS === 'false' ? 'headed' : 'headless',
			outputFormat,
			cancelled: false,
			track: null,
			defaultMetadata: null,
			existingMetadata: null,
			progress: {
				stage: 'pending',
				message: 'Job created',
				percent: 0,
			},
			downloadFilename: null,
			outputFilename: null,
			sourceIsLossless: null,
			artworkBuffer: null,
			artworkFileName: null,
			existingArtworkBuffer: null,
			existingArtworkFileName: null,
			error: null,
			createdAt: now,
			updatedAt: now,
		};
		this.jobs.set(id, job);
		return job;
	}

	/**
	 * Gets a job by ID
	 */
	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	/** True when another job already claims this downloads/ filename. */
	isFilenameOwnedByOtherJob(filename: string, excludeJobId: string): boolean {
		for (const job of this.jobs.values()) {
			if (job.id === excludeJobId) continue;
			if (
				job.downloadFilename === filename ||
				job.outputFilename === filename
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Updates a job and notifies listeners
	 */
	update(
		id: string,
		updates: Partial<Omit<Job, 'id' | 'createdAt'>>,
	): Job | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;

		Object.assign(job, updates, { updatedAt: new Date() });

		// Notify progress listeners if progress was updated
		if (updates.progress) {
			this.notifyListeners(id, job.progress);
		}

		return job;
	}

	/**
	 * Updates job progress and notifies listeners
	 */
	updateProgress(
		id: string,
		stage: JobStage,
		message: string,
		percent: number,
		extra?: Partial<JobProgress>,
	): void {
		const job = this.jobs.get(id);
		if (!job) return;

		job.progress = {
			stage,
			message,
			percent,
			...extra,
		};
		job.updatedAt = new Date();

		this.notifyListeners(id, job.progress);
	}

	/**
	 * Sets job error state
	 */
	setError(id: string, error: string): void {
		const job = this.jobs.get(id);
		if (!job) return;

		job.error = error;
		job.progress = {
			stage: 'error',
			message: error,
			percent: 0,
		};
		job.updatedAt = new Date();

		this.notifyListeners(id, job.progress);
	}

	isCancelled(id: string): boolean {
		return this.jobs.get(id)?.cancelled === true;
	}

	/**
	 * Mark a job cancelled and notify listeners. Caller closes the browser.
	 */
	cancel(id: string, message = 'Download cancelled'): Job | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;

		job.cancelled = true;
		job.error = null;
		job.bandcampAlbumTracks = null;
		job.progress = {
			stage: 'cancelled',
			message,
			percent: job.progress.percent,
		};
		job.updatedAt = new Date();
		this.resolveBandcampTrackSelection(id, null);
		this.notifyListeners(id, job.progress);
		return job;
	}

	/**
	 * Pause until the user picks a Bandcamp album track (or cancel → null).
	 */
	waitForBandcampTrackSelection(id: string): Promise<string | null> {
		const existing = this.bandcampTrackResolvers.get(id);
		if (existing) {
			existing(null);
			this.bandcampTrackResolvers.delete(id);
		}
		return new Promise((resolve) => {
			this.bandcampTrackResolvers.set(id, resolve);
		});
	}

	/**
	 * Resolve a pending Bandcamp album-track wait with a track URL, or null.
	 */
	resolveBandcampTrackSelection(id: string, url: string | null): boolean {
		const resolve = this.bandcampTrackResolvers.get(id);
		if (!resolve) return false;
		this.bandcampTrackResolvers.delete(id);
		resolve(url);
		return true;
	}

	/**
	 * Clear cancelled flag when restarting a job (e.g. after error).
	 */
	clearCancelled(id: string): void {
		const job = this.jobs.get(id);
		if (job) job.cancelled = false;
	}

	/**
	 * Subscribe to progress updates for a job
	 */
	subscribe(id: string, listener: ProgressListener): () => void {
		let listenerSet = this.listeners.get(id);
		if (!listenerSet) {
			listenerSet = new Set();
			this.listeners.set(id, listenerSet);
		}
		listenerSet.add(listener);

		// Return unsubscribe function
		return () => {
			this.listeners.get(id)?.delete(listener);
		};
	}

	/**
	 * Notify all listeners for a job
	 */
	private notifyListeners(id: string, progress: JobProgress): void {
		const jobListeners = this.listeners.get(id);
		if (jobListeners) {
			for (const listener of jobListeners) {
				try {
					listener(progress);
				} catch (e) {
					console.error('Error in progress listener:', e);
				}
			}
		}
	}

	/**
	 * Delete a job
	 */
	delete(id: string): boolean {
		this.resolveBandcampTrackSelection(id, null);
		this.listeners.delete(id);
		return this.jobs.delete(id);
	}

	/**
	 * Clean up old jobs (older than specified milliseconds)
	 */
	cleanup(maxAgeMs: number = 60 * 60 * 1000): number {
		const now = Date.now();
		let deleted = 0;
		for (const [id, job] of this.jobs) {
			if (now - job.createdAt.getTime() > maxAgeMs) {
				this.delete(id);
				deleted++;
			}
		}
		return deleted;
	}
}

// Export singleton instance
export const jobStore = new JobStore();
