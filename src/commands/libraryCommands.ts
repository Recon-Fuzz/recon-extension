import * as vscode from 'vscode';
import { exec } from 'child_process';
import { getEnvironmentPath, getFoundryConfigPath } from '../utils';
import { ServiceContainer } from '../services/serviceContainer';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'yaml';

const parseLibrariesFromOutput = (output: string): string[] => {
    const usesPattern = /^\s+uses: \[(.*?)\]/gm;
    const matches = [...output.matchAll(usesPattern)];

    const allLibraries: string[] = [];
    matches.forEach(match => {
        if (match[1]) {
            const libraries = match[1]
                .split(',')
                .map(lib => lib.trim().replace(/['"\s]/g, ''))
                .filter(lib => lib.length > 0);

            // Keep order and only add if not already present
            libraries.forEach(lib => {
                if (!allLibraries.includes(lib)) {
                    allLibraries.push(lib);
                }
            });
        }
    });

    return allLibraries;
};

const generateHexAddress = (index: number): string => {
    return `0xf${(index + 1).toString().padStart(2, '0')}`;
};

const updateEchidnaConfig = (configPath: string, libraries: string[]): void => {
    try {
        // Read existing echidna.yaml
        const yamlContent = fs.readFileSync(configPath, 'utf8');
        const config = yaml.parse(yamlContent) || {};

        if (libraries.length > 0) {
            // Generate library compilation arguments
            const libraryArgs = libraries.map((lib, index) => 
                `${lib},${generateHexAddress(index)}`
            ).join(',');
            
            // Update cryticArgs and deployContracts - we'll format these manually
            config.cryticArgs = [`--compile-libraries=(${libraryArgs})`, "--foundry-compile-all"];
            config.deployContracts = libraries.map((lib, index) => [
                generateHexAddress(index),
                lib
            ]);
        }

        // Create a copy without the arrays we want to format manually
        const configWithoutArrays = { ...config };
        delete configWithoutArrays.cryticArgs;
        delete configWithoutArrays.deployContracts;

        // Generate YAML for other config options
        let updatedYaml = yaml.stringify(configWithoutArrays, { indent: 2 });
        
        // Manually add the arrays in inline format if libraries exist
        if (libraries.length > 0) {
            const libraryArgs = libraries.map((lib, index) => 
                `(${lib},${generateHexAddress(index)})`
            ).join(',');
            
            // Add cryticArgs in inline format
            updatedYaml += `cryticArgs: ["--compile-libraries=${libraryArgs}","--foundry-compile-all"]\n`;
            
            // Add deployContracts in inline format
            updatedYaml += 'deployContracts: [\n';
            libraries.forEach((lib, index) => {
                updatedYaml += `  ["${generateHexAddress(index)}", "${lib}"]${index < libraries.length - 1 ? ',' : ''}\n`;
            });
            updatedYaml += ']\n';
        }

        fs.writeFileSync(configPath, updatedYaml, 'utf8');
    } catch (error) {
        throw new Error(`Failed to update echidna.yaml: ${error}`);
    }
};

const updateMedusaConfig = (configPath: string, libraries: string[]): void => {
    try {
        // Read existing medusa.json
        const jsonContent = fs.readFileSync(configPath, 'utf8');
        const medusaConfig = JSON.parse(jsonContent);

        // Ensure the nested structure exists
        if (!medusaConfig.compilation) {
            medusaConfig.compilation = {};
        }
        if (!medusaConfig.compilation.platformConfig) {
            medusaConfig.compilation.platformConfig = {};
        }

        if (libraries.length > 0) {
            // Generate library compilation arguments
            const libraryArgs = libraries.map((lib, index) => 
                `(${lib},${generateHexAddress(index)})`
            ).join(',');
            
            medusaConfig.compilation.platformConfig.args = [
                "--compile-libraries",
                libraryArgs,
                "--foundry-compile-all"
            ];
        }

        // Write updated config back to file
        const updatedJson = JSON.stringify(medusaConfig, null, 2);
        fs.writeFileSync(configPath, updatedJson, 'utf8');
    } catch (error) {
        throw new Error(`Failed to update medusa.json: ${error}`);
    }
};

export function registerLibraryCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): void {
    // Register link libraries command
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.linkLibraries', async () => {
            if (!vscode.workspace.workspaceFolders) {
                vscode.window.showErrorMessage('Please open a workspace first');
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            
            // Check if echidna.yaml and medusa.json files exist
            const echidnaConfigPath = path.join(workspaceRoot, 'echidna.yaml');
            const medusaConfigPath = path.join(workspaceRoot, 'medusa.json');
            
            if (!fs.existsSync(echidnaConfigPath) || !fs.existsSync(medusaConfigPath)) {
                vscode.window.showErrorMessage('Please first run scaffold - echidna.yaml and medusa.json files are required');
                return;
            }

            const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
            const foundryRoot = path.dirname(foundryConfigPath);
            const outputChannel = services.outputService.getMainChannel();

            // Show and clear output channel
            outputChannel.show();
            outputChannel.clear();
            outputChannel.appendLine('Starting library linking analysis...');
            outputChannel.appendLine('Make sure to run `forge build` is successful before running this command');

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Analyzing Libraries",
                cancellable: true
            }, async (progress, token) => {
                return new Promise((resolve, reject) => {
                    const linkProcess = exec('crytic-compile . --foundry-compile-all --print-libraries',
                        {
                            cwd: foundryRoot,
                            env: {
                                ...process.env,
                                PATH: getEnvironmentPath()
                            }
                        },
                        (error, stdout, stderr) => {
                            if (error && !token.isCancellationRequested) {
                                const errorMsg = `Library analysis failed: ${error.message}`;
                                outputChannel.appendLine(errorMsg);
                                vscode.window.showErrorMessage(errorMsg);
                                reject(error);
                                return;
                            }

                            if (stdout) {
                                outputChannel.appendLine('Raw output:');
                                outputChannel.appendLine(stdout);
                                
                                // Parse libraries from output
                                const libraries = parseLibrariesFromOutput(stdout);
                                
                                outputChannel.appendLine('\nParsed libraries:');
                                if (libraries.length > 0) {
                                    libraries.forEach(lib => {
                                        outputChannel.appendLine(`- ${lib}`);
                                    });
                                    
                                    // Update configuration files with library configuration
                                    try {
                                        updateEchidnaConfig(echidnaConfigPath, libraries);
                                        updateMedusaConfig(medusaConfigPath, libraries);
                                        
                                        outputChannel.appendLine('\nUpdated echidna.yaml with library configuration:');
                                        const libraryArgs = libraries.map((lib, index) => 
                                            `${lib},${generateHexAddress(index)}`
                                        ).join(',');
                                        outputChannel.appendLine(`cryticArgs: ["--compile-libraries=(${libraryArgs})","--foundry-compile-all"]`);
                                        
                                        outputChannel.appendLine('deployContracts:');
                                        libraries.forEach((lib, index) => {
                                            outputChannel.appendLine(`  ["${generateHexAddress(index)}", "${lib}"]`);
                                        });
                                        
                                        outputChannel.appendLine('\nUpdated medusa.json with library configuration:');
                                        const medusaLibraryArgs = libraries.map((lib, index) => 
                                            `(${lib},${generateHexAddress(index)})`
                                        ).join(',');
                                        outputChannel.appendLine(`compilation.platformConfig.args: ["--compile-libraries","${medusaLibraryArgs}","--foundry-compile-all"]`);
                                        
                                        vscode.window.showInformationMessage(`Updated echidna.yaml and medusa.json with ${libraries.length} libraries. Check output channel for details.`);
                                    } catch (error) {
                                        outputChannel.appendLine(`\nError updating configuration files: ${error}`);
                                        vscode.window.showErrorMessage(`Failed to update configuration files: ${error}`);
                                    }
                                } else {
                                    outputChannel.appendLine('No libraries found in the output.');
                                    
                                    // Clear library configuration from config files if no libraries found
                                    try {
                                        updateEchidnaConfig(echidnaConfigPath, []);
                                        updateMedusaConfig(medusaConfigPath, []);
                                        outputChannel.appendLine('Cleared library configuration from echidna.yaml and medusa.json');
                                    } catch (error) {
                                        outputChannel.appendLine(`Error clearing configuration files: ${error}`);
                                    }
                                    
                                    vscode.window.showInformationMessage('No libraries found in the project.');
                                }
                            }

                            if (stderr && !token.isCancellationRequested) {
                                outputChannel.appendLine('Warnings:');
                                outputChannel.appendLine(stderr);
                            }

                            if (!token.isCancellationRequested) {
                                outputChannel.appendLine('Library analysis completed');
                                resolve(stdout);
                            }
                        }
                    );

                    token.onCancellationRequested(() => {
                        linkProcess.kill();
                        outputChannel.appendLine('Library analysis cancelled by user');
                        vscode.window.showInformationMessage('Library analysis cancelled');
                        resolve(undefined);
                    });
                });
            });
        })
    );
} 