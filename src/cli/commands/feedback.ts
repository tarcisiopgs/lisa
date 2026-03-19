import { defineCommand } from "citty";
import pc from "picocolors";
import { CliError } from "../error.js";

export const feedback = defineCommand({
	meta: {
		name: "feedback",
		description: "Inject PR review feedback from a closed-without-merge PR into guardrails",
	},
	args: {
		pr: { type: "string", required: true, description: "GitHub pull request URL" },
		issue: {
			type: "string",
			description: "Issue ID to associate with the feedback (e.g. INT-123)",
		},
	},
	async run({ args }) {
		const { fetchPrFeedback, formatPrFeedbackEntry } = await import("../../git/pr-feedback.js");
		const { appendRawEntrySync } = await import("../../session/guardrails.js");
		const { ensureCacheDir } = await import("../../paths.js");

		const prUrl = args.pr;
		const issueId = args.issue ?? "unknown";
		const date = new Date().toISOString().slice(0, 10);

		console.log(`Fetching feedback from ${prUrl}...`);

		let prFeedback: Awaited<ReturnType<typeof fetchPrFeedback>>;
		try {
			prFeedback = await fetchPrFeedback(prUrl);
		} catch (err) {
			console.error(
				pc.red(`Failed to fetch PR feedback: ${err instanceof Error ? err.message : String(err)}`),
			);
			throw new CliError(err instanceof Error ? err.message : String(err));
		}

		if (prFeedback.state === "merged") {
			console.log(pc.yellow("PR was merged — no feedback to inject."));
			return;
		}

		if (prFeedback.state === "open") {
			console.log(
				pc.yellow("PR is still open — injecting available feedback, but PR is not closed yet."),
			);
		}

		const hasAnyFeedback = prFeedback.reviews.length > 0 || prFeedback.comments.length > 0;
		if (!hasAnyFeedback) {
			console.log(pc.yellow("No review comments found on this PR."));
			return;
		}

		const entryText = formatPrFeedbackEntry(prFeedback, issueId, date);
		const cwd = process.cwd();
		ensureCacheDir(cwd);
		appendRawEntrySync(cwd, entryText);

		const total = prFeedback.reviews.length + prFeedback.comments.length;
		console.log(pc.green(`Injected ${total} review comment(s) as guardrail for issue ${issueId}.`));
	},
});
