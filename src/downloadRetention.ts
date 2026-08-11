export function deleteAfterDownloadEnabled(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === 'true';
}

/**
 * Proxy a file stream and run cleanup only after every byte was consumed.
 * Cancelling or failing the response deliberately keeps the source file.
 */
export function streamWithSuccessfulDownloadCleanup(
	source: ReadableStream<Uint8Array>,
	cleanup: () => Promise<void>,
	signal?: AbortSignal,
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let sourceComplete = false;
	let cancelled = signal?.aborted ?? false;
	const markCancelled = () => {
		cancelled = true;
	};
	signal?.addEventListener('abort', markCancelled, { once: true });
	const detachAbortListener = () => {
		signal?.removeEventListener('abort', markCancelled);
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (!result.done) {
					controller.enqueue(result.value);
					return;
				}
				sourceComplete = true;
				if (!cancelled && !signal?.aborted) {
					try {
						await cleanup();
					} catch (error) {
						console.error('Post-download cleanup failed:', error);
					}
				}
				detachAbortListener();
				controller.close();
			} catch (error) {
				detachAbortListener();
				controller.error(error);
			}
		},
		async cancel(reason) {
			cancelled = true;
			detachAbortListener();
			if (!sourceComplete) await reader.cancel(reason);
		},
	});
}
