const PASSWORD_KEY_PREFIX = 'sc-gate-dl-vnc-password:';
export const REMOTE_POINTER_RELEASE_EVENT = 'sc-gate-dl-release-remote-pointer';

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
