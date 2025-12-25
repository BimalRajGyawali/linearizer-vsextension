import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { ChangedFunction, FlowEntry, FunctionBody } from '../changedFunctions';
import { TraceCallArgs, NormalisedCallArgs, CallSite } from '../types';
import {
  hydrateFunctionBodies,
  getPythonPath,
  findCallSites,
  getFunctionSignature,
  extractCallArguments,
} from '../python/pythonBridge';
import { handleTraceLine, getRequiredParameterNames, isTraceCallArgsInput } from '../tracing/traceLine';
import {
  normaliseCallArgs,
  setStoredCallArgs,
  getStoredCallArgs,
  cloneCallArgs,
  DEFAULT_PARENT_CALL_ARGS,
  getArgsContextKey,
} from '../utils/callArgs';
import { resolveFunctionBody, ensureTopLevelFunctionIdentifier } from '../utils/identifiers';
import {
  setRepoRoot,
  setFunctionBodies,
  getFlowPanel,
  setFlowPanel,
  getFlowPanelDisposable,
  setFlowPanelDisposable,
  resetRuntimeState,
  getRepoRoot,
} from '../state/runtime';
import {
  stopAllTracers,
  clearTracingForFunction,
  parentExecutionContextCache,
  getCacheKey,
  getOrCreateTracerManager,
  buildFlowTraceRequest,
  lastExecutedLineByContext,
} from '../tracing/tracingService';

export async function showFlowPanel(
  context: vscode.ExtensionContext,
  repoRoot: string,
  changedFunctions: ChangedFunction[],
  flows: FlowEntry[],
  warnings: string[],
  functionBodies: Record<string, FunctionBody>,
): Promise<void> {
  setRepoRoot(repoRoot);
  const hydratedFunctionBodies = await hydrateFunctionBodies(functionBodies);
  setFunctionBodies(hydratedFunctionBodies);

  let panel = getFlowPanel();
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'linearizerFlows',
      'Linearizer Call Flows',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    setFlowPanel(panel);
    context.subscriptions.push(panel);
    panel.onDidDispose(
      () => {
        stopAllTracers();
        setFlowPanel(undefined);
        setFunctionBodies({});
        setRepoRoot(undefined);
        const disposable = getFlowPanelDisposable();
        if (disposable) {
          disposable.dispose();
          setFlowPanelDisposable(undefined);
        }
        resetRuntimeState();
      },
      undefined,
      context.subscriptions,
    );
  } else {
    panel.reveal(vscode.ViewColumn.Active);
  }

  const existingHandler = getFlowPanelDisposable();
  if (existingHandler) {
    existingHandler.dispose();
    setFlowPanelDisposable(undefined);
  }

  panel.webview.html = buildFlowWebviewHtml(
    context,
    panel.webview,
    changedFunctions,
    flows,
    warnings,
    hydratedFunctionBodies,
  );

  const handler = panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    const currentRepoRoot = getRepoRoot();
    if (!currentRepoRoot) {
      vscode.window.showErrorMessage('Repository root is not set.');
      return;
    }

    switch (message.type) {
      case 'open-source':
        if (typeof message.identifier === 'string') {
          const details = resolveFunctionBody(message.identifier);
          if (!details) {
            return;
          }
          const targetUri = vscode.Uri.file(path.join(currentRepoRoot, details.file));
          const document = await vscode.workspace.openTextDocument(targetUri);
          const editor = await vscode.window.showTextDocument(document, { preview: false });
          const targetPosition = new vscode.Position(Math.max(details.line - 1, 0), 0);
          editor.selection = new vscode.Selection(targetPosition, targetPosition);
          editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);
        }
        break;
      case 'reveal-function-file':
        if (typeof message.functionId === 'string') {
          await revealFunctionFile(currentRepoRoot, message.functionId);
        }
        break;
      case 'trace-line':
        if (typeof message.functionId === 'string' && typeof message.line === 'number') {
          const callArgs = isTraceCallArgsInput(message.callArgs) ? message.callArgs : undefined;
          const stopLineCandidate = typeof message.stopLine === 'number' ? message.stopLine : message.line + 1;
          const stopLine = Number.isFinite(stopLineCandidate) ? stopLineCandidate : message.line + 1;
          const parentContext =
            message.isNested &&
            typeof message.parentFunctionId === 'string' &&
            typeof message.parentLine === 'number' &&
            typeof message.callLine === 'number'
              ? {
                  parentFunctionId: message.parentFunctionId,
                  parentLine: message.parentLine,
                  callLine: message.callLine,
                  parentCallArgs: isTraceCallArgsInput(message.parentCallArgs)
                    ? message.parentCallArgs
                    : undefined,
                }
              : undefined;
          await handleTraceLine(message.functionId, message.line, stopLine, context, callArgs, parentContext);
        }
        break;
      case 'find-call-sites':
        if (typeof message.functionId === 'string') {
          await handleFindCallSites(panel, context, currentRepoRoot, message.functionId);
        }
        break;
      case 'request-function-signature':
        if (typeof message.functionId === 'string') {
          await sendFunctionSignature(panel, context, currentRepoRoot, message.functionId);
        }
        break;
      case 'request-args-form':
        if (typeof message.functionId === 'string') {
          await showArgsForm(panel, context, currentRepoRoot, message.functionId);
        }
        break;
      case 'store-call-args':
        if (typeof message.functionId === 'string' && message.args && typeof message.args === 'object') {
          const callArgs = normaliseCallArgs(message.args as TraceCallArgs);
          setStoredCallArgs(message.functionId, callArgs);
        }
        break;
      case 'execute-with-args':
        if (typeof message.functionId === 'string') {
          const targetLine = typeof message.line === 'number' ? message.line : 1;
          let callArgs: NormalisedCallArgs;
          if (message.args && typeof message.args === 'object') {
            callArgs = normaliseCallArgs(message.args as TraceCallArgs);
            setStoredCallArgs(message.functionId, callArgs);
          } else {
            callArgs = { args: [], kwargs: {} };
          }
          await handleTraceLine(message.functionId, targetLine, targetLine, context, callArgs);
        }
        break;
      case 'execute-from-call-site':
        if (typeof message.functionId === 'string' && typeof message.callSite === 'object') {
          await executeFromCallSite(panel, context, currentRepoRoot, message.functionId, message.callSite as CallSite);
        }
        break;
      case 'stop-trace':
        stopAllTracers();
        break;
      case 'reset-tracer':
        if (typeof message.functionId === 'string') {
          clearTracingForFunction(message.functionId);
        }
        break;
      default:
        break;
    }
  });

  setFlowPanelDisposable(handler);
  context.subscriptions.push(handler);
}

async function revealFunctionFile(repoRoot: string, functionIdInput: string): Promise<void> {
  let functionId = functionIdInput;
  let details = resolveFunctionBody(functionId);
  if (!details && !functionId.startsWith('/')) {
    functionId = `/${functionId}`;
    details = resolveFunctionBody(functionId);
  }
  if (!details) {
    return;
  }
  const filePath = details.file.startsWith('/') ? details.file.slice(1) : details.file;
  const fullPath = path.join(repoRoot, filePath);
  const targetUri = vscode.Uri.file(fullPath);
  try {
    await fs.access(fullPath);
    await vscode.commands.executeCommand('revealInExplorer', targetUri);
  } catch {
    const document = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(document, { preview: true });
    await vscode.commands.executeCommand('revealInExplorer', targetUri);
  }
}

async function handleFindCallSites(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  repoRoot: string,
  functionId: string,
): Promise<void> {
  try {
    const pythonPath = await getPythonPath();
    const callSites = await findCallSites(pythonPath, repoRoot, functionId, context.extensionPath);
    console.log('Call sites found:', callSites);
    panel.webview.postMessage({
      type: 'call-sites-found',
      functionId,
      callSites,
    });
  } catch (error) {
    panel.webview.postMessage({
      type: 'call-sites-error',
      functionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sendFunctionSignature(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  repoRoot: string,
  functionId: string,
): Promise<void> {
  try {
    const pythonPath = await getPythonPath();
    const entryFullId = functionId.startsWith('/') ? functionId.slice(1) : functionId;
    const signature = await getFunctionSignature(pythonPath, repoRoot, entryFullId, context.extensionPath);
    panel.webview.postMessage({
      type: 'function-signature',
      functionId,
      params: signature?.params || [],
    });
  } catch (error) {
    panel.webview.postMessage({
      type: 'function-signature',
      functionId,
      params: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function showArgsForm(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  repoRoot: string,
  functionId: string,
): Promise<void> {
  try {
    const pythonPath = await getPythonPath();
    const entryFullId = functionId.startsWith('/') ? functionId.slice(1) : functionId;
    const signature = await getFunctionSignature(pythonPath, repoRoot, entryFullId, context.extensionPath);
    const functionName = entryFullId.split('::').pop() || entryFullId;
    panel.webview.postMessage({
      type: 'show-args-form',
      functionId,
      params: signature?.params || [],
      functionName,
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Error getting function signature: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function executeFromCallSite(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  repoRoot: string,
  functionId: string,
  callSite: CallSite,
): Promise<void> {
  if (typeof callSite.line !== 'number') {
    vscode.window.showErrorMessage('Invalid call site: line number is missing.');
    return;
  }

  try {
    const pythonPath = await getPythonPath();
    const derivedTopLevelId =
      !callSite.calling_function_id && callSite.file ? ensureTopLevelFunctionIdentifier(callSite.file) : undefined;
    const resolvedCallingFunctionId = callSite.calling_function_id ?? derivedTopLevelId;

    console.log('Executing from call site:', callSite, {
      functionId,
      resolvedCallingFunctionId,
    });
    

    const executeTargetWithArgs = async (argsToUse: NormalisedCallArgs) => {
      setStoredCallArgs(functionId, argsToUse);
      const targetBody = resolveFunctionBody(functionId);
      const startLine = targetBody?.line ?? 1;
      await handleTraceLine(functionId, startLine, startLine, context, argsToUse);
    };

    if (resolvedCallingFunctionId) {
      const callingFunctionId = resolvedCallingFunctionId.startsWith('/')
        ? resolvedCallingFunctionId.slice(1)
        : resolvedCallingFunctionId;
      const callingIsTopLevel = derivedTopLevelId !== undefined && resolvedCallingFunctionId === derivedTopLevelId;
      if (!callingFunctionId.includes('::')) {
        throw new Error(
          `Invalid calling function ID format: ${resolvedCallingFunctionId}. Expected format: path/to/file.py::function_name`,
        );
      }
      const storedCallingArgs =
        getStoredCallArgs(resolvedCallingFunctionId) ?? getStoredCallArgs(callingFunctionId);
      let callingCallArgs: NormalisedCallArgs | undefined;
      if (storedCallingArgs) {
        callingCallArgs = cloneCallArgs(storedCallingArgs);
      } else if (!callingIsTopLevel) {
        const callingSignature = await getFunctionSignature(
          pythonPath,
          repoRoot,
          callingFunctionId,
          context.extensionPath,
        );
        const requiredParams = getRequiredParameterNames(callingSignature);
        if (requiredParams.length > 0) {
          const requiredList = requiredParams.join(', ');
          const warningMessage = `Arguments for ${callSite.calling_function || callingFunctionId} require ${requiredList}. Run the calling function once with its inputs or provide them manually before selecting a call site.`;
          vscode.window.showWarningMessage(warningMessage);
          panel.webview.postMessage({
            type: 'call-site-args-error',
            functionId,
            callSite,
            error: warningMessage,
          });
          return;
        }
        callingCallArgs = cloneCallArgs(DEFAULT_PARENT_CALL_ARGS);
      } else {
        callingCallArgs = cloneCallArgs(DEFAULT_PARENT_CALL_ARGS);
      }

      if (!callingCallArgs) {
        callingCallArgs = cloneCallArgs(DEFAULT_PARENT_CALL_ARGS);
      }

      const callingArgsJson = JSON.stringify(callingCallArgs);
      const callingArgsKey = getArgsContextKey(callingFunctionId, callingCallArgs);
      const callingParentId = resolvedCallingFunctionId.startsWith('/')
        ? resolvedCallingFunctionId
        : `/${resolvedCallingFunctionId}`;
      const callingCacheKey = getCacheKey(callingParentId, callSite.line, callingCallArgs);
      let callingContext = parentExecutionContextCache.get(callingCacheKey);

      if (!callingContext) {
        const callingTracer = getOrCreateTracerManager(
          context,
          repoRoot,
          callingFunctionId,
          callingArgsJson,
          panel.webview,
        );
        callingTracer.setSuppressWebviewEvents(false);

        const callSiteFilePath = callSite.file
          ? path.isAbsolute(callSite.file)
            ? callSite.file
            : path.join(repoRoot, callSite.file.startsWith('/') ? callSite.file.slice(1) : callSite.file)
          : undefined;

        const callSiteRequest = buildFlowTraceRequest({
          entryFullId: callingFunctionId,
          line: callSite.line,
          functionName: callSite.calling_function || (callingIsTopLevel ? '<module>' : undefined),
          filePath: callSiteFilePath,
        });

        const callSiteEvent = await callingTracer.getTracerData(
          repoRoot,
          callingFunctionId,
          callSite.line - 1,
          callSite.file,
          callingArgsJson,
          context.extensionPath,
          pythonPath,
          false,
          callSiteRequest,
          callingParentId,
        );

        callingContext = {
          locals: callSiteEvent.locals || {},
          globals: callSiteEvent.globals || {},
          file: callSite.file,
        };

        parentExecutionContextCache.set(callingCacheKey, callingContext);
      }

      const previousLine = lastExecutedLineByContext.get(callingArgsKey) ?? 0;
      lastExecutedLineByContext.set(callingArgsKey, Math.max(previousLine, callSite.line));

      const extractedArgs = await extractCallArguments(
        pythonPath,
        repoRoot,
        functionId.startsWith('/') ? functionId.slice(1) : functionId,
        callSite.file,
        callSite.line,
        callingContext.locals || {},
        callingContext.globals || {},
        context.extensionPath,
        {
          callingEntryFullId: callingFunctionId,
          callingArgsJson,
        },
      );

      if (extractedArgs && !('error' in extractedArgs)) {
        const normalisedArgs = normaliseCallArgs(extractedArgs);
        panel.webview.postMessage({
          type: 'call-site-args-extracted',
          functionId,
          callSite,
          args: normalisedArgs,
        });
        await executeTargetWithArgs(normalisedArgs);
      } else {
        const errorMsg = extractedArgs && 'error' in extractedArgs ? extractedArgs.error : 'Failed to extract call arguments';
        panel.webview.postMessage({
          type: 'call-site-args-error',
          functionId,
          callSite,
          error: errorMsg,
        });
      }
      return;
    }

    if (callSite.call_line) {
      const extractedArgs = await extractCallArguments(
        await getPythonPath(),
        repoRoot,
        functionId.startsWith('/') ? functionId.slice(1) : functionId,
        callSite.file,
        callSite.line,
        {},
        {},
        context.extensionPath,
      );
      if (extractedArgs && !('error' in extractedArgs)) {
        const normalisedArgs = normaliseCallArgs(extractedArgs);
        panel.webview.postMessage({
          type: 'call-site-args-extracted',
          functionId,
          callSite,
          args: normalisedArgs,
        });
        await executeTargetWithArgs(normalisedArgs);
      } else {
        const errorMsg = extractedArgs && 'error' in extractedArgs ? extractedArgs.error : 'Failed to extract call arguments from call line';
        panel.webview.postMessage({
          type: 'call-site-args-error',
          functionId,
          callSite,
          error: errorMsg,
        });
      }
      return;
    }

    panel.webview.postMessage({
      type: 'call-site-args-error',
      functionId,
      callSite,
      error: 'The calling function could not be determined and the call line is not available.',
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Error executing from call site: ${error instanceof Error ? error.message : String(error)}`);
  }
}


// async function executeFromCallSite( 
//   panel: vscode.WebviewPanel,
//   context: vscode.ExtensionContext,
//   repoRoot: string,
//   functionId: string,
//   callSite: CallSite,){

//   				console.log('[extension] Executing from call site:', callSite);
// 				try {
// 					// The call site contains: file, line, calling_function_id
// 					// We need to execute up to that line in the calling function, then extract arguments
// 					if (typeof callSite.line === 'number') {
// 						const pythonPath = await getPythonPath();
// 						const targetFunctionId = functionId; // The parent function to execute

// 						// Check if we have a calling function ID
// 						if (callSite.calling_function_id) {
// 							// We have a calling function - execute it first to get runtime context
// 							// We need to ensure activeTracer exists or create one
// 							if (!activeTracer) {
// 								if (!tracerOutputChannel) {
// 									tracerOutputChannel = vscode.window.createOutputChannel('Linearizer Tracer');
// 									context.subscriptions.push(tracerOutputChannel);
// 								}
// 								activeTracer = new TracerManager(tracerOutputChannel);
// 							}

//               const callingTracer = getOrCreateTracerManager(
//           context,
//           repoRoot,
//           functionId,
//           callingArgsJson,
//           panel.webview,
//         );

// 							const callingFunctionId = callSite.calling_function_id.startsWith('/') 
// 								? callSite.calling_function_id.slice(1) 
// 								: callSite.calling_function_id;

// 							console.log('[extension] Executing calling function:', {
// 								callingFunctionId,
// 								file: callSite.file,
// 								line: callSite.line,
// 								targetFunctionId
// 							});

// 							// Validate the calling function ID format
// 							if (!callingFunctionId.includes('::')) {
// 								throw new Error(`Invalid calling function ID format: ${callSite.calling_function_id}. Expected format: path/to/file.py::function_name`);
// 							}

// 							const callSiteEvent = await activeTracer.getTracerData(
// 								repoRoot,
// 								callingFunctionId,
// 								callSite.line - 1, // displayLine is 0-indexed, callSite.line is 1-indexed
// 								callSite.file,
// 								JSON.stringify({ args: [], kwargs: {} }), // Dummy args - we'll extract real ones
// 								context.extensionPath,
// 								pythonPath,
// 								false, // suppressWebview
// 							);

// 							// Now extract the call arguments at that line
// 							const extractedArgs = await extractCallArguments(
// 								pythonPath,
// 								repoRoot,
// 								targetFunctionId.startsWith('/') ? targetFunctionId.slice(1) : targetFunctionId,
// 								callSite.file,
// 								callSite.line,
// 								callSiteEvent.locals || {},
// 								callSiteEvent.globals || {},
// 								context.extensionPath,
// 							);

// 							// Send extracted arguments to webview to display and allow editing
// 							if (extractedArgs && !('error' in extractedArgs)) {
// 								const normalisedArgs = normaliseCallArgs(extractedArgs);
// 								if (panel?.webview) {
// 									panel.webview.postMessage({
// 										type: 'call-site-args-extracted',
// 										functionId: targetFunctionId,
// 										callSite: callSite,
// 										args: normalisedArgs,
// 									});
// 								}
// 							} else {
// 								const errorMsg = extractedArgs && 'error' in extractedArgs ? extractedArgs.error : 'Failed to extract call arguments';
// 								if (panel?.webview) {
// 									panel.webview.postMessage({
// 										type: 'call-site-args-error',
// 										functionId: targetFunctionId,
// 										error: errorMsg,
// 									});
// 								}
// 							}
// 						} else {
// 							// No calling function ID (from fallback text search) - try to extract from call line directly
// 							// This is a fallback when we can't determine the calling function
// 							if (callSite.call_line) {
// 								// Try to extract arguments from the call line text directly
// 								const extractedArgs = await extractCallArguments(
// 									pythonPath,
// 									repoRoot!,
// 									targetFunctionId.startsWith('/') ? targetFunctionId.slice(1) : targetFunctionId,
// 									callSite.file,
// 									callSite.line,
// 									{}, // Empty locals - we don't have runtime context
// 									{}, // Empty globals - we don't have runtime context
// 									context.extensionPath,
// 								);

// 								if (extractedArgs && !('error' in extractedArgs)) {
// 									const normalisedArgs = normaliseCallArgs(extractedArgs);
// 									if (panel?.webview) {
// 										panel.webview.postMessage({
// 											type: 'call-site-args-extracted',
// 											functionId: targetFunctionId,
// 											callSite: callSite,
// 											args: normalisedArgs,
// 										});
// 									}
// 								} else {
// 									const errorMsg = extractedArgs && 'error' in extractedArgs ? extractedArgs.error : 'Failed to extract call arguments from call line';
// 									if (panel?.webview) {
// 										panel.webview.postMessage({
// 											type: 'call-site-args-error',
// 											functionId: targetFunctionId,
// 											error: errorMsg,
// 										});
// 									}
// 								}
// 							} else {
// 								if (panel?.webview) {
// 									panel.webview.postMessage({
// 										type: 'call-site-args-error',
// 										functionId: targetFunctionId,
// 										error: 'The calling function could not be determined and the call line is not available.',
// 									});
// 								}
// 							}
// 						}
// 					} else {
// 						vscode.window.showErrorMessage('Invalid call site: line number is missing.');
// 					}
// 				} catch (error) {
// 					console.error('[extension] Error executing from call site:', error);
// 					vscode.window.showErrorMessage(`Error executing from call site: ${error instanceof Error ? error.message : String(error)}`);
// 				}


// }













function buildFlowWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  changedFunctions: ChangedFunction[],
  flows: FlowEntry[],
  warnings: string[],
  functionBodies: Record<string, FunctionBody>,
): string {
  const warningsSection = warnings.length
    ? `<section class="warnings-section"><h2>Warnings</h2><ul class="warnings">${warnings
        .map((warning) => `<li>${escapeHtml(warning)}</li>`)
        .join('')}</ul></section>`
    : '';

  const payload = {
    changedFunctions,
    flows,
    warnings,
    functionBodies,
  };

  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'flowPanel.js'));
  const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'flowPanel.css'));
  const nonce = getNonce();

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Linearizer Call Flows</title>
    <link rel="stylesheet" href="${stylesUri}" />
  </head>
  <body>
    <main class="layout">
      <div id="flow-root" class="flow-root" data-state="idle"></div>
      ${warningsSection}
    </main>
    <script nonce="${nonce}">window.__INITIAL_DATA__ = ${serialiseForScript(payload)};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
  </html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serialiseForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026');
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => possible.charAt(Math.floor(Math.random() * possible.length))).join('');
}
