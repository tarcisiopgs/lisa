import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrelloSource } from "./trello.js";

function mockFetchSequence(...responses: unknown[]) {
	let call = 0;
	return vi.fn().mockImplementation(async () => {
		const response = responses[call] ?? responses[responses.length - 1];
		call++;
		return {
			ok: true,
			status: 200,
			json: async () => response,
			text: async () => JSON.stringify(response),
		};
	});
}

const config = {
	scope: "My Board",
	project: "Backlog",
	label: "lisa",
	pick_from: "Backlog",
	in_progress: "In Progress",
	done: "Done",
};

describe("TrelloSource.listIssues", () => {
	beforeEach(() => {
		process.env.TRELLO_API_KEY = "test-key";
		process.env.TRELLO_TOKEN = "test-token";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TRELLO_API_KEY;
		delete process.env.TRELLO_TOKEN;
	});

	it("returns all cards with the configured label in the pick_from list", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetchSequence(
				[{ id: "board1", name: "My Board" }],
				[{ id: "list1", name: "Backlog" }],
				[{ id: "label1", name: "lisa" }],
				[
					{
						id: "card1",
						name: "Fix login",
						desc: "",
						url: "https://trello.com/c/a",
						idLabels: ["label1"],
					},
					{
						id: "card2",
						name: "Add feature",
						desc: "",
						url: "https://trello.com/c/b",
						idLabels: ["label1"],
					},
					{ id: "card3", name: "No label", desc: "", url: "https://trello.com/c/c", idLabels: [] },
				],
			),
		);

		const source = new TrelloSource();
		const result = await source.listIssues(config);

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ id: "card1", title: "Fix login" });
		expect(result[1]).toMatchObject({ id: "card2", title: "Add feature" });
	});

	it("returns empty array when no cards match the label", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetchSequence(
				[{ id: "board1", name: "My Board" }],
				[{ id: "list1", name: "Backlog" }],
				[{ id: "label1", name: "lisa" }],
				[],
			),
		);

		const source = new TrelloSource();
		const result = await source.listIssues(config);

		expect(result).toEqual([]);
	});
});

describe("wizard helpers", () => {
	beforeEach(() => {
		process.env.TRELLO_API_KEY = "test-key";
		process.env.TRELLO_TOKEN = "test-token";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.TRELLO_API_KEY;
		delete process.env.TRELLO_TOKEN;
	});

	it("listScopes returns board names", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetchSequence([
				{ id: "board1", name: "My Board" },
				{ id: "board2", name: "Other Board" },
			]),
		);

		const source = new TrelloSource();
		const result = await source.listScopes();

		expect(result).toEqual([
			{ value: "My Board", label: "My Board" },
			{ value: "Other Board", label: "Other Board" },
		]);
	});

	it("listLabels returns labels with non-empty names", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetchSequence(
				[{ id: "board1", name: "My Board" }],
				[
					{ id: "l1", name: "lisa" },
					{ id: "l2", name: "" },
					{ id: "l3", name: "bug" },
				],
			),
		);

		const source = new TrelloSource();
		const result = await source.listLabels("My Board");

		expect(result).toEqual([
			{ value: "lisa", label: "lisa" },
			{ value: "bug", label: "bug" },
		]);
	});

	it("listStatuses returns list names", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetchSequence(
				[{ id: "board1", name: "My Board" }],
				[
					{ id: "list1", name: "Backlog" },
					{ id: "list2", name: "In Progress" },
					{ id: "list3", name: "Done" },
				],
			),
		);

		const source = new TrelloSource();
		const result = await source.listStatuses("My Board");

		expect(result).toEqual([
			{ value: "Backlog", label: "Backlog" },
			{ value: "In Progress", label: "In Progress" },
			{ value: "Done", label: "Done" },
		]);
	});
});
