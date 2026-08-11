/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import {
	defaultPanelGeometry,
	maximizedPanelGeometry,
	movePanelGeometry,
	parseStoredPanelGeometry,
	resizePanelGeometry,
	restorePanelGeometryForDrag,
} from './remoteBrowserGeometry';

const viewport = { width: 1200, height: 800 };

describe('remote browser panel geometry', () => {
	test('fits the native remote view below the top-right launcher', () => {
		const geometry = defaultPanelGeometry(viewport);
		expect(geometry.x).toBe(12);
		expect(geometry.y).toBe(68);
		expect(geometry.width).toBe(1176);
		expect(geometry.height).toBeCloseTo(710.5);
	});

	test('uses the native dimensions when they fit', () => {
		expect(defaultPanelGeometry({ width: 1920, height: 1080 })).toEqual({
			x: 628,
			y: 68,
			width: 1280,
			height: 769,
		});
	});

	test('keeps dragging inside the viewport', () => {
		expect(
			movePanelGeometry(
				{ x: 100, y: 100, width: 500, height: 400 },
				2000,
				-2000,
				viewport,
			),
		).toEqual({ x: 700, y: 0, width: 500, height: 330.25 });
	});

	test('maximizes to the viewport and restores under the drag pointer', () => {
		expect(maximizedPanelGeometry(viewport)).toEqual({
			x: 0,
			y: 0,
			width: 1200,
			height: 800,
		});
		expect(
			restorePanelGeometryForDrag(
				{ x: 700, y: 100, width: 500, height: 330.25 },
				{ x: 900, y: 24.5 },
				viewport,
			),
		).toEqual({ x: 525, y: 0, width: 500, height: 330.25 });
	});

	test('resizes from the north-west corner', () => {
		expect(
			resizePanelGeometry(
				{ x: 300, y: 200, width: 600, height: 386.5 },
				-100,
				-50,
				{ north: true, west: true },
				viewport,
			),
		).toEqual({ x: 200, y: 143.75, width: 700, height: 442.75 });
	});

	test('validates and clamps remembered geometry', () => {
		expect(
			parseStoredPanelGeometry(
				JSON.stringify({ x: 1100, y: 700, width: 500, height: 400 }),
				viewport,
			),
		).toEqual({ x: 700, y: 469.75, width: 500, height: 330.25 });
		expect(parseStoredPanelGeometry('{broken', viewport)).toBeNull();
	});

	test('accounts for a responsive two-line toolbar without side bars', () => {
		expect(
			parseStoredPanelGeometry(
				JSON.stringify({ x: 18, y: 19, width: 486, height: 322 }),
				{ width: 900, height: 900 },
				16 / 9,
				79,
			),
		).toEqual({ x: 18, y: 19, width: 486, height: 352.375 });
	});
});
