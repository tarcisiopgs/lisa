import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		passWithNoTests: true,
		environment: "jsdom",
		coverage: {
			provider: "v8",
			thresholds: {
				branches: 70,
				functions: 70,
				lines: 70,
				statements: 70,
			},
		},
	},
});
