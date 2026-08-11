export type PanelGeometry = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type PanelViewport = {
	width: number;
	height: number;
};

export type ResizeEdges = {
	north?: boolean;
	south?: boolean;
	east?: boolean;
	west?: boolean;
};

const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const VIEWPORT_GAP = 12;
const LAUNCHER_STACK_HEIGHT = 68;
export const DEFAULT_REMOTE_ASPECT_RATIO = 16 / 9;
export const DEFAULT_PANEL_CHROME_HEIGHT = 49;

const clamp = (value: number, minimum: number, maximum: number) =>
	Math.min(Math.max(value, minimum), maximum);

export function defaultPanelGeometry(
	viewport: PanelViewport,
	remoteWidth = 1280,
	remoteHeight = 720,
	chromeHeight = DEFAULT_PANEL_CHROME_HEIGHT,
): PanelGeometry {
	const aspectRatio = remoteWidth / remoteHeight;
	const maximumWidth = Math.max(0, viewport.width - VIEWPORT_GAP * 2);
	const maximumHeight = Math.max(
		0,
		viewport.height - LAUNCHER_STACK_HEIGHT - VIEWPORT_GAP,
	);
	const width = Math.min(
		remoteWidth,
		maximumWidth,
		Math.max(0, maximumHeight - chromeHeight) * aspectRatio,
	);
	const height = width / aspectRatio + chromeHeight;
	return {
		x: Math.max(VIEWPORT_GAP, viewport.width - width - VIEWPORT_GAP),
		y: LAUNCHER_STACK_HEIGHT,
		width,
		height,
	};
}

export function clampPanelGeometry(
	geometry: PanelGeometry,
	viewport: PanelViewport,
	aspectRatio = DEFAULT_REMOTE_ASPECT_RATIO,
	chromeHeight = DEFAULT_PANEL_CHROME_HEIGHT,
): PanelGeometry {
	const minimumWidth = Math.min(
		Math.max(MIN_WIDTH, (MIN_HEIGHT - chromeHeight) * aspectRatio),
		viewport.width,
	);
	const maximumWidth = Math.max(
		0,
		Math.min(viewport.width, (viewport.height - chromeHeight) * aspectRatio),
	);
	const width = clamp(
		geometry.width,
		Math.min(minimumWidth, maximumWidth),
		maximumWidth,
	);
	const height = width / aspectRatio + chromeHeight;
	return {
		x: clamp(geometry.x, 0, Math.max(0, viewport.width - width)),
		y: clamp(geometry.y, 0, Math.max(0, viewport.height - height)),
		width,
		height,
	};
}

export function movePanelGeometry(
	start: PanelGeometry,
	deltaX: number,
	deltaY: number,
	viewport: PanelViewport,
	aspectRatio = DEFAULT_REMOTE_ASPECT_RATIO,
	chromeHeight = DEFAULT_PANEL_CHROME_HEIGHT,
): PanelGeometry {
	return clampPanelGeometry(
		{ ...start, x: start.x + deltaX, y: start.y + deltaY },
		viewport,
		aspectRatio,
		chromeHeight,
	);
}

export function maximizedPanelGeometry(viewport: PanelViewport): PanelGeometry {
	return { x: 0, y: 0, width: viewport.width, height: viewport.height };
}

export function restorePanelGeometryForDrag(
	restored: PanelGeometry,
	pointer: { x: number; y: number },
	viewport: PanelViewport,
	aspectRatio = DEFAULT_REMOTE_ASPECT_RATIO,
	chromeHeight = DEFAULT_PANEL_CHROME_HEIGHT,
): PanelGeometry {
	const geometry = clampPanelGeometry(
		restored,
		viewport,
		aspectRatio,
		chromeHeight,
	);
	const horizontalPosition = viewport.width ? pointer.x / viewport.width : 0.5;
	return {
		...geometry,
		x: clamp(
			pointer.x - geometry.width * horizontalPosition,
			0,
			Math.max(0, viewport.width - geometry.width),
		),
		y: clamp(
			pointer.y - chromeHeight / 2,
			0,
			Math.max(0, viewport.height - geometry.height),
		),
	};
}

export function resizePanelGeometry(
	start: PanelGeometry,
	deltaX: number,
	deltaY: number,
	edges: ResizeEdges,
	viewport: PanelViewport,
	aspectRatio = DEFAULT_REMOTE_ASPECT_RATIO,
	chromeHeight = DEFAULT_PANEL_CHROME_HEIGHT,
): PanelGeometry {
	const horizontalWidth = start.width + (edges.west ? -deltaX : deltaX);
	const screenHeight = start.height - chromeHeight;
	const verticalScreenHeight = screenHeight + (edges.north ? -deltaY : deltaY);
	const widthFromHeight = verticalScreenHeight * aspectRatio;
	const requestedWidth =
		Math.abs(horizontalWidth - start.width) >=
		Math.abs(widthFromHeight - start.width)
			? horizontalWidth
			: widthFromHeight;
	const horizontalLimit = edges.west
		? start.x + start.width
		: viewport.width - start.x;
	const verticalLimit = edges.north
		? start.y + start.height
		: viewport.height - start.y;
	const maximumWidth = Math.min(
		horizontalLimit,
		Math.max(0, verticalLimit - chromeHeight) * aspectRatio,
	);
	const minimumWidth = Math.min(
		Math.max(MIN_WIDTH, (MIN_HEIGHT - chromeHeight) * aspectRatio),
		maximumWidth,
	);
	const width = clamp(requestedWidth, minimumWidth, maximumWidth);
	const height = width / aspectRatio + chromeHeight;
	const x = edges.west ? start.x + start.width - width : start.x;
	const y = edges.north ? start.y + start.height - height : start.y;

	return { x, y, width, height };
}

export function parseStoredPanelGeometry(
	value: string | null,
	viewport: PanelViewport,
	aspectRatio = DEFAULT_REMOTE_ASPECT_RATIO,
	chromeHeight = DEFAULT_PANEL_CHROME_HEIGHT,
): PanelGeometry | null {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object') return null;
		const candidate = parsed as Partial<PanelGeometry>;
		if (
			typeof candidate.x !== 'number' ||
			typeof candidate.y !== 'number' ||
			typeof candidate.width !== 'number' ||
			typeof candidate.height !== 'number'
		) {
			return null;
		}
		return clampPanelGeometry(
			candidate as PanelGeometry,
			viewport,
			aspectRatio,
			chromeHeight,
		);
	} catch {
		return null;
	}
}
