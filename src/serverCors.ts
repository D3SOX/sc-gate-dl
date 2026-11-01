const DEFAULT_ALLOWED_ORIGINS = new Set([
	'https://soundcloud.com',
	'https://www.soundcloud.com',
	'https://m.soundcloud.com',
	'http://localhost:4321',
	'http://127.0.0.1:4321',
	'http://localhost:3000',
	'http://127.0.0.1:3000',
]);

function configuredOrigins(value?: string): Set<string> {
	return new Set(
		(value ?? '')
			.split(',')
			.map((origin) => origin.trim().replace(/\/$/, ''))
			.filter(Boolean),
	);
}

export function isAllowedCorsOrigin(
	requestUrl: string,
	origin: string,
	extraOrigins = process.env.SC_GATE_DL_ALLOWED_ORIGINS,
): boolean {
	if (
		DEFAULT_ALLOWED_ORIGINS.has(origin) ||
		configuredOrigins(extraOrigins).has(origin)
	) {
		return true;
	}

	try {
		const request = new URL(requestUrl);
		const candidate = new URL(origin);
		return (
			(candidate.protocol === 'http:' || candidate.protocol === 'https:') &&
			candidate.hostname === request.hostname &&
			candidate.port === '4321'
		);
	} catch {
		return false;
	}
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CORS only hides responses; browsers still deliver simple cross-site POSTs.
 * Reject state-changing requests from browser origins outside the allowlist.
 * Requests without an Origin header come from non-browser clients.
 */
export function isForbiddenCrossOriginRequest(req: Request): boolean {
	const origin = req.headers.get('Origin');
	return (
		!SAFE_METHODS.has(req.method) &&
		origin !== null &&
		origin !== new URL(req.url).origin &&
		!isAllowedCorsOrigin(req.url, origin)
	);
}
