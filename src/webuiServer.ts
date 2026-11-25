import { resolve, sep } from 'node:path';

const WEBUI_PORT = 4321;
const DIST_DIR = resolve(import.meta.dir, '../webui/dist');

// The userscript embeds the Web UI on soundcloud.com, which Chrome treats as
// a public page loading a private-network one.
const BASE_HEADERS = { 'Access-Control-Allow-Private-Network': 'true' };

/** Serves the built Web UI from `distDir`, like Astro's static hosting. */
export function createWebuiHandler(distDir = DIST_DIR) {
	const root = resolve(distDir);
	return async (request: Request): Promise<Response> => {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: BASE_HEADERS });
		}
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: { ...BASE_HEADERS, Allow: 'GET, HEAD, OPTIONS' },
			});
		}

		let pathname: string;
		try {
			pathname = decodeURIComponent(new URL(request.url).pathname);
		} catch {
			return new Response('Bad Request', {
				status: 400,
				headers: BASE_HEADERS,
			});
		}
		if (pathname.endsWith('/')) pathname += 'index.html';
		const path = resolve(root, `.${pathname}`);
		const file = Bun.file(path);
		if (!path.startsWith(root + sep) || !(await file.exists())) {
			return new Response('Not Found', { status: 404, headers: BASE_HEADERS });
		}

		// Astro puts a content hash in every file name under /_astro/.
		const cacheControl = pathname.startsWith('/_astro/')
			? 'public, max-age=31536000, immutable'
			: 'no-cache';
		return new Response(request.method === 'HEAD' ? null : file, {
			headers: {
				...BASE_HEADERS,
				'Cache-Control': cacheControl,
				'Content-Type': file.type,
				'Content-Length': String(file.size),
			},
		});
	};
}

if (import.meta.main) {
	if (!(await Bun.file(resolve(DIST_DIR, 'index.html')).exists())) {
		console.error(
			`No Web UI build in ${DIST_DIR}. Run "bun run build:webui" first.`,
		);
		process.exit(1);
	}
	const server = Bun.serve({ port: WEBUI_PORT, fetch: createWebuiHandler() });
	console.log(`Web UI is running on ${server.url}`);
}
