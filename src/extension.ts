import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  analyzeWithPython,
  ChangedFunction,
  FlowEntry,
  FunctionBody,
  resolveRepoRoot,
} from './changedFunctions';

let flowPanel: vscode.WebviewPanel | undefined;
let flowPanelMessageDisposable: vscode.Disposable | undefined;
let currentFunctionBodies: Record<string, FunctionBody> = {};
let currentRepoRoot: string | undefined;

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

export function deactivate() {}

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
