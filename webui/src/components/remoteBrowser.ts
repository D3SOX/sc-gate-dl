const PASSWORD_KEY_PREFIX = 'sc-gate-dl-vnc-password:';
export const REMOTE_POINTER_RELEASE_EVENT = 'sc-gate-dl-release-remote-pointer';
const internalRemotePointerReleaseEvents = new WeakSet<Event>();

export type RemotePointer = { x: number; y: number };
export type RemoteCanvasBounds = {
	left: number;
	top: number;
	width: number;
	height: number;
};

const clampUnit = (value: number) => Math.min(Math.max(value, 0), 1);

export function normalizedRemotePointer(
	client: RemotePointer,
	bounds: RemoteCanvasBounds,
): RemotePointer {
	return {
		x: bounds.width ? clampUnit((client.x - bounds.left) / bounds.width) : 0.5,
		y: bounds.height ? clampUnit((client.y - bounds.top) / bounds.height) : 0.5,
	};
}

export function remotePointerClientPosition(
	pointer: RemotePointer | null,
	bounds: RemoteCanvasBounds,
): RemotePointer {
	const normalized = pointer ?? { x: 0.5, y: 0.5 };
	return {
		x:
			bounds.left +
			Math.min(
				clampUnit(normalized.x) * bounds.width,
				Math.max(0, bounds.width - 1),
			),
		y:
			bounds.top +
			Math.min(
				clampUnit(normalized.y) * bounds.height,
				Math.max(0, bounds.height - 1),
			),
	};
}

export function markInternalRemotePointerRelease<T extends Event>(event: T): T {
	internalRemotePointerReleaseEvents.add(event);
	return event;
}

export function shouldBlockRemoteMouseEvent(
	event: Event,
	interactionActive: boolean,
	suppressRemoteClick: boolean,
): boolean {
	return (
		!internalRemotePointerReleaseEvents.has(event) &&
		(interactionActive || suppressRemoteClick)
	);
}

export function browserViewWebSocketUrl(browserViewUrl: string): string {
	const url = new URL(browserViewUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

	const configuredPath = url.searchParams.get('path')?.replace(/^\/+/, '');
	const basePath = url.pathname.replace(/\/(?:vnc\.html)?$/, '');
	url.pathname = `${basePath}/${configuredPath || 'websockify'}`;
	url.search = '';
	url.hash = '';
	return url.href;
}

export function browserPasswordStorageKey(browserViewUrl: string): string {
	return `${PASSWORD_KEY_PREFIX}${browserViewWebSocketUrl(browserViewUrl)}`;
}

export function browserRememberStorageKey(browserViewUrl: string): string {
	return `${browserPasswordStorageKey(browserViewUrl)}:remember`;
}
