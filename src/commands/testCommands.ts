import * as vscode from 'vscode';
import * as path from 'path';
import { getFoundryConfigPath } from '../utils';
import { Actor, Mode, FunctionDefinitionParams } from '../types';
import { targetFunctionTemplate } from '../generators/templates/target-function';
import { ServiceContainer } from '../services/serviceContainer';

export function registerTestCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): void {
    // Register command to run individual test
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.runTest', async (uri: vscode.Uri, testName: string) => {
            if (!vscode.workspace.workspaceFolders) {
                vscode.window.showErrorMessage('Please open a workspace first');
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
            const foundryRoot = path.dirname(foundryConfigPath);

            // Get verbosity level from settings
            const verbosity = vscode.workspace.getConfiguration('recon.forge').get<string>('testVerbosity', '-vvv');
            const command = `forge test --match-test ${testName} ${verbosity} --decode-internal`;

            const terminal = vscode.window.createTerminal({
                name: `Test: ${testName}`,
                cwd: foundryRoot,
                isTransient: true
            });
            terminal.show();
            terminal.sendText(command);
        })
    );

    // Register command to set function actor
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.setFunctionActor', async (
            uri: vscode.Uri,
            contractName: string,
            functionName: string,
            actor: Actor,
            range: vscode.Range,
            fnParams: FunctionDefinitionParams
        ) => {
            if (!vscode.workspace.workspaceFolders) { return; }

            try {
                // Update recon.json - use jsonPath if available, otherwise fall back to contractName lookup
                const pathName = fnParams.jsonPath || contractName;
                await services.reconContractsProvider.updateFunctionConfig(pathName, functionName, {
                    actor
                });

                // Get current document and edit
                const document = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(document);

                // Use the complete fnParams with updated actor
                const newFunctionDef = targetFunctionTemplate({
                    fn: {
                        ...fnParams,
                        actor
                    }
                }).trimStart();

                await editor.edit(editBuilder => {
                    editBuilder.replace(range, newFunctionDef);
                });
                await document.save();

            } catch (error) {
                console.error('Error updating function actor:', error);
                vscode.window.showErrorMessage(`Failed to update function actor: ${error}`);
            }
        })
    );

    // Register command to set function mode
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.setFunctionMode', async (
            uri: vscode.Uri,
            contractName: string,
            functionName: string,
            mode: Mode,
            range: vscode.Range,
            fnParams: FunctionDefinitionParams
        ) => {
            if (!vscode.workspace.workspaceFolders) { return; }

            try {
                // Update recon.json - use jsonPath if available, otherwise fall back to contractName lookup
                const pathName = fnParams.jsonPath || contractName;
                await services.reconContractsProvider.updateFunctionConfig(pathName, functionName, {
                    mode
                });

                // Get current document and edit
                const document = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(document);

                // Use the complete fnParams with updated mode
                const newFunctionDef = targetFunctionTemplate({
                    fn: {
                        ...fnParams,
                        mode
                    }
                }).trimStart();

                await editor.edit(editBuilder => {
                    editBuilder.replace(range, newFunctionDef);
                });
                await document.save();

            } catch (error) {
                console.error('Error updating function mode:', error);
                vscode.window.showErrorMessage(`Failed to update function mode: ${error}`);
            }
        })
    );
}
