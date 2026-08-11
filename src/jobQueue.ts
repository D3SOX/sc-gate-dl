type QueueTask = () => Promise<void>;

interface QueuedJob {
	id: string;
	run: QueueTask;
}

interface JobQueueHooks {
	onQueued(id: string, position: number): void;
	onTaskError(id: string, error: unknown): void;
}

export interface EnqueueResult {
	queued: boolean;
	position: number;
}

/** Serializes download jobs shared by every Web UI tab connected to the server. */
export class JobQueue {
	private activeJobId: string | null = null;
	private activeRun: QueuedJob | null = null;
	private activeCompletion: Promise<void> | null = null;
	private waiting: QueuedJob[] = [];

	constructor(private readonly hooks: JobQueueHooks) {}

	enqueue(id: string, run: QueueTask): EnqueueResult {
		if (this.activeJobId === id) return { queued: false, position: 0 };
		const existingPosition = this.getPosition(id);
		if (existingPosition > 0) {
			return { queued: true, position: existingPosition };
		}

		const queuedJob = { id, run };
		if (!this.activeJobId) {
			this.start(queuedJob);
			return { queued: false, position: 0 };
		}

		this.waiting.push(queuedJob);
		this.notifyPositions();
		return { queued: true, position: this.waiting.length };
	}

	/** Removes a waiting job. Active jobs are cancelled by their downloader. */
	cancel(id: string): boolean {
		const index = this.waiting.findIndex((job) => job.id === id);
		if (index === -1) return false;
		this.waiting.splice(index, 1);
		this.notifyPositions();
		return true;
	}

	getPosition(id: string): number {
		const index = this.waiting.findIndex((job) => job.id === id);
		return index === -1 ? 0 : index + 1;
	}

	/** Wait until an active job has fully released the serial queue slot. */
	async waitForCompletion(id: string): Promise<void> {
		if (this.activeJobId !== id) return;
		await this.activeCompletion;
	}

	/** Release a cancelled active job after its downloader has been closed. */
	releaseActive(id: string): boolean {
		if (this.activeJobId !== id) return false;
		this.activeJobId = null;
		this.activeRun = null;
		this.activeCompletion = null;
		const next = this.waiting.shift();
		this.notifyPositions();
		if (next) this.start(next);
		return true;
	}

	private start(job: QueuedJob): void {
		this.activeJobId = job.id;
		this.activeRun = job;

		let task: Promise<void>;
		try {
			task = job.run();
		} catch (error) {
			task = Promise.reject(error);
		}

		this.activeCompletion = task
			.catch((error) => {
				if (this.activeRun === job) {
					this.hooks.onTaskError(job.id, error);
				}
			})
			.finally(() => {
				if (this.activeRun !== job) return;
				this.activeJobId = null;
				this.activeRun = null;
				this.activeCompletion = null;
				const next = this.waiting.shift();
				this.notifyPositions();
				if (next) this.start(next);
			});
	}

	private notifyPositions(): void {
		this.waiting.forEach((job, index) => {
			this.hooks.onQueued(job.id, index + 1);
		});
	}
}
