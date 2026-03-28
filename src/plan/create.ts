import * as logger from "../output/logger.js";
import { normalizeLabels } from "../sources/base.js";
import type { LineageContext, PlanResult, Source, SourceConfig } from "../types/index.js";
import { saveLineage } from "./lineage.js";

/**
 * Ensure the issue description contains acceptance criteria as a `- [ ]` checklist.
 * If the description already has checklist items, return it unchanged.
 * Otherwise, append the acceptance criteria from the structured array.
 */
function ensureAcceptanceCriteria(description: string, criteria: string[]): string {
	if (!criteria.length) return description;
	if (/- \[ \]/.test(description)) return description;

	const checklist = criteria.map((c) => `- [ ] ${c}`).join("\n");
	return `${description}\n\n## Acceptance Criteria\n\n${checklist}`;
}

/**
 * Create all plan issues in the source, in order.
 * Links dependencies where the source supports it.
 * Returns array of created issue IDs.
 */
export async function createPlanIssues(
	source: Source,
	config: SourceConfig,
	plan: PlanResult,
	workspace?: string,
): Promise<string[]> {
	if (!source.createIssue) {
		throw new Error(`Source "${source.name}" does not support createIssue`);
	}

	const labels = normalizeLabels(config);
	const primaryLabel = labels[0] ?? "";
	const sorted = [...plan.issues].sort((a, b) => a.order - b.order);
	const createdIds: string[] = [];
	// Map order → created issue ID for dependency linking
	const orderToId = new Map<number, string>();

	for (const issue of sorted) {
		// Ensure acceptance criteria are embedded in the description as a checklist
		let description = ensureAcceptanceCriteria(issue.description, issue.acceptanceCriteria);

		if (issue.dependsOn.length > 0 && !source.linkDependency) {
			const depRefs = issue.dependsOn
				.map((depOrder) => {
					const depId = orderToId.get(depOrder);
					return depId ? `#${depId}` : `step ${depOrder}`;
				})
				.join(", ");
			description += `\n\n---\n_Depends on: ${depRefs}_`;
		}

		try {
			const id = await source.createIssue(
				{
					title: issue.title,
					description,
					status: config.pick_from,
					label: primaryLabel,
					order: issue.order,
					parentId: plan.sourceIssueId,
				},
				config,
			);

			createdIds.push(id);
			orderToId.set(issue.order, id);
			logger.ok(`${id}: ${issue.title}`);

			// Link dependencies where supported
			if (source.linkDependency && issue.dependsOn.length > 0) {
				for (const depOrder of issue.dependsOn) {
					const depId = orderToId.get(depOrder);
					if (depId) {
						try {
							await source.linkDependency(id, depId);
						} catch (err) {
							logger.warn(
								`Could not link dependency ${id} → ${depId}: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					}
				}
			}
		} catch (err) {
			logger.warn(
				`Failed to create issue "${issue.title}": ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (createdIds.length > 1 && workspace) {
		const lineage: LineageContext = {
			planId: plan.createdAt,
			goal: plan.goal,
			issues: sorted.map((issue, idx) => ({
				id: createdIds[idx] ?? `unknown-${idx}`,
				title: issue.title,
				order: issue.order,
			})),
		};
		try {
			saveLineage(workspace, lineage);
		} catch {
			// Non-fatal
		}
	}

	return createdIds;
}
