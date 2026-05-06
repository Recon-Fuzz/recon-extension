import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import AbiToMock from 'abi-to-mock';
import { findOutputDirectory, getFoundryConfigPath, getTestFolder } from '../utils';
import { ServiceContainer } from '../services/serviceContainer';
import { Actor, Mode, FunctionConfig, FunctionDefinitionParams } from '../types';
import { TemplateManager } from '../generators/manager';
import { ChimeraGenerator } from '../chimeraGenerator';
import { targetsTemplate } from '../generators/templates/index';

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
                } else if (uri.fsPath.endsWith('.vy')) {
                    // Find corresponding JSON ABI file for the Vyper file
                    const vyperFileName = path.basename(uri.fsPath, '.vy');
                    const outDir = await findOutputDirectory(workspaceRoot);
                    const expectedJsonPath = path.join(outDir, `${vyperFileName}.vy`, `${vyperFileName}.json`);

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

    // Register generate mock and add to setup command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.generateMockAndAddToSetup', async (uri: vscode.Uri) => {
            if (!vscode.workspace.workspaceFolders) {
                vscode.window.showErrorMessage('Please open a workspace first');
                return;
            }

            try {
                const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
                const foundryRoot = path.dirname(foundryConfigPath);

                // Get mocks folder path from settings
                const mocksFolderPath = vscode.workspace.getConfiguration('recon').get<string>('mocksFolderPath', 'test/recon/mocks');
                const mocksFolder = path.join(foundryRoot, mocksFolderPath);

                let abiFilePath: string;
                let originalContractName: string;
                let sourcePath: string = '';

                // Check if this is a Solidity file or a JSON file
                if (uri.fsPath.endsWith('.sol')) {
                    // Find corresponding JSON ABI file for the Solidity file
                    const solFileName = path.basename(uri.fsPath, '.sol');
                    originalContractName = solFileName;
                    sourcePath = path.relative(foundryRoot, uri.fsPath);
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
                } else if (uri.fsPath.endsWith('.vy')) {
                    // Find corresponding JSON ABI file for the Vyper file
                    const vyperFileName = path.basename(uri.fsPath, '.vy');
                    originalContractName = vyperFileName;
                    sourcePath = path.relative(foundryRoot, uri.fsPath);
                    const outDir = await findOutputDirectory(workspaceRoot);
                    const expectedJsonPath = path.join(outDir, `${vyperFileName}.vy`, `${vyperFileName}.json`);

                    try {
                        await fs.access(expectedJsonPath);
                        abiFilePath = expectedJsonPath;
                    } catch (err) {
                        vscode.window.showErrorMessage(
                            `Couldn't find compiled ABI for ${vyperFileName}.vy. Please build the project first.`
                        );
                        return;
                    }
                } else {
                    // It's a JSON file, use it directly
                    abiFilePath = uri.fsPath;
                    originalContractName = path.basename(abiFilePath, '.json');
                    
                    // Try to extract source path from the JSON metadata
                    try {
                        const abiContent = await fs.readFile(abiFilePath, 'utf8');
                        const abiJson = JSON.parse(abiContent);
                        if (abiJson.metadata) {
                            const metadata = typeof abiJson.metadata === 'string' ? JSON.parse(abiJson.metadata) : abiJson.metadata;
                            if (metadata.settings?.compilationTarget) {
                                const sourcePaths = Object.keys(metadata.settings.compilationTarget);
                                if (sourcePaths.length > 0) {
                                    sourcePath = sourcePaths[0];
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('Could not extract source path from JSON metadata:', e);
                    }
                }

                // Read the original ABI file
                const abiContent = await fs.readFile(abiFilePath, 'utf8');
                const abiJson = JSON.parse(abiContent);
                const abi = abiJson.abi || [];

                // Extract contract name and create mock name
                const mockName = `${originalContractName}Mock`;
                const mockFilePath = path.join(mocksFolder, `${mockName}.sol`);

                // Ensure mocks directory exists
                await vscode.workspace.fs.createDirectory(vscode.Uri.file(mocksFolder));

                // Generate mock using abi-to-mock
                await AbiToMock(
                    abiFilePath,
                    mocksFolder,
                    mockName
                );

                // Get mutable functions from the ABI
                const mutableFunctions = abi.filter((item: any) =>
                    item.type === 'function' &&
                    item.stateMutability !== 'view' &&
                    item.stateMutability !== 'pure'
                );

                // Create function configs for all mutable functions
                const functionConfigs: FunctionConfig[] = mutableFunctions.map((fn: any) => {
                    const inputs = fn.inputs.map((input: any) => input.type).join(',');
                    const signature = `${fn.name}(${inputs})`;
                    return {
                        signature,
                        actor: Actor.ACTOR,
                        mode: Mode.NORMAL
                    };
                });

                // Calculate expected JSON path for the mock (where it will be after compilation)
                const outDir = await findOutputDirectory(workspaceRoot);
                const mockJsonPath = path.join(outDir, `${mockName}.sol`, `${mockName}.json`);
                const mockJsonPathRelative = path.relative(workspaceRoot, mockJsonPath);

                // Calculate mock source path relative to foundry root
                const mockSourcePath = path.relative(foundryRoot, mockFilePath);

                // Create synthetic compiled JSON artifact (so scaffold can read it without compilation)
                await fs.mkdir(path.dirname(mockJsonPath), { recursive: true });
                
                // Parse metadata from original ABI if it exists
                let metadata: any = {};
                if (abiJson.metadata) {
                    try {
                        metadata = typeof abiJson.metadata === 'string' 
                            ? JSON.parse(abiJson.metadata) 
                            : abiJson.metadata;
                    } catch (e) {
                        console.warn('Could not parse metadata from original ABI:', e);
                        metadata = {};
                    }
                }

                // Create synthetic JSON with ABI and metadata pointing to mock file
                // Store metadata as an object (matching what the scaffold code expects)
                const syntheticMetadata = {
                    ...metadata,
                    settings: {
                        ...(metadata?.settings || {}),
                        compilationTarget: {
                            [mockSourcePath]: mockName
                        }
                    }
                };

                const syntheticJson = {
                    abi: abi,
                    metadata: syntheticMetadata
                };

                await fs.writeFile(mockJsonPath, JSON.stringify(syntheticJson, null, 2));

                // Load existing recon.json
                const reconJsonPath = path.join(workspaceRoot, 'recon.json');
                let reconJson: Record<string, { functions: FunctionConfig[], separated?: boolean, enabled?: boolean }> = {};
                try {
                    const reconContent = await fs.readFile(reconJsonPath, 'utf8');
                    reconJson = JSON.parse(reconContent);
                } catch (e) {
                    // File doesn't exist or is invalid, start with empty object
                }

                // Add mock to recon.json
                reconJson[mockJsonPathRelative] = {
                    enabled: true,
                    functions: functionConfigs,
                    separated: true
                };

                // Save recon.json
                await fs.writeFile(reconJsonPath, JSON.stringify(reconJson, null, 2));

                // Regenerate templates (scaffold)
                const templateManager = new TemplateManager(workspaceRoot);
                await templateManager.generateTemplates();

                // Refresh contracts view
                if (services.reconContractsProvider) {
                    const outPath = await findOutputDirectory(workspaceRoot);
                    const generator = new ChimeraGenerator(workspaceRoot);
                    const contracts = await generator.findSourceContracts(outPath);
                    services.reconContractsProvider.setContracts(contracts);
                }

                // Create function definitions for target functions template
                const functionDefinitions: FunctionDefinitionParams[] = mutableFunctions.map((fn: any) => ({
                    contractName: mockName,
                    contractPath: mockSourcePath,
                    functionName: fn.name,
                    abi: fn,
                    actor: Actor.ACTOR,
                    mode: Mode.NORMAL,
                    separated: true
                }));

                // Generate the target functions using the template
                const targetFunctionsContent = targetsTemplate({
                    contractName: mockName,
                    path: mockSourcePath,
                    functions: functionDefinitions
                });

                // Save target functions to test folder
                const testFolder = await getTestFolder(workspaceRoot);
                const targetFunctionsPath = path.join(foundryRoot, testFolder, 'recon', 'targets', `${mockName}Targets.sol`);
                await fs.mkdir(path.dirname(targetFunctionsPath), { recursive: true });
                await fs.writeFile(targetFunctionsPath, targetFunctionsContent);

                vscode.window.showInformationMessage(
                    `Generated mock contract ${mockName}, added it to Setup with ${functionConfigs.length} target functions, and created ${mockName}Targets.sol`
                );

                // Open the generated target functions file
                const targetFunctionsUri = vscode.Uri.file(targetFunctionsPath);
                const targetDoc = await vscode.workspace.openTextDocument(targetFunctionsUri);
                await vscode.window.showTextDocument(targetDoc);

            } catch (error: any) {
                console.error('Failed to generate mock and add to setup:', error);
                vscode.window.showErrorMessage(`Failed to generate mock and add to setup: ${error.message}`);
            }
        })
    );
}
