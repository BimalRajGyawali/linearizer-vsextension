import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FunctionSignatureInfo, TraceCallArgs, ExtractCallArgsOptions, ExtractCallArgsResult } from '../types';
import { FunctionBody } from '../changedFunctions';
import { getRepoRoot } from '../state/runtime';

const execFileAsync = promisify(execFile);

export async function getPythonPath(): Promise<string> {
  const config = vscode.workspace.getConfiguration('linearizer');
  const configured = config.get<string>('pythonPath');
  if (configured && configured.trim().length > 0) {
    return configured.trim();
  }
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['--version']);
      return candidate;
    } catch {
      // Continue
    }
  }
  throw new Error('Python executable not found. Please configure linearizer.pythonPath');
}

export async function extractCallArguments(
  pythonPath: string,
  repoRoot: string,
  nestedFunctionId: string,
  parentFile: string,
  callLine: number,
  locals: Record<string, unknown>,
  globals: Record<string, unknown>,
  extensionPath: string,
  options?: ExtractCallArgsOptions,
): Promise<ExtractCallArgsResult | null> {
  try {
    const tracerScript = path.join(extensionPath, 'python', 'tracer.py');
    const nestedEntryFullId = nestedFunctionId.startsWith('/') ? nestedFunctionId.slice(1) : nestedFunctionId;

    const args = [
      tracerScript,
      '--extract-call-args',
      '--repo_root', repoRoot,
      '--entry_full_id', nestedEntryFullId,
      '--parent-file', parentFile,
      '--call-line', String(callLine),
      '--locals', JSON.stringify(locals),
      '--globals', JSON.stringify(globals),
    ];

    if (options?.callingEntryFullId) {
      const normalizedCallingEntry = options.callingEntryFullId.startsWith('/')
        ? options.callingEntryFullId.slice(1)
        : options.callingEntryFullId;
      args.push('--calling-entry-full-id', normalizedCallingEntry);
      if (options.callingArgsJson) {
        args.push('--calling-args-json', options.callingArgsJson);
      }
    }

    const result = await execFileAsync(pythonPath, args, {
      timeout: 30000,
      cwd: repoRoot,
    });

    const parsed = JSON.parse(result.stdout);
    if (parsed.error) {
      return { error: String(parsed.error) };
    }
    if (parsed.args) {
      return parsed.args as TraceCallArgs;
    }
    return { error: 'Tracer did not return arguments for the selected call site' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: errorMessage };
  }
}

export interface CallSiteResult {
  file: string;
  line: number;
  column: number;
  call_line: string;
  context: string[];
  calling_function: string | null;
  calling_function_id: string | null;
}

export async function findCallSites(
  pythonPath: string,
  repoRoot: string,
  functionId: string,
  extensionPath: string,
): Promise<CallSiteResult[]> {
  const scriptPath = path.join(extensionPath, 'python', 'find_call_sites.py');
  const entryFullId = functionId.startsWith('/') ? functionId.slice(1) : functionId;
  const { stdout } = await execFileAsync(
    pythonPath,
    ['-u', scriptPath, '--repo', repoRoot, '--function-id', entryFullId],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const result = JSON.parse(trimmed);
  return Array.isArray(result.call_sites) ? result.call_sites : [];
}

export async function getFunctionSignature(
  pythonPath: string,
  repoRoot: string,
  entryFullId: string,
  extensionPath: string,
): Promise<FunctionSignatureInfo | null> {
  const tracerPath = path.join(extensionPath, 'python', 'tracer.py');
  try {
    await fs.access(tracerPath);
  } catch {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      pythonPath,
      [
        tracerPath,
        '--repo_root', repoRoot,
        '--entry_full_id', entryFullId,
        '--get_signature',
      ],
      { cwd: repoRoot },
    );
    const parsed = JSON.parse(stdout);
    if (parsed.error) {
      return null;
    }
    return parsed as FunctionSignatureInfo;
  } catch {
    return null;
  }
}

export async function hydrateFunctionBodies(
  functionBodies: Record<string, FunctionBody>,
): Promise<Record<string, FunctionBody>> {
  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    return functionBodies;
  }

  const entries = await Promise.all(
    Object.entries(functionBodies).map(async ([id, body]) => {
      if (!body?.file) {
        return [id, body] as const;
      }
      try {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.file(path.join(repoRoot, body.file)),
        );
        const fallbackText = typeof body.body === 'string' ? body.body : '';
        const lineCount = Math.max(fallbackText.split(/\r?\n/).length, 1);
        const startLine = Math.max((body.line ?? 1) - 1, 0);
        const endLine = Math.min(startLine + lineCount, document.lineCount);
        const range = new vscode.Range(
          new vscode.Position(startLine, 0),
          new vscode.Position(endLine, 0),
        );
        const extracted = document.getText(range).replace(/\r\n/g, '\n');
        const normalised = extracted.endsWith('\n') ? extracted.slice(0, -1) : extracted;
        return [id, { ...body, body: normalised || fallbackText }] as const;
      } catch {
        return [id, body] as const;
      }
    }),
  );

  return Object.fromEntries(entries);
}
