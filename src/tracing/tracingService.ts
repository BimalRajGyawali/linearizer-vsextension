import * as vscode from 'vscode';
import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { FlowTraceRequest, FlowTraceRequestOptions, TracerEvent, ExecutionContext, NormalisedCallArgs } from '../types';
import { clearStoredCallArgs } from '../utils/callArgs';
import { extractDisplayNameFromId } from '../utils/identifiers';

let tracerOutputChannel: vscode.OutputChannel | undefined;
const tracerManagers = new Map<string, TracerManager>();
export const lastExecutedLineByContext = new Map<string, number>();
export const parentExecutionContextCache = new Map<string, ExecutionContext>();

function ensureTracerOutputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!tracerOutputChannel) {
    tracerOutputChannel = vscode.window.createOutputChannel('Linearizer Tracer');
    context.subscriptions.push(tracerOutputChannel);
  }
  return tracerOutputChannel;
}

function getTracerManagerKey(repoRoot: string, entryFullId: string, argsJson: string): string {
  return JSON.stringify({ repoRoot, entryFullId, argsJson });
}

export function getCacheKey(parentId: string, callLine: number, args: NormalisedCallArgs): string {
  const argsKey = JSON.stringify(args);
  return `${parentId}:${callLine}:${argsKey}`;
}

export function stopAllTracers(): void {
  for (const manager of tracerManagers.values()) {
    manager.stop();
  }
  tracerManagers.clear();
  lastExecutedLineByContext.clear();
  parentExecutionContextCache.clear();
}

export function clearTracingForFunction(functionId: string): void {
  const normalizedId = functionId.startsWith('/') ? functionId.slice(1) : functionId;
  const withSlash = functionId.startsWith('/') ? functionId : `/${normalizedId}`;

  for (const [key, manager] of Array.from(tracerManagers.entries())) {
    const parsed = JSON.parse(key) as { entryFullId: string };
    if (parsed.entryFullId === normalizedId) {
      manager.stop();
      tracerManagers.delete(key);
    }
  }

  for (const argsKey of Array.from(lastExecutedLineByContext.keys())) {
    if (argsKey.startsWith(`${normalizedId}::`)) {
      lastExecutedLineByContext.delete(argsKey);
    }
  }

  for (const cacheKey of Array.from(parentExecutionContextCache.keys())) {
    if (cacheKey.startsWith(`${withSlash}:`) || cacheKey.startsWith(`${normalizedId}:`)) {
      parentExecutionContextCache.delete(cacheKey);
    }
  }

  clearStoredCallArgs(functionId);
}

export function getOrCreateTracerManager(
  context: vscode.ExtensionContext,
  repoRoot: string,
  entryFullId: string,
  argsJson: string,
  webview?: vscode.Webview,
): TracerManager {
  const outputChannel = ensureTracerOutputChannel(context);
  const key = getTracerManagerKey(repoRoot, entryFullId, argsJson);
  let manager = tracerManagers.get(key);
  if (!manager) {
    manager = new TracerManager(outputChannel, webview);
    tracerManagers.set(key, manager);
  }
  manager.setWebview(webview);
  return manager;
}

export function buildFlowTraceRequest(options: FlowTraceRequestOptions): FlowTraceRequest {
  const functionName = options.functionName ?? extractDisplayNameFromId(options.entryFullId, options.entryFullId);
  const normalizedLine = Math.max(1, Math.floor(options.line));
  const location = options.locationLabel ?? `${functionName}:${normalizedLine}`;
  return {
    flowId: options.entryFullId,
    flowName: options.flowName ?? options.entryFullId,
    functionName,
    line: normalizedLine,
    location,
    filePath: options.filePath,
  };
}

export class TracerManager {
  private process: ChildProcess | undefined;
  private outputChannel: vscode.OutputChannel;
  private webview: vscode.Webview | undefined;
  private currentFlow: string | undefined;
  private stderrBuffer = '';
  private eventQueue: TracerEvent[] = [];
  private pendingReadResolve: ((value: TracerEvent) => void) | undefined;
  private pendingReadReject: ((error: Error) => void) | undefined;
  private pendingDisplayLine: number | undefined;
  private pendingDisplayFile: string | undefined;
  private currentDisplayLine: number | undefined;
  private currentDisplayFile: string | undefined;
  private suppressWebviewEvents = false;
  private lastEvent: TracerEvent | undefined;
  private lastContextKey: string | undefined;
  private lastLocationKey: string | undefined;
  private pendingLocation: string | undefined;
  private pendingContextKey: string | undefined;
  private lastTraceRequest: FlowTraceRequest | undefined;
  private pendingTraceRequest: FlowTraceRequest | undefined;
  private cachedEvents: Map<string, Map<string, TracerEvent>> = new Map();

  constructor(outputChannel: vscode.OutputChannel, webview?: vscode.Webview) {
    this.outputChannel = outputChannel;
    this.webview = webview;
  }

  setWebview(webview?: vscode.Webview): void {
    this.webview = webview;
  }

  setSuppressWebviewEvents(suppress: boolean): void {
    this.suppressWebviewEvents = suppress;
  }

  private decorateEvent(event: TracerEvent): TracerEvent {
    const decorated = { ...event };
    const targetLine =
      typeof this.pendingDisplayLine === 'number'
        ? this.pendingDisplayLine
        : this.currentDisplayLine;
    const targetFile = this.pendingDisplayFile ?? this.currentDisplayFile;

    if (decorated.event === 'line' || decorated.event === 'error') {
      if (typeof targetLine === 'number') {
        decorated.line = targetLine;
      }
      if (targetFile && !decorated.filename) {
        decorated.filename = targetFile;
      }
    }
    return decorated;
  }

  private clearPendingDisplay(): void {
    this.pendingDisplayLine = undefined;
    this.pendingDisplayFile = undefined;
  }

  private buildContextKey(
    repoRoot: string,
    entryFullId: string,
    argsJson: string,
    suffix?: string,
  ): string {
    const base = `${repoRoot}::${entryFullId}::${argsJson}`;
    return suffix ? `${base}::${suffix}` : base;
  }

  private cloneEvent(event: TracerEvent): TracerEvent {
    return JSON.parse(JSON.stringify(event)) as TracerEvent;
  }

  private getCachedEvent(
    contextKey: string,
    location: string,
    displayLine: number,
    displayFile: string | undefined,
  ): TracerEvent | undefined {
    const contextCache = this.cachedEvents.get(contextKey);
    if (!contextCache) {
      return undefined;
    }
    const cached = contextCache.get(location);
    if (!cached) {
      return undefined;
    }
    const cloned = this.cloneEvent(cached);
    cloned.line = displayLine;
    if (displayFile) {
      cloned.filename = displayFile;
    }
    return cloned;
  }

  private processIncomingEvent(rawEvent: TracerEvent): void {
    const decorated = this.decorateEvent(rawEvent);

    if (this.pendingContextKey) {
      this.lastContextKey = this.pendingContextKey;
    }
    if (this.pendingTraceRequest) {
      this.lastTraceRequest = this.pendingTraceRequest;
    }

    const cacheContextKey = this.pendingContextKey ?? this.lastContextKey;
    const eventLocation = decorated.target_location ?? rawEvent.target_location ?? undefined;
    const locationKey = this.pendingLocation ?? eventLocation ?? this.lastLocationKey;
    if (cacheContextKey && locationKey && decorated.event !== 'error') {
      let contextCache = this.cachedEvents.get(cacheContextKey);
      if (!contextCache) {
        contextCache = new Map<string, TracerEvent>();
        this.cachedEvents.set(cacheContextKey, contextCache);
      }
      contextCache.set(locationKey, this.cloneEvent(decorated));
      this.lastLocationKey = locationKey;
    } else if (locationKey) {
      this.lastLocationKey = locationKey;
    }

    this.lastEvent = decorated;

    if (decorated.event === 'line') {
      this.outputChannel.appendLine(
        `[processIncomingEvent] Decorated event: line=${decorated.line}, pendingDisplayLine=${this.pendingDisplayLine}, currentDisplayLine=${this.currentDisplayLine}, originalLine=${rawEvent.line}`,
      );
    }

    if (this.pendingReadResolve) {
      const resolver = this.pendingReadResolve;
      this.pendingReadResolve = undefined;
      this.pendingReadReject = undefined;
      resolver(decorated);
      this.clearPendingDisplay();
    } else {
      this.eventQueue.push(decorated);
      this.emitTracerEvent(decorated);
    }

    this.pendingLocation = undefined;
    this.pendingContextKey = undefined;
    this.pendingTraceRequest = undefined;
  }

  private spawnTracer(
    repoRoot: string,
    entryFullId: string,
    initialRequest: FlowTraceRequest,
    argsJson: string,
    extensionPath: string,
    pythonPath: string,
  ): void {
    const tracerPath = path.join(extensionPath, 'python', 'tracer.py');
    console.log('Spawning tracer with path:', tracerPath);
    this.outputChannel.appendLine(
      `[Rust-like] Spawning tracer for ${entryFullId} at location ${initialRequest.location}`,
    );

    const args = [
      '-u',
      tracerPath,
      '--repo_root', repoRoot,
      '--entry_full_id', entryFullId,
      '--args_json', argsJson,
    ];

    if (initialRequest.flowName) {
      args.push('--flow_name', initialRequest.flowName);
    }

    if (initialRequest.location) {
      args.push('--stop_location', initialRequest.location);
    } else {
      args.push('--stop_line', Math.max(1, initialRequest.line).toString());
    }

    if (initialRequest.filePath) {
      args.push('--stop_file', initialRequest.filePath);
    }

    this.process = spawn(pythonPath, args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    this.stderrBuffer = '';
    this.eventQueue = [];
    this.lastEvent = undefined;
    this.lastContextKey = undefined;
    this.pendingContextKey = undefined;
    this.lastTraceRequest = undefined;
    this.pendingTraceRequest = undefined;

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.stderrBuffer += text;

      const lines = this.stderrBuffer.split('\n');
      this.stderrBuffer = lines.pop() || '';
      console.log('Tracer stderr line data:', lines);

      for (const line of lines) {
        if (line.trim()) {
          try {
            const rawEvent: TracerEvent = JSON.parse(line);
            this.processIncomingEvent(rawEvent);
          } catch {
            this.outputChannel.appendLine(`[Tracer] ${line}`);
          }
        }
      }
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      this.outputChannel.appendLine(`[Tracer stdout] ${data.toString()}`);
    });

    this.process.on('error', (error) => {
      console.log('Tracer process error:', error);
      this.outputChannel.appendLine(`[Tracer error] ${error.message}`);
      if (this.pendingReadReject) {
        this.pendingReadReject(new Error(error.message));
        this.pendingReadResolve = undefined;
        this.pendingReadReject = undefined;
      }
      this.webview?.postMessage({
        type: 'tracer-error',
        error: error.message,
      });
    });

    this.process.on('exit', (code) => {
      this.outputChannel.appendLine(`[Tracer] Process exited with code ${code}`);
      if (code !== 0 && code !== null) {
        let errorMessage = `Python process exited with code ${code}`;
        const errorEvent = this.eventQueue.find((e) => e.event === 'error');
        if (errorEvent) {
          errorMessage = errorEvent.error || errorMessage;
          if (errorEvent.filename) {
            errorMessage += ` in ${errorEvent.filename}`;
          }
          if (errorEvent.line) {
            errorMessage += ` at line ${errorEvent.line}`;
          }
        } else if (this.stderrBuffer.trim()) {
          const stderrLines = this.stderrBuffer.trim().split('\n').filter((l) => l.trim());
          if (stderrLines.length > 0) {
            const errorLines = stderrLines.filter(
              (l) =>
                l.toLowerCase().includes('error') ||
                l.toLowerCase().includes('exception') ||
                l.toLowerCase().includes('traceback'),
            );
            if (errorLines.length > 0) {
              errorMessage += `: ${errorLines[0]}`;
            } else {
              errorMessage += `: ${stderrLines[stderrLines.length - 1]}`;
            }
          }
        }

        if (this.pendingReadReject) {
          this.pendingReadReject(new Error(errorMessage));
          this.pendingReadResolve = undefined;
          this.pendingReadReject = undefined;
        }
      }
      this.process = undefined;
      this.currentFlow = undefined;
      this.clearPendingDisplay();
      this.currentDisplayLine = undefined;
      this.currentDisplayFile = undefined;
    });
  }

  async getTracerData(
    repoRoot: string,
    entryFullId: string,
    displayLine: number,
    displayFile: string | undefined,
    argsJson: string,
    extensionPath: string,
    pythonPath: string,
    suppressWebview = false,
    traceRequest?: FlowTraceRequest,
    contextSuffix?: string,
  ): Promise<TracerEvent> {
    const fallbackFunction = traceRequest?.functionName ?? extractDisplayNameFromId(entryFullId, entryFullId);
    const fallbackLine = traceRequest?.line ?? Math.max(1, Math.floor(displayLine + 1));
    const resolvedRequest: FlowTraceRequest = traceRequest ?? {
      flowId: entryFullId,
      flowName: entryFullId,
      functionName: fallbackFunction,
      line: fallbackLine,
      location: `${fallbackFunction}:${fallbackLine}`,
      filePath: undefined,
    };
    const firstTime = this.process === undefined;
    const needsNewTracer = this.currentFlow !== entryFullId;

    this.suppressWebviewEvents = suppressWebview;
    this.pendingDisplayLine = displayLine;
    this.pendingDisplayFile = displayFile;
    this.currentDisplayLine = displayLine;
    this.currentDisplayFile = displayFile;

    const contextKey = this.buildContextKey(repoRoot, entryFullId, argsJson, contextSuffix);
    this.pendingLocation = resolvedRequest.location;
    this.pendingContextKey = contextKey;
    this.pendingTraceRequest = resolvedRequest;

    const cachedEvent = this.getCachedEvent(contextKey, resolvedRequest.location, displayLine, displayFile);
    if (cachedEvent) {
      this.outputChannel.appendLine(
        `[Rust-like] Using cached tracer result for location=${resolvedRequest.location}`,
      );
      this.lastEvent = cachedEvent;
      this.lastContextKey = contextKey;
      this.lastLocationKey = resolvedRequest.location;
      this.lastTraceRequest = resolvedRequest;
      this.clearPendingDisplay();
      return cachedEvent;
    }

    if (firstTime) {
      this.outputChannel.appendLine(`[Rust-like] First call - spawning tracer for ${entryFullId}`);
      this.currentFlow = entryFullId;
      console.log('Spawning tracer with request:', resolvedRequest);
      this.spawnTracer(repoRoot, entryFullId, resolvedRequest, argsJson, extensionPath, pythonPath);
    }

    if (needsNewTracer && this.process) {
      this.outputChannel.appendLine(
        `[Rust-like] Switching tracer from ${this.currentFlow ?? 'unknown'} to ${entryFullId}`,
      );
      if (this.process.stdin) {
        this.process.stdin.write('0\n');
      }
      this.process.kill();
      try {
        this.process.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      } catch {
        // ignore kill errors
      }
      this.currentFlow = entryFullId;
      this.spawnTracer(repoRoot, entryFullId, resolvedRequest, argsJson, extensionPath, pythonPath);
    }

    const isFirstCall = firstTime || needsNewTracer;
    if (!isFirstCall && this.process && this.process.stdin && !this.process.stdin.destroyed) {
      const continuePayload: Record<string, unknown> = {
        flow: resolvedRequest.flowName,
        location: resolvedRequest.location,
        function: resolvedRequest.functionName,
        line: resolvedRequest.line,
      };
      if (resolvedRequest.filePath) {
        continuePayload.file = resolvedRequest.filePath;
      }
      const payloadText = JSON.stringify(continuePayload);
      this.outputChannel.appendLine(`{Rust-like} Continue ${payloadText}`);
      this.process.stdin.write(`${payloadText}\n`);
    } else {
      this.outputChannel.appendLine(`[Rust-like] Awaiting initial flow payload from Python`);
    }

    if (this.process) {
      const status = this.process.killed ? 'killed' : null;
      if (status) {
        throw new Error('Python process was killed before reading event');
      }
    }

    if (this.eventQueue.length > 0) {
      const queued = this.eventQueue.shift() as TracerEvent;
      this.clearPendingDisplay();
      return queued;
    }

    return new Promise<TracerEvent>((resolve, reject) => {
      const resolveWrapper = (event: TracerEvent) => {
        clearTimeout(timeout);
        resolve(event);
      };

      const rejectWrapper = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
        this.clearPendingDisplay();
      };

      const timeout = setTimeout(() => {
        if (this.pendingReadResolve === resolveWrapper) {
          this.pendingReadResolve = undefined;
          this.pendingReadReject = undefined;
        }
        reject(new Error(`Timeout waiting for location ${resolvedRequest.location}`));
      }, 30000);

      this.pendingReadResolve = resolveWrapper;
      this.pendingReadReject = rejectWrapper;

      if (this.stderrBuffer) {
        const lines = this.stderrBuffer.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const rawEvent: TracerEvent = JSON.parse(line);
              this.processIncomingEvent(rawEvent);
              clearTimeout(timeout);
              return;
            } catch {
              // ignore
            }
          }
        }
      }
    });
  }

  private emitTracerEvent(event: TracerEvent): void {
    if (event.event === 'line') {
      this.outputChannel.appendLine(
        `[Line ${event.line}] Function: ${event.function || 'unknown'}`,
      );

      if (event.locals) {
        this.outputChannel.appendLine('  Locals:');
        for (const [key, value] of Object.entries(event.locals)) {
          this.outputChannel.appendLine(`    ${key} = ${JSON.stringify(value)}`);
        }
      }

      if (event.globals) {
        this.outputChannel.appendLine('  Globals:');
        for (const [key, value] of Object.entries(event.globals)) {
          this.outputChannel.appendLine(`    ${key} = ${JSON.stringify(value)}`);
        }
      }

      if (this.webview && !this.suppressWebviewEvents) {
        this.webview.postMessage({
          type: 'tracer-event',
          event,
        });
      }
    } else if (event.event === 'error') {
      this.outputChannel.appendLine(`[Tracer Error] ${event.error || 'Unknown error'}`);
      if (event.traceback) {
        this.outputChannel.appendLine(event.traceback);
      }
      if (this.webview && !this.suppressWebviewEvents) {
        this.webview.postMessage({
          type: 'tracer-error',
          error: event.error || 'Unknown error',
          traceback: event.traceback,
          line: event.line,
          filename: event.filename,
        });
      }
    }
  }

  stop(): void {
    if (this.process) {
      if (this.process.stdin && !this.process.stdin.destroyed) {
        this.process.stdin.write('0\n');
      }
      this.process.kill();
      this.process = undefined;
      this.currentFlow = undefined;
    }
    if (this.pendingReadReject) {
      this.pendingReadReject(new Error('Tracer stopped'));
      this.pendingReadResolve = undefined;
      this.pendingReadReject = undefined;
    }
    this.stderrBuffer = '';
    this.eventQueue = [];
    this.clearPendingDisplay();
    this.currentDisplayLine = undefined;
    this.currentDisplayFile = undefined;
    this.lastEvent = undefined;
    this.lastContextKey = undefined;
    this.lastLocationKey = undefined;
    this.pendingContextKey = undefined;
    this.pendingLocation = undefined;
    this.lastTraceRequest = undefined;
    this.pendingTraceRequest = undefined;
    this.cachedEvents.clear();
  }
}
