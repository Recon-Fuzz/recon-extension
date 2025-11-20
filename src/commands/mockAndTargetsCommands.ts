import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import AbiToMock from 'abi-to-mock';
import { findOutputDirectory, getFoundryConfigPath } from '../utils';
import { ServiceContainer } from '../services/serviceContainer';
import * as templates from '../generators/templates';
import { Actor, Mode, FunctionDefinitionParams } from '../types';

export function registerMockAndTargetsCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): void {
    // Register generate mock and targets command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.generateMockAndTargets', async (uri: vscode.Uri) => {
            if (!vscode.workspace.workspaceFolders) {
                vscode.window.showErrorMessage('Please open a workspace first');
                return;
            }

            try {
                const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
                const foundryRoot = path.dirname(foundryConfigPath);

                // Check if this is a folder
                const stats = await fs.stat(uri.fsPath);
                if (stats.isDirectory()) {
                    await handleFolder(uri.fsPath, workspaceRoot, foundryRoot);
                } else {
                    await handleFile(uri.fsPath, workspaceRoot, foundryRoot);
                }

            } catch (error: any) {
                console.error('Failed to generate mock and targets:', error);
                vscode.window.showErrorMessage(`Failed to generate mock and targets: ${error.message}`);
            }
        })
    );
}

async function handleFolder(folderPath: string, workspaceRoot: string, foundryRoot: string): Promise<void> {
    // Find all Solidity files in the folder
    const files = await fs.readdir(folderPath);
    const solFiles = files.filter(file => file.endsWith('.sol') || file.endsWith('.vy'));

    if (solFiles.length === 0) {
        vscode.window.showWarningMessage('No Solidity or Vyper files found in the selected folder');
        return;
    }

    // Process each file
    let successCount = 0;
    let failCount = 0;

    for (const file of solFiles) {
        const filePath = path.join(folderPath, file);
        try {
            await handleFile(filePath, workspaceRoot, foundryRoot);
            successCount++;
        } catch (error: any) {
            console.error(`Failed to process ${file}:`, error);
            failCount++;
        }
    }

    if (successCount > 0) {
        vscode.window.showInformationMessage(
            `Generated mock and targets for ${successCount} file(s)${failCount > 0 ? ` (${failCount} failed)` : ''}`
        );
    } else {
        vscode.window.showErrorMessage('Failed to generate mock and targets for all files');
    }
}

async function handleFile(filePath: string, workspaceRoot: string, foundryRoot: string): Promise<void> {
    let abiFilePath: string;
    const fileExtension = path.extname(filePath);

    // Check if this is a Solidity file, Vyper file, or a JSON file
    if (fileExtension === '.sol') {
        // Find corresponding JSON ABI file for the Solidity file
        const solFileName = path.basename(filePath, '.sol');
        const outDir = await findOutputDirectory(workspaceRoot);
        const expectedJsonPath = path.join(outDir, `${solFileName}.sol`, `${solFileName}.json`);

        try {
            await fs.access(expectedJsonPath);
            abiFilePath = expectedJsonPath;
        } catch (err) {
            throw new Error(
                `Couldn't find compiled ABI for ${solFileName}.sol. Please build the project first.`
            );
        }
    } else if (fileExtension === '.vy') {
        // Find corresponding JSON ABI file for the Vyper file
        const vyperFileName = path.basename(filePath, '.vy');
        const outDir = await findOutputDirectory(workspaceRoot);
        const expectedJsonPath = path.join(outDir, `${vyperFileName}.vy`, `${vyperFileName}.json`);

        try {
            await fs.access(expectedJsonPath);
            abiFilePath = expectedJsonPath;
        } catch (err) {
            throw new Error(
                `Couldn't find compiled ABI for ${vyperFileName}.vy. Please build the project first.`
            );
        }
    } else {
        // It's a JSON file, use it directly
        abiFilePath = filePath;
    }

    // Extract contract name from JSON file name
    const contractName = path.basename(abiFilePath, '.json');

    // Step 1: Generate Mock
    await generateMock(abiFilePath, contractName, foundryRoot);

    // Step 2: Generate Targets
    await generateTargets(abiFilePath, contractName);
}

async function generateMock(abiFilePath: string, contractName: string, foundryRoot: string): Promise<void> {
    // Get mocks folder path from settings and resolve it relative to foundry root
    const mocksFolderPath = vscode.workspace.getConfiguration('recon').get<string>('mocksFolderPath', 'test/recon/mocks');
    const mocksFolder = path.join(foundryRoot, mocksFolderPath);
    const mockName = `${contractName}Mock`;
    const mockFilePath = path.join(mocksFolder, `${mockName}.sol`);

    // Check if auto-save is enabled
    const autoSave = vscode.workspace.getConfiguration('recon').get<boolean>('mockAutoSave', true);

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

        console.log(`Generated mock contract: ${mockName}`);
    } else {
        // Generate to a temp file/string and open as unsaved document
        const tempDir = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, '.recon-temp');
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

        console.log(`Generated mock contract: ${mockName} (not saved)`);
    }
}

async function generateTargets(abiFilePath: string, contractName: string): Promise<void> {
    // Read the ABI file
    const abiContent = await fs.readFile(abiFilePath, 'utf8');
    const abiJson = JSON.parse(abiContent);

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
        console.log(`No mutable functions found in ${contractName}`);
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

    console.log(`Generated target functions for ${contractName} (not saved)`);
}
