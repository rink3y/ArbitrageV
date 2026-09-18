import { expect, test } from "bun:test";
import { type Address } from "viem";
import { OpportunityManager } from "../src/execute";
import { type ExecutableOpportunity } from "../src/execution/execution-planner";

const pair = "0x0000000000000000000000000000000000000001" as Address;

const opportunity: ExecutableOpportunity = {
  path: [pair, pair],
  pairs: [pair],
  protocols: ["v2"],
  fees: [30],
  routeData: ["0x"],
  optimalInput: 1n,
  profit: 1n,
};

test("locks pools before an overlapping fire-and-forget submission", async () => {
  let submissions = 0;
  let releaseFirst!: () => void;
  const manager = new OpportunityManager({} as never, async () => {
    submissions++;
    await new Promise<void>(resolve => { releaseFirst = resolve; });
    return true;
  });

  const first = manager.processOpportunities({} as never, [opportunity]);
  await Promise.resolve();
  await manager.processOpportunities({} as never, [opportunity]);

  expect(submissions).toBe(1);
  releaseFirst();
  await first;
});
