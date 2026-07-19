import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { RepositoryBoundary } from "../repository/index.js";
import { DEFAULT_GIT_EXECUTABLE } from "../repository/boundary.js";
import { AgentError, errorMessage } from "../shared/errors.js";
import { info, success, warning, type Writable } from "./presentation.js";
import { confirmPrompt, selectPrompt, textPrompt } from "./prompts.js";
import { CURRENT_HOST_PLATFORM } from "../platform/index.js";

const execFileAsync = promisify(execFile);
const IMPORT_METADATA_VERSION = "cope-file-import/1" as const;

export class WorkspaceExitRequestedError extends Error {
  public constructor() {
    super("Workspace selection closed");
    this.name = "WorkspaceExitRequestedError";
  }
}

export interface WorkspaceResolution {
  readonly repositoryRoot: string;
  readonly originalSelection: string;
  readonly copiedFromFile?: string;
  readonly copiedFileName?: string;
  readonly originalSha256?: string;
}

export interface WorkspaceResolutionOptions {
  readonly interactive: boolean;
  readonly output?: Writable;
  readonly implicitSelection?: boolean;
  readonly preferredRepository?: string;
}

export async function resolveWorkspace(
  requestedPath: string,
  options: WorkspaceResolutionOptions,
): Promise<WorkspaceResolution> {
  const output = options.output ?? process.stdout;
  const absolute = path.resolve(stripWrappingQuotes(requestedPath));
  let entry: Awaited<ReturnType<typeof stat>>;
  try {
    entry = await stat(absolute);
  } catch (error) {
    if (!options.interactive) {
      throw new AgentError("CONFIG_INVALID", `Project path does not exist: ${absolute}`, {}, { cause: error });
    }
    warning(`I could not find ${absolute}`, output);
    const replacement = await textPrompt("Project folder or file");
    return resolveWorkspace(replacement, { interactive: true, output, implicitSelection: false });
  }

  if (entry.isFile()) {
    const existing = await tryDiscover(path.dirname(absolute));
    if (existing !== undefined) return withImportMetadata(existing.root, absolute);
    if (!options.interactive) {
      throw new AgentError(
        "CONFIG_INVALID",
        "Cope needs a Git project, but the selected file is not inside one",
        { file: absolute, next: `Run cope "${absolute}" in an interactive terminal.` },
      );
    }
    return createWorkspaceForFile(absolute, output);
  }

  if (!entry.isDirectory()) {
    throw new AgentError("CONFIG_INVALID", "The selected project path is not a regular file or directory", { path: absolute });
  }

  const existing = await tryDiscover(absolute);
  if (existing !== undefined) return withImportMetadata(existing.root, absolute);
  if (!options.interactive) {
    throw new AgentError(
      "CONFIG_INVALID",
      "Cope needs a Git repository and the selected folder is not one",
      { directory: absolute, next: `Run cope "${absolute}" interactively.` },
    );
  }

  if (options.implicitSelection === true) return chooseInitialWorkspace(absolute, options, output);

  warning("This folder is not a Git repository yet.", output);
  const decision = await selectPrompt("How should Cope open it?", [
    {
      value: "initialize",
      label: "Initialize Git here",
      description: "Keeps every file in place and adds a local .git directory",
    },
    { value: "choose", label: "Choose another project", description: "Enter a different folder or file" },
    { value: "exit", label: "Exit" },
  ] as const);

  if (decision === "exit") throw new WorkspaceExitRequestedError();
  if (decision === "choose") {
    const replacement = await textPrompt("Project folder or file");
    return resolveWorkspace(replacement, { interactive: true, output, implicitSelection: false });
  }
  await initializeGitRepository(absolute);
  success(`Initialized Git in ${absolute}`, output);
  return { repositoryRoot: await realpath(absolute), originalSelection: absolute };
}

async function chooseInitialWorkspace(
  currentDirectory: string,
  options: WorkspaceResolutionOptions,
  output: Writable,
): Promise<WorkspaceResolution> {
  const preferred = await resolvePreferredRepository(options.preferredRepository, currentDirectory);
  info("Choose the project Cope should open.", output);
  const choices: Array<{
    readonly value: "last" | "choose" | "initialize" | "exit";
    readonly label: string;
    readonly description?: string;
  }> = [];
  if (preferred !== undefined) {
    choices.push({ value: "last", label: `Open last project (${path.basename(preferred)})`, description: preferred });
  }
  choices.push(
    { value: "choose", label: "Choose a project or file", description: "Paste a folder path or an individual file path" },
    { value: "initialize", label: "Initialize this folder", description: `Create a Git repository in ${currentDirectory}` },
    { value: "exit", label: "Exit" },
  );
  const decision = await selectPrompt("Start Cope", choices);
  if (decision === "exit") throw new WorkspaceExitRequestedError();
  if (decision === "last" && preferred !== undefined) {
    return resolveWorkspace(preferred, { interactive: true, output, implicitSelection: false });
  }
  if (decision === "choose") {
    const replacement = await textPrompt("Project folder or file");
    return resolveWorkspace(replacement, { interactive: true, output, implicitSelection: false });
  }
  await initializeGitRepository(currentDirectory);
  success(`Initialized Git in ${currentDirectory}`, output);
  return { repositoryRoot: await realpath(currentDirectory), originalSelection: currentDirectory };
}

async function resolvePreferredRepository(candidate: string | undefined, currentDirectory: string): Promise<string | undefined> {
  if (candidate === undefined) return undefined;
  const absolute = path.resolve(candidate);
  if (absolute === currentDirectory) return undefined;
  try {
    const entry = await stat(absolute);
    if (!entry.isDirectory()) return undefined;
    return (await tryDiscover(absolute))?.root;
  } catch {
    return undefined;
  }
}

async function createWorkspaceForFile(file: string, output: Writable): Promise<WorkspaceResolution> {
  warning("Cope works inside Git projects, so this standalone file needs a small workspace.", output);
  const decision = await selectPrompt("How should I handle this file?", [
    { value: "copy", label: "Create a clean project copy", description: "Recommended. Leaves the original untouched" },
    { value: "parent", label: "Initialize the containing folder", description: `Turns ${path.dirname(file)} into a Git repository` },
    { value: "choose", label: "Choose another project" },
    { value: "exit", label: "Exit" },
  ] as const);

  if (decision === "exit") throw new WorkspaceExitRequestedError();
  if (decision === "choose") {
    const replacement = await textPrompt("Project folder or file");
    return resolveWorkspace(replacement, { interactive: true, output, implicitSelection: false });
  }
  if (decision === "parent") {
    const parent = path.dirname(file);
    await initializeGitRepository(parent);
    success(`Initialized Git in ${parent}`, output);
    return { repositoryRoot: await realpath(parent), originalSelection: file };
  }

  const suggested = await uniqueWorkspacePath(file);
  const target = path.resolve(await textPrompt("Workspace folder", { defaultValue: suggested }));
  await mkdir(target, { recursive: false });
  const copiedFileName = path.basename(file);
  const targetFile = path.join(target, copiedFileName);
  await copyFile(file, targetFile);
  await initializeGitRepository(target);
  await createBaselineCommit(target, copiedFileName);
  await excludeCopeMetadata(target);
  const repositoryRoot = await realpath(target);
  const original = await realpath(file);
  const originalSha256 = await fileSha256(original);
  await writeImportMetadata(repositoryRoot, {
    schema_version: IMPORT_METADATA_VERSION,
    original_file: original,
    copied_file: copiedFileName,
    original_sha256: originalSha256,
  });
  info(`Copied ${copiedFileName} into a dedicated project.`, output);
  success(`Workspace ready at ${target}`, output);
  return {
    repositoryRoot,
    originalSelection: file,
    copiedFromFile: original,
    copiedFileName,
    originalSha256,
  };
}

export async function syncWorkspaceCopy(
  workspace: WorkspaceResolution,
  options: { readonly interactive: boolean; readonly output?: Writable },
): Promise<WorkspaceResolution> {
  if (workspace.copiedFromFile === undefined || workspace.copiedFileName === undefined || workspace.originalSha256 === undefined) {
    return workspace;
  }
  const output = options.output ?? process.stdout;
  const workspaceFile = path.join(workspace.repositoryRoot, workspace.copiedFileName);
  let workspaceEntry: Awaited<ReturnType<typeof lstat>>;
  let originalEntry: Awaited<ReturnType<typeof lstat>>;
  try {
    [workspaceEntry, originalEntry] = await Promise.all([lstat(workspaceFile), lstat(workspace.copiedFromFile)]);
  } catch (error) {
    warning(`Could not sync the imported file: ${errorMessage(error)}`, output);
    return workspace;
  }
  if (!workspaceEntry.isFile() || workspaceEntry.isSymbolicLink() || !originalEntry.isFile() || originalEntry.isSymbolicLink()) {
    warning("The imported file or original is no longer a regular file, so Cope did not overwrite it.", output);
    return workspace;
  }

  const [workspaceSha256, currentOriginalSha256] = await Promise.all([
    fileSha256(workspaceFile),
    fileSha256(workspace.copiedFromFile),
  ]);
  if (workspaceSha256 === currentOriginalSha256) return { ...workspace, originalSha256: workspaceSha256 };
  if (currentOriginalSha256 !== workspace.originalSha256) {
    warning("The original file changed after it was imported. Cope left both copies untouched.", output);
    info(`Edited workspace: ${workspaceFile}`, output);
    info(`Original file:   ${workspace.copiedFromFile}`, output);
    return workspace;
  }
  if (!options.interactive) {
    warning("Verified changes remain in the project copy because no interactive terminal is attached.", output);
    info(`Edited file: ${workspaceFile}`, output);
    return workspace;
  }
  const approved = await confirmPrompt(`Copy the verified changes back to ${path.basename(workspace.copiedFromFile)}?`, true);
  if (!approved) {
    info(`Kept the edited copy at ${workspaceFile}`, output);
    return workspace;
  }

  const temporary = `${workspace.copiedFromFile}.${process.pid}.${Date.now()}.cope.tmp`;
  try {
    await copyFile(workspaceFile, temporary);
    if (CURRENT_HOST_PLATFORM.supportsPosixModes) await chmod(temporary, originalEntry.mode);
    await rename(temporary, workspace.copiedFromFile);
  } catch (error) {
    throw new AgentError(
      "RECOVERY_REQUIRED",
      `The project is complete, but copying it back to the original failed: ${errorMessage(error)}`,
      { workspaceFile, originalFile: workspace.copiedFromFile },
      { cause: error },
    );
  }
  const updated = { ...workspace, originalSha256: workspaceSha256 };
  await writeImportMetadata(workspace.repositoryRoot, {
    schema_version: IMPORT_METADATA_VERSION,
    original_file: workspace.copiedFromFile,
    copied_file: workspace.copiedFileName,
    original_sha256: workspaceSha256,
  });
  success(`Updated ${workspace.copiedFromFile}`, output);
  return updated;
}

export async function initializeGitRepository(directory: string): Promise<void> {
  try {
    await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["init", "--quiet", directory], {
      windowsHide: true,
      maxBuffer: 128 * 1024,
    });
  } catch (error) {
    throw new AgentError(
      "CONFIG_INVALID",
      `Could not initialize Git in ${directory}: ${errorMessage(error)}`,
      { executable: DEFAULT_GIT_EXECUTABLE },
      { cause: error },
    );
  }
}

async function excludeCopeMetadata(repositoryRoot: string): Promise<void> {
  const filename = path.join(repositoryRoot, ".git", "info", "exclude");
  let current = "";
  try { current = await readFile(filename, "utf8"); } catch { /* Git creates this file, but appendFile can create it if needed. */ }
  if (/^(?:\.\/)?\.cba\/$/mu.test(current)) return;
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await appendFile(filename, `${prefix}\n# Cope local configuration\n.cba/\n`, "utf8");
}

async function createBaselineCommit(directory: string, filename: string): Promise<void> {
  try {
    await execFileAsync(DEFAULT_GIT_EXECUTABLE, ["-C", directory, "add", "--", filename], { windowsHide: true, maxBuffer: 128 * 1024 });
    await execFileAsync(
      DEFAULT_GIT_EXECUTABLE,
      ["-C", directory, "-c", "user.name=Cope", "-c", "user.email=cope@local.invalid", "commit", "--quiet", "-m", "Baseline before Cope"],
      { windowsHide: true, maxBuffer: 128 * 1024 },
    );
  } catch (error) {
    throw new AgentError(
      "CONFIG_INVALID",
      `The workspace was created, but its baseline commit failed: ${errorMessage(error)}`,
      { directory },
      { cause: error },
    );
  }
}

async function tryDiscover(startPath: string): Promise<RepositoryBoundary | undefined> {
  try {
    return await RepositoryBoundary.discover(startPath);
  } catch (error) {
    if (error instanceof AgentError && error.code === "CONFIG_INVALID") return undefined;
    throw error;
  }
}

async function uniqueWorkspacePath(file: string): Promise<string> {
  const extension = path.extname(file);
  const stem = path.basename(file, extension).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "project";
  const parent = path.dirname(file);
  const base = path.join(parent, `${stem}-cope`);
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    try {
      await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new AgentError("CONFIG_INVALID", "Could not choose a unique workspace folder", { file });
}

async function withImportMetadata(repositoryRoot: string, originalSelection: string): Promise<WorkspaceResolution> {
  const base: WorkspaceResolution = { repositoryRoot, originalSelection };
  try {
    const raw = JSON.parse(await readFile(path.join(repositoryRoot, ".cba", "file-import.json"), "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return base;
    const value = raw as Readonly<Record<string, unknown>>;
    if (
      value.schema_version !== IMPORT_METADATA_VERSION ||
      typeof value.original_file !== "string" || !path.isAbsolute(value.original_file) ||
      typeof value.copied_file !== "string" || path.basename(value.copied_file) !== value.copied_file ||
      typeof value.original_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.original_sha256)
    ) return base;
    return {
      ...base,
      copiedFromFile: value.original_file,
      copiedFileName: value.copied_file,
      originalSha256: value.original_sha256,
    };
  } catch {
    return base;
  }
}

async function writeImportMetadata(
  repositoryRoot: string,
  value: {
    readonly schema_version: typeof IMPORT_METADATA_VERSION;
    readonly original_file: string;
    readonly copied_file: string;
    readonly original_sha256: string;
  },
): Promise<void> {
  const directory = path.join(repositoryRoot, ".cba");
  const filename = path.join(directory, "file-import.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
}

async function fileSha256(filename: string): Promise<string> {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}
