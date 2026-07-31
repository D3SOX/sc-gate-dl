import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPrivateOrLocalIp(ip: string): boolean {
	const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');

	if (isIP(normalized) === 4) {
		const parts = normalized.split('.').map(Number);
		const a = parts[0] ?? 0;
		const b = parts[1] ?? 0;
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		return false;
	}

	if (isIP(normalized) === 6) {
		if (normalized === '::1' || normalized === '::') return true;
		if (normalized.startsWith('fe80:')) return true; // link-local
		if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
		// IPv4-mapped
		const v4mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (v4mapped?.[1]) return isPrivateOrLocalIp(v4mapped[1]);
		return false;
	}

	return true;
}

function isBlockedHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, '');
	if (
		host === 'localhost' ||
		host === '0.0.0.0' ||
		host === '::1' ||
		host === 'metadata.google.internal' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host.endsWith('.internal')
	) {
		return true;
	}
	return false;
}

/**
 * Reject non-http(s) URLs and destinations that resolve to private / local
 * addresses (basic SSRF guard for user-supplied and metadata-derived links).
 */
export async function assertSafeOutboundUrl(urlString: string): Promise<void> {
	let url: URL;
	try {
		url = new URL(urlString);
	} catch {
		throw new Error(`Invalid URL: ${urlString}`);
	}

	if (!/^https?:$/i.test(url.protocol)) {
		throw new Error(`Refusing non-http(s) URL: ${urlString}`);
	}

	const host = url.hostname;
	if (isBlockedHostname(host)) {
		throw new Error(`Refusing to fetch non-public host: ${host}`);
	}

	if (isIP(host) !== 0) {
		if (isPrivateOrLocalIp(host)) {
			throw new Error(`Refusing to fetch private/local address: ${host}`);
		}
		return;
	}

	const { address } = await lookup(host);
	if (isPrivateOrLocalIp(address)) {
		throw new Error(
			`Refusing to fetch host ${host} (resolves to private/local address ${address})`,
		);
	}
}
