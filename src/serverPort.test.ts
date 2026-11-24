import { describe, expect, test } from 'bun:test';
import { spawn } from 'bun';

async function startWithPort(value: string | undefined) {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		SC_COMMENT: 'test-comment',
	};
	if (value === undefined) delete env.SC_GATE_DL_PORT;
	else env.SC_GATE_DL_PORT = value;
	const proc = spawn(['bun', 'run', './src/server.ts'], {
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const timer = setTimeout(() => proc.kill(), 8_000);
	const [stderr, exitCode] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stderr, exitCode };
}

describe('SC_GATE_DL_PORT validation', () => {
	test.each(['abc', '3.5', '-1', '65536', ' ', '0'])(
		'rejects the invalid value %p at startup and names the setting',
		async (value) => {
			const { stderr, exitCode } = await startWithPort(value);
			expect(exitCode).not.toBe(0);
			expect(stderr).toContain('SC_GATE_DL_PORT');
		},
		15_000,
	);
});

describe('SC_GATE_DL_PORT selects the listening port', () => {
	async function freePort(): Promise<number> {
		const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
		const port = probe.port ?? 0;
		probe.stop(true);
		return port;
	}

	test('listens on the configured valid port', async () => {
		const port = await freePort();
		const proc = spawn(['bun', 'run', './src/server.ts'], {
			env: {
				...(process.env as Record<string, string>),
				SC_COMMENT: 'test-comment',
				SC_GATE_DL_PORT: String(port),
			},
			stdout: 'ignore',
			stderr: 'ignore',
		});
		try {
			let response: Response | undefined;
			for (let attempt = 0; attempt < 100 && !response; attempt += 1) {
				response = await fetch(`http://127.0.0.1:${port}/`).catch(
					() => undefined,
				);
				if (!response) await Bun.sleep(100);
			}
			expect(response).toBeDefined();
		} finally {
			proc.kill();
			await proc.exited;
		}
	}, 20_000);
});

describe('SC_GATE_DL_PORT default', () => {
	test('listens on port 3000 when the setting is absent', async () => {
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			SC_COMMENT: 'test-comment',
		};
		delete env.SC_GATE_DL_PORT;
		const proc = spawn(['bun', 'run', './src/server.ts'], {
			env,
			stdout: 'ignore',
			stderr: 'ignore',
		});
		try {
			let response: Response | undefined;
			for (let attempt = 0; attempt < 100 && !response; attempt += 1) {
				response = await fetch('http://127.0.0.1:3000/').catch(() => undefined);
				if (!response) await Bun.sleep(100);
			}
			expect(response).toBeDefined();
		} finally {
			proc.kill();
			await proc.exited;
		}
	}, 20_000);
});
