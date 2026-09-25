import type { Stage } from "../api/types";

/** The stage the decision panel acts on: the one awaiting approval, else the selected one. */
export function decisionTarget(stages: Stage[], selected: Stage["key"]): { stage: Stage; index: number } {
  const w = stages.findIndex((x) => x.status === "awaiting_approval");
  const i = w >= 0 ? w : Math.max(0, stages.findIndex((x) => x.key === selected));
  return { stage: stages[i], index: i };
}
