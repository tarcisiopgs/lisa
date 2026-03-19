import type { SourceConfig } from "../types/index.js";

/** Shared timeout for all source API requests (30 seconds). */
export const REQUEST_TIMEOUT_MS = 30_000;

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
	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
	}

	return {
		get: <T>(path: string) => request<T>("GET", path),
		post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
		put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
		patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
		delete: (path: string) => request<void>("DELETE", path),
		/** Raw request for non-JSON bodies (e.g. Trello form-encoded). */
		raw: async <T>(method: string, path: string, init?: RequestInit): Promise<T> => {
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
		},
	};
}

export type ApiClient = ReturnType<typeof createApiClient>;
