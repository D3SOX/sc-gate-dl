declare module '@novnc/novnc' {
	export type RFBCredentials = {
		username?: string;
		password?: string;
		target?: string;
	};

	export type RFBOptions = {
		credentials?: RFBCredentials;
		shared?: boolean;
		repeaterID?: string;
		wsProtocols?: string[];
	};

	export default class RFB extends EventTarget {
		constructor(
			target: HTMLElement,
			urlOrChannel: string | WebSocket,
			options?: RFBOptions,
		);
		background: string;
		clipViewport: boolean;
		compressionLevel: number;
		focusOnClick: boolean;
		qualityLevel: number;
		resizeSession: boolean;
		scaleViewport: boolean;
		viewOnly: boolean;
		clipboardPasteFrom(text: string): void;
		disconnect(): void;
		focus(): void;
		sendKey(keysym: number, code: string, down?: boolean): void;
		sendCredentials(credentials: RFBCredentials): void;
	}
}
