import * as vscode from 'vscode';
import * as path from 'path';
import { getFoundryConfigPath, getTestFolder } from '../utils';
import { Actor, Mode, FunctionDefinitionParams } from '../types';
import { targetFunctionTemplate } from '../generators/templates/target-function';
import { ServiceContainer } from '../services/serviceContainer';
import { canaryFunctionTemplate } from '../generators/templates/canary-function';

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
            {oldMode, newMode}: {oldMode: Mode, newMode: Mode},
            range: vscode.Range,
            fnParams: FunctionDefinitionParams
        ) => {
            if (
                !vscode.workspace.workspaceFolders ||
                oldMode === newMode
            ) { return; }
            
            try {
                // Get base paths for CanaryStorage and Properties files
                const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const foundryRoot = path.dirname(getFoundryConfigPath(workspaceRoot));
                const testFolder = await getTestFolder(workspaceRoot);
                const reconPath = path.join(foundryRoot, testFolder, 'recon');

                // Update CanaryStorage.sol: add or remove canary variable
                const storagePath = path.join(reconPath, 'CanaryStorage.sol');
                const storageUri = vscode.Uri.file(storagePath);

                let storageDocument: vscode.TextDocument | undefined;
                try {
                    storageDocument = await vscode.workspace.openTextDocument(storageUri);
                } catch (error) {
                    console.error('Error updating function mode:', error);
                    vscode.window.showWarningMessage(`Please re-run Scaffold to generate the missing file! File "CanaryStorage.sol" not found.`);
                    return;
                }
                
                const storageEditor = await vscode.window.showTextDocument(storageDocument);
                const storageText = storageDocument.getText();

                const storageCanaryVariable = `    bool ${fnParams.abi.name}Canary = false;\n`;
                
                if (newMode === Mode.CANARY) { // Find placeholder line and insert canary variable just bellow it
                    const storageMatch = storageText.indexOf('/// AUTO GENERATED CANARIES - WARNING: DO NOT DELETE OR MODIFY THIS LINE ///');
                    if (storageMatch === -1) {
                        console.error('CanaryStorage.sol is missing the canary placeholder line.');
                        vscode.window.showWarningMessage(`Please re-run Scaffold to generate the malformed file! File "CanaryStorage.sol" is missing the canary placeholder line.`);
                        return;
                    }
                    const storageLine = storageText.substring(0, storageMatch).split('\n').length - 1;
                    const insertionPosition = new vscode.Position(storageLine + 1, 0);

                    await storageEditor.edit(editBuilder => {
                        editBuilder.insert(insertionPosition, storageCanaryVariable);
                    });

                } else { // Find the canary variable if it exists and remove it
                    const storageMatch = storageText.indexOf(storageCanaryVariable);
                    if (storageMatch !== -1) {
                        const startPos = storageDocument.positionAt(storageMatch);
                        const endPos = storageDocument.positionAt(storageMatch + storageCanaryVariable.length);
                        const rangeToDelete = new vscode.Range(startPos, endPos);

                        await storageEditor.edit(editBuilder => {
                            editBuilder.delete(rangeToDelete);
                        });
                    }
                }
                await storageDocument.save();

                // Update Properties.sol: add or remove canary function
                const propertiesPath = path.join(reconPath, 'Properties.sol');
                const propertiesUri = vscode.Uri.file(propertiesPath);

                let propertiesDocument: vscode.TextDocument | undefined;
                try {
                    propertiesDocument = await vscode.workspace.openTextDocument(propertiesUri);
                } catch (error) {
                    console.error('Error updating function mode:', error);
                    vscode.window.showWarningMessage(`Please re-run Scaffold to generate the missing file! File "Properties.sol" not found.`);
                    return;
                }
                
                const propertiesEditor = await vscode.window.showTextDocument(propertiesDocument);
                const propertiesText = propertiesDocument.getText();

                const canaryFunctionDef = canaryFunctionTemplate({
                    fn: {
                        ...fnParams,
                    }
                });

                if (newMode === Mode.CANARY) { // Find placeholder line and insert canary function just bellow it
                    const propertiesMatch = propertiesText.indexOf('/// AUTO GENERATED CANARIES FUNCTIONS - WARNING: DO NOT DELETE OR MODIFY THIS LINE ///');
                    if (propertiesMatch === -1) {
                        console.error('Properties.sol is missing the canary placeholder line.');
                        vscode.window.showWarningMessage(`Please re-run Scaffold to generate the malformed file! File "Properties.sol" is missing the canary placeholder line.`);
                        return;
                    }
                    const propertiesLine = propertiesText.substring(0, propertiesMatch).split('\n').length - 1;
                    const insertionPosition = new vscode.Position(propertiesLine + 1, 0);

                    await propertiesEditor.edit(editBuilder => {
                        editBuilder.insert(insertionPosition, canaryFunctionDef + '\n');
                    });

                } else { // Find the canary function if it exists and remove it
                    const propertiesMatch = propertiesText.indexOf(canaryFunctionDef);
                    if (propertiesMatch !== -1) {
                        const startPos = propertiesDocument.positionAt(propertiesMatch);
                        const endPos = propertiesDocument.positionAt(propertiesMatch + canaryFunctionDef.length + 1);
                        const rangeToDelete = new vscode.Range(startPos, endPos);

                        await propertiesEditor.edit(editBuilder => {
                            editBuilder.delete(rangeToDelete);
                        });
                    }
                }
                await propertiesDocument.save();

                // Update recon.json - use jsonPath if available, otherwise fall back to contractName lookup
                const pathName = fnParams.jsonPath || contractName;
                await services.reconContractsProvider.updateFunctionConfig(pathName, functionName, {
                    mode: newMode
                });

                // Get current document and edit
                const document = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(document);

                // Use the complete fnParams with updated mode
                const newFunctionDef = targetFunctionTemplate({
                    fn: {
                        ...fnParams,
                        mode: newMode,
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
