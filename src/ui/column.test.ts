import { describe, expect, it } from "vitest";
import { calcCardWidth, calcVisibleCount } from "./column.js";

describe("calcVisibleCount", () => {
	it("returns 1 for very small terminals (below threshold)", () => {
		// With HEADER_ROWS=8 and CARD_HEIGHT=7, terminals ≤15 rows yield 1
		expect(calcVisibleCount(8)).toBe(1);
		expect(calcVisibleCount(10)).toBe(1);
		expect(calcVisibleCount(15)).toBe(1);
	});

	it("returns correct count for a 24-row terminal", () => {
		// (24 - 8) / 7 = 16 / 7 = 2 cards
		expect(calcVisibleCount(24)).toBe(2);
	});

	it("returns correct count for a 40-row terminal", () => {
		// (40 - 8) / 7 = 32 / 7 = 4 cards
		expect(calcVisibleCount(40)).toBe(4);
	});

	it("returns correct count for a 60-row terminal", () => {
		// (60 - 8) / 7 = 52 / 7 = 7 cards
		expect(calcVisibleCount(60)).toBe(7);
	});

	it("never returns less than 1", () => {
		expect(calcVisibleCount(1)).toBe(1);
		expect(calcVisibleCount(0)).toBe(1);
	});

	it("returns more cards than HEADER_ROWS=4 would have allowed for the same terminal size", () => {
		// Old HEADER_ROWS=4: (40-4)/7 = 5 cards (overestimate → empty gap)
		// New HEADER_ROWS=8: (40-8)/7 = 4 cards (correct)
		const result = calcVisibleCount(40);
		// Ensure we are not over-counting compared to the old (buggy) behaviour
		expect(result).toBeLessThan(Math.floor((40 - 4) / 7));
	});
});

describe("calcCardWidth", () => {
	it("returns minimum of 1 for very narrow terminals", () => {
		// (40 - 28) / 3 - 9 = 4 - 9 < 0, clamp to 1
		expect(calcCardWidth(40)).toBe(1);
		expect(calcCardWidth(1)).toBe(1);
	});

	it("calculates correctly for 80-col terminals", () => {
		// (80 - 28) / 3 - 9 = floor(17.33) - 9 = 17 - 9 = 8
		expect(calcCardWidth(80)).toBe(8);
	});

	it("calculates correctly for 100-col terminals", () => {
		// (100 - 28) / 3 - 9 = floor(24) - 9 = 24 - 9 = 15
		expect(calcCardWidth(100)).toBe(15);
	});

	it("calculates correctly for 120-col terminal", () => {
		// (120 - 28) / 3 - 9 = floor(30.67) - 9 = 30 - 9 = 21
		expect(calcCardWidth(120)).toBe(21);
	});

	it("calculates correctly for 140-col terminal", () => {
		// (140 - 28) / 3 - 9 = floor(37.33) - 9 = 37 - 9 = 28
		expect(calcCardWidth(140)).toBe(28);
	});

	it("calculates correctly for 160-col terminal", () => {
		// (160 - 28) / 3 - 9 = floor(44) - 9 = 44 - 9 = 35
		expect(calcCardWidth(160)).toBe(35);
	});

	it("never returns less than 1", () => {
		for (const cols of [40, 60, 80, 100]) {
			expect(calcCardWidth(cols)).toBeGreaterThanOrEqual(1);
		}
	});

	it("increases with terminal width beyond the minimum threshold", () => {
		expect(calcCardWidth(160)).toBeGreaterThan(calcCardWidth(140));
		expect(calcCardWidth(140)).toBeGreaterThan(calcCardWidth(120));
	});
});
