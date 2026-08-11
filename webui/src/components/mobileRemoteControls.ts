export type MobileTouch = {
	identifier: number;
	clientX: number;
	clientY: number;
};

type MobileRemoteControlOptions = {
	getZoom: () => number;
	moveTolerance: number;
	longPressMs: number;
	schedule: (callback: () => void, delay: number) => () => void;
	movePointerBy: (deltaX: number, deltaY: number) => void;
	click: (button: 0 | 2) => void;
	panBy: (deltaX: number, deltaY: number) => void;
	setPanning: (active: boolean) => void;
	zoomBy: (deltaY: number, anchorX: number, anchorY: number) => void;
	setZooming: (active: boolean) => void;
};

type TouchSession = {
	identifier: number;
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	moved: boolean;
	longPressed: boolean;
	zooming: boolean;
	multiple: boolean;
	cancelHold: (() => void) | null;
};

const centerOfFirstTwoTouches = (touches: readonly MobileTouch[]) => {
	if (touches.length < 2) return null;
	return {
		x: (touches[0].clientX + touches[1].clientX) / 2,
		y: (touches[0].clientY + touches[1].clientY) / 2,
	};
};

export function createMobileRemoteControls({
	getZoom,
	moveTolerance,
	longPressMs,
	schedule,
	movePointerBy,
	click,
	panBy,
	setPanning,
	zoomBy,
	setZooming,
}: MobileRemoteControlOptions) {
	let session: TouchSession | null = null;
	let panCenter: { x: number; y: number } | null = null;

	const cancelHold = () => {
		session?.cancelHold?.();
		if (session) session.cancelHold = null;
	};

	const finishPan = () => {
		panCenter = null;
		setPanning(false);
	};

	const finishZoom = () => {
		if (!session?.zooming) return;
		session.zooming = false;
		setZooming(false);
	};

	const startSingleTouch = (touch: MobileTouch, moved = false) => {
		session = {
			identifier: touch.identifier,
			startX: touch.clientX,
			startY: touch.clientY,
			lastX: touch.clientX,
			lastY: touch.clientY,
			moved,
			longPressed: false,
			zooming: false,
			multiple: false,
			cancelHold: null,
		};
		if (moved) return;
		session.cancelHold = schedule(() => {
			if (!session || session.moved || session.multiple) return;
			session.longPressed = true;
		}, longPressMs);
	};

	return {
		start(touches: readonly MobileTouch[]) {
			if (touches.length >= 2) {
				if (session) session.multiple = true;
				cancelHold();
				panCenter = centerOfFirstTwoTouches(touches);
				setPanning(getZoom() > 1);
				return;
			}
			if (touches[0]) startSingleTouch(touches[0]);
		},

		move(touches: readonly MobileTouch[]) {
			if (touches.length >= 2) {
				if (session) session.multiple = true;
				cancelHold();
				const nextCenter = centerOfFirstTwoTouches(touches);
				if (getZoom() > 1 && panCenter && nextCenter) {
					panBy(nextCenter.x - panCenter.x, nextCenter.y - panCenter.y);
				}
				panCenter = nextCenter;
				return;
			}

			if (!session || session.multiple) return;
			const touch = touches.find(
				(candidate) => candidate.identifier === session?.identifier,
			);
			if (!touch) return;
			const previousX = session.lastX;
			const previousY = session.lastY;
			session.lastX = touch.clientX;
			session.lastY = touch.clientY;
			let startedMoving = false;
			if (
				!session.moved &&
				Math.hypot(
					touch.clientX - session.startX,
					touch.clientY - session.startY,
				) > moveTolerance
			) {
				session.moved = true;
				startedMoving = true;
				if (session.longPressed) {
					session.zooming = true;
					setZooming(true);
				} else {
					cancelHold();
				}
			}
			if (!session.moved) return;
			if (session.zooming) {
				zoomBy(
					(startedMoving ? session.startY : previousY) - touch.clientY,
					session.startX,
					session.startY,
				);
				return;
			}
			movePointerBy(
				touch.clientX - (startedMoving ? session.startX : previousX),
				touch.clientY - (startedMoving ? session.startY : previousY),
			);
		},

		end(
			touches: readonly MobileTouch[],
			_changedTouches: readonly MobileTouch[],
		) {
			if (touches.length > 0) {
				if (touches.length < 2) {
					finishPan();
					if (touches[0]) {
						startSingleTouch(touches[0], true);
					}
				}
				return;
			}

			cancelHold();
			finishPan();
			finishZoom();
			if (session && !session.moved && !session.multiple) {
				click(session.longPressed ? 2 : 0);
			}
			session = null;
		},

		cancel() {
			cancelHold();
			finishPan();
			finishZoom();
			session = null;
		},
	};
}
