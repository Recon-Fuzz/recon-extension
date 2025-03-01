import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { cleanupCoverageReport } from '../utils';
import { ServiceContainer } from '../services/serviceContainer';

export function registerCoverageCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): void {
    // Register cleanup coverage report command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.cleanupCoverageReport', async (uri: vscode.Uri) => {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Cleaning coverage report",
                cancellable: false
            }, async (progress) => {
                try {
                    progress.report({ message: "Reading file..." });
                    const content = await fs.readFile(uri.fsPath, 'utf8');
                    
                    const workspaceRoot = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
                    if (!workspaceRoot) {
                        throw new Error('No workspace folder found');
                    }
                    
                    progress.report({ message: "Processing coverage data..." });
                    const cleanedContent = await cleanupCoverageReport(workspaceRoot, content);
                    
                    progress.report({ message: "Saving cleaned report..." });
                    const parsedPath = path.parse(uri.fsPath);
                    const newPath = path.join(parsedPath.dir, `${parsedPath.name}-cleaned${parsedPath.ext}`);
                    await fs.writeFile(newPath, cleanedContent, 'utf8');
                    
                    vscode.window.showInformationMessage(`Coverage report cleaned and saved to ${path.basename(newPath)}`);
                } catch (error) {
                    vscode.window.showErrorMessage(`Error cleaning coverage report: ${error}`);
                }
            });
        })
    );

    // Register refresh coverage command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.refreshCoverage', () => {
            services.coverageViewProvider._updateWebview();
        })
    );
}
