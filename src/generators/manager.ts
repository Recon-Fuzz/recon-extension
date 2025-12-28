import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import * as templates from './templates';
import { FunctionDefinitionParams, Actor, Mode } from '../types';
import { getFoundryConfigPath, getTestFolder } from '../utils';


export class TemplateManager {
    constructor(private workspaceRoot: string) { }

    private async shouldGenerateFile(filePath: string): Promise<boolean> {
        const testFolder = await getTestFolder(this.workspaceRoot);
        const SKIP_IF_EXISTS = [
            'echidna.yaml',
            'medusa.json',
            'halmos.toml',
            `${testFolder}/recon/BeforeAfter.sol`,
            `${testFolder}/recon/CryticTester.sol`,
            `${testFolder}/recon/CryticToFoundry.sol`,
            `${testFolder}/recon/Properties.sol`,
            `${testFolder}/recon/helpers/Utils.sol`,
            `${testFolder}/recon/helpers/Panic.sol`,
            `${testFolder}/recon/managers/ActorManager.sol`,
            `${testFolder}/recon/managers/AssetManager.sol`,
            `${testFolder}/recon/managers/utils/EnumerableSet.sol`,
            `${testFolder}/recon/mocks/MockERC20.sol`,
            `${testFolder}/recon/targets/DoomsdayTargets.sol`,
            `${testFolder}/recon/targets/ManagersTargets.sol`
        ];
        if (!SKIP_IF_EXISTS.includes(filePath)) {
            return true;
        }

        try {
            await fs.access(path.join(await this.getFoundryRoot(), filePath));
            return false; // File exists, skip generation
        } catch {
            return true; // File doesn't exist, generate it
        }
    }

    private async findEnabledContracts(): Promise<{ name: string; path: string; abi: any[]; jsonPath: string; }[]> {
        const contracts = [];
        const reconPath = path.join(this.workspaceRoot, 'recon.json');
        
        try {
            const reconContent = await fs.readFile(reconPath, 'utf8');
            const reconConfig = JSON.parse(reconContent);

            // Process all enabled contracts, including those with only view/pure functions
            for (const [jsonPath, config] of Object.entries(reconConfig)) {
                if ((config as any).enabled === true) {
                    try {
                        const fullPath = path.join(this.workspaceRoot, jsonPath);
                        const content = await fs.readFile(fullPath, 'utf8');
                        const json = JSON.parse(content);

                        if (json.metadata && json.abi) {
                            const metadata = json.metadata;
                            if (metadata.settings?.compilationTarget) {
                                for (const [sourcePath, contractName] of Object.entries(metadata.settings.compilationTarget)) {
                                    contracts.push({
                                        jsonPath,
                                        name: contractName as string,
                                        path: sourcePath,
                                        abi: json.abi
                                    });
                                }
                            }
                        }
                    } catch (e) {
                        console.error(`Error loading contract from ${jsonPath}:`, e);
                    }
                }
            }
        } catch (e) {
            console.error('Error reading recon.json:', e);
        }

        return contracts;
    }

    private async findContractFunctions(): Promise<{ adminFunctions: FunctionDefinitionParams[], otherFunctions: FunctionDefinitionParams[] }> {
        const enabledContracts = await this.findEnabledContracts();
        const adminFunctions: FunctionDefinitionParams[] = [];
        const otherFunctions: FunctionDefinitionParams[] = [];

        // Load recon.json to get function configurations
        const reconPath = path.join(this.workspaceRoot, 'recon.json');
        let reconConfig = {};
        try {
            const reconContent = await fs.readFile(reconPath, 'utf8');
            reconConfig = JSON.parse(reconContent);
        } catch (e) {
            console.warn('No recon.json found or invalid');
        }

        for (const contract of enabledContracts) {
            const contractConfig = (reconConfig as any)[contract.jsonPath];
            if (!contractConfig || !contractConfig.functions || !contractConfig.functions.length) {
                continue;
            }
            
            const isSeparated = contractConfig.separated !== false; // Default to true if not specified

            // Filter functions based on what's defined in recon.json
            for (const functionConfig of contractConfig.functions) {
                const functionName = functionConfig.signature.split('(')[0];
                const functionAbi = contract.abi.find((item: any) => 
                    item.type === 'function' && 
                    item.name === functionName && 
                    `${item.name}(${item.inputs.map((i: any) => i.type).join(',')})` === functionConfig.signature
                );

                if (functionAbi) {
                    const functionInfo: FunctionDefinitionParams = {
                        contractName: contract.name,
                        contractPath: contract.path,
                        jsonPath: contract.jsonPath,
                        functionName: functionAbi.name,
                        abi: functionAbi,
                        actor: functionConfig.actor || Actor.ACTOR,
                        mode: functionConfig.mode || Mode.NORMAL,
                        separated: isSeparated
                    };

                    if (functionConfig.actor === Actor.ADMIN) {
                        adminFunctions.push(functionInfo);
                    } else {
                        otherFunctions.push(functionInfo);
                    }
                }
            }
        }

        return { adminFunctions, otherFunctions };
    }

    private async updateTargetFile(filepath: string, newContent: string): Promise<string> {
        try {
            const existingContent = await fs.readFile(filepath, 'utf8');

            // Check if file has the auto-generated section
            if (existingContent.includes('/// AUTO GENERATED TARGET FUNCTIONS - WARNING: DO NOT DELETE OR MODIFY THIS LINE ///')) {
                const [beforeMarker, afterMarker] = existingContent.split('/// AUTO GENERATED TARGET FUNCTIONS - WARNING: DO NOT DELETE OR MODIFY THIS LINE ///');

                // Extract the new auto-generated content
                const [_, newAutoGenerated] = newContent.split('/// AUTO GENERATED TARGET FUNCTIONS - WARNING: DO NOT DELETE OR MODIFY THIS LINE ///');

                // Combine the existing content before the marker with the new auto-generated content
                return beforeMarker + '/// AUTO GENERATED TARGET FUNCTIONS - WARNING: DO NOT DELETE OR MODIFY THIS LINE ///' + newAutoGenerated;
            }

            return newContent;
        } catch (error) {
            // If file doesn't exist, return the new content
            return newContent;
        }
    }

    private async shouldGenerateSetup(filePath: string): Promise<boolean> {
        try {
            await fs.access(path.join(await this.getFoundryRoot(), filePath));
            // File exists, ask user
            const answer = await vscode.window.showQuickPick(['Yes', 'No'], {
                placeHolder: 'Setup.sol already exists. Do you want to overwrite it?'
            });
            return answer === 'Yes';
        } catch {
            // File doesn't exist, generate it
            return true;
        }
    }

    private async getFoundryRoot(): Promise<string> {
        const foundryConfigPath = getFoundryConfigPath(this.workspaceRoot);
        return path.dirname(foundryConfigPath);
    }

    async generateTemplates(context: any = {}): Promise<void> {
        const { adminFunctions, otherFunctions } = await this.findContractFunctions();
        const enabledContracts = await this.findEnabledContracts();
        const testFolder = await getTestFolder(this.workspaceRoot);

        // Group other functions by contract using the separated property
        const functionsByContract: Record<string, FunctionDefinitionParams[]> = {};
        const nonSeparatedFunctions: FunctionDefinitionParams[] = [];

        for (const fn of otherFunctions) {
            if (fn.separated) {
                if (!functionsByContract[fn.contractName]) {
                    functionsByContract[fn.contractName] = [];
                }
                functionsByContract[fn.contractName].push(fn);
            } else {
                nonSeparatedFunctions.push(fn);
            }
        }

        // Get list of all contract names for inheritance (including built-in ones)
        const allContractNames = [
            "Admin",
            "Doomsday",
            "Managers",
            ...Object.keys(functionsByContract)
        ].sort();

        const files: Record<string, string> = {
            'echidna.yaml': templates.echidnaConfigTemplate({}),
            'medusa.json': templates.medusaConfigTemplate({}),
            'halmos.toml': templates.halmosConfigTemplate({}),
            [`${testFolder}/recon/BeforeAfter.sol`]: templates.beforeAfterTemplate({}),
            [`${testFolder}/recon/CryticTester.sol`]: templates.cryticTesterTemplate({}),
            [`${testFolder}/recon/CryticToFoundry.sol`]: templates.cryticToFoundryTemplate({}),
            [`${testFolder}/recon/Properties.sol`]: templates.propertiesTemplate({}),
            [`${testFolder}/recon/Setup.sol`]: templates.setupTemplate({ contracts: enabledContracts }),
            [`${testFolder}/recon/TargetFunctions.sol`]: templates.targetFunctionsTemplate({
                functions: nonSeparatedFunctions,
                contracts: allContractNames
            }),
            [`${testFolder}/recon/targets/AdminTargets.sol`]: templates.adminTargetsTemplate({ functions: adminFunctions }),
            [`${testFolder}/recon/targets/DoomsdayTargets.sol`]: templates.doomsdayTargetsTemplate({}),
            [`${testFolder}/recon/targets/ManagersTargets.sol`]: templates.managersTargetsTemplate({}),
        };

        // Generate separated contract target files
        for (const [contractName, functions] of Object.entries(functionsByContract)) {
            const targetPath = `${testFolder}/recon/targets/${contractName}Targets.sol`;
            files[targetPath] = templates.targetsTemplate({
                contractName,
                path: functions.length > 0 ? functions[0].contractPath : '',
                functions
            });
        }

        // Write all files
        for (const [name, content] of Object.entries(files)) {
            const outputPath = path.join(await this.getFoundryRoot(), name);

            // Skip file if it exists and is in the skip list
            if (!(await this.shouldGenerateFile(name))) {
                continue;
            }

            await fs.mkdir(path.dirname(outputPath), { recursive: true });

            // Special handling for Setup.sol
            if (name === `${testFolder}/recon/Setup.sol`) {
                if (!(await this.shouldGenerateSetup(name))) {
                    continue;
                }
            }

            // Special handling for target function files
            if (name.includes('targets/') && name.endsWith('Targets.sol')) {
                const finalContent = await this.updateTargetFile(outputPath, content);
                await fs.writeFile(outputPath, finalContent);
            } else {
                await fs.writeFile(outputPath, content);
            }
        }
    }
}