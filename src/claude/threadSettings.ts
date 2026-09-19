import type { ActivePermissionProfile } from "../codex/generated/v2/ActivePermissionProfile.js";
import type { SandboxPolicy } from "../codex/generated/v2/SandboxPolicy.js";
import type { ThreadSettings } from "../codex/generated/v2/ThreadSettings.js";
import type { ClaudeThreadRecord } from "../store/HybridStore.js";
import { normalizeClaudeModelIdentifier } from "./modelSelection.js";
import type { TranscriptHeader } from "./native/summary.js";

export interface NativeThreadSettingsDefaults {
  readonly modelPickerId: string;
  readonly claudeModelValue: string;
  readonly reasoningEffort: ThreadSettings["effort"];
  readonly serviceTier: string | null;
  readonly modelPickerIdFor: (model: string) => string;
}

export interface NativeThreadSettings {
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly modelPickerId: string;
  readonly claudeModelValue: string;
  readonly serviceTier: string | null;
  readonly approvalPolicy: ThreadSettings["approvalPolicy"];
  readonly approvalsReviewer: ThreadSettings["approvalsReviewer"];
  readonly sandboxPolicy: ThreadSettings["sandboxPolicy"];
  readonly reasoningEffort: ThreadSettings["effort"];
  readonly reasoningSummary: null;
  readonly personality: null;
  readonly collaborationMode: null;
  readonly outputSchema: null;
  readonly baseInstructions: null;
  readonly developerInstructions: null;
}

function activePermissionProfile(policy: SandboxPolicy): ActivePermissionProfile | null {
  if (policy.type === "readOnly") return { id: ":read-only", extends: null };
  if (policy.type === "workspaceWrite") return { id: ":workspace", extends: null };
  if (policy.type === "dangerFullAccess") return { id: ":danger-full-access", extends: null };
  return null;
}

export function nativePermissions(
  permissionMode: string | null,
  cwd: string,
): Pick<NativeThreadSettings, "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy"> {
  if (permissionMode === "bypassPermissions") {
    return { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } };
  }
  const workspace: SandboxPolicy = {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
  if (permissionMode === "dontAsk") {
    return { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: workspace };
  }
  if (permissionMode === "auto") {
    return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: workspace };
  }
  return { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: workspace };
}

export function nativeThreadSettings(
  header: TranscriptHeader,
  cwd: string,
  defaults: NativeThreadSettingsDefaults,
): NativeThreadSettings {
  const modelPickerId = header.model ? defaults.modelPickerIdFor(header.model) : defaults.modelPickerId;
  return {
    cwd,
    runtimeWorkspaceRoots: [cwd],
    modelPickerId,
    claudeModelValue: header.model ? normalizeClaudeModelIdentifier(header.model) : defaults.claudeModelValue,
    serviceTier: header.model ? header.serviceTier : defaults.serviceTier,
    ...nativePermissions(header.permissionMode, cwd),
    reasoningEffort: header.reasoningEffort as ThreadSettings["effort"] ?? defaults.reasoningEffort,
    reasoningSummary: null,
    personality: null,
    collaborationMode: null,
    outputSchema: null,
    baseInstructions: null,
    developerInstructions: null,
  };
}

export function syncedCollaborationMode(
  value: unknown | null | undefined,
  model: string,
  effort: ThreadSettings["effort"],
): ThreadSettings["collaborationMode"] {
  const mode = (value ?? {
    mode: "default",
    settings: { model, reasoning_effort: effort, developer_instructions: null },
  }) as ThreadSettings["collaborationMode"];
  return { ...mode, settings: { ...mode.settings, model, reasoning_effort: effort } };
}

export function threadSettings(record: ClaudeThreadRecord): ThreadSettings {
  const sandboxPolicy = record.sandboxPolicy as ThreadSettings["sandboxPolicy"];
  return {
    cwd: record.thread.cwd,
    approvalPolicy: record.approvalPolicy as ThreadSettings["approvalPolicy"],
    approvalsReviewer: record.approvalsReviewer,
    sandboxPolicy,
    activePermissionProfile: activePermissionProfile(sandboxPolicy),
    model: record.modelPickerId,
    modelProvider: "claude",
    serviceTier: record.serviceTier,
    effort: record.reasoningEffort as ThreadSettings["effort"],
    summary: record.reasoningSummary as ThreadSettings["summary"],
    collaborationMode: syncedCollaborationMode(
      record.collaborationMode,
      record.modelPickerId,
      record.reasoningEffort as ThreadSettings["effort"],
    ),
    multiAgentMode: "explicitRequestOnly",
    personality: record.personality as ThreadSettings["personality"],
  };
}
