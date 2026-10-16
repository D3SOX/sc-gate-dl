import type { ElementHandle, Page } from 'puppeteer';

/** Visit the popup from this action without matching unrelated tabs by URL. */
export async function visitSocialPopup(
	page: Page,
	button: ElementHandle<Element>,
): Promise<boolean> {
	let receivePopup!: (popup: Page | null) => void;
	const opened = new Promise<Page | null>((resolve) => {
		receivePopup = resolve;
	});
	const onPopup = (popup: Page | null) => receivePopup(popup);
	page.once('popup', onPopup);
	const timer = setTimeout(() => receivePopup(null), 5_000);
	try {
		await button.evaluate((element) => {
			if (!(element instanceof HTMLElement) || !element.checkVisibility())
				throw new Error('Social visit button is not visible.');
			element.click();
		});
		const popup = await opened;
		if (!popup) return false;
		// The target may initially be blank or redirect to Instagram's login page.
		// A slow external page must not leave its popup hanging around indefinitely.
		await popup
			.waitForFunction(
				() =>
					location.href !== 'about:blank' && document.readyState !== 'loading',
				{ timeout: 5_000 },
			)
			.catch(() => {});
		if (!popup.isClosed()) await popup.close();
		await page.bringToFront();
		return true;
	} finally {
		clearTimeout(timer);
		page.off('popup', onPopup);
	}
}
