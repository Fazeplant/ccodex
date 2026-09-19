import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NativeSessionCatalog } from "../../../src/claude/native/catalog.js";
import { summarizeTranscript, type TranscriptHeader } from "../../../src/claude/native/summary.js";
import type { TranscriptRecord } from "../../../src/claude/native/records.js";
import { providerPermissionMode } from "../../../src/claude/session/providerRuntimeFactory.js";
import type { RuntimeTransportSettings } from "../../../src/claude/session/commands.js";
import {
  nativePermissions,
  nativeThreadSettings,
  type NativeThreadSettingsDefaults,
} from "../../../src/claude/threadSettings.js";

const fixtureProjects = fileURLToPath(new URL("../../fixtures/nativeClaudeHome/projects/", import.meta.url));
const cwd = "/synthetic";

function record(fields: Record<string, unknown>): TranscriptRecord {
  return fields as unknown as TranscriptRecord;
}

function header(fields: Partial<TranscriptHeader> = {}): TranscriptHeader {
  return {
    cwd,
    gitBranch: null,
    createdAt: 0,
    updatedAt: 0,
    preview: "",
    customTitle: null,
    aiTitle: null,
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    permissionMode: null,
    cliVersion: null,
    ...fields,
  };
}

const defaults: NativeThreadSettingsDefaults = {
  modelPickerId: "claude:default-model",
  claudeModelValue: "default-model",
  reasoningEffort: "medium",
  serviceTier: "fast",
  modelPickerIdFor: (model) => `catalog:${model}`,
};

function transport(permissionMode: "default" | "auto" | "dontAsk" | "bypassPermissions"): RuntimeTransportSettings {
  return {
    cwd,
    runtimeWorkspaceRoots: [cwd],
    model: "claude:test",
    settingsGeneration: 0,
    ...nativePermissions(permissionMode, cwd),
    serviceTier: null,
    reasoningEffort: null,
    reasoningSummary: null,
    collaborationMode: null,
  };
}

describe("native Claude thread settings", () => {
  it("reduces fixture model, effort, canonical permission, and standard tier", async () => {
    const catalog = new NativeSessionCatalog(fixtureProjects);
    await catalog.refresh();

    for (const summary of catalog.sessions()) {
      expect(summary.model).toMatch(/^claude-/u);
      expect(summary.reasoningEffort).not.toBeNull();
      expect(summary.permissionMode).toBe("bypassPermissions");
      expect(summary.serviceTier).toBeNull();
    }
  });

  it("takes the latest permission across user and state records by file position", () => {
    const stateThenUser = summarizeTranscript([
      record({ type: "permission-mode", permissionMode: "auto" }),
      record({ type: "user", permissionMode: "dontAsk", message: { content: "later" } }),
    ]);
    const userThenState = summarizeTranscript([
      record({ type: "user", permissionMode: "dontAsk", message: { content: "earlier" } }),
      record({ type: "permission-mode", permissionMode: "auto" }),
    ]);

    expect(stateThenUser.permissionMode).toBe("dontAsk");
    expect(userThenState.permissionMode).toBe("auto");
  });

  it("uses only finalized assistant usage and canonicalizes service tier", () => {
    const summary = summarizeTranscript([
      record({
        type: "assistant", effort: "low",
        message: { model: "claude-first", stop_reason: "end_turn", content: [], usage: { service_tier: "priority" } },
      }),
      record({
        type: "assistant", effort: "high",
        message: { model: "claude-second", stop_reason: null, content: [], usage: { service_tier: "standard" } },
      }),
    ]);
    expect(summary).toMatchObject({ model: "claude-second", reasoningEffort: "high", serviceTier: "fast" });

    expect(summarizeTranscript([record({
      type: "assistant",
      message: { model: "claude-second", stop_reason: "end_turn", content: [], usage: { service_tier: "default" } },
    })]).serviceTier).toBeNull();
  });

  it("adapts transcript values and pre-response catalog defaults", () => {
    expect(nativeThreadSettings(header(), cwd, defaults)).toMatchObject({
      cwd,
      runtimeWorkspaceRoots: [cwd],
      modelPickerId: "claude:default-model",
      claudeModelValue: "default-model",
      reasoningEffort: "medium",
      serviceTier: "fast",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      reasoningSummary: null,
      personality: null,
      collaborationMode: null,
      outputSchema: null,
    });
    expect(nativeThreadSettings(header({
      model: "claude-fable-5",
      reasoningEffort: "xhigh",
      serviceTier: null,
      permissionMode: "auto",
    }), cwd, defaults)).toMatchObject({
      modelPickerId: "catalog:claude-fable-5",
      claudeModelValue: "claude-fable-5",
      reasoningEffort: "xhigh",
      serviceTier: null,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  });

  it("round-trips all four canonical native permission modes", () => {
    for (const mode of ["default", "auto", "dontAsk", "bypassPermissions"] as const) {
      const settings = transport(mode);
      expect(providerPermissionMode(settings)).toBe(mode);
      expect(nativePermissions(providerPermissionMode(settings), cwd)).toEqual(nativePermissions(mode, cwd));
    }
  });
});
