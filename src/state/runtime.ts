import * as vscode from 'vscode';
import { FunctionBody } from '../changedFunctions';
import { ExecutionContext, NormalisedCallArgs } from '../types';

interface RuntimeState {
  repoRoot?: string;
  functionBodies: Record<string, FunctionBody>;
  flowPanel?: vscode.WebviewPanel;
  flowPanelMessageDisposable?: vscode.Disposable;
}

const state: RuntimeState = {
  functionBodies: {},
};

const storedCallArgs = new Map<string, NormalisedCallArgs>();
const parentExecutionContextCache = new Map<string, ExecutionContext>();
const lastExecutedLineByContext = new Map<string, number>();

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
  state.flowPanel = undefined;
  state.flowPanelMessageDisposable = undefined;
  clearTracingCaches();
}
