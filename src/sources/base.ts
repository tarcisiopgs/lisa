import { warn } from "../output/logger.js";
import type { SourceConfig } from "../types/index.js";

/** Shared timeout for all source API requests (30 seconds). */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum number of attempts for retryable requests (1 initial + 2 retries). */
const MAX_ATTEMPTS = 3;

/** Base backoff delay in milliseconds (doubles per retry: 1s, 2s). */
const BASE_BACKOFF_MS = 1_000;

/**
 * Normalize label config to a string array.
 * Handles both single string and string[] formats from SourceConfig.
 */
export function normalizeLabels(config: SourceConfig): string[] {
	return Array.isArray(config.label) ? config.label : config.label ? [config.label] : [];
}

/**
 * Creates a typed HTTP client for a REST API.
 *
 * @param baseUrl - API base URL (e.g. "https://api.github.com")
 * @param getHeaders - Function returning auth/content headers (may be async for token refresh)
 * @param name - API name for error messages (e.g. "GitHub")
 */
export function createApiClient(
	baseUrl: string,
	getHeaders: () => Record<string, string> | Promise<Record<string, string>>,
	name: string,
) {
	/**
	 * Determine whether an error is retryable (transient).
	 * Retries on: server errors (5xx), AbortError (timeout), TypeError (network failure).
	 * Does NOT retry on 4xx (client errors).
	 */
	function isRetryable(error: unknown): boolean {
		if (error instanceof Error) {
			if (error.name === "AbortError") return true;
			if (error instanceof TypeError) return true;
			// Check for server errors encoded in our error message format
			const match = error.message.match(/API error \((\d+)\)/);
			if (match?.[1]) {
				const status = Number.parseInt(match[1], 10);
				return status >= 500;
			}
		}
		return false;
	}

	/**
	 * Execute an async operation with exponential backoff retry.
	 * Retries only on transient errors (5xx, timeout, network failure).
	 */
	async function retryableRequest<T>(operation: () => Promise<T>): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			try {
				return await operation();
			} catch (error) {
				lastError = error;
				if (!isRetryable(error) || attempt === MAX_ATTEMPTS - 1) {
					throw error;
				}
				const delay = BASE_BACKOFF_MS * 2 ** attempt;
				warn(
					`${name} API request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${delay}ms...`,
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
		throw lastError;
	}

	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		return retryableRequest(async () => {
			const url = `${baseUrl}${path}`;
			const headers: Record<string, string> = {
				...(await getHeaders()),
				"Content-Type": "application/json",
			};

			const res = await fetch(url, {
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			if (!res.ok) {
				const text = await res.text();
				throw new Error(`${name} API error (${res.status}): ${text}`);
			}

			if (method === "DELETE" || res.status === 204) return undefined as T;
			return (await res.json()) as T;
		});
	}

	return {
		get: <T>(path: string) => request<T>("GET", path),
		post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
		put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
		patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
		delete: (path: string) => request<void>("DELETE", path),
		/** Raw request for non-JSON bodies (e.g. Trello form-encoded). */
		raw: async <T>(method: string, path: string, init?: RequestInit): Promise<T> => {
			return retryableRequest(async () => {
				const url = `${baseUrl}${path}`;
				const headers = await getHeaders();
				const res = await fetch(url, {
					method,
					headers: { ...headers, ...init?.headers },
					body: init?.body,
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				if (!res.ok) {
					const text = await res.text();
					throw new Error(`${name} API error (${res.status}): ${text}`);
				}
				if (method === "DELETE" || res.status === 204) return undefined as T;
				return (await res.json()) as T;
			});
		},
	};
}

export type ApiClient = ReturnType<typeof createApiClient>;
