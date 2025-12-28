import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TemplateManager } from './generators/manager';
import { findOutputDirectory, getEnvironmentPath, getFoundryConfigPath } from './utils';
import { ContractMetadata } from './types';

export class ChimeraGenerator {
    private templateManager: TemplateManager;

    constructor(private workspaceRoot: string) {
        this.templateManager = new TemplateManager(workspaceRoot);
    }

    public async findSourceContracts(outDir: string): Promise<ContractMetadata[]> {
        const contracts: ContractMetadata[] = [];
        
        try {
            const entries = await fs.readdir(outDir, { withFileTypes: true });
            
            for (const entry of entries) {
                if (!entry.isDirectory()) {continue;}
                
                const contractDir = path.join(outDir, entry.name);
                const files = await fs.readdir(contractDir);
                
                for (const file of files) {
                    if (!file.endsWith('.json')) {continue;}
                    
                    const filePath = path.join(contractDir, file);
                    const content = await fs.readFile(filePath, 'utf8');
                    const json = JSON.parse(content);
                    
                    // Fix: properly parse metadata which is already a string
                    if (json.metadata && json.abi) {
                        try {
                            const metadata = json.metadata;

                            if (metadata.settings?.compilationTarget) {
                                for (const [sourcePath, contractName] of Object.entries(metadata.settings.compilationTarget)) {
                                    // Convert absolute path to relative path
                                    const relativePath = path.relative(this.workspaceRoot, filePath);
                                    contracts.push({
                                        path: sourcePath,
                                        name: contractName as string,
                                        jsonPath: relativePath,
                                        abi: json.abi,
                                        enabled: false  // Default to disabled
                                    });
                                }
                            }
                        } catch (e) {
                            console.error(`Error parsing metadata for ${filePath}:`, e);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error parsing contracts:', error);
        }
        
        return contracts;
    }

    async generate(progress: vscode.Progress<{ message?: string }>): Promise<ContractMetadata[]> {
        const foundryRoot = await this.getFoundryRoot();
        const chimeraPath = path.join(foundryRoot, 'lib', 'chimera');
        const setupHelpersPath = path.join(foundryRoot, 'lib', 'setup-helpers');

        // Install Chimera
        progress.report({ message: "Installing Chimera..." });
        await this.installChimera(chimeraPath);

        // Install Chimera
        progress.report({ message: "Installing Setup Helpers..." });
        await this.installSetupHelpers(setupHelpersPath);

        // Handle remappings
        progress.report({ message: "Updating remappings..." });
        await this.updateRemappings();

        // Handle gitignore
        progress.report({ message: "Updating gitignore..." });
        await this.updateGitignore();

        // Generate templates
        progress.report({ message: "Generating templates..." });
        await this.templateManager.generateTemplates();

        // Find contracts
        progress.report({ message: "Scanning contracts..." });
        const outPath = await findOutputDirectory(this.workspaceRoot);
        const contracts = await this.findSourceContracts(outPath);

        if (contracts.length === 0) {
            vscode.window.showWarningMessage('No suitable contracts found for template generation');
            return [];
        }

        return contracts;
    }

    private async getFoundryRoot(): Promise<string> {
        const foundryConfigPath = getFoundryConfigPath(this.workspaceRoot);
        return path.dirname(foundryConfigPath);
    }

    private async installChimera(chimeraPath: string): Promise<void> {
        try {
            await fs.access(chimeraPath);
        } catch {
            const foundryRoot = await this.getFoundryRoot();
            await new Promise((resolve, reject) => {
                exec('forge install Recon-Fuzz/chimera',
                    { 
                        cwd: foundryRoot,
                        env: {
                            ...process.env,
                            PATH: getEnvironmentPath()
                        }
                    },
                    (error, stdout, stderr) => {
                        if (error) {reject(error);}
                        else {resolve(stdout);}
                    }
                );
            });
        }
    }

    private async installSetupHelpers(setupHelpersPath: string): Promise<void> {
        try {
            await fs.access(setupHelpersPath);
        } catch {
            const foundryRoot = await this.getFoundryRoot();
            await new Promise((resolve, reject) => {
                exec('forge install Recon-Fuzz/setup-helpers',
                    { 
                        cwd: foundryRoot,
                        env: {
                            ...process.env,
                            PATH: getEnvironmentPath()
                        }
                    },
                    (error, stdout, stderr) => {
                        if (error) {reject(error);}
                        else {resolve(stdout);}
                    }
                );
            });
        }
    }

    private async updateGitignore(): Promise<void> {
        const foundryRoot = await this.getFoundryRoot();
        const gitignorePath = path.join(foundryRoot, '.gitignore');
        const newLines = '\n# Coverage files\ncrytic-export\nechidna\nmedusa\n';
        try {
            let content = '';
            try {
                content = await fs.readFile(gitignorePath, 'utf8');
            } catch {
                // File doesn't exist, start with empty content
            }
            if (!content.includes('crytic-export') || 
                !content.includes('echidna') || 
                !content.includes('medusa')) {
                if (content && !content.endsWith('\n')) {
                    content += '\n';
                }
                content += newLines;
                await fs.writeFile(gitignorePath, content);
            }
        } catch (error) {
            console.error('Error updating .gitignore:', error);
            throw error;
        }
    }

    private async updateRemappings(): Promise<void> {
        const foundryRoot = await this.getFoundryRoot();
        const remappingsPath = path.join(foundryRoot, 'remappings.txt');
        
        try {
            await fs.access(remappingsPath);
        } catch {
            await new Promise((resolve, reject) => {
                exec('forge remappings > remappings.txt',
                    { 
                        cwd: foundryRoot,
                        env: {
                            ...process.env,
                            PATH: getEnvironmentPath()
                        }
                    },
                    (error, stdout, stderr) => {
                        if (error) {reject(error);}
                        else {resolve(stdout);}
                    }
                );
            });
        }

        const currentRemappings = await fs.readFile(remappingsPath, 'utf8');
        const chimeraMapping = '@chimera/=lib/chimera/src/';
        const setupToolsMapping = '@recon/=lib/setup-helpers/src/';
        
        const remappings = currentRemappings
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('@chimera') && !line.startsWith('@recon'));

        remappings.push(chimeraMapping);
        remappings.push(setupToolsMapping);
        
        await fs.writeFile(remappingsPath, remappings.join('\n'));
    }
}