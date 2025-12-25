import * as vscode from 'vscode';
import { analyzeWithPython, resolveRepoRoot } from '../changedFunctions';
import { showFlowPanel } from '../panel/flowPanel';

export async function showChangedFunctionsCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const workspaceFolder = await pickWorkspaceFolder();
  if (!workspaceFolder) {
    return;
  }

  try {
    const repoRoot = await resolveRepoRoot(workspaceFolder.uri.fsPath);
    const analysis = await analyzeWithPython(workspaceFolder.uri.fsPath, context.extensionPath);
    const { changedFunctions, flows, warnings, functionBodies } = analysis;

    if (changedFunctions.length === 0) {
      outputChannel.clear();
      outputChannel.appendLine(`No changed Python functions found for ${workspaceFolder.name}.`);
      outputChannel.show(true);
      vscode.window.showInformationMessage('No changed Python functions found in the Git diff.');
      return;
    }

    await showFlowPanel(context, repoRoot, changedFunctions, flows, warnings, functionBodies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Error: ${message}`);
    outputChannel.show(true);
    vscode.window.showErrorMessage(message);
  }
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('Open a workspace folder to analyze Git changes.');
    return undefined;
  }

  if (workspaceFolders.length === 1) {
    return workspaceFolders[0];
  }

  const items: Array<vscode.QuickPickItem & { folder: vscode.WorkspaceFolder }> = workspaceFolders.map((folder) => ({
    label: folder.name,
    description: folder.uri.fsPath,
    folder,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the workspace folder to analyze',
  });
  return picked?.folder;
}
