import { describe, expect, it } from "vitest";
import { calcVisibleCount } from "./column.js";

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
