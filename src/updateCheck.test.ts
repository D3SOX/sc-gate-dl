import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkServerVersion, readHeadCommit } from './updateCheck';

async function git(dir: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(
		[
			'git',
			'-C',
			dir,
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.com',
			'-c',
			'commit.gpgsign=false',
			...args,
		],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
	return stdout.trim();
}

async function commit(dir: string, message: string): Promise<string> {
	await git(dir, 'commit', '--allow-empty', '-m', message);
	return git(dir, 'rev-parse', 'HEAD');
}

describe('checkServerVersion', () => {
	let root: string;
	let upstream: string;
	let checkout: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), 'update-check-'));
		upstream = join(root, 'upstream');
		checkout = join(root, 'checkout');
		await git(root, 'init', '--initial-branch=master', upstream);
		await commit(upstream, 'first');
		await git(root, 'clone', upstream, checkout);
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('is up to date on the latest commit', async () => {
		const head = await readHeadCommit(checkout);
		expect(await checkServerVersion(head, checkout)).toEqual({
			commit: head,
			latestCommit: head,
			outdated: false,
		});
	});

	test('treats local commits on top of the latest one as up to date', async () => {
		const local = await commit(checkout, 'local');
		const version = await checkServerVersion(local, checkout);
		expect(version.outdated).toBeFalse();
		await git(checkout, 'reset', '--hard', 'HEAD~1');
	});

	test('is outdated when origin has a commit the checkout lacks', async () => {
		const head = await readHeadCommit(checkout);
		const latest = await commit(upstream, 'second');
		expect(await checkServerVersion(head, checkout)).toEqual({
			commit: head,
			latestCommit: latest,
			outdated: true,
		});
	});

	test('stays outdated after a pull without a restart', async () => {
		const running = await readHeadCommit(checkout);
		await git(checkout, 'pull', '--ff-only');
		const version = await checkServerVersion(running, checkout);
		expect(version.outdated).toBeTrue();
		expect(version.latestCommit).toBe(await readHeadCommit(checkout));
	});

	test('reports nothing outside a Git checkout', async () => {
		expect(await readHeadCommit(root)).toBeNull();
		expect(await checkServerVersion(null, root)).toEqual({
			commit: null,
			latestCommit: null,
			outdated: false,
		});
	});
});
