import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Claude rollback boundary ownership", () => {
  it("derives rollback boundaries from transcript projection without a store boundary writer", () => {
    const projector = readFileSync("src/claude/native/projector.ts", "utf8");
    const store = readFileSync("src/store/HybridStore.ts", "utf8");
    expect(projector).toContain("turnBoundaries: projectTurnBoundaries");
    expect(store).not.toContain("commitProviderBoundary");
  });
});
