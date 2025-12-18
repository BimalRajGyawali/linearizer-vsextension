import * as vscode from 'vscode';
import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import {
  analyzeWithPython,
  ChangedFunction,
  FlowEntry,
  FunctionBody,
  resolveRepoRoot,
} from './changedFunctions';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from 'node:console';

const execFileAsync = promisify(execFile);

let flowPanel: vscode.WebviewPanel | undefined;
let flowPanelMessageDisposable: vscode.Disposable | undefined;
let currentFunctionBodies: Record<string, FunctionBody> = {};
let currentRepoRoot: string | undefined;
let activeTracer: TracerManager | undefined;
let tracerOutputChannel: vscode.OutputChannel | undefined;
const storedCallArgs: Map<string, NormalisedCallArgs> = new Map();

interface TracerEvent {
	event: string;
	filename?: string;
	function?: string;
	line?: number;
	locals?: Record<string, unknown>;
	globals?: Record<string, unknown>;
	error?: string;
	traceback?: string;
}

interface TraceCallArgs {
	args?: unknown[];
	kwargs?: Record<string, unknown>;
}

interface NormalisedCallArgs {
	args: unknown[];
	kwargs: Record<string, unknown>;
}

const DEFAULT_PARENT_CALL_ARGS: NormalisedCallArgs = {
	args: [],
	kwargs: { metric_name: 'test', period: 'last_7_days' },
};

function isTraceCallArgs(value: unknown): value is TraceCallArgs {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as TraceCallArgs;
	const argsValid = !('args' in candidate) || Array.isArray(candidate.args);
	const kwargsValid =
		!('kwargs' in candidate) ||
		(typeof candidate.kwargs === 'object' && candidate.kwargs !== null && !Array.isArray(candidate.kwargs));
	return argsValid && kwargsValid;
}

function normaliseCallArgs(input?: TraceCallArgs): NormalisedCallArgs {
	const args = input && Array.isArray(input.args) ? input.args : [];
	const kwargs = input && input.kwargs && typeof input.kwargs === 'object' && !Array.isArray(input.kwargs)
		? input.kwargs
		: {};
	return {
		args: [...args],
		kwargs: { ...kwargs } as Record<string, unknown>,
	};
}

function cloneCallArgs(args: NormalisedCallArgs): NormalisedCallArgs {
	return {
		args: [...args.args],
		kwargs: { ...args.kwargs },
	};
}

function getStoredCallArgs(functionId: string): NormalisedCallArgs | undefined {
	return storedCallArgs.get(functionId);
}

function setStoredCallArgs(functionId: string, args: NormalisedCallArgs): void {
	storedCallArgs.set(functionId, cloneCallArgs(args));
}

class TracerManager {
	private process: ChildProcess | undefined;
	private outputChannel: vscode.OutputChannel;
	private webview: vscode.Webview | undefined;
	private currentFlow: string | undefined; // Track which function is currently being traced
	private stderrBuffer: string = '';
	private eventQueue: TracerEvent[] = [];
	private pendingReadResolve: ((value: TracerEvent) => void) | undefined;
	private pendingReadReject: ((error: Error) => void) | undefined;
	private pendingDisplayLine: number | undefined;
	private pendingDisplayFile: string | undefined;
	private currentDisplayLine: number | undefined;
	private currentDisplayFile: string | undefined;
	private suppressWebviewEvents: boolean = false; // Suppress webview events for parent tracing

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
		// Always prefer pendingDisplayLine, then currentDisplayLine
		const targetLine =
			typeof this.pendingDisplayLine === 'number'
				? this.pendingDisplayLine
				: this.currentDisplayLine;
		const targetFile = this.pendingDisplayFile ?? this.currentDisplayFile;

		if (decorated.event === 'line') {
			// ALWAYS override line number with targetLine if available
			// This ensures the clicked line is always used, not the tracer's reported line
			if (typeof targetLine === 'number') {
				decorated.line = targetLine;
			}
			if (targetFile && !decorated.filename) {
				decorated.filename = targetFile;
			}
		}
		if (decorated.event === 'error') {
			// For errors, use targetLine if event doesn't have a line, or always override
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

	private processIncomingEvent(rawEvent: TracerEvent): void {
		const decorated = this.decorateEvent(rawEvent);
		
		// Log for debugging first click issues
		if (decorated.event === 'line') {
			this.outputChannel.appendLine(`[processIncomingEvent] Decorated event: line=${decorated.line}, pendingDisplayLine=${this.pendingDisplayLine}, currentDisplayLine=${this.currentDisplayLine}, originalLine=${rawEvent.line}`);
		}

		if (this.pendingReadResolve) {
			const resolver = this.pendingReadResolve;
			this.pendingReadResolve = undefined;
			this.pendingReadReject = undefined;
			resolver(decorated);
			this.clearPendingDisplay();
			// Don't emit to webview here - handleTraceLine will send it with the correct line number
		} else {
			this.eventQueue.push(decorated);
			// Only emit to webview if there's no pending resolver (queued events)
			this.emitTracerEvent(decorated);
		}
	}

	private spawnTracer(
		repoRoot: string,
		entryFullId: string,
		stopLine: number,
		argsJson: string,
		extensionPath: string,
		pythonPath: string,
	): void {
		const tracerPath = path.join(extensionPath, 'python', 'tracer.py');

		this.outputChannel.appendLine(`[Rust-like] Spawning tracer for ${entryFullId} at line ${stopLine}`);
		this.outputChannel.show(true);

		const args = [
			'-u',
			tracerPath,
			'--repo_root', repoRoot,
			'--entry_full_id', entryFullId,
			'--args_json', argsJson,
			'--stop_line', stopLine.toString(),
		];

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

		// Handle stderr data - accumulate and parse JSON lines
		this.process.stderr?.on('data', (data: Buffer) => {
			const text = data.toString();
			this.stderrBuffer += text;
			
			// Try to parse complete JSON lines
			const lines = this.stderrBuffer.split('\n');
			this.stderrBuffer = lines.pop() || '';
			
			for (const line of lines) {
				if (line.trim()) {
					try {
						const rawEvent: TracerEvent = JSON.parse(line);
						this.processIncomingEvent(rawEvent);
					} catch {
						// Not JSON, just log it
						this.outputChannel.appendLine(`[Tracer] ${line}`);
					}
				}
			}
		});

		this.process.stdout?.on('data', (data: Buffer) => {
			this.outputChannel.appendLine(`[Tracer stdout] ${data.toString()}`);
		});

		this.process.on('error', (error) => {
			this.outputChannel.appendLine(`[Tracer error] ${error.message}`);
			if (this.pendingReadReject) {
				this.pendingReadReject(new Error(error.message));
				this.pendingReadResolve = undefined;
				this.pendingReadReject = undefined;
			}
			if (this.webview) {
				this.webview.postMessage({
					type: 'tracer-error',
					error: error.message,
				});
			}
		});

		this.process.on('exit', (code) => {
			this.outputChannel.appendLine(`[Tracer] Process exited with code ${code}`);
			if (this.pendingReadReject) {
				this.pendingReadReject(new Error(`Python process exited with code ${code}`));
				this.pendingReadResolve = undefined;
				this.pendingReadReject = undefined;
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
		suppressWebview: boolean = false,
	): Promise<TracerEvent> {
		const firstTime = this.process === undefined;
		const needsNewTracer = this.currentFlow !== entryFullId;

		// Set suppress flag for parent tracing (don't show values at call site)
		this.suppressWebviewEvents = suppressWebview;

		this.pendingDisplayLine = displayLine;
		this.pendingDisplayFile = displayFile;
		this.currentDisplayLine = displayLine;
		this.currentDisplayFile = displayFile;

		// Spawn tracer if not alive
		if (firstTime) {
			this.outputChannel.appendLine(`[Rust-like] First time - spawning tracer`);
			this.currentFlow = entryFullId;
			this.spawnTracer(repoRoot, entryFullId, displayLine + 1, argsJson, extensionPath, pythonPath);
		}

		// If new flow detected, kill old tracer and spawn new one
		if (needsNewTracer && this.process) {
			this.outputChannel.appendLine(
				`[Rust-like] New flow detected (old: ${this.currentFlow}, new: ${entryFullId}), spawning new tracer`
			);
			
			// Kill the old tracer process
			if (this.process.stdin) {
				this.process.stdin.write('0\n');
			}
			this.process.kill();
			try {
				this.process.kill('SIGTERM');
				// Wait a bit for graceful shutdown
				await new Promise(resolve => setTimeout(resolve, 100));
				if (this.process && !this.process.killed) {
					this.process.kill('SIGKILL');
				}
			} catch {
				// Ignore errors
			}
			
			// Spawn new tracer for the new function
			this.currentFlow = entryFullId;
			this.spawnTracer(repoRoot, entryFullId, displayLine + 1, argsJson, extensionPath, pythonPath);
		}

		// Determine if this is the first call for this tracer
		const isFirstCall = firstTime || needsNewTracer;

		// Send continue command if not first call
		if (!isFirstCall && this.process && this.process.stdin && !this.process.stdin.destroyed) {
			this.outputChannel.appendLine(`[Rust-like] Sending continue_to ${displayLine + 1}`);
			this.process.stdin.write(`${displayLine + 1}\n`);
		} else {
			this.outputChannel.appendLine(`[Rust-like] First call for this function — Python will send initial event`);
		}

		// Read from stderr (Python writes events to stderr)
		// Check if process is still alive before reading
		if (this.process) {
			const status = this.process.killed ? 'killed' : null;
			if (status) {
				throw new Error(`Python process was killed before reading event`);
			}
		}

		// If there's already an event queued, return it immediately
		if (this.eventQueue.length > 0) {
			const queued = this.eventQueue.shift() as TracerEvent;
			this.clearPendingDisplay();
			return queued;
		}

		// Wait for event from stderr (async read)
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

			// Set timeout (30 seconds like Python)
			const timeout = setTimeout(() => {
				if (this.pendingReadResolve === resolveWrapper) {
					this.pendingReadResolve = undefined;
					this.pendingReadReject = undefined;
				}
				reject(new Error(`Timeout waiting for function to reach line ${displayLine + 1}`));
			}, 30000);

			this.pendingReadResolve = resolveWrapper;
			this.pendingReadReject = rejectWrapper;

			// Check if we already have data in buffer
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
							// Not JSON, continue
						}
					}
				}
			}
		});
	}

	private emitTracerEvent(event: TracerEvent): void {
		if (event.event === 'line') {
			this.outputChannel.appendLine(
				`[Line ${event.line}] Function: ${event.function || 'unknown'}`
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
					event: event,
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
	}
}

export function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('Linearizer');
	context.subscriptions.push(outputChannel);

	const disposable = vscode.commands.registerCommand('linearizer.showChangedFunctions', async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			vscode.window.showErrorMessage('Open a workspace folder to analyze Git changes.');
			return;
		}

		let selectedFolder: vscode.WorkspaceFolder | undefined;
		if (workspaceFolders.length === 1) {
			selectedFolder = workspaceFolders[0];
		} else {
			const items: Array<vscode.QuickPickItem & { folder: vscode.WorkspaceFolder }> = workspaceFolders.map(
				(folder) => ({
					label: folder.name,
					description: folder.uri.fsPath,
					folder,
				}),
			);
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: 'Select the workspace folder to analyze',
			});
			if (!picked) {
				return;
			}
			selectedFolder = picked.folder;
		}

		if (!selectedFolder) {
			return;
		}

		console.log(`[extension] Analyzing folder: ${selectedFolder.name} at ${selectedFolder.uri.fsPath}`);

		try {
			const repoRoot = await resolveRepoRoot(selectedFolder.uri.fsPath);
			const analysis = await analyzeWithPython(selectedFolder.uri.fsPath, context.extensionPath);
			const { changedFunctions, flows, warnings, functionBodies } = analysis;

			if (changedFunctions.length === 0) {
				outputChannel.clear();
				outputChannel.appendLine(`No changed Python functions found for ${selectedFolder.name}.`);
				outputChannel.show(true);
				vscode.window.showInformationMessage('No changed Python functions found in the Git diff.');
				return;
			}

			outputChannel.clear();
			renderChangedFunctions(outputChannel, changedFunctions);
			renderWarnings(outputChannel, warnings);
			await showFlowPanel(context, repoRoot, changedFunctions, flows, warnings, functionBodies);

			const quickPickItems = changedFunctions.map((entry) => ({
				label: buildFunctionLabel(entry),
				description: `${entry.file}:${entry.line}`,
				entry,
			}));

			const selection = await vscode.window.showQuickPick(quickPickItems, {
				placeHolder: 'Select a changed function to open (Esc to cancel)',
			});

			if (selection) {
				const targetUri = vscode.Uri.file(path.join(repoRoot, selection.entry.file));
				const document = await vscode.workspace.openTextDocument(targetUri);
				const editor = await vscode.window.showTextDocument(document, { preview: false });
				const targetPosition = new vscode.Position(Math.max(selection.entry.line - 1, 0), 0);
				editor.selection = new vscode.Selection(targetPosition, targetPosition);
				editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outputChannel.appendLine(`Error: ${message}`);
			outputChannel.show(true);
			vscode.window.showErrorMessage(message);
		}
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {
	if (activeTracer) {
		activeTracer.stop();
		activeTracer = undefined;
	}
}

function renderChangedFunctions(channel: vscode.OutputChannel, changedFunctions: ChangedFunction[]): void {
	channel.appendLine(`Changed Python functions (${changedFunctions.length})`);

	let currentFile: string | undefined;
	for (const entry of changedFunctions) {
		if (entry.file !== currentFile) {
			channel.appendLine('');
			channel.appendLine(entry.file);
			currentFile = entry.file;
		}

		const label = buildFunctionLabel(entry);
		const endLine = entry.endLine && entry.endLine !== entry.line ? `-${entry.endLine}` : '';
		channel.appendLine(`  • ${label} (line ${entry.line}${endLine})`);
	}
}

function renderWarnings(channel: vscode.OutputChannel, warnings: string[]): void {
	if (!warnings.length) {
		return;
	}
	channel.appendLine('');
	channel.appendLine('Warnings');
	for (const warning of warnings) {
		channel.appendLine(`  ! ${warning}`);
	}
}

function buildFunctionLabel(entry: ChangedFunction): string {
	if (entry.module && entry.module.length > 0) {
		return `${entry.module}.${entry.functionName}`;
	}
	return entry.functionName;
}

async function showFlowPanel(
	context: vscode.ExtensionContext,
	repoRoot: string,
	changedFunctions: ChangedFunction[],
	flows: FlowEntry[],
	warnings: string[],
	functionBodies: Record<string, FunctionBody>,
): Promise<void> {
	currentRepoRoot = repoRoot;
	const hydratedFunctionBodies = await hydrateFunctionBodies(repoRoot, functionBodies);
	currentFunctionBodies = hydratedFunctionBodies;

	if (!flowPanel) {
		flowPanel = vscode.window.createWebviewPanel(
			'linearizerFlows',
			'Linearizer Call Flows',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
			},
		);
		context.subscriptions.push(flowPanel);
		flowPanel.onDidDispose(
			() => {
				if (activeTracer) {
					activeTracer.stop();
					activeTracer = undefined;
				}
				flowPanel = undefined;
				currentFunctionBodies = {};
				currentRepoRoot = undefined;
				if (flowPanelMessageDisposable) {
					flowPanelMessageDisposable.dispose();
					flowPanelMessageDisposable = undefined;
				}
			},
			undefined,
			context.subscriptions,
		);
	} else {
		flowPanel.reveal(vscode.ViewColumn.Active);
	}

	if (flowPanelMessageDisposable) {
		flowPanelMessageDisposable.dispose();
		flowPanelMessageDisposable = undefined;
	}

	if (flowPanel) {
		flowPanel.webview.html = buildFlowWebviewHtml(
			context,
			flowPanel.webview,
			changedFunctions,
			flows,
			warnings,
			hydratedFunctionBodies,
		);

		flowPanelMessageDisposable = flowPanel.webview.onDidReceiveMessage(async (message) => {
			if (!message || typeof message !== 'object') {
				return;
			}
			console.log('[extension] Received message:', message.type);
			if (message.type === 'open-source' && typeof message.identifier === 'string') {
				const details = resolveFunctionBody(message.identifier);
				if (!details || !currentRepoRoot) {
					return;
				}
				const targetUri = vscode.Uri.file(path.join(currentRepoRoot, details.file));
				const document = await vscode.workspace.openTextDocument(targetUri);
				const editor = await vscode.window.showTextDocument(document, { preview: false });
				const targetPosition = new vscode.Position(Math.max(details.line - 1, 0), 0);
				editor.selection = new vscode.Selection(targetPosition, targetPosition);
				editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);
			} else if (message.type === 'trace-line' && typeof message.functionId === 'string' && typeof message.line === 'number') {
				console.log('[extension] Handling trace-line:', message.functionId, message.line);
				try {
					const callArgs = isTraceCallArgs(message.callArgs) ? message.callArgs : undefined;
					const stopLineCandidate = typeof message.stopLine === 'number' ? message.stopLine : message.line + 1;
					const stopLine = Number.isFinite(stopLineCandidate) ? stopLineCandidate : message.line + 1;
					const parentContext = (message.isNested && typeof message.parentFunctionId === 'string' && typeof message.parentLine === 'number' && typeof message.callLine === 'number')
						? {
							parentFunctionId: message.parentFunctionId,
							parentLine: message.parentLine,
							callLine: message.callLine,
						}
						: undefined;
					await handleTraceLine(message.functionId, message.line, stopLine, context, callArgs, parentContext);
				} catch (error) {
					console.error('[extension] Error in handleTraceLine:', error);
					vscode.window.showErrorMessage(`Error tracing line: ${error instanceof Error ? error.message : String(error)}`);
				}
			} else if (message.type === 'stop-trace') {
				if (activeTracer) {
					activeTracer.stop();
					activeTracer = undefined;
				}
			}
		});
		context.subscriptions.push(flowPanelMessageDisposable);
	}
}

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
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
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

function escapeAttribute(value: string): string {
	return escapeHtml(value).replace(/`/g, '&#96;');
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

async function hydrateFunctionBodies(
	repoRoot: string,
	original: Record<string, FunctionBody>,
): Promise<Record<string, FunctionBody>> {
	const entries = await Promise.all(
		Object.entries(original).map(async ([id, body]) => {
			if (!body || typeof body !== 'object') {
				return [id, body] as const;
			}
			const relativeFile = body.file;
			if (!relativeFile) {
				return [id, body] as const;
			}
			let document: vscode.TextDocument;
			try {
				document = await vscode.workspace.openTextDocument(
					vscode.Uri.file(path.join(repoRoot, relativeFile)),
				);
			} catch {
				return [id, body] as const;
			}

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

			return [
				id,
				{
					...body,
					body: normalised || fallbackText,
				},
			] as const;
		}),
	);

	return Object.fromEntries(entries);
}

function extractDisplayNameFromId(identifier: string, fallback: string): string {
	const trimmed = identifier.trim();
	if (!trimmed) {
		return fallback;
	}
	const withoutPrefix = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
	const parts = withoutPrefix.split('::');
	if (parts.length > 1) {
		const candidate = parts[parts.length - 1].trim();
		if (candidate.length > 0) {
			return candidate;
		}
	}
	const lastSlash = withoutPrefix.lastIndexOf('/');
	if (lastSlash >= 0 && lastSlash < withoutPrefix.length - 1) {
		const candidate = withoutPrefix.slice(lastSlash + 1);
		if (candidate.length > 0) {
			return candidate;
		}
	}
	return withoutPrefix || fallback;
}

function resolveFunctionBody(identifier: string): FunctionBody | undefined {
	if (!identifier || identifier.trim().length === 0) {
		return undefined;
	}

	const candidates = buildIdentifierCandidates(identifier);
	for (const candidate of candidates) {
		const match = currentFunctionBodies[candidate];
		if (match) {
			return match;
		}
	}

	const normalisedTarget = normaliseIdentifier(identifier);
	if (!normalisedTarget) {
		return undefined;
	}

	for (const [key, body] of Object.entries(currentFunctionBodies)) {
		if (normaliseIdentifier(key) === normalisedTarget) {
			return body;
		}
	}

	return undefined;
}

function buildIdentifierCandidates(identifier: string): string[] {
	const trimmed = identifier.trim();
	if (!trimmed) {
		return [];
	}

	const candidates = new Set<string>();
	const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
	const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
	const withoutDotSlash = withoutSlash.startsWith('./') ? withoutSlash.slice(2) : withoutSlash;

	candidates.add(trimmed);
	candidates.add(withSlash);
	candidates.add(withoutSlash);
	candidates.add(withoutDotSlash);

	return Array.from(candidates);
}

function normaliseIdentifier(identifier: string): string {
	const trimmed = identifier.trim();
	if (!trimmed) {
		return '';
	}
	const withoutPrefix = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
	const [file, func = ''] = withoutPrefix.split('::');
	const normalisedFile = file.replace(/\\+/g, '/').replace(/^\.\//, '');
	return `${normalisedFile}::${func}`.toLowerCase();
}

async function getPythonPath(): Promise<string> {
	const config = vscode.workspace.getConfiguration('linearizer');
	const configured = config.get<string>('pythonPath');
	if (configured && configured.trim().length > 0) {
		return configured.trim();
	}
	// Try common Python executables
	const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
	for (const candidate of candidates) {
		try {
			await execFileAsync(candidate, ['--version']);
			return candidate;
		} catch {
			// Continue to next candidate
		}
	}
	throw new Error('Python executable not found. Please configure linearizer.pythonPath');
}

async function extractCallArguments(
	pythonPath: string,
	repoRoot: string,
	nestedFunctionId: string,
	parentFile: string,
	callLine: number,
	locals: Record<string, unknown>,
	globals: Record<string, unknown>,
	extensionPath: string,
): Promise<TraceCallArgs | null> {
	try {
		const tracerScript = path.join(extensionPath, 'python', 'tracer.py');
		const nestedEntryFullId = nestedFunctionId.startsWith('/') ? nestedFunctionId.slice(1) : nestedFunctionId;
		
		const result = await execFileAsync(pythonPath, [
			tracerScript,
			'--extract-call-args',
			'--repo_root', repoRoot,
			'--entry_full_id', nestedEntryFullId,
			'--parent-file', parentFile,
			'--call-line', String(callLine),
			'--locals', JSON.stringify(locals),
			'--globals', JSON.stringify(globals),
		], {
			timeout: 30000,
			cwd: repoRoot,
		});

		const parsed = JSON.parse(result.stdout);
		if (parsed.error) {
			console.error('[extension] Error extracting call arguments:', parsed.error);
			return null;
		}
		return parsed.args ? parsed.args : null;
	} catch (error) {
		console.error('[extension] Failed to extract call arguments:', error);
		return null;
	}
}

async function getFunctionSignature(
	pythonPath: string,
	repoRoot: string,
	entryFullId: string,
	extensionPath: string,
): Promise<{ params: string[]; param_count: number } | null> {
	const tracerPath = path.join(extensionPath, 'python', 'tracer.py');

	try {
		await fs.access(tracerPath);
	} catch {
		return null;
	}

	try {
		const { stdout } = await execFileAsync(pythonPath, [
			tracerPath,
			'--repo_root', repoRoot,
			'--entry_full_id', entryFullId,
			'--get_signature',
		], { cwd: repoRoot });
		
		const result = JSON.parse(stdout);
		if (result.error) {
			return null;
		}
		return result;
	} catch {
		return null;
	}
}

interface ParentContext {
	parentFunctionId: string;
	parentLine: number;
	callLine: number;
}

async function handleTraceLine(
	functionId: string,
	displayLine: number,
	stopLine: number,
	context: vscode.ExtensionContext,
	callArgs?: TraceCallArgs,
	parentContext?: ParentContext,
): Promise<void> {
	if (!currentRepoRoot) {
		vscode.window.showErrorMessage('No repository root available');
		return;
	}

	const functionBody = resolveFunctionBody(functionId);
	if (!functionBody) {
		vscode.window.showErrorMessage(`Function ${functionId} not found`);
		return;
	}

		const executionLine = Number.isFinite(stopLine) ? stopLine : displayLine + 1;

	try {
		const pythonPath = await getPythonPath();
		const entryFullId = functionId.startsWith('/') ? functionId.slice(1) : functionId;
		let resolvedArgs = callArgs ? normaliseCallArgs(callArgs) : cloneCallArgs(DEFAULT_PARENT_CALL_ARGS);
		let argsJson: string;
		let hasExtractedArgs = false; // Track if we extracted args from parent

		// If this is a nested function, trace the parent first to get arguments
		if (parentContext && !callArgs) {
			const parentFunctionBody = resolveFunctionBody(parentContext.parentFunctionId);
			if (!parentFunctionBody) {
				vscode.window.showErrorMessage(`Parent function ${parentContext.parentFunctionId} not found`);
				return;
			}

			// Get parent function's stored args or use defaults
			const parentStoredArgs = getStoredCallArgs(parentContext.parentFunctionId);
			const parentArgsJson = parentStoredArgs 
				? JSON.stringify(parentStoredArgs)
				: JSON.stringify(cloneCallArgs(DEFAULT_PARENT_CALL_ARGS));

			// Create or get tracer for parent
			if (!tracerOutputChannel) {
				tracerOutputChannel = vscode.window.createOutputChannel('Linearizer Tracer');
			}
			if (!activeTracer) {
				activeTracer = new TracerManager(tracerOutputChannel, flowPanel?.webview);
			}
			activeTracer.setWebview(flowPanel?.webview);

			const parentEntryFullId = parentContext.parentFunctionId.startsWith('/') 
				? parentContext.parentFunctionId.slice(1) 
				: parentContext.parentFunctionId;

			// Trace parent to the call line (including the call line itself)
			// The Python tracer stops when lineno >= target_line, so we pass callLine as displayLine
			// which becomes stopLine = callLine + 1, executing up to and including the call line
			// Suppress webview events so we don't show values at the call site
			const parentEvent = await activeTracer.getTracerData(
				currentRepoRoot!,
				parentEntryFullId,
				parentContext.callLine, // Display line: this becomes stopLine = callLine + 1, executing the call line
				parentFunctionBody.file,
				parentArgsJson,
				context.extensionPath,
				pythonPath,
				true, // suppressWebview = true: don't display parent events
			);

			if (parentEvent.event === 'error') {
				vscode.window.showErrorMessage(`Error tracing parent function: ${parentEvent.error || 'Unknown error'}`);
				return;
			}

			// Extract call arguments from parent's locals/globals
			// We need to find the call to the nested function (functionId) on the call line in the parent
			const extractedArgs = await extractCallArguments(
				pythonPath,
				currentRepoRoot!,
				functionId, // The nested function being called
				parentFunctionBody.file, // The parent function's file where the call happens
				parentContext.callLine,
				parentEvent.locals || {},
				parentEvent.globals || {},
				context.extensionPath,
			);

			if (extractedArgs) {
				resolvedArgs = normaliseCallArgs(extractedArgs);
				hasExtractedArgs = true; // Mark that we have extracted args
			}
			
			// Reset suppress flag so nested function events will be displayed
			if (activeTracer) {
				activeTracer.setSuppressWebviewEvents(false);
			}
		}

		// If we have callArgs or extracted args from parent, use them directly
		if (callArgs || hasExtractedArgs) {
			argsJson = JSON.stringify(resolvedArgs);
		} else {
			const signature = await getFunctionSignature(pythonPath, currentRepoRoot, entryFullId, context.extensionPath);
			const defaultJson = JSON.stringify(resolvedArgs);
			if (signature && signature.params.length > 0) {
				const paramInput = await vscode.window.showInputBox({
					prompt: `Enter function arguments as JSON (params: ${signature.params.join(', ')}). Example: {"args": [1, 2], "kwargs": {"key": "value"}}`,
					placeHolder: defaultJson,
					value: defaultJson,
				});

				if (paramInput === undefined) {
					return; // User cancelled
				}

				if (paramInput.trim()) {
					try {
						const parsed = JSON.parse(paramInput);
						if (!isTraceCallArgs(parsed)) {
							throw new Error('Invalid argument structure');
						}
						resolvedArgs = normaliseCallArgs(parsed);
					} catch {
						vscode.window.showErrorMessage('Invalid JSON format for arguments');
						return;
					}
				} else {
					resolvedArgs = cloneCallArgs(DEFAULT_PARENT_CALL_ARGS);
				}
			}
			argsJson = JSON.stringify(resolvedArgs);
		}

		// Create or reuse tracer
		if (!tracerOutputChannel) {
			tracerOutputChannel = vscode.window.createOutputChannel('Linearizer Tracer');
		}
		if (!activeTracer) {
			activeTracer = new TracerManager(tracerOutputChannel, flowPanel?.webview);
		}
		// Update webview reference in case it changed
		activeTracer.setWebview(flowPanel?.webview);
		
		try {
			const event = await activeTracer.getTracerData(
				currentRepoRoot,
				entryFullId,
				displayLine,
				functionBody.file,
				argsJson,
				context.extensionPath,
				pythonPath,
			);

			if (event.event === 'error') {
				const errorMessage = event.error || 'Unknown tracer error';
				vscode.window.showErrorMessage(`Tracer error: ${errorMessage}`);
				return;
			}

			
			if (flowPanel?.webview) {
				// Ensure we only send one event with the exact displayLine
				// Override any line number from the tracer to match the clicked line
				const finalEvent = {
					...event,
					line: displayLine, // Always use the clicked line, not the tracer's line
					filename: event.filename ?? functionBody.file,
				};
				flowPanel.webview.postMessage({
					type: 'tracer-event',
					event: finalEvent,
				});
			}

			vscode.window.showInformationMessage(`Tracer reached line ${displayLine} in ${functionId}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Tracer error: ${message}`);
			
			// Send error event to webview
			if (flowPanel?.webview) {
				flowPanel.webview.postMessage({
					type: 'tracer-error',
					error: message,
					line: displayLine,
					filename: functionBody.file,
				});
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to start tracer: ${message}`);
	}
}
