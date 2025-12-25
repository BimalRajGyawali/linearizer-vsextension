import * as vscode from 'vscode';
import { showChangedFunctionsCommand } from './commands/showChangedFunctions';
import { stopAllTracers } from './tracing/tracingService';
import { resetRuntimeState } from './state/runtime';

let sharedOutputChannel: vscode.OutputChannel | undefined;

function ensureOutputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!sharedOutputChannel) {
    sharedOutputChannel = vscode.window.createOutputChannel('Linearizer');
    context.subscriptions.push(sharedOutputChannel);
  }
  return sharedOutputChannel;
}

function disposeResources(): void {
  stopAllTracers();
  resetRuntimeState();
  if (sharedOutputChannel) {
    sharedOutputChannel.dispose();
    sharedOutputChannel = undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const commandDisposable = vscode.commands.registerCommand('linearizer.showChangedFunctions', async () => {
    const outputChannel = ensureOutputChannel(context);
    await showChangedFunctionsCommand(context, outputChannel);
  });

  context.subscriptions.push(commandDisposable, new vscode.Disposable(disposeResources));
}

export function deactivate(): void {
  disposeResources();
}
