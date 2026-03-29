import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../types/index.js";
import { createApiClient, normalizeLabels, REQUEST_TIMEOUT_MS } from "./base.js";

vi.mock("../output/logger.js", () => ({
	warn: vi.fn(),
}));

describe("normalizeLabels", () => {
	it("returns array from single string label", () => {
		const config: SourceConfig = {
			scope: "",
			project: "",
			label: "ready",
			pick_from: "",
			in_progress: "",
			done: "",
		};
		expect(normalizeLabels(config)).toEqual(["ready"]);
	});

	it("returns array from array label", () => {
		const config: SourceConfig = {
			scope: "",
			project: "",
			label: ["ready", "api"],
			pick_from: "",
			in_progress: "",
			done: "",
		};
		expect(normalizeLabels(config)).toEqual(["ready", "api"]);
	});

	it("returns empty array from empty string", () => {
		const config: SourceConfig = {
			scope: "",
			project: "",
			label: "",
			pick_from: "",
			in_progress: "",
			done: "",
		};
		expect(normalizeLabels(config)).toEqual([]);
	});

	it("returns empty array when label is undefined/empty", () => {
		const config = {
			scope: "",
			project: "",
			label: undefined,
			pick_from: "",
			in_progress: "",
			done: "",
		} as unknown as SourceConfig;
		expect(normalizeLabels(config)).toEqual([]);
	});
});

describe("createApiClient", () => {
	const mockFetch = vi.fn();

	beforeEach(() => {
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("get() calls fetch with GET method and returns parsed JSON", async () => {
		const data = { id: 1, name: "test" };
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve(data),
		});

		const client = createApiClient(
			"https://api.example.com",
			() => ({ Authorization: "Bearer tok" }),
			"Test",
		);
		const result = await client.get<{ id: number; name: string }>("/items");

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.example.com/items",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({
					Authorization: "Bearer tok",
					"Content-Type": "application/json",
				}),
				body: undefined,
				signal: expect.any(AbortSignal),
			}),
		);
		expect(result).toEqual(data);
	});

	it("post() calls fetch with POST and stringified body", async () => {
		const responseData = { id: 2 };
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve(responseData),
		});

		const client = createApiClient(
			"https://api.example.com",
			() => ({ Authorization: "Bearer tok" }),
			"Test",
		);
		const result = await client.post<{ id: number }>("/items", { name: "new" });

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.example.com/items",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ name: "new" }),
			}),
		);
		expect(result).toEqual(responseData);
	});

	it("delete() returns undefined", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 204,
		});

		const client = createApiClient(
			"https://api.example.com",
			() => ({ Authorization: "Bearer tok" }),
			"Test",
		);
		const result = await client.delete("/items/1");

		expect(result).toBeUndefined();
		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.example.com/items/1",
			expect.objectContaining({ method: "DELETE" }),
		);
	});

	it("throws on non-ok response with API name in error message", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 404,
			text: () => Promise.resolve("Not found"),
		});

		const client = createApiClient(
			"https://api.example.com",
			() => ({ Authorization: "Bearer tok" }),
			"GitHub",
		);
		await expect(client.get("/missing")).rejects.toThrow("GitHub API error (404): Not found");
	});

	it("uses AbortSignal.timeout with REQUEST_TIMEOUT_MS", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({}),
		});

		const client = createApiClient("https://api.example.com", () => ({}), "Test");
		await client.get("/test");

		const call = mockFetch.mock.calls[0]!;
		const signal = call[1].signal as AbortSignal;
		expect(signal).toBeInstanceOf(AbortSignal);
		// Verify REQUEST_TIMEOUT_MS constant is 30000
		expect(REQUEST_TIMEOUT_MS).toBe(30_000);
	});

	it("supports async headers function", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ ok: true }),
		});

		const asyncHeaders = async () => ({ Authorization: "Bearer async-token" });
		const client = createApiClient("https://api.example.com", asyncHeaders, "Test");
		await client.get("/test");

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.example.com/test",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer async-token",
				}),
			}),
		);
	});

	describe("retry with exponential backoff", () => {
		beforeEach(() => {
			vi.useFakeTimers();
			mockFetch.mockReset();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("succeeds on first try without retrying", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ id: 1 }),
			});

			const client = createApiClient("https://api.example.com", () => ({}), "Test");
			const result = await client.get<{ id: number }>("/items");

			expect(result).toEqual({ id: 1 });
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it("retries on 500 and succeeds on second attempt", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: false,
					status: 500,
					text: () => Promise.resolve("Internal Server Error"),
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ id: 2 }),
				});

			const client = createApiClient("https://api.example.com", () => ({}), "Test");
			const promise = client.get<{ id: number }>("/items");

			// Advance past the 1s backoff delay
			await vi.advanceTimersByTimeAsync(1_000);

			const result = await promise;
			expect(result).toEqual({ id: 2 });
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});

		it("retries on network error (TypeError) and succeeds", async () => {
			mockFetch.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ id: 3 }),
			});

			const client = createApiClient("https://api.example.com", () => ({}), "Test");
			const promise = client.get<{ id: number }>("/items");

			await vi.advanceTimersByTimeAsync(1_000);

			const result = await promise;
			expect(result).toEqual({ id: 3 });
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});

		it("does NOT retry on 400 client error", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 400,
				text: () => Promise.resolve("Bad Request"),
			});

			const client = createApiClient("https://api.example.com", () => ({}), "Test");
			await expect(client.get("/items")).rejects.toThrow("Test API error (400): Bad Request");
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it("does NOT retry on 404 client error", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 404,
				text: () => Promise.resolve("Not Found"),
			});

			const client = createApiClient("https://api.example.com", () => ({}), "Test");
			await expect(client.get("/items")).rejects.toThrow("Test API error (404): Not Found");
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it("gives up after 3 attempts and throws the last error", async () => {
			mockFetch.mockImplementation(() =>
				Promise.resolve({
					ok: false,
					status: 503,
					text: () => Promise.resolve("Service Unavailable"),
				}),
			);

			const client = createApiClient("https://api.example.com", () => ({}), "Test");
			const promise = client.get("/items").catch((e: Error) => e);

			// Advance past backoff delays: 1s (attempt 1→2), 2s (attempt 2→3)
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(2_000);

			const error = await promise;
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("Test API error (503): Service Unavailable");
			expect(mockFetch).toHaveBeenCalledTimes(3);
		});

		it("retries raw() on server error and succeeds", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: false,
					status: 502,
					text: () => Promise.resolve("Bad Gateway"),
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ ok: true }),
				});

			const client = createApiClient("https://api.example.com", () => ({}), "Test");
			const promise = client.raw<{ ok: boolean }>("POST", "/upload", {
				body: "raw-data",
			});

			await vi.advanceTimersByTimeAsync(1_000);

			const result = await promise;
			expect(result).toEqual({ ok: true });
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});
	});
});
