import * as vscode from 'vscode';
import { ChimeraGenerator } from '../chimeraGenerator';
import { ServiceContainer } from '../services/serviceContainer';

export function registerTemplateCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): void {
    // Register install chimera command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.installChimera', async () => {
            if (!vscode.workspace.workspaceFolders) {
                vscode.window.showErrorMessage('Please open a workspace first');
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const generator = new ChimeraGenerator(workspaceRoot);

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Generating Chimera Template",
                cancellable: false
            }, async (progress) => {
                try {
                    const contracts = await generator.generate(progress);
                    services.reconContractsProvider.setContracts(contracts);
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to install/configure Chimera: ${error.message}`);
                    throw error;
                }
            });
        })
    );
}
