import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
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

export type SafeConnectTarget = {
	url: URL;
	/** Validated public address used for the TCP connection. */
	address: string;
};

/**
 * Resolve a URL to a public connect address. Rejects private/local hosts and
 * DNS answers that only resolve to private/local IPs.
 */
export async function resolveSafeConnectTarget(
	urlString: string,
): Promise<SafeConnectTarget> {
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
		return { url, address: host.replace(/^\[|\]$/g, '') };
	}

	const results = await lookup(host, { all: true });
	const publicAddrs = results.filter((r) => !isPrivateOrLocalIp(r.address));
	const chosen = publicAddrs[0];
	if (!chosen) {
		const sample = results[0]?.address ?? 'none';
		throw new Error(
			`Refusing to fetch host ${host} (resolves to private/local address ${sample})`,
		);
	}
	return { url, address: chosen.address };
}

/** @deprecated Prefer resolveSafeConnectTarget / safeFetch */
export async function assertSafeOutboundUrl(urlString: string): Promise<void> {
	await resolveSafeConnectTarget(urlString);
}

export type SafeFetchInit = {
	method?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
};

export type SafeFetchResult = {
	response: Response;
	/** Request URL (redirects are not followed). */
	url: string;
};

/**
 * Fetch via a validated public IP while keeping Host + TLS SNI as the original
 * hostname, so DNS TOCTOU cannot redirect the TCP connection to a private IP.
 * Redirects are never followed — callers must validate each Location hop.
 */
export async function safeFetch(
	urlString: string,
	init: SafeFetchInit = {},
): Promise<SafeFetchResult> {
	const { url, address } = await resolveSafeConnectTarget(urlString);
	const isHttps = url.protocol === 'https:';
	const transport = isHttps ? https : http;
	const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
	const path = `${url.pathname}${url.search}`;
	const headers: Record<string, string> = {
		...(init.headers ?? {}),
		host: url.host,
	};

	return await new Promise<SafeFetchResult>((resolve, reject) => {
		const req = transport.request(
			{
				hostname: address,
				port,
				path,
				method: init.method ?? 'GET',
				headers,
				servername: isHttps ? url.hostname : undefined,
				signal: init.signal,
			},
			(res) => {
				const responseHeaders = new Headers();
				for (const [key, value] of Object.entries(res.headers)) {
					if (value === undefined) continue;
					if (Array.isArray(value)) {
						for (const item of value) responseHeaders.append(key, item);
					} else {
						responseHeaders.set(key, value);
					}
				}

				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						res.on('data', (chunk: Buffer | string) => {
							const bytes =
								typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
							controller.enqueue(new Uint8Array(bytes));
						});
						res.on('end', () => {
							try {
								controller.close();
							} catch {
								// already closed
							}
						});
						res.on('error', (err) => controller.error(err));
					},
					cancel() {
						res.destroy();
					},
				});

				resolve({
					url: url.toString(),
					response: new Response(body, {
						status: res.statusCode ?? 0,
						statusText: res.statusMessage,
						headers: responseHeaders,
					}),
				});
			},
		);

		req.on('error', reject);
		req.end();
	});
}
