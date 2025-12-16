import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface ChangedFunction {
  id: string;
  file: string;
  functionName: string;
  module?: string;
  line: number;
  endLine?: number | null;
}

export interface FlowEntry {
  entrypoint: string;
  sequence: string[];
}

export interface FunctionBody {
  id: string;
  file: string;
  line: number;
  body: string;
}

export interface PythonAnalysis {
  changedFunctions: ChangedFunction[];
  flows: FlowEntry[];
  warnings: string[];
  functionBodies: Record<string, FunctionBody>;
}

export async function analyzeWithPython(workspacePath: string, extensionPath: string): Promise<PythonAnalysis> {
  const scriptPath = path.join(extensionPath, 'python', 'linearizer.py');
  try {
    await fs.access(scriptPath, fs.constants.X_OK);
  } catch {
    try {
      await fs.access(scriptPath);
    } catch {
      throw new Error(`Python tooling script not found at ${scriptPath}`);
    }
  }

  const repoRoot = await resolveRepoRoot(workspacePath);
  const candidates = buildPythonCandidates();
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const output = await invokePython(candidate, scriptPath, repoRoot);
      const { list: changedFunctions, bodies } = await loadChangedFunctions(repoRoot);
      const flows = await loadFlows(repoRoot, output);
      const warnings = extractWarnings(output);
      const functionBodies = Object.fromEntries(bodies.entries());
      return {
        changedFunctions,
        flows,
        warnings,
        functionBodies,
      };
    } catch (error: unknown) {
      if (isCommandNotFound(error)) {
        lastError = error;
        continue;
      }
      if (isPythonToolError(error)) {
        throw new Error(error.message);
      }
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
  throw new Error(`Unable to execute Python linearizer. Candidates tried: ${candidates.join(', ')}. Details: ${detail}`);
}

export async function resolveRepoRoot(workspacePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: workspacePath });
    return stdout.trim();
  } catch (error) {
    throw new Error('The workspace folder is not inside a Git repository.');
  }
}

function buildPythonCandidates(): string[] {
  const config = vscode.workspace.getConfiguration('linearizer');
  const configured = config.get<string>('pythonPath');
  const candidates: string[] = [];

  if (configured && configured.trim().length > 0) {
    candidates.push(configured.trim());
  }

  if (process.platform === 'win32') {
    candidates.push('python', 'python3');
  } else {
    candidates.push('python3', 'python');
  }

  return Array.from(new Set(candidates));
}

async function invokePython(pythonExecutable: string, scriptPath: string, repoRoot: string): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await execFileAsync(
      pythonExecutable,
      [scriptPath, '--repo', repoRoot],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    return parsePythonOutput(stdout);
  } catch (error: unknown) {
    const stdout = getErrorField(error, 'stdout');
    if (typeof stdout === 'string' && stdout.trim().length > 0) {
      const parsed = parsePythonMaybeError(stdout);
      if (parsed) {
        throw new PythonToolError(parsed);
      }
    }

    const code = getErrorCode(error);
    if (code === 'ENOENT') {
      const notFound = new Error(`Python executable "${pythonExecutable}" was not found.`);
      (notFound as NodeJS.ErrnoException).code = 'ENOENT';
      throw notFound;
    }

    const stderr = getErrorField(error, 'stderr');
    const message = getErrorField(error, 'message');
    const detail = typeof stderr === 'string' && stderr.trim().length > 0
      ? stderr.trim()
      : typeof message === 'string' && message.trim().length > 0
        ? message.trim()
        : 'Unknown error';
    throw new Error(`Python execution failed: ${detail}`);
  }
}

function parsePythonOutput(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('Python tooling returned no output.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Unable to parse Python output as JSON: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Python tooling returned malformed data.');
  }

  if (!isRecord(parsed)) {
    throw new Error('Python tooling returned malformed data.');
  }

  if (typeof parsed.error === 'string') {
    throw new Error(parsed.error);
  }

  return parsed;
}

function parsePythonMaybeError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    return null;
  }
  return null;
}

class PythonToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PythonToolError';
  }
}

function isPythonToolError(error: unknown): error is PythonToolError {
  return error instanceof PythonToolError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorField(error: unknown, field: string): unknown {
  if (isRecord(error) && field in error) {
    return (error as Record<string, unknown>)[field];
  }
  return undefined;
}

function getErrorCode(error: unknown): string | number | undefined {
  const value = getErrorField(error, 'code');
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  return undefined;
}

function isCommandNotFound(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 'ENOENT';
}

function toStringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

function toNumberValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

async function loadChangedFunctions(repoRoot: string): Promise<{ list: ChangedFunction[]; bodies: Map<string, FunctionBody> }>
{
  const filePath = path.join(repoRoot, 'functions.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return { list: [], bodies: new Map() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { list: [], bodies: new Map() };
  }

  if (!isRecord(parsed)) {
    return { list: [], bodies: new Map() };
  }

  const results: ChangedFunction[] = [];
  const bodies = new Map<string, FunctionBody>();

  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      continue;
    }

    const functionName = extractFunctionName(key);
    if (!functionName) {
      continue;
    }

    const absolutePath = typeof value.file_path === 'string' ? value.file_path : undefined;
    const relativePath = absolutePath ? toRepoRelativePath(repoRoot, absolutePath) : extractRelativePath(key);
    if (!relativePath) {
      continue;
    }

    const displayFile = normalizePathSeparators(relativePath);
    const module = toModuleName(displayFile);
    const startLine = toNumberValue(value.start_line) ?? 1;
    const id = key.startsWith('/') ? key : `/${key}`;
    const body = typeof value.body === 'string' ? value.body : '';

    results.push({
      id,
      file: displayFile,
      functionName,
      module,
      line: startLine,
    });

    bodies.set(id, {
      id,
      file: displayFile,
      line: startLine,
      body,
    });
  }

  const sorted = results.sort((a, b) => {
    if (a.file === b.file) {
      return a.line - b.line;
    }
    return a.file.localeCompare(b.file);
  });

  return { list: sorted, bodies };
}

async function loadFlows(repoRoot: string, pythonOutput: Record<string, unknown>): Promise<FlowEntry[]> {
  const directFlows = extractFlowsFromOutput(pythonOutput);
  if (directFlows.length > 0) {
    return directFlows;
  }

  const fileCandidates = [
    'flows.json',
    'flow.json',
    'call_flows.json',
    'linearized_flows.json',
    'parent_functions.json',
  ];

  for (const candidate of fileCandidates) {
    const absolute = path.join(repoRoot, candidate);
    try {
      const raw = await fs.readFile(absolute, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const flows = interpretFlowArtifacts(parsed);
      if (flows.length > 0) {
        return flows;
      }
    } catch {
      // Ignore missing or malformed files.
    }
  }

  return [];
}

function extractWarnings(pythonOutput: Record<string, unknown>): string[] {
  if (Array.isArray(pythonOutput.warnings)) {
    return pythonOutput.warnings
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof pythonOutput.warning === 'string') {
    const trimmed = pythonOutput.warning.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  return [];
}

function extractFlowsFromOutput(pythonOutput: Record<string, unknown>): FlowEntry[] {
  if (Array.isArray(pythonOutput.flows)) {
    return interpretFlowArtifacts(pythonOutput.flows);
  }

  if (Array.isArray(pythonOutput.parents)) {
    return pythonOutput.parents
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => ({ entrypoint: entry, sequence: [] }));
  }

  return [];
}

function interpretFlowArtifacts(artifact: unknown): FlowEntry[] {
  if (Array.isArray(artifact)) {
    return artifact
      .map((entry): FlowEntry | null => {
        if (typeof entry === 'string') {
          const trimmed = entry.trim();
          return trimmed.length > 0 ? { entrypoint: trimmed, sequence: [] } : null;
        }

        if (isRecord(entry)) {
          const entrypoint = toStringValue(entry.entrypoint ?? entry.root ?? entry.name ?? '');
          if (!entrypoint) {
            return null;
          }
          const sequence = Array.isArray(entry.sequence)
            ? entry.sequence.map((value: unknown) => toStringValue(value)).filter((value) => value.length > 0)
            : [];
          return { entrypoint, sequence };
        }

        return null;
      })
      .filter((entry): entry is FlowEntry => entry !== null);
  }

  if (isRecord(artifact)) {
    const entrypoint = toStringValue(artifact.entrypoint ?? artifact.root ?? '');
    if (!entrypoint) {
      return [];
    }
    const sequence = Array.isArray(artifact.sequence)
      ? artifact.sequence.map((value: unknown) => toStringValue(value)).filter((value) => value.length > 0)
      : [];
    return [{ entrypoint, sequence }];
  }

  return [];
}

function extractFunctionName(identifier: string): string | null {
  const cleaned = identifier.startsWith('/') ? identifier.slice(1) : identifier;
  const parts = cleaned.split('::');
  if (parts.length < 2) {
    return null;
  }
  return parts[parts.length - 1];
}

function extractRelativePath(identifier: string): string | null {
  const cleaned = identifier.startsWith('/') ? identifier.slice(1) : identifier;
  const parts = cleaned.split('::');
  if (parts.length < 2) {
    return null;
  }
  return parts.slice(0, parts.length - 1).join('::');
}

function toModuleName(relativePath: string): string | undefined {
  if (!relativePath.endsWith('.py')) {
    return undefined;
  }
  const withoutExtension = relativePath.slice(0, -3);
  if (!withoutExtension) {
    return undefined;
  }
  const dotted = withoutExtension.replace(/[\\/]+/g, '.');
  if (dotted.endsWith('.__init__')) {
    return dotted.slice(0, dotted.length - '.__init__'.length);
  }
  return dotted;
}

function normalizePathSeparators(value: string): string {
  return value.replace(/[\\]+/g, '/');
}

function toRepoRelativePath(repoRoot: string, absolutePath: string): string | null {
  try {
    const relative = path.relative(repoRoot, absolutePath);
    return normalizePathSeparators(relative);
  } catch {
    return null;
  }
}
