import * as vscode from 'vscode';
import { FlowEntry, FunctionBody } from '../changedFunctions';
import { ExecutionContext, NormalisedCallArgs } from '../types';

interface RuntimeState {
  repoRoot?: string;
  functionBodies: Record<string, FunctionBody>;
  flowPanel?: vscode.WebviewPanel;
  flowPanelMessageDisposable?: vscode.Disposable;
  flows: FlowEntry[];
}

const state: RuntimeState = {
  functionBodies: {},
  flows: [],
};

const storedCallArgs = new Map<string, NormalisedCallArgs>();
const parentExecutionContextCache = new Map<string, ExecutionContext>();
const lastExecutedLineByContext = new Map<string, number>();
const flowRootIndex = new Map<string, string>();

function normaliseFunctionId(functionId: string | undefined): string | undefined {
  if (!functionId) {
    return undefined;
  }
  return functionId.startsWith('/') ? functionId : `/${functionId}`;
}

export function getRepoRoot(): string | undefined {
  return state.repoRoot;
}

export function setRepoRoot(repoRoot: string | undefined): void {
  state.repoRoot = repoRoot;
}

export function getFunctionBodies(): Record<string, FunctionBody> {
  return state.functionBodies;
}

export function setFunctionBodies(bodies: Record<string, FunctionBody>): void {
  state.functionBodies = bodies;
}

export function setFlowEntries(flows: FlowEntry[]): void {
  state.flows = Array.isArray(flows) ? flows : [];
  flowRootIndex.clear();
  for (const entry of state.flows) {
    if (!entry || typeof entry.entrypoint !== 'string') {
      continue;
    }
    const rootId = normaliseFunctionId(entry.entrypoint);
    if (!rootId) {
      continue;
    }
    flowRootIndex.set(rootId, rootId);
    const sequence = Array.isArray(entry.sequence) ? entry.sequence : [];
    for (const item of sequence) {
      if (typeof item !== 'string') {
        continue;
      }
      const normalizedChild = normaliseFunctionId(item);
      if (!normalizedChild) {
        continue;
      }
      if (!flowRootIndex.has(normalizedChild)) {
        flowRootIndex.set(normalizedChild, rootId);
      }
    }
  }
}

export function getFlowEntries(): FlowEntry[] {
  return state.flows;
}

export function getFlowRootForFunction(functionId: string | undefined): string | undefined {
  const normalized = normaliseFunctionId(functionId);
  if (!normalized) {
    return undefined;
  }
  return flowRootIndex.get(normalized);
}

export function getFlowPanel(): vscode.WebviewPanel | undefined {
  return state.flowPanel;
}

export function setFlowPanel(panel: vscode.WebviewPanel | undefined): void {
  state.flowPanel = panel;
}

export function getFlowPanelDisposable(): vscode.Disposable | undefined {
  return state.flowPanelMessageDisposable;
}

export function setFlowPanelDisposable(disposable: vscode.Disposable | undefined): void {
  state.flowPanelMessageDisposable = disposable;
}

export function getStoredCallArgsMap(): Map<string, NormalisedCallArgs> {
  return storedCallArgs;
}

export function getExecutionContextCache(): Map<string, ExecutionContext> {
  return parentExecutionContextCache;
}

export function getLastExecutedLineMap(): Map<string, number> {
  return lastExecutedLineByContext;
}

export function clearTracingCaches(): void {
  storedCallArgs.clear();
  parentExecutionContextCache.clear();
  lastExecutedLineByContext.clear();
}

export function resetRuntimeState(): void {
  state.repoRoot = undefined;
  state.functionBodies = {};
  state.flows = [];
  state.flowPanel = undefined;
  state.flowPanelMessageDisposable = undefined;
  clearTracingCaches();
  flowRootIndex.clear();
}
