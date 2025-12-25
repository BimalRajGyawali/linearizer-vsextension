import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  NormalisedCallArgs,
  ParentContext,
  ParentTraceDetails,
  TraceCallArgs,
  FunctionSignatureInfo,
  ExecutionContext,
} from '../types';
import {
  DEFAULT_PARENT_CALL_ARGS,
  getStoredCallArgs,
  setStoredCallArgs,
  normaliseCallArgs,
  cloneCallArgs,
  hasCallArgs,
  getArgsContextKey,
  isTraceCallArgs,
} from '../utils/callArgs';
import {
  resolveFunctionBody,
  extractDisplayNameFromId,
  ensureTopLevelFunctionIdentifier,
} from '../utils/identifiers';
import {
  getPythonPath,
  extractCallArguments,
  findCallSites,
  getFunctionSignature,
} from '../python/pythonBridge';
import {
  buildFlowTraceRequest,
  getOrCreateTracerManager,
  parentExecutionContextCache,
  getCacheKey,
  lastExecutedLineByContext,
} from './tracingService';
import { getRepoRoot, getFlowPanel } from '../state/runtime';

function resolveAbsolutePath(repoRoot: string, filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  const trimmed = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  return path.join(repoRoot, trimmed);
}

function getFunctionNameForDebugger(identifier: string): string | undefined {
  const trimmed = identifier.startsWith('/') ? identifier.slice(1) : identifier;
  const display = extractDisplayNameFromId(trimmed, '').trim();
  return display.length > 0 ? display : undefined;
}

export async function handleTraceLine(
  functionId: string,
  displayLine: number,
  stopLine: number,
  context: vscode.ExtensionContext,
  callArgs?: TraceCallArgs,
  parentContext?: ParentContext,
): Promise<void> {
  const repoRootValue = getRepoRoot();
  if (!repoRootValue) {
    vscode.window.showErrorMessage('No repository root available');
    return;
  }
  const repoRoot = repoRootValue;

  const functionBody = resolveFunctionBody(functionId);
  if (!functionBody) {
    vscode.window.showErrorMessage(`Function ${functionId} not found`);
    return;
  }

  const pythonPath = await getPythonPath();
  const entryFullId = functionId.startsWith('/') ? functionId.slice(1) : functionId;
  const functionName = getFunctionNameForDebugger(functionId);
  const executionLine = Number.isFinite(stopLine) ? stopLine : displayLine + 1;
  const traceRequest = buildFlowTraceRequest({
    entryFullId,
    line: executionLine,
    functionName,
    filePath: resolveAbsolutePath(repoRoot, functionBody.file),
    flowName: entryFullId,
  });

  const flowPanel = getFlowPanel();
  const storedArgs = getStoredCallArgs(functionId);
  let resolvedArgs = callArgs
    ? normaliseCallArgs(callArgs)
    : storedArgs
      ? cloneCallArgs(storedArgs)
      : cloneCallArgs(DEFAULT_PARENT_CALL_ARGS);
  let hasExtractedArgs = false;

  async function traceParentFunction(
    parentId: string,
    callLine: number,
    parentStoredArgs: NormalisedCallArgs | undefined,
    visited: Set<string> = new Set(),
  ): Promise<ParentTraceDetails> {
    if (visited.has(parentId)) {
      throw new Error(`Circular dependency detected: ${parentId}`);
    }
    visited.add(parentId);

    const parentBody = resolveFunctionBody(parentId);
    if (!parentBody) {
      throw new Error(`Parent function ${parentId} not found`);
    }

    const parentEntryFullId = parentId.startsWith('/') ? parentId.slice(1) : parentId;
    const parentSignature = await getFunctionSignature(pythonPath, repoRoot, parentEntryFullId, context.extensionPath);
    const requiredParentParams = getRequiredParameterNames(parentSignature);
    const hasRequiredParams = requiredParentParams.length > 0;
    let effectiveParentArgs = parentStoredArgs;

    if (hasRequiredParams && !hasCallArgs(effectiveParentArgs)) {
      const callSites = await findCallSites(pythonPath, repoRoot, parentId, context.extensionPath);
      if (callSites.length > 0) {
        let extractionError: Error | undefined;
        for (const callSite of callSites) {
          if (!callSite.calling_function_id) {
            continue;
          }
          const grandParentId = callSite.calling_function_id.startsWith('/')
            ? callSite.calling_function_id
            : `/${callSite.calling_function_id}`;
          const grandParentStoredArgs = getStoredCallArgs(grandParentId);
          try {
            const grandParentDetails = await traceParentFunction(
              grandParentId,
              callSite.line,
              grandParentStoredArgs,
              new Set(visited),
            );
            const extractedParentArgs = await extractCallArguments(
              pythonPath,
              repoRoot,
              parentId,
              callSite.file,
              callSite.line,
              grandParentDetails.context.locals,
              grandParentDetails.context.globals,
              context.extensionPath,
            );
            if (extractedParentArgs && !('error' in extractedParentArgs)) {
              effectiveParentArgs = normaliseCallArgs(extractedParentArgs);
              break;
            }
          } catch (error) {
            extractionError = error instanceof Error ? error : new Error(String(error));
          }
        }
        if (!hasCallArgs(effectiveParentArgs) && extractionError) {
          throw extractionError;
        }
      }
      if (!hasCallArgs(effectiveParentArgs)) {
        const signatureLabel = requiredParentParams.length > 0 ? ` (${requiredParentParams.join(', ')})` : '';
        throw new Error(
          `Arguments for ${parentId}${signatureLabel} are required. Please run the top-level function in the flow with its arguments before tracing nested calls.`,
        );
      }
    }

    const finalParentArgs = effectiveParentArgs
      ? cloneCallArgs(effectiveParentArgs)
      : cloneCallArgs(DEFAULT_PARENT_CALL_ARGS);
    setStoredCallArgs(parentId, finalParentArgs);

    const parentArgsJson = JSON.stringify(finalParentArgs);
    const parentTracer = getOrCreateTracerManager(
      context,
      repoRoot,
      parentEntryFullId,
      parentArgsJson,
      flowPanel?.webview,
    );

    const parentFunctionName = getFunctionNameForDebugger(parentEntryFullId);
    const parentRequest = buildFlowTraceRequest({
      entryFullId: parentEntryFullId,
      line: callLine,
      functionName: parentFunctionName,
      filePath: resolveAbsolutePath(repoRoot, parentBody.file),
      flowName: parentEntryFullId,
    });

    parentTracer.setSuppressWebviewEvents(true);
    const cacheKey = getCacheKey(parentId, callLine, finalParentArgs);
    const parentEvent = await parentTracer.getTracerData(
      repoRoot,
      parentEntryFullId,
      callLine,
      parentBody.file,
      parentArgsJson,
      context.extensionPath,
      pythonPath,
      true,
      parentRequest,
      `parent::${parentEntryFullId}::line:${callLine}`,
    );

    if (parentEvent.event === 'error') {
      throw new Error(`Error tracing parent function ${parentId}: ${parentEvent.error || 'Unknown error'}`);
    }

    const executionContext: ExecutionContext = {
      locals: parentEvent.locals || {},
      globals: parentEvent.globals || {},
      file: parentBody.file,
    };

    parentExecutionContextCache.set(cacheKey, executionContext);
    const parentArgsKey = getArgsContextKey(parentEntryFullId, finalParentArgs);
    const prevLine = lastExecutedLineByContext.get(parentArgsKey) ?? 0;
    lastExecutedLineByContext.set(parentArgsKey, Math.max(prevLine, callLine));
    parentTracer.setSuppressWebviewEvents(false);

    return {
      tracer: parentTracer,
      args: finalParentArgs,
      argsJson: parentArgsJson,
      entryFullId: parentEntryFullId,
      body: parentBody,
      context: executionContext,
    };
  }

  try {
    let parentTraceDetails: ParentTraceDetails | undefined;
    if (parentContext && !callArgs) {
      const parentStoredArgs = parentContext.parentCallArgs
        ? normaliseCallArgs(parentContext.parentCallArgs)
        : getStoredCallArgs(parentContext.parentFunctionId);
      parentTraceDetails = await traceParentFunction(
        parentContext.parentFunctionId,
        parentContext.callLine,
        parentStoredArgs,
      );
      const extractedArgs = await extractCallArguments(
        pythonPath,
        repoRoot,
        functionId,
        parentTraceDetails.context.file,
        parentContext.callLine,
        parentTraceDetails.context.locals,
        parentTraceDetails.context.globals,
        context.extensionPath,
      );
      if (extractedArgs && !('error' in extractedArgs)) {
        resolvedArgs = normaliseCallArgs(extractedArgs);
        hasExtractedArgs = true;
      } else {
        const errorMsg = extractedArgs && 'error' in extractedArgs ? extractedArgs.error : 'Failed to extract call arguments';
        vscode.window.showErrorMessage(`Error extracting arguments from parent function: ${errorMsg}`);
        return;
      }
    }

    if (callArgs || hasExtractedArgs) {
      setStoredCallArgs(functionId, resolvedArgs);
    } else {
      if (parentContext) {
        vscode.window.showErrorMessage(
          `Unable to resolve arguments for ${functionId}. Trace the parent function in the flow first so its arguments are captured.`,
        );
        return;
      }
      const signature = await getFunctionSignature(pythonPath, repoRoot, entryFullId, context.extensionPath);
      const params = signature?.params ?? [];
      if (params.length > 0 && !hasCallArgs(resolvedArgs)) {
        const functionDisplayName = entryFullId.split('::').pop() || entryFullId;
        flowPanel?.webview.postMessage({
          type: 'show-args-form',
          functionId,
          params,
          functionName: functionDisplayName,
        });
        vscode.window.showInformationMessage(
          `Arguments are required for ${functionDisplayName}. Use the flow panel to provide them, then trace again.`,
        );
        return;
      }
      setStoredCallArgs(functionId, resolvedArgs);
    }

    const argsJson = JSON.stringify(resolvedArgs);
    if (parentTraceDetails && !callArgs) {
      const nestedFunctionName = getFunctionNameForDebugger(functionId);
      const nestedRequest = buildFlowTraceRequest({
        entryFullId: parentTraceDetails.entryFullId,
        line: executionLine,
        functionName: nestedFunctionName,
        filePath: resolveAbsolutePath(repoRoot, functionBody.file),
        flowName: parentTraceDetails.entryFullId,
        locationLabel: nestedFunctionName ? `${nestedFunctionName}:${executionLine}` : undefined,
      });

      try {
        const event = await parentTraceDetails.tracer.getTracerData(
          repoRoot,
          parentTraceDetails.entryFullId,
          displayLine,
          functionBody.file,
          parentTraceDetails.argsJson,
          context.extensionPath,
          pythonPath,
          false,
          nestedRequest,
          `nested::${parentTraceDetails.entryFullId}::${functionId}`,
        );

        if (event.event === 'error') {
          vscode.window.showErrorMessage(`Tracer error: ${event.error || 'Unknown tracer error'}`);
          return;
        }

        const executionContextKey = getCacheKey(functionId, executionLine, resolvedArgs);
        parentExecutionContextCache.set(executionContextKey, {
          locals: { ...(event.locals ?? {}) },
          globals: { ...(event.globals ?? {}) },
          file: functionBody.file,
        });

        const nestedEntryFullId = functionId.startsWith('/') ? functionId.slice(1) : functionId;
        const argsKey = getArgsContextKey(nestedEntryFullId, resolvedArgs);
        const prevExecutedLine = lastExecutedLineByContext.get(argsKey) ?? 0;
        lastExecutedLineByContext.set(argsKey, Math.max(prevExecutedLine, executionLine));

        flowPanel?.webview.postMessage({
          type: 'tracer-event',
          event: {
            ...event,
            line: displayLine,
            filename: event.filename ?? functionBody.file,
          },
        });
        vscode.window.showInformationMessage(`Tracer reached line ${displayLine} in ${functionId}`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Tracer error: ${message}`);
        flowPanel?.webview.postMessage({
          type: 'tracer-error',
          error: message,
          line: displayLine,
          filename: functionBody.file,
        });
        return;
      }
    }

    const tracerManager = getOrCreateTracerManager(
      context,
      repoRoot,
      entryFullId,
      argsJson,
      flowPanel?.webview,
    );
    tracerManager.setSuppressWebviewEvents(false);

    try {
      const event = await tracerManager.getTracerData(
        repoRoot,
        entryFullId,
        displayLine,
        functionBody.file,
        argsJson,
        context.extensionPath,
        pythonPath,
        false,
        traceRequest,
      );

      if (event.event === 'error') {
        vscode.window.showErrorMessage(`Tracer error: ${event.error || 'Unknown tracer error'}`);
        return;
      }

      const executionContextKey = getCacheKey(functionId, executionLine, resolvedArgs);
      parentExecutionContextCache.set(executionContextKey, {
        locals: { ...(event.locals ?? {}) },
        globals: { ...(event.globals ?? {}) },
        file: functionBody.file,
      });

      const argsKey = getArgsContextKey(entryFullId, resolvedArgs);
      const prevExecutedLine = lastExecutedLineByContext.get(argsKey) ?? 0;
      lastExecutedLineByContext.set(argsKey, Math.max(prevExecutedLine, executionLine));

      flowPanel?.webview.postMessage({
        type: 'tracer-event',
        event: {
          ...event,
          line: displayLine,
          filename: event.filename ?? functionBody.file,
        },
      });
      vscode.window.showInformationMessage(`Tracer reached line ${displayLine} in ${functionId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Tracer error: ${message}`);
      flowPanel?.webview.postMessage({
        type: 'tracer-error',
        error: message,
        line: displayLine,
        filename: functionBody.file,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to start tracer: ${message}`);
  }
}

export function getRequiredParameterNames(signature?: FunctionSignatureInfo | null): string[] {
  if (!signature || !Array.isArray(signature.params)) {
    return [];
  }
  const params = signature.params;
  const requiredFlags = Array.isArray(signature.param_required) && signature.param_required.length === params.length
    ? signature.param_required
    : undefined;
  const result: string[] = [];
  params.forEach((param, index) => {
    const trimmed = (param || '').trim();
    if (!trimmed || trimmed === 'self' || trimmed === 'cls') {
      return;
    }
    if (requiredFlags) {
      if (requiredFlags[index]) {
        result.push(trimmed);
      }
      return;
    }
    result.push(trimmed);
  });
  return result;
}

export function isTraceCallArgsInput(value: unknown): value is TraceCallArgs {
  return isTraceCallArgs(value);
}
