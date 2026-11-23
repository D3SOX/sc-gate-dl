import { defaultCliDeps, runCli } from './cliRun';

try {
	await runCli(defaultCliDeps);
} catch (error) {
	if (error instanceof Error && error.name === 'ExitPromptError') {
		console.log('\nAborted by user.');
		process.exit(0);
	}
	throw error;
}
