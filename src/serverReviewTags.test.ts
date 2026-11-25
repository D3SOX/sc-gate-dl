import { describe, expect, test } from 'bun:test';
import { type Subprocess, spawn } from 'bun';

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
	const port = probe.port ?? 0;
	probe.stop(true);
	return port;
}

async function withServer<T>(
	reviewTags: string | undefined,
	run: (base: string) => Promise<T>,
): Promise<T> {
	const port = await freePort();
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		SC_COMMENT: 'test-comment',
		SC_GATE_DL_PORT: String(port),
	};
	delete env.SC_GATE_DL_REVIEW_TAGS;
	if (reviewTags !== undefined) env.SC_GATE_DL_REVIEW_TAGS = reviewTags;
	const proc: Subprocess = spawn(['bun', 'run', './src/server.ts'], {
		env,
		stdout: 'ignore',
		stderr: 'ignore',
	});
	try {
		const base = `http://127.0.0.1:${port}`;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				if ((await fetch(base)).ok) break;
			} catch {
				// not listening yet
			}
			await Bun.sleep(100);
		}
		return await run(base);
	} finally {
		proc.kill();
		await proc.exited;
	}
}

async function capabilities(base: string) {
	return (await (await fetch(`${base}/api/capabilities`)).json()) as {
		reviewTagsDefault?: boolean;
	};
}

describe('SC_GATE_DL_REVIEW_TAGS on the server', () => {
	test.each([
		[undefined, false],
		['false', false],
		[' TRUE ', true],
	])(
		'reports %p as reviewTagsDefault %p',
		async (value, expected) => {
			await withServer(value, async (base) => {
				expect((await capabilities(base)).reviewTagsDefault).toBe(expected);
			});
		},
		30_000,
	);

	test.each(['', 'maybe'])(
		'rejects %p at startup',
		async (value) => {
			const env: Record<string, string> = {
				...(process.env as Record<string, string>),
				SC_COMMENT: 'test-comment',
				SC_GATE_DL_PORT: String(await freePort()),
				SC_GATE_DL_REVIEW_TAGS: value,
			};
			const proc = spawn(['bun', 'run', './src/server.ts'], {
				env,
				stdout: 'ignore',
				stderr: 'pipe',
			});
			const timer = setTimeout(() => proc.kill(), 8_000);
			const [stderr, code] = await Promise.all([
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			clearTimeout(timer);
			expect(code).not.toBe(0);
			expect(stderr).toContain('SC_GATE_DL_REVIEW_TAGS');
		},
		20_000,
	);
});
