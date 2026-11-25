import { dlopen, FFIType, type Pointer, ptr } from 'bun:ffi';
import { timeout } from './utils';

/**
 * Pointer input through the X server (XTest), the same path a real mouse
 * takes: the browser gets ordinary OS events and no automation is attached.
 * Works on X11 displays, such as the Xvfb of the remote browser stack.
 */

export interface Point {
	x: number;
	y: number;
}

type X11 = ReturnType<typeof loadX11>;

function loadX11() {
	const x11 = dlopen('libX11.so.6', {
		XOpenDisplay: { args: [FFIType.ptr], returns: FFIType.ptr },
		XCloseDisplay: { args: [FFIType.ptr], returns: FFIType.i32 },
		XFlush: { args: [FFIType.ptr], returns: FFIType.i32 },
		XDefaultRootWindow: { args: [FFIType.ptr], returns: FFIType.u64 },
		XQueryPointer: {
			args: [
				FFIType.ptr,
				FFIType.u64,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
			],
			returns: FFIType.i32,
		},
	});
	const xtst = dlopen('libXtst.so.6', {
		XTestFakeMotionEvent: {
			args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u64],
			returns: FFIType.i32,
		},
		XTestFakeButtonEvent: {
			args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u64],
			returns: FFIType.i32,
		},
	});
	return { ...x11.symbols, ...xtst.symbols };
}

let x11: X11 | null | undefined;

/**
 * Copies a variable into the C environment, where native libraries read it.
 * Values Bun loads from `.env` only reach `process.env`.
 */
export function exportToNativeEnv(name: string): void {
	const value = process.env[name];
	if (process.platform !== 'linux' || value === undefined) return;
	try {
		const { symbols } = dlopen('libc.so.6', {
			setenv: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		symbols.setenv(
			ptr(Buffer.from(`${name}\0`, 'utf8')),
			ptr(Buffer.from(`${value}\0`, 'utf8')),
			1,
		);
	} catch {
		// Not glibc; the variable keeps whatever the process started with.
	}
}

function x11Library(): X11 | null {
	if (x11 === undefined) {
		try {
			x11 = loadX11();
		} catch {
			x11 = null;
		}
	}
	return x11;
}

const random = (min: number, max: number) => min + Math.random() * (max - min);

export class X11Input {
	private constructor(
		private readonly lib: X11,
		private readonly display: Pointer,
	) {}

	/** Null without an X display or the X libraries. */
	static open(display = process.env.DISPLAY): X11Input | null {
		if (process.platform !== 'linux' || !display) return null;
		const lib = x11Library();
		exportToNativeEnv('XAUTHORITY');
		const handle = lib?.XOpenDisplay(ptr(Buffer.from(`${display}\0`, 'utf8')));
		return lib && handle ? new X11Input(lib, handle as Pointer) : null;
	}

	close(): void {
		this.lib.XCloseDisplay(this.display);
	}

	pointer(): Point {
		const ints = new Int32Array(4);
		const windows = new BigUint64Array(2);
		const mask = new Uint32Array(1);
		this.lib.XQueryPointer(
			this.display,
			this.lib.XDefaultRootWindow(this.display),
			ptr(windows),
			ptr(windows, 8),
			ptr(ints),
			ptr(ints, 4),
			ptr(ints, 8),
			ptr(ints, 12),
			ptr(mask),
		);
		return { x: ints[0] ?? 0, y: ints[1] ?? 0 };
	}

	private move({ x, y }: Point): void {
		this.lib.XTestFakeMotionEvent(
			this.display,
			-1,
			Math.round(x),
			Math.round(y),
			0,
		);
		this.lib.XFlush(this.display);
	}

	private button(down: boolean): void {
		this.lib.XTestFakeButtonEvent(this.display, 1, down ? 1 : 0, 0);
		this.lib.XFlush(this.display);
	}

	/** Moves along a slightly curved path with a slow start and end. */
	async moveTo(target: Point, durationMs = random(350, 700)): Promise<void> {
		const start = this.pointer();
		const bend = random(-0.15, 0.15);
		const started = Date.now();
		for (;;) {
			const t = Math.min(1, (Date.now() - started) / durationMs);
			const eased = t * t * (3 - 2 * t);
			const sideways = Math.sin(Math.PI * t) * bend;
			this.move({
				x:
					start.x +
					(target.x - start.x) * eased -
					(target.y - start.y) * sideways +
					random(-1, 1),
				y:
					start.y +
					(target.y - start.y) * eased +
					(target.x - start.x) * sideways +
					random(-1, 1),
			});
			if (t >= 1) break;
			await timeout(random(8, 20));
		}
		this.move(target);
	}

	async click(target: Point): Promise<void> {
		await this.moveTo(target);
		await timeout(random(80, 200));
		this.button(true);
		await timeout(random(60, 130));
		this.button(false);
	}

	/**
	 * Drags like a hand on a slider: speeds up, slows down, wobbles a little
	 * vertically, overshoots and settles on the target before letting go.
	 */
	async drag(from: Point, to: Point): Promise<void> {
		await this.moveTo(from);
		await timeout(random(150, 300));
		this.button(true);
		await timeout(random(100, 200));
		const duration = random(1_200, 2_000);
		const overshoot = random(4, 9);
		const phase = random(0, 2 * Math.PI);
		const wobble = random(1.5, 3.5);
		const started = Date.now();
		for (;;) {
			const t = (Date.now() - started) / duration;
			if (t >= 1) break;
			const eased = t - Math.sin(2 * Math.PI * t) / (2 * Math.PI);
			this.move({
				x: from.x + (to.x + overshoot - from.x) * eased,
				y:
					from.y +
					(to.y - from.y) * eased +
					wobble * Math.sin(phase + t * 3) +
					random(-0.6, 0.6),
			});
			// Now and then a hand pauses for a moment.
			await timeout(random(8, 20) + (Math.random() < 0.04 ? 50 : 0));
		}
		for (let step = 1; step <= 4; step++) {
			this.move({
				x: to.x + overshoot * (1 - step / 4),
				y: to.y + random(-1, 1),
			});
			await timeout(random(30, 60));
		}
		await timeout(random(150, 350));
		this.button(false);
	}
}
