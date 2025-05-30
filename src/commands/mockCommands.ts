import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import AbiToMock from 'abi-to-mock';
import { findOutputDirectory, getFoundryConfigPath } from '../utils';
import { ServiceContainer } from '../services/serviceContainer';

export function registerMockCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): void {
    // Register generate mock command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.generateMock', async (uri: vscode.Uri) => {
            if (!vscode.workspace.workspaceFolders) {
                vscode.window.showErrorMessage('Please open a workspace first');
                return;
            }

            try {
                const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
                const foundryRoot = path.dirname(foundryConfigPath);

                // Get mocks folder path from settings and resolve it relative to foundry root
                const mocksFolderPath = vscode.workspace.getConfiguration('recon').get<string>('mocksFolderPath', 'test/recon/mocks');
                const mocksFolder = path.join(foundryRoot, mocksFolderPath);

                // Check if auto-save is enabled
                const autoSave = vscode.workspace.getConfiguration('recon').get<boolean>('mockAutoSave', true);

                let abiFilePath: string;

                // Check if this is a Solidity file or a JSON file
                if (uri.fsPath.endsWith('.sol')) {
                    // Find corresponding JSON ABI file for the Solidity file
                    const solFileName = path.basename(uri.fsPath, '.sol');
                    const outDir = await findOutputDirectory(workspaceRoot);
                    const expectedJsonPath = path.join(outDir, `${solFileName}.sol`, `${solFileName}.json`);

                    try {
                        await fs.access(expectedJsonPath);
                        abiFilePath = expectedJsonPath;
                    } catch (err) {
                        vscode.window.showErrorMessage(
                            `Couldn't find compiled ABI for ${solFileName}.sol. Please build the project first.`
                        );
                        return;
                    }
                } else {
                    // It's a JSON file, use it directly
                    abiFilePath = uri.fsPath;
                }

                // Extract contract name from JSON file name (remove .json extension)
                const contractName = path.basename(abiFilePath, '.json');
                const mockName = `${contractName}Mock`;
                const mockFilePath = path.join(mocksFolder, `${mockName}.sol`);

                if (autoSave) {
                    // Ensure mocks directory exists and save the file
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(mocksFolder));

                    // Update settings at workspace level
                    await vscode.workspace.getConfiguration('recon').update('mocksFolderPath', mocksFolderPath, vscode.ConfigurationTarget.Workspace);

                    // Generate mock using abi-to-mock
                    await AbiToMock(
                        abiFilePath,           // Full path to ABI
                        mocksFolder,           // Output directory
                        mockName               // Mock contract name
                    );

                    vscode.window.showInformationMessage(`Generated mock contract: ${mockName}`);
                    vscode.window.showInformationMessage(`Please build the project to see the generated mock in the contracts explorer.`);

                    // Open the generated mock file
                    const mockPath = vscode.Uri.file(mockFilePath);
                    const doc = await vscode.workspace.openTextDocument(mockPath);
                    await vscode.window.showTextDocument(doc);
                } else {
                    // Generate to a temp file/string and open as unsaved document
                    const tempDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.recon-temp');
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(tempDir));

                    // Generate mock to temp location
                    await AbiToMock(
                        abiFilePath,
                        tempDir,
                        mockName
                    );

                    // Read the generated file content
                    const tempMockPath = path.join(tempDir, `${mockName}.sol`);
                    const content = await fs.readFile(tempMockPath, 'utf8');

                    // Create a new untitled document with the mock content
                    const document = await vscode.workspace.openTextDocument({
                        language: 'solidity',
                        content: content
                    });

                    // Show the document
                    await vscode.window.showTextDocument(document);

                    // Delete the temp file
                    await fs.unlink(tempMockPath);

                    vscode.window.showInformationMessage(`Generated mock contract: ${mockName} (not saved)`);
                }

            } catch (error: any) {
                console.error('Failed to generate mock:', error);
                vscode.window.showErrorMessage(`Failed to generate mock contract: ${error.message}`);
            }
        })
    );
}
