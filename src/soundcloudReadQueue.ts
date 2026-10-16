export interface SoundcloudReadQueueOptions {
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
}

export class SoundcloudReadQueue {
	private tail: Promise<unknown> = Promise.resolve();
	private nextReadAt = 0;
	private consecutiveLimits = 0;
	private readonly now: () => number;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	constructor(options: SoundcloudReadQueueOptions = {}) {
		this.now = options.now ?? Date.now;
		this.sleep =
			options.sleep ??
			((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
	}
	run<T>(
		operation: () => Promise<T>,
		onRateLimit?: (milliseconds: number) => void,
	): Promise<T> {
		const task = this.tail.then(async () => {
			for (let attempt = 0; ; attempt++) {
				const delay = Math.max(0, this.nextReadAt - this.now());
				if (delay) {
					if (this.consecutiveLimits) onRateLimit?.(delay);
					await this.sleep(delay);
				}
				try {
					const result = await operation();
					this.consecutiveLimits = 0;
					this.nextReadAt = this.now() + 2000;
					return result;
				} catch (error) {
					this.nextReadAt = this.now() + 2000;
					if (
						!(error instanceof Error) ||
						!/\b(?:Status code|HTTP|status)\s*429\b/i.test(error.message)
					)
						throw error;
					const backoff = Math.min(
						300_000,
						30_000 * 2 ** Math.min(this.consecutiveLimits++, 4),
					);
					this.nextReadAt = this.now() + backoff;
					if (attempt >= 2) throw error;
				}
			}
		});
		// A rejected read must not poison the queue for later requests.
		this.tail = task.catch(() => {});
		return task;
	}
}
