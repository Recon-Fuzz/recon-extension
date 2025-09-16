import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ChimeraGenerator } from '../chimeraGenerator';
import { ServiceContainer } from '../services/serviceContainer';
import { findOutputDirectory, getFoundryConfigPath } from '../utils';
import * as templates from '../generators/templates';
import { Actor, Mode, FunctionDefinitionParams } from '../types';

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

    // Register generate target functions command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.generateTargetFunctions', async (uri: vscode.Uri) => {
            if (!vscode.workspace.workspaceFolders) {
                vscode.window.showErrorMessage('Please open a workspace first');
                return;
            }

            try {
                const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;                
                let abiFilePath: string;
                
                // Check if this is a Solidity file or a JSON file
                if (uri.fsPath.endsWith('.sol')) {
                    // Find corresponding JSON ABI file for the Solidity file
                    const solFileName = path.basename(uri.fsPath, '.sol');
                    const outDir = await findOutputDirectory(workspaceRoot);
                    const expectedJsonPath = path.join(outDir, `${solFileName}.sol`, `${solFileName}.json`);
                    console.log("expectedJsonPath", expectedJsonPath);

                    try {
                        await fs.access(expectedJsonPath);
                        abiFilePath = expectedJsonPath;
                    } catch (err) {
                        vscode.window.showErrorMessage(
                            `Couldn't find compiled ABI for ${solFileName}.sol. Please build the project first.`
                        );
                        return;
                    }
                } else if (uri.fsPath.endsWith('.vy')) {
                    // Find corresponding JSON ABI file for the Vyper file
                    const vyperFileName = path.basename(uri.fsPath, '.vy');
                    const outDir = await findOutputDirectory(workspaceRoot);
                    const expectedJsonPath = path.join(outDir, `${vyperFileName}.vy`, `${vyperFileName}.json`);
                    console.log("expectedJsonPath", expectedJsonPath);

                    try {
                        await fs.access(expectedJsonPath);
                        abiFilePath = expectedJsonPath;
                    } catch (err) {
                        vscode.window.showErrorMessage(
                            `Couldn't find compiled ABI for ${vyperFileName}.sol. Please build the project first.`
                        );
                        return;
                    }
                } else {
                    // It's a JSON file, use it directly
                    abiFilePath = uri.fsPath;
                }

                // Read the ABI file
                const abiContent = await fs.readFile(abiFilePath, 'utf8');
                const abiJson = JSON.parse(abiContent);

                // Extract contract name from the file name
                const contractName = path.basename(abiFilePath, '.json');
                
                // Extract the contract path from the metadata if available
                let contractPath = '';
                if (abiJson.metadata) {
                    const metadata = abiJson.metadata;
                    if (metadata.settings?.compilationTarget) {
                        const sourcePaths = Object.keys(metadata.settings.compilationTarget);
                        if (sourcePaths.length > 0) {
                            contractPath = sourcePaths[0];
                        }
                    }
                }

                // Filter out non-mutable functions (view and pure)
                const functions: FunctionDefinitionParams[] = [];
                
                if (abiJson.abi) {
                    for (const item of abiJson.abi) {
                        if (
                            item.type === 'function' && 
                            !item.stateMutability?.match(/^(view|pure)$/)
                        ) {
                            functions.push({
                                contractName: contractName,
                                contractPath: contractPath,
                                functionName: item.name,
                                abi: item,
                                actor: Actor.ACTOR, // Default actor
                                mode: Mode.NORMAL,  // Default mode
                                separated: true     // Default is separated
                            });
                        }
                    }
                }
                
                if (functions.length === 0) {
                    vscode.window.showInformationMessage(
                        `No mutable functions found in ${contractName}`
                    );
                    return;
                }

                // Generate the target functions using the template
                const targetFunctions = templates.targetsTemplate({
                    contractName,
                    path: contractPath || "",
                    functions
                });
                
                // Create a new untitled document with the generated content
                const document = await vscode.workspace.openTextDocument({
                    language: 'solidity',
                    content: targetFunctions
                });
                
                // Show the document
                await vscode.window.showTextDocument(document);
                
                vscode.window.showInformationMessage(
                    `Generated target functions for ${contractName} (not saved)`
                );

            } catch (error: any) {
                console.error('Failed to generate target functions:', error);
                vscode.window.showErrorMessage(`Failed to generate target functions: ${error.message}`);
            }
        })
    );
}
