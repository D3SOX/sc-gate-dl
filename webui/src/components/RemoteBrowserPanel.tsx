import type RFB from '@novnc/novnc';
import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import {
	browserPasswordStorageKey,
	browserRememberStorageKey,
	browserViewWebSocketUrl,
} from './remoteBrowser';
import {
	clampPanelGeometry,
	DEFAULT_PANEL_CHROME_HEIGHT,
	DEFAULT_REMOTE_ASPECT_RATIO,
	defaultPanelGeometry,
	maximizedPanelGeometry,
	movePanelGeometry,
	parseStoredPanelGeometry,
	type ResizeEdges,
	resizePanelGeometry,
	restorePanelGeometryForDrag,
} from './remoteBrowserGeometry';
import './RemoteBrowserPanel.css';

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

type RemoteBrowserPanelProps = {
	open: boolean;
	viewUrl: string;
	onOpen: () => void;
	onClose: () => void;
};

const GEOMETRY_STORAGE_KEY = 'sc-gate-dl-vnc-panel-geometry-v2';
const initialGeometry = { x: 420, y: 68, width: 760, height: 560 };
const MIN_ZOOM = 1;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;
const FINE_ZOOM_STEP = 0.05;
const ZOOM_DRAG_PER_PIXEL = FINE_ZOOM_STEP / 20;
const TOUCH_ZOOM_HOLD_MS = 450;
const TOUCH_HOLD_MOVE_TOLERANCE = 8;

type ZoomAnchor = {
	x: number;
	y: number;
	scrollLeft: number;
	scrollTop: number;
	previousZoom: number;
};

const viewport = () => ({
	width: window.innerWidth,
	height: window.innerHeight,
});

export function RemoteBrowserPanel({
	open,
	viewUrl,
	onOpen,
	onClose,
}: RemoteBrowserPanelProps) {
	const screenRef = useRef<HTMLDivElement>(null);
	const screenContainerRef = useRef<HTMLDivElement>(null);
	const toolbarRef = useRef<HTMLElement>(null);
	const rfbRef = useRef<RFB | null>(null);
	const activeViewUrlRef = useRef(viewUrl);
	const connectionGenerationRef = useRef(0);
	const aspectRatioRef = useRef(DEFAULT_REMOTE_ASPECT_RATIO);
	const remoteSizeRef = useRef({ width: 1280, height: 720 });
	const chromeHeightRef = useRef(DEFAULT_PANEL_CHROME_HEIGHT);
	const hasStoredGeometryRef = useRef(false);
	const geometryRef = useRef(initialGeometry);
	const restoredGeometryRef = useRef(initialGeometry);
	const maximizedRef = useRef(false);
	const remotePointerPositionRef = useRef<{ x: number; y: number } | null>(
		null,
	);
	const viewportInteractionRef = useRef<'pan' | 'zoom' | null>(null);
	const suppressRemoteClickRef = useRef(false);
	const zoomRef = useRef(1);
	const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
	const [geometry, setGeometry] = useState(initialGeometry);
	const [maximized, setMaximized] = useState(false);
	const [zoom, setZoom] = useState(1);
	const [shiftHeld, setShiftHeld] = useState(false);
	const [altHeld, setAltHeld] = useState(false);
	const [clipboardOpen, setClipboardOpen] = useState(false);
	const [clipboardText, setClipboardText] = useState('');
	const [clipboardError, setClipboardError] = useState<string | null>(null);
	const [password, setPassword] = useState('');
	const [remember, setRemember] = useState(true);
	const [status, setStatus] = useState<ConnectionStatus>('idle');
	const [error, setError] = useState<string | null>(null);

	const updateGeometry = useCallback((nextGeometry: typeof geometry) => {
		geometryRef.current = nextGeometry;
		setGeometry(nextGeometry);
	}, []);

	const rememberGeometry = useCallback(() => {
		try {
			localStorage.setItem(
				GEOMETRY_STORAGE_KEY,
				JSON.stringify(geometryRef.current),
			);
		} catch {
			// Storage may be unavailable in a restricted browser context.
		}
	}, []);

	const updateMaximized = useCallback((value: boolean) => {
		maximizedRef.current = value;
		setMaximized(value);
	}, []);

	const toggleMaximized = useCallback(() => {
		if (maximizedRef.current) {
			updateMaximized(false);
			updateGeometry(
				clampPanelGeometry(
					restoredGeometryRef.current,
					viewport(),
					aspectRatioRef.current,
					chromeHeightRef.current,
				),
			);
			return;
		}
		restoredGeometryRef.current = geometryRef.current;
		updateMaximized(true);
		updateGeometry(maximizedPanelGeometry(viewport()));
	}, [updateGeometry, updateMaximized]);

	useEffect(() => {
		const currentViewport = viewport();
		let restored = defaultPanelGeometry(currentViewport);
		try {
			const stored = localStorage.getItem(GEOMETRY_STORAGE_KEY);
			hasStoredGeometryRef.current = Boolean(stored);
			restored = parseStoredPanelGeometry(stored, currentViewport) ?? restored;
		} catch {
			// Storage may be unavailable in a restricted browser context.
		}
		updateGeometry(restored);
		restoredGeometryRef.current = restored;

		const handleResize = () => {
			if (maximizedRef.current) {
				updateGeometry(maximizedPanelGeometry(viewport()));
				return;
			}
			updateGeometry(
				clampPanelGeometry(
					geometryRef.current,
					viewport(),
					aspectRatioRef.current,
					chromeHeightRef.current,
				),
			);
			rememberGeometry();
		};
		window.addEventListener('resize', handleResize);
		return () => window.removeEventListener('resize', handleResize);
	}, [rememberGeometry, updateGeometry]);

	useEffect(() => {
		const toolbar = toolbarRef.current;
		if (!toolbar) return;
		const observer = new ResizeObserver(([entry]) => {
			const chromeHeight =
				entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
			if (!chromeHeight || chromeHeight === chromeHeightRef.current) return;
			chromeHeightRef.current = chromeHeight;
			if (maximizedRef.current) return;
			const adjusted = clampPanelGeometry(
				geometryRef.current,
				viewport(),
				aspectRatioRef.current,
				chromeHeight,
			);
			restoredGeometryRef.current = adjusted;
			updateGeometry(adjusted);
			rememberGeometry();
		});
		observer.observe(toolbar);
		return () => observer.disconnect();
	}, [rememberGeometry, updateGeometry]);

	const beginPointerInteraction = useCallback(
		(event: ReactPointerEvent, edges?: ResizeEdges) => {
			if (event.button !== 0) return;
			if (
				!edges &&
				event.target instanceof Element &&
				event.target.closest('button')
			) {
				return;
			}
			event.preventDefault();
			let start = geometryRef.current;
			let startX = event.clientX;
			let startY = event.clientY;
			let pendingMaximizedRestore = !edges && maximizedRef.current;
			const previousUserSelect = document.body.style.userSelect;
			document.body.style.userSelect = 'none';

			const handleMove = (moveEvent: PointerEvent) => {
				if (
					pendingMaximizedRestore &&
					Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 3
				) {
					start = restorePanelGeometryForDrag(
						restoredGeometryRef.current,
						{ x: moveEvent.clientX, y: moveEvent.clientY },
						viewport(),
						aspectRatioRef.current,
						chromeHeightRef.current,
					);
					startX = moveEvent.clientX;
					startY = moveEvent.clientY;
					pendingMaximizedRestore = false;
					updateMaximized(false);
					updateGeometry(start);
				}
				if (pendingMaximizedRestore) return;
				const deltaX = moveEvent.clientX - startX;
				const deltaY = moveEvent.clientY - startY;
				updateGeometry(
					edges
						? resizePanelGeometry(
								start,
								deltaX,
								deltaY,
								edges,
								viewport(),
								aspectRatioRef.current,
								chromeHeightRef.current,
							)
						: movePanelGeometry(
								start,
								deltaX,
								deltaY,
								viewport(),
								aspectRatioRef.current,
								chromeHeightRef.current,
							),
				);
			};
			const handleEnd = () => {
				document.body.style.userSelect = previousUserSelect;
				window.removeEventListener('pointermove', handleMove);
				window.removeEventListener('pointerup', handleEnd);
				window.removeEventListener('pointercancel', handleEnd);
				if (!maximizedRef.current) {
					restoredGeometryRef.current = geometryRef.current;
					rememberGeometry();
				}
			};

			window.addEventListener('pointermove', handleMove);
			window.addEventListener('pointerup', handleEnd);
			window.addEventListener('pointercancel', handleEnd);
		},
		[rememberGeometry, updateGeometry, updateMaximized],
	);

	const disconnect = useCallback(() => {
		connectionGenerationRef.current += 1;
		rfbRef.current?.disconnect();
		rfbRef.current = null;
	}, []);

	const connect = useCallback(
		async (credential: string, rememberCredential: boolean) => {
			const target = screenRef.current;
			if (!target || !credential) return;

			disconnect();
			const generation = connectionGenerationRef.current;
			setStatus('connecting');
			setError(null);

			try {
				const { default: RFBClient } = await import('@novnc/novnc');
				if (generation !== connectionGenerationRef.current) return;

				let authenticationFailed = false;
				const rfb = new RFBClient(target, browserViewWebSocketUrl(viewUrl), {
					credentials: { password: credential },
					shared: true,
				});
				rfb.scaleViewport = true;
				rfb.resizeSession = false;
				rfb.focusOnClick = true;
				rfb.background = '#0a0a0f';
				rfb.addEventListener('connect', () => {
					if (generation !== connectionGenerationRef.current) return;
					setStatus('connected');
					const canvas = target.querySelector('canvas');
					if (canvas?.width && canvas.height) {
						remoteSizeRef.current = {
							width: canvas.width,
							height: canvas.height,
						};
						aspectRatioRef.current = canvas.width / canvas.height;
						if (!maximizedRef.current && !hasStoredGeometryRef.current) {
							updateGeometry(
								defaultPanelGeometry(
									viewport(),
									canvas.width,
									canvas.height,
									chromeHeightRef.current,
								),
							);
						} else if (!maximizedRef.current) {
							updateGeometry(
								clampPanelGeometry(
									geometryRef.current,
									viewport(),
									aspectRatioRef.current,
									chromeHeightRef.current,
								),
							);
						}
					}
					try {
						if (rememberCredential) {
							localStorage.setItem(
								browserPasswordStorageKey(viewUrl),
								credential,
							);
						} else {
							localStorage.removeItem(browserPasswordStorageKey(viewUrl));
						}
					} catch {
						// Storage may be unavailable in a restricted browser context.
					}
				});
				rfb.addEventListener('securityfailure', () => {
					authenticationFailed = true;
					try {
						localStorage.removeItem(browserPasswordStorageKey(viewUrl));
					} catch {
						// Storage may be unavailable in a restricted browser context.
					}
					setStatus('error');
					setError('Authentication failed. Check the viewer password.');
				});
				rfb.addEventListener('disconnect', (disconnectEvent) => {
					if (generation !== connectionGenerationRef.current) return;
					if (rfbRef.current === rfb) rfbRef.current = null;
					const clean = (disconnectEvent as CustomEvent<{ clean?: boolean }>)
						.detail?.clean;
					if (authenticationFailed) return;
					if (clean) {
						setStatus('idle');
						return;
					}
					setStatus('error');
					setError('The remote browser connection closed.');
				});
				rfbRef.current = rfb;
			} catch (connectionError) {
				setStatus('error');
				setError(
					connectionError instanceof Error
						? connectionError.message
						: 'Could not connect to the remote browser.',
				);
			}
		},
		[disconnect, updateGeometry, viewUrl],
	);

	useEffect(() => {
		if (activeViewUrlRef.current === viewUrl) return;
		activeViewUrlRef.current = viewUrl;
		disconnect();
		setStatus('idle');
		setError(null);
	}, [disconnect, viewUrl]);

	useEffect(() => () => disconnect(), [disconnect]);

	useEffect(() => {
		const releaseRemotePointer = () => {
			const canvas = screenRef.current?.querySelector('canvas');
			const pointer = remotePointerPositionRef.current;
			if (!canvas || !pointer) return;
			window.dispatchEvent(
				new MouseEvent('mouseup', {
					bubbles: true,
					cancelable: true,
					view: window,
					button: 0,
					buttons: 0,
					clientX: pointer.x,
					clientY: pointer.y,
				}),
			);
		};
		window.addEventListener(
			'sc-gate-dl-release-remote-pointer',
			releaseRemotePointer,
		);
		window.addEventListener('blur', releaseRemotePointer);
		return () => {
			window.removeEventListener(
				'sc-gate-dl-release-remote-pointer',
				releaseRemotePointer,
			);
			window.removeEventListener('blur', releaseRemotePointer);
		};
	}, []);

	useEffect(() => {
		if (!open || rfbRef.current) return;

		let remembered = '';
		let rememberPreference = true;
		try {
			rememberPreference =
				localStorage.getItem(browserRememberStorageKey(viewUrl)) !== 'false';
			if (rememberPreference) {
				remembered =
					localStorage.getItem(browserPasswordStorageKey(viewUrl)) ?? '';
			}
		} catch {
			// Storage may be unavailable in a restricted browser context.
		}
		setPassword(remembered);
		setRemember(rememberPreference);
		if (remembered) void connect(remembered, true);
	}, [connect, open, viewUrl]);

	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
			setShiftHeld(event.shiftKey);
			setAltHeld(event.altKey);
		};
		const handleKeyUp = (event: KeyboardEvent) => {
			setShiftHeld(event.shiftKey);
			setAltHeld(event.altKey);
		};
		const clearModifiers = () => {
			setShiftHeld(false);
			setAltHeld(false);
		};
		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);
		window.addEventListener('blur', clearModifiers);
		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
			window.removeEventListener('blur', clearModifiers);
		};
	}, [onClose, open]);

	useLayoutEffect(() => {
		const screen = screenContainerRef.current;
		const anchor = zoomAnchorRef.current;
		if (!screen || !anchor) return;
		const ratio = zoom / anchor.previousZoom;
		screen.scrollLeft = (anchor.scrollLeft + anchor.x) * ratio - anchor.x;
		screen.scrollTop = (anchor.scrollTop + anchor.y) * ratio - anchor.y;
		zoomAnchorRef.current = null;
	}, [zoom]);

	const forgetPassword = () => {
		try {
			localStorage.removeItem(browserPasswordStorageKey(viewUrl));
			localStorage.setItem(browserRememberStorageKey(viewUrl), 'false');
		} catch {
			// Storage may be unavailable in a restricted browser context.
		}
		setPassword('');
		setRemember(false);
		disconnect();
		setStatus('idle');
		setError(null);
	};

	const updateRememberPreference = (value: boolean) => {
		setRemember(value);
		try {
			localStorage.setItem(browserRememberStorageKey(viewUrl), String(value));
			if (!value) {
				localStorage.removeItem(browserPasswordStorageKey(viewUrl));
			}
		} catch {
			// Keep the in-memory preference when storage is unavailable.
		}
	};

	const disconnectFromViewer = () => {
		disconnect();
		setStatus('idle');
		setError(null);
	};

	const sendClipboardText = (text: string) => {
		const rfb = rfbRef.current;
		if (!rfb || !text) return;
		rfb.clipboardPasteFrom(text);
		setClipboardText('');
		setClipboardError(null);
		setClipboardOpen(false);
		setTimeout(() => {
			if (rfbRef.current !== rfb) return;
			rfb.focus();
			rfb.sendKey(0xffe3, 'ControlLeft', true);
			rfb.sendKey(0x76, 'KeyV');
			rfb.sendKey(0xffe3, 'ControlLeft', false);
		}, 100);
	};

	const pasteIntoRemoteBrowser = async () => {
		if (!rfbRef.current) return;
		try {
			const text = await navigator.clipboard.readText();
			if (text) {
				sendClipboardText(text);
				return;
			}
			setClipboardError('The clipboard is empty.');
		} catch {
			setClipboardError(null);
		}
		setClipboardOpen(true);
	};

	const updateZoom = useCallback(
		(nextZoom: number, anchorPoint?: { x: number; y: number }) => {
			const screen = screenContainerRef.current;
			const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
			if (clampedZoom === zoomRef.current) return;
			if (screen) {
				zoomAnchorRef.current = {
					x: anchorPoint?.x ?? screen.clientWidth / 2,
					y: anchorPoint?.y ?? screen.clientHeight / 2,
					scrollLeft: screen.scrollLeft,
					scrollTop: screen.scrollTop,
					previousZoom: zoomRef.current,
				};
			}
			zoomRef.current = clampedZoom;
			setZoom(clampedZoom);
		},
		[],
	);

	useEffect(() => {
		const screen = screenContainerRef.current;
		if (!screen) return;

		const handleWheel = (event: WheelEvent) => {
			if (!event.altKey || event.deltaY === 0) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const bounds = screen.getBoundingClientRect();
			updateZoom(
				zoomRef.current + (event.deltaY < 0 ? FINE_ZOOM_STEP : -FINE_ZOOM_STEP),
				{
					x: event.clientX - bounds.left - screen.clientLeft,
					y: event.clientY - bounds.top - screen.clientTop,
				},
			);
		};
		const blockRemoteMouse = (event: MouseEvent) => {
			if (!viewportInteractionRef.current && !suppressRemoteClickRef.current) {
				return;
			}
			if (!viewportInteractionRef.current && event.type === 'mousedown') {
				suppressRemoteClickRef.current = false;
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.type === 'click') suppressRemoteClickRef.current = false;
		};

		screen.addEventListener('wheel', handleWheel, {
			capture: true,
			passive: false,
		});
		for (const type of [
			'mousedown',
			'mousemove',
			'mouseup',
			'click',
		] as const) {
			screen.addEventListener(type, blockRemoteMouse, true);
		}
		return () => {
			screen.removeEventListener('wheel', handleWheel, true);
			for (const type of [
				'mousedown',
				'mousemove',
				'mouseup',
				'click',
			] as const) {
				screen.removeEventListener(type, blockRemoteMouse, true);
			}
		};
	}, [updateZoom]);

	const resetBrowserView = () => {
		const canvas = screenRef.current?.querySelector('canvas');
		if (canvas?.width && canvas.height) {
			remoteSizeRef.current = { width: canvas.width, height: canvas.height };
			aspectRatioRef.current = canvas.width / canvas.height;
		}
		const nextGeometry = defaultPanelGeometry(
			viewport(),
			remoteSizeRef.current.width,
			remoteSizeRef.current.height,
			chromeHeightRef.current,
		);
		zoomAnchorRef.current = null;
		zoomRef.current = 1;
		setZoom(1);
		restoredGeometryRef.current = nextGeometry;
		if (maximizedRef.current) {
			updateGeometry(maximizedPanelGeometry(viewport()));
		} else {
			updateGeometry(nextGeometry);
			rememberGeometry();
		}
		requestAnimationFrame(() => screenContainerRef.current?.scrollTo(0, 0));
	};

	const beginViewportPan = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		const screen = screenContainerRef.current;
		if (!screen) return;
		event.preventDefault();
		event.stopPropagation();
		viewportInteractionRef.current = 'pan';
		suppressRemoteClickRef.current = true;
		const startX = event.clientX;
		const startY = event.clientY;
		const startScrollLeft = screen.scrollLeft;
		const startScrollTop = screen.scrollTop;
		screen.classList.add('is-panning');

		const handleMove = (moveEvent: PointerEvent) => {
			screen.scrollLeft = startScrollLeft - (moveEvent.clientX - startX);
			screen.scrollTop = startScrollTop - (moveEvent.clientY - startY);
		};
		const handleEnd = () => {
			viewportInteractionRef.current = null;
			screen.classList.remove('is-panning');
			window.removeEventListener('pointermove', handleMove);
			window.removeEventListener('pointerup', handleEnd);
			window.removeEventListener('pointercancel', handleEnd);
		};
		window.addEventListener('pointermove', handleMove);
		window.addEventListener('pointerup', handleEnd);
		window.addEventListener('pointercancel', handleEnd);
	};

	const beginViewportZoom = (
		event: ReactPointerEvent<HTMLDivElement>,
		delayed = false,
	) => {
		if (event.button !== 0 || !event.isPrimary) return;
		const screen = screenContainerRef.current;
		if (!screen) return;
		const startX = event.clientX;
		const startY = event.clientY;
		const startZoom = zoomRef.current;
		const bounds = screen.getBoundingClientRect();
		const anchor = {
			x: startX - bounds.left - screen.clientLeft,
			y: startY - bounds.top - screen.clientTop,
		};
		let zooming = !delayed;
		let holdTimer = 0;

		const activate = () => {
			zooming = true;
			viewportInteractionRef.current = 'zoom';
			suppressRemoteClickRef.current = true;
			screen.classList.add('is-zooming');
			if (delayed) {
				window.dispatchEvent(new Event('sc-gate-dl-release-remote-pointer'));
			}
		};

		if (delayed) {
			holdTimer = window.setTimeout(activate, TOUCH_ZOOM_HOLD_MS);
		} else {
			event.preventDefault();
			event.stopPropagation();
			activate();
		}

		const handleMove = (moveEvent: PointerEvent) => {
			if (!zooming) {
				if (
					Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >
					TOUCH_HOLD_MOVE_TOLERANCE
				) {
					window.clearTimeout(holdTimer);
				}
				return;
			}
			moveEvent.preventDefault();
			moveEvent.stopPropagation();
			const nextZoom =
				Math.round(
					(startZoom + (startY - moveEvent.clientY) * ZOOM_DRAG_PER_PIXEL) *
						100,
				) / 100;
			updateZoom(nextZoom, anchor);
		};
		const handleEnd = () => {
			window.clearTimeout(holdTimer);
			if (viewportInteractionRef.current === 'zoom') {
				viewportInteractionRef.current = null;
			}
			screen.classList.remove('is-zooming');
			window.removeEventListener('pointermove', handleMove);
			window.removeEventListener('pointerup', handleEnd);
			window.removeEventListener('pointercancel', handleEnd);
		};
		window.addEventListener('pointermove', handleMove);
		window.addEventListener('pointerup', handleEnd);
		window.addEventListener('pointercancel', handleEnd);
	};

	const beginViewportInteraction = (
		event: ReactPointerEvent<HTMLDivElement>,
	) => {
		if (event.shiftKey) {
			beginViewportPan(event);
			return;
		}
		if (event.altKey) {
			beginViewportZoom(event);
			return;
		}
		if (event.pointerType === 'touch') {
			beginViewportZoom(event, true);
		}
	};

	const launcherCenter = {
		x:
			typeof window === 'undefined'
				? geometry.x + geometry.width
				: window.innerWidth - 38,
		y: 38,
	};
	const panelStyle = {
		left: geometry.x,
		top: geometry.y,
		width: geometry.width,
		height: geometry.height,
		'--remote-browser-origin-x': `${launcherCenter.x - geometry.x}px`,
		'--remote-browser-origin-y': `${launcherCenter.y - geometry.y}px`,
		'--remote-browser-toolbar-height': `${chromeHeightRef.current}px`,
	} as CSSProperties;

	const resizeHandles: Array<{ className: string; edges: ResizeEdges }> = [
		{ className: 'north-east', edges: { north: true, east: true } },
		{ className: 'north-west', edges: { north: true, west: true } },
		{ className: 'south-east', edges: { south: true, east: true } },
		{ className: 'south-west', edges: { south: true, west: true } },
	];

	return (
		<>
			<button
				type="button"
				className={`remote-browser-launcher${open ? ' is-open' : ''}${maximized ? ' is-maximized' : ''}`}
				onClick={open ? onClose : onOpen}
				aria-expanded={open}
				aria-controls="remote-browser-panel"
				title={open ? 'Close remote browser' : 'Open remote browser'}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<rect x="3" y="4" width="18" height="13" rx="2" />
					<path d="M8 21h8M12 17v4" />
				</svg>
				<span className={`remote-browser-launcher-dot is-${status}`} />
			</button>

			<section
				id="remote-browser-panel"
				className={`remote-browser-panel${open ? ' is-open' : ''}${maximized ? ' is-maximized' : ''}`}
				style={panelStyle}
				role="dialog"
				aria-hidden={!open}
				inert={!open}
				aria-labelledby="remote-browser-title"
			>
				<header
					ref={toolbarRef}
					className="remote-browser-toolbar"
					role="toolbar"
					aria-label="Remote browser window controls"
					onPointerDown={(event) => beginPointerInteraction(event)}
					onDoubleClick={(event) => {
						if (
							event.target instanceof Element &&
							event.target.closest('button')
						) {
							return;
						}
						toggleMaximized();
					}}
				>
					<div className="remote-browser-toolbar-heading">
						<h2 id="remote-browser-title">Remote Browser</h2>
						<span
							className={`remote-browser-status is-${status}`}
							role="status"
							title={`Browser ${status}`}
							aria-label={`Browser ${status}`}
						>
							<span>{status}</span>
						</span>
					</div>
					<div className="remote-browser-toolbar-actions">
						<fieldset className="remote-browser-zoom" aria-label="Browser zoom">
							<button
								type="button"
								onClick={() => updateZoom(zoomRef.current - ZOOM_STEP)}
								disabled={zoom <= MIN_ZOOM}
								aria-label="Zoom out"
								title="Zoom out"
							>
								<svg viewBox="0 0 16 16" aria-hidden="true">
									<path d="M3 8h10" />
								</svg>
							</button>
							<button
								type="button"
								onClick={resetBrowserView}
								aria-label="Reset zoom"
								title="Reset zoom"
							>
								{Math.round(zoom * 100)}%
							</button>
							<button
								type="button"
								onClick={() => updateZoom(zoomRef.current + ZOOM_STEP)}
								disabled={zoom >= MAX_ZOOM}
								aria-label="Zoom in"
								title="Zoom in"
							>
								<svg viewBox="0 0 16 16" aria-hidden="true">
									<path d="M3 8h10M8 3v10" />
								</svg>
							</button>
						</fieldset>
						{status === 'connected' || status === 'connecting' ? (
							<button
								type="button"
								className="remote-browser-action-button"
								onClick={() => void pasteIntoRemoteBrowser()}
								disabled={status !== 'connected'}
								aria-label="Paste clipboard into remote browser"
								title="Paste clipboard into remote browser"
							>
								<svg viewBox="0 0 16 16" aria-hidden="true">
									<path d="M6 3.5h4M6 2h4v3H6zM4 3.5H3v10h10v-10h-1" />
								</svg>
								<span className="remote-browser-button-label">Paste</span>
							</button>
						) : null}
						{status === 'connected' || status === 'connecting' ? (
							<button
								type="button"
								className="remote-browser-action-button"
								onClick={disconnectFromViewer}
								aria-label="Disconnect remote browser"
								title="Disconnect"
							>
								<svg viewBox="0 0 16 16" aria-hidden="true">
									<path d="M8 2v5M4.5 4.5a5 5 0 1 0 7 0" />
								</svg>
								<span className="remote-browser-button-label">Disconnect</span>
							</button>
						) : null}
						{password ? (
							<button
								type="button"
								className="remote-browser-action-button"
								onClick={forgetPassword}
								aria-label="Forget viewer credentials"
								title="Forget credentials"
							>
								<svg viewBox="0 0 16 16" aria-hidden="true">
									<path d="M3.5 5h9M6 5V3.5h4V5m-5 0 .6 8h4.8l.6-8M7 7.5v3M9 7.5v3" />
								</svg>
								<span className="remote-browser-button-label">
									Forget credentials
								</span>
							</button>
						) : null}
						<button
							type="button"
							className="remote-browser-window-control"
							onClick={toggleMaximized}
							aria-label={
								maximized ? 'Restore browser window' : 'Maximize browser window'
							}
							title={maximized ? 'Restore' : 'Maximize'}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								{maximized ? (
									<>
										<rect x="3" y="5" width="8" height="8" />
										<path d="M5 5V3h8v8h-2" />
									</>
								) : (
									<rect x="2.5" y="2.5" width="11" height="11" />
								)}
							</svg>
						</button>
						<button
							type="button"
							className="remote-browser-window-control"
							onClick={onClose}
							aria-label="Close browser"
							title="Close"
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M3.5 3.5l9 9m0-9-9 9" />
							</svg>
						</button>
					</div>
				</header>

				{clipboardOpen ? (
					<form
						className="remote-browser-clipboard"
						onSubmit={(event) => {
							event.preventDefault();
							sendClipboardText(clipboardText);
						}}
					>
						<label htmlFor="remote-browser-clipboard-text">
							Paste text to send to the remote browser
						</label>
						<textarea
							id="remote-browser-clipboard-text"
							value={clipboardText}
							onChange={(event) => setClipboardText(event.target.value)}
						/>
						{clipboardError ? <p>{clipboardError}</p> : null}
						<div>
							<button
								type="submit"
								className="is-send"
								disabled={!clipboardText}
							>
								Send
							</button>
							<button
								type="button"
								className="is-cancel"
								onClick={() => setClipboardOpen(false)}
							>
								Cancel
							</button>
						</div>
					</form>
				) : null}

				<div
					className={`remote-browser-screen${shiftHeld ? ' is-shift-held' : ''}${altHeld ? ' is-alt-held' : ''}`}
					ref={screenContainerRef}
					title="Shift-drag to pan. Alt-scroll or Alt-drag vertically to zoom. Long-press and drag vertically on touch."
					onPointerDownCapture={(event) => {
						remotePointerPositionRef.current = {
							x: event.clientX,
							y: event.clientY,
						};
						beginViewportInteraction(event);
					}}
					onPointerMoveCapture={(event) => {
						remotePointerPositionRef.current = {
							x: event.clientX,
							y: event.clientY,
						};
					}}
				>
					<div
						className="remote-browser-viewport"
						ref={screenRef}
						style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
					/>
				</div>

				{status !== 'connected' ? (
					<form
						className="remote-browser-login"
						onSubmit={(event) => {
							event.preventDefault();
							void connect(password, remember);
						}}
					>
						<label htmlFor="remote-browser-password">Viewer password</label>
						<input
							id="remote-browser-password"
							type="password"
							autoComplete="current-password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							disabled={status === 'connecting'}
						/>
						<label className="checkbox-row">
							<input
								type="checkbox"
								checked={remember}
								onChange={(event) =>
									updateRememberPreference(event.target.checked)
								}
							/>
							<span>Remember on this device</span>
						</label>
						{error ? <p className="remote-browser-error">{error}</p> : null}
						<button
							type="submit"
							className="btn-primary"
							disabled={!password || status === 'connecting'}
						>
							{status === 'connecting' ? 'Connecting…' : 'Connect'}
						</button>
					</form>
				) : null}

				{!maximized &&
					resizeHandles.map((handle) => (
						<div
							key={handle.className}
							className={`remote-browser-resize-handle is-${handle.className}`}
							onPointerDown={(event) =>
								beginPointerInteraction(event, handle.edges)
							}
						/>
					))}
			</section>
		</>
	);
}
