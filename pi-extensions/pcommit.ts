/**
 * Prompt-to-Commit Tracker Extension
 *
 * Tracks user prompts and links them to git commits, creating a clear audit
 * trail of AI-assisted changes. Zero dependencies - just copy this file to
 * your pi extensions directory.
 *
 * Data is stored per-repository in .pi/prompt-commit/<session-id>.json:
 * {
 *   "sessionId": "2026-01-29-abc123.json",
 *   "prompts": [
 *     { "id": "...", "text": "add login form", "timestamp": 1706540000000 }
 *   ],
 *   "fileChanges": [
 *     { "id": "...", "promptId": "...", "filePath": "src/Login.tsx", "toolName": "write", "timestamp": ... }
 *   ],
 *   "commits": [
 *     { "id": "...", "commitHash": "abc1234", "message": "...", "promptIds": [...], "createdAt": ... }
 *   ]
 * }
 *
 * Settings can be configured in .pi/prompt-commit/settings.json:
 * {
 *   "truncateLength": 76,      // max length for prompt lines in commit message
 *   "includeSession": true     // include session ID in commit message
 * }
 *
 * Usage:
 *   1. Make changes using natural language prompts
 *   2. Stage your changes with `git add`
 *   3. Run `/pcommit` or `/pcommit <custom message>`
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// =============================================================================
// Constants
// =============================================================================

const DATA_DIR_NAME = ".pi/prompt-commit";
const SETTINGS_FILE_NAME = "settings.json";

const DEFAULT_SETTINGS: PromptCommitSettings = {
  truncateLength: 76,
  includeSession: true,
};

// =============================================================================
// Types
// =============================================================================

interface PromptCommitSettings {
  truncateLength: number;
  includeSession: boolean;
}

interface TrackedPrompt {
  id: string;
  text: string;
  timestamp: number;
}

interface FileChange {
  id: string;
  promptId: string;
  filePath: string;
  toolName: string;
  timestamp: number;
}

interface CommitRecord {
  id: string;
  commitHash: string;
  message: string;
  promptIds: string[];
  createdAt: number;
}

interface SessionData {
  sessionId: string;
  prompts: TrackedPrompt[];
  fileChanges: FileChange[];
  commits: CommitRecord[];
}

interface PendingChange {
  toolCallId: string;
  filePath: string;
  toolName: string;
}

// =============================================================================
// Path Utilities
// =============================================================================

function getDataDir(repoRoot: string): string {
  return path.join(repoRoot, DATA_DIR_NAME);
}

function getSettingsPath(repoRoot: string): string {
  return path.join(getDataDir(repoRoot), SETTINGS_FILE_NAME);
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getSessionFilePath(repoRoot: string, sessionId: string): string {
  const safeId = sanitizeSessionId(sessionId);
  return path.join(getDataDir(repoRoot), `${safeId}.json`);
}

function getShortSessionId(sessionId: string): string {
  return sessionId.split("/").pop() || sessionId;
}

// =============================================================================
// Settings
// =============================================================================

function normalizeSettings(raw: Partial<PromptCommitSettings>): PromptCommitSettings {
  return {
    truncateLength: typeof raw.truncateLength === "number" 
      ? Math.max(20, Math.floor(raw.truncateLength)) 
      : DEFAULT_SETTINGS.truncateLength,
    includeSession: typeof raw.includeSession === "boolean" 
      ? raw.includeSession 
      : DEFAULT_SETTINGS.includeSession,
  };
}

async function readSettings(repoRoot: string): Promise<PromptCommitSettings> {
  const settingsPath = getSettingsPath(repoRoot);
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    return normalizeSettings(JSON.parse(raw) as Partial<PromptCommitSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function readSettingsSync(repoRoot: string): PromptCommitSettings {
  const settingsPath = getSettingsPath(repoRoot);
  try {
    const raw = readFileSync(settingsPath, "utf8");
    return normalizeSettings(JSON.parse(raw) as Partial<PromptCommitSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// =============================================================================
// Session Data Storage
// =============================================================================

function createEmptySessionData(sessionId: string): SessionData {
  return {
    sessionId,
    prompts: [],
    fileChanges: [],
    commits: [],
  };
}

async function ensureDataDir(repoRoot: string): Promise<void> {
  await fs.mkdir(getDataDir(repoRoot), { recursive: true });
}

function ensureDataDirSync(repoRoot: string): void {
  mkdirSync(getDataDir(repoRoot), { recursive: true });
}

async function readSessionData(repoRoot: string, sessionId: string): Promise<SessionData> {
  const filePath = getSessionFilePath(repoRoot, sessionId);
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as SessionData;
  } catch {
    return createEmptySessionData(sessionId);
  }
}

function readSessionDataSync(repoRoot: string, sessionId: string): SessionData {
  const filePath = getSessionFilePath(repoRoot, sessionId);
  try {
    const content = readFileSync(filePath, "utf8");
    return JSON.parse(content) as SessionData;
  } catch {
    return createEmptySessionData(sessionId);
  }
}

async function writeSessionData(repoRoot: string, data: SessionData): Promise<void> {
  await ensureDataDir(repoRoot);
  const filePath = getSessionFilePath(repoRoot, data.sessionId);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function writeSessionDataSync(repoRoot: string, data: SessionData): void {
  ensureDataDirSync(repoRoot);
  const filePath = getSessionFilePath(repoRoot, data.sessionId);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// =============================================================================
// Prompt & File Change Operations
// =============================================================================

function addPrompt(data: SessionData, text: string): string {
  const id = randomUUID();
  data.prompts.push({
    id,
    text,
    timestamp: Date.now(),
  });
  return id;
}

function addFileChange(
  data: SessionData,
  promptId: string,
  filePath: string,
  toolName: string
): void {
  data.fileChanges.push({
    id: randomUUID(),
    promptId,
    filePath,
    toolName,
    timestamp: Date.now(),
  });
}

function addCommit(
  data: SessionData,
  commitHash: string,
  message: string,
  promptIds: string[]
): void {
  data.commits.push({
    id: randomUUID(),
    commitHash,
    message,
    promptIds,
    createdAt: Date.now(),
  });
}

function findPromptById(data: SessionData, promptId: string): TrackedPrompt | undefined {
  return data.prompts.find((p) => p.id === promptId);
}

function findPromptsForFiles(
  data: SessionData,
  stagedFiles: string[],
  cwd: string
): TrackedPrompt[] {
  const promptIds = new Set<string>();

  for (const staged of stagedFiles) {
    const normalizedStaged = path.normalize(staged);

    for (const change of data.fileChanges) {
      let normalizedChange = change.filePath;
      if (path.isAbsolute(normalizedChange)) {
        normalizedChange = path.relative(cwd, normalizedChange);
      }
      normalizedChange = path.normalize(normalizedChange);

      if (normalizedStaged === normalizedChange) {
        promptIds.add(change.promptId);
      }
    }
  }

  const prompts: TrackedPrompt[] = [];
  for (const promptId of promptIds) {
    const prompt = findPromptById(data, promptId);
    if (prompt) {
      prompts.push(prompt);
    }
  }

  return prompts.sort((a, b) => a.timestamp - b.timestamp);
}

// =============================================================================
// Text Formatting
// =============================================================================

function truncateText(text: string, maxLength: number): string {
  const firstLine = text.split("\n")[0] || "";
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength - 3) + "...";
}

function formatPromptForCommit(text: string, maxLength: number): string {
  return `- ${truncateText(text, maxLength - 2)}`;
}

function buildCommitMessage(
  userMessage: string | undefined,
  prompts: TrackedPrompt[],
  sessionId: string,
  settings: PromptCommitSettings
): string {
  let message: string;

  if (userMessage && userMessage.trim()) {
    message = userMessage.trim();
  } else if (prompts.length > 0) {
    message = truncateText(prompts[0].text, 72);
  } else {
    message = "Changes made with AI assistance";
  }

  if (prompts.length > 0) {
    message += "\n\nAI-Prompts:";
    for (const prompt of prompts) {
      message += `\n${formatPromptForCommit(prompt.text, settings.truncateLength)}`;
    }
  }

  if (settings.includeSession) {
    message += `\n\nSession: ${getShortSessionId(sessionId)}`;
  }

  return message;
}

// =============================================================================
// Bash Command Parsing
// =============================================================================

/**
 * Extract file paths from common bash commands that modify files.
 * Handles: touch, mv, cp, rm, sed -i, echo/cat redirects, mkdir
 */
function extractFilesFromBashCommand(command: string): string[] {
  const trimmed = command.trim();
  const files: string[] = [];

  const patterns: Array<{ regex: RegExp; extract: (match: RegExpMatchArray) => string[] }> = [
    // touch <file> [<file>...]
    {
      regex: /^touch\s+(.+)$/,
      extract: (m) => parseSpaceSeparatedArgs(m[1]),
    },
    // mv [-flags] <src> <dest>
    {
      regex: /^mv\s+(?:-[a-zA-Z]+\s+)*(.+?)\s+(\S+)$/,
      extract: (m) => [m[2]],
    },
    // cp [-flags] <src> <dest>
    {
      regex: /^cp\s+(?:-[a-zA-Z]+\s+)*(.+?)\s+(\S+)$/,
      extract: (m) => [m[2]],
    },
    // rm [-flags] <file> [<file>...]
    {
      regex: /^rm\s+(?:-[a-zA-Z]+\s+)*(.+)$/,
      extract: (m) => parseSpaceSeparatedArgs(m[1]),
    },
    // sed -i ... <file>
    {
      regex: /sed\s+(?:.*?-i[^\s]*\s+)?.*?['"].*?['"]\s+(\S+)$/,
      extract: (m) => [m[1]],
    },
    // echo ... > <file> or >> <file>
    {
      regex: /echo\s+.*?>+\s*(\S+)$/,
      extract: (m) => [m[1]],
    },
    // cat ... > <file> or >> <file>
    {
      regex: /cat\s+.*?>+\s*(\S+)$/,
      extract: (m) => [m[1]],
    },
    // General redirect: ... > <file> or >> <file>
    {
      regex: />+\s*(\S+)\s*$/,
      extract: (m) => [m[1]],
    },
    // mkdir [-flags] <dir> [<dir>...]
    {
      regex: /^mkdir\s+(?:-[a-zA-Z]+\s+)*(.+)$/,
      extract: (m) => parseSpaceSeparatedArgs(m[1]),
    },
  ];

  for (const { regex, extract } of patterns) {
    const match = trimmed.match(regex);
    if (match) {
      files.push(...extract(match));
      break;
    }
  }

  return files;
}

function parseSpaceSeparatedArgs(argsStr: string): string[] {
  return argsStr
    .split(/\s+/)
    .filter((p) => p && !p.startsWith("-"));
}

// =============================================================================
// Git Utilities
// =============================================================================

async function getGitRoot(pi: ExtensionAPI): Promise<string | null> {
  const { stdout, code } = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
  return code === 0 ? stdout.trim() : null;
}

async function isGitRepo(pi: ExtensionAPI): Promise<boolean> {
  return (await getGitRoot(pi)) !== null;
}

async function getStagedFiles(pi: ExtensionAPI): Promise<string[]> {
  const { stdout, code } = await pi.exec("git", ["diff", "--cached", "--name-only"]);
  if (code !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

async function createCommit(
  pi: ExtensionAPI,
  message: string
): Promise<{ hash: string } | { error: string }> {
  const { stdout, stderr, code } = await pi.exec("git", ["commit", "-m", message]);
  if (code !== 0) {
    return { error: stderr || stdout || "Commit failed" };
  }

  const { stdout: hashOutput, code: hashCode } = await pi.exec("git", ["rev-parse", "HEAD"]);
  if (hashCode !== 0) {
    return { error: "Failed to get commit hash" };
  }

  return { hash: hashOutput.trim() };
}

function formatCommitHash(hash: string): string {
  return hash.slice(0, 7);
}

// =============================================================================
// Extension State
// =============================================================================

interface ExtensionState {
  repoRoot: string | null;
  sessionId: string | null;
  sessionData: SessionData | null;
  currentPromptId: string | null;
  pendingChanges: Map<string, PendingChange>;
}

function createInitialState(): ExtensionState {
  return {
    repoRoot: null,
    sessionId: null,
    sessionData: null,
    currentPromptId: null,
    pendingChanges: new Map(),
  };
}

async function initializeState(
  state: ExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<void> {
  state.repoRoot = await getGitRoot(pi);
  state.sessionId = ctx.sessionManager.getSessionFile() ?? `ephemeral-${Date.now()}`;
  state.currentPromptId = null;
  state.pendingChanges.clear();

  if (state.repoRoot) {
    state.sessionData = await readSessionData(state.repoRoot, state.sessionId);
  } else {
    state.sessionData = null;
  }
}

function saveState(state: ExtensionState): void {
  if (state.repoRoot && state.sessionData) {
    writeSessionDataSync(state.repoRoot, state.sessionData);
  }
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function promptCommitExtension(pi: ExtensionAPI) {
  const state = createInitialState();

  // ---------------------------------------------------------------------------
  // Session Lifecycle
  // ---------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    await initializeState(state, pi, ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await initializeState(state, pi, ctx);
  });

  // ---------------------------------------------------------------------------
  // Prompt Capture
  // ---------------------------------------------------------------------------

  pi.on("input", async (event, ctx) => {
    // Ensure state is initialized
    if (!state.repoRoot) {
      state.repoRoot = await getGitRoot(pi);
    }
    if (!state.repoRoot) {
      // Not in a git repo, skip tracking
      return { action: "continue" as const };
    }

    if (!state.sessionId) {
      state.sessionId = ctx.sessionManager.getSessionFile() ?? `ephemeral-${Date.now()}`;
    }
    if (!state.sessionData) {
      state.sessionData = await readSessionData(state.repoRoot, state.sessionId);
    }

    // Track the prompt
    state.currentPromptId = addPrompt(state.sessionData, event.text);
    saveState(state);

    return { action: "continue" as const };
  });

  // ---------------------------------------------------------------------------
  // File Change Tracking
  // ---------------------------------------------------------------------------

  pi.on("tool_call", async (event, _ctx) => {
    if (!state.currentPromptId || !state.repoRoot) return;

    const { toolName, toolCallId, input } = event;
    const lowerName = toolName.toLowerCase();

    if (lowerName === "write" || lowerName === "edit") {
      const filePath = (input as { path?: string }).path;
      if (filePath) {
        state.pendingChanges.set(toolCallId, {
          toolCallId,
          filePath,
          toolName: lowerName,
        });
      }
    } else if (lowerName === "bash") {
      const command = (input as { command?: string }).command;
      if (command) {
        const files = extractFilesFromBashCommand(command);
        for (const filePath of files) {
          state.pendingChanges.set(`${toolCallId}-${filePath}`, {
            toolCallId,
            filePath,
            toolName: "bash",
          });
        }
      }
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!state.currentPromptId || !state.sessionData) return;

    const { toolCallId, isError } = event;

    // Find pending changes for this tool call
    const matchingKeys = [...state.pendingChanges.keys()].filter(
      (key) => state.pendingChanges.get(key)?.toolCallId === toolCallId
    );

    if (isError) {
      // Remove pending changes on error
      for (const key of matchingKeys) {
        state.pendingChanges.delete(key);
      }
      return;
    }

    // Record successful file changes
    for (const key of matchingKeys) {
      const change = state.pendingChanges.get(key);
      if (change) {
        addFileChange(
          state.sessionData,
          state.currentPromptId,
          change.filePath,
          change.toolName
        );
        state.pendingChanges.delete(key);
      }
    }

    saveState(state);
  });

  // ---------------------------------------------------------------------------
  // /pcommit Command
  // ---------------------------------------------------------------------------

  pi.registerCommand("pcommit", {
    description: "Commit staged changes with linked AI prompts",

    handler: async (args, ctx) => {
      // Validate git repo
      if (!(await isGitRepo(pi))) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      // Validate staged files
      const stagedFiles = await getStagedFiles(pi);
      if (stagedFiles.length === 0) {
        ctx.ui.notify("No staged files. Use 'git add' first.", "warning");
        return;
      }

      // Validate session
      if (!state.repoRoot || !state.sessionId || !state.sessionData) {
        ctx.ui.notify("No active session", "error");
        return;
      }

      // Find linked prompts
      const linkedPrompts = findPromptsForFiles(
        state.sessionData,
        stagedFiles,
        ctx.cwd
      );

      // Build commit message
      const settings = await readSettings(state.repoRoot);
      const commitMessage = buildCommitMessage(
        args,
        linkedPrompts,
        state.sessionId,
        settings
      );

      // Create the commit
      const result = await createCommit(pi, commitMessage);
      if ("error" in result) {
        ctx.ui.notify(`Commit failed: ${result.error}`, "error");
        return;
      }

      // Record the commit
      addCommit(
        state.sessionData,
        result.hash,
        commitMessage,
        linkedPrompts.map((p) => p.id)
      );
      saveState(state);

      // Show success
      const shortHash = formatCommitHash(result.hash);
      const promptCount = linkedPrompts.length;
      const promptWord = promptCount === 1 ? "prompt" : "prompts";
      ctx.ui.notify(
        `Committed ${shortHash} with ${promptCount} linked ${promptWord}`,
        "success"
      );
    },
  });
}
