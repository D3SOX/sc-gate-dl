import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

const BLOCKED_IPV4_SUBNETS: [string, number][] = [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10], // CGNAT
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15], // benchmarking
	['224.0.0.0', 4], // multicast
	['240.0.0.0', 4], // reserved and broadcast
];

const blockedAddresses = new BlockList();
blockedAddresses.addAddress('::', 'ipv6');
blockedAddresses.addAddress('::1', 'ipv6');
blockedAddresses.addSubnet('fc00::', 7, 'ipv6'); // ULA
blockedAddresses.addSubnet('fe80::', 10, 'ipv6'); // link-local
blockedAddresses.addSubnet('ff00::', 8, 'ipv6'); // multicast
blockedAddresses.addSubnet('64:ff9b:1::', 48, 'ipv6'); // local-use NAT64
for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) {
	blockedAddresses.addSubnet(network, prefix, 'ipv4');
	// URL parsing rewrites embedded IPv4 to hex (`::ffff:7f00:1`), so block the
	// IPv4-mapped, IPv4-compatible and NAT64 forms of each range as well.
	const [a = 0, b = 0, c = 0, d = 0] = network.split('.').map(Number);
	const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	for (const embedPrefix of ['::ffff:', '::', '64:ff9b::']) {
		blockedAddresses.addSubnet(`${embedPrefix}${hex}`, 96 + prefix, 'ipv6');
	}
}

function isPrivateOrLocalIp(ip: string): boolean {
	const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
	const family = isIP(normalized);
	if (family === 0) return true;
	return blockedAddresses.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

function isBlockedHostname(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '');
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

	// URL.hostname is usually unbracketed for IPv6, but strip defensively so
	// isIP / blocklist / connect address never see "[::1]".
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (isBlockedHostname(host)) {
		throw new Error(`Refusing to fetch non-public host: ${host}`);
	}

	if (isIP(host) !== 0) {
		if (isPrivateOrLocalIp(host)) {
			throw new Error(`Refusing to fetch private/local address: ${host}`);
		}
		return { url, address: host };
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
							// Pause the socket when the consumer is behind so progress
							// callbacks can run against live download progress.
							if (
								controller.desiredSize !== null &&
								controller.desiredSize <= 0
							) {
								res.pause();
							}
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
					pull() {
						res.resume();
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
