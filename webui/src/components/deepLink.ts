export function shouldAutoStartDeepLink(
	browserModeHydrated: boolean,
	alreadyStarted: boolean,
	queryUrl: string | null,
): queryUrl is string {
	return browserModeHydrated && !alreadyStarted && Boolean(queryUrl);
}
