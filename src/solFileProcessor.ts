import * as parser from '@solidity-parser/parser';
import * as vscode from 'vscode';
import { TestFunction, TargetFunction, Mode, Actor } from './types';
import { ReconContractsViewProvider } from './reconContractsView';
import { camel } from 'case';

export class SolFileProcessor implements vscode.CodeLensProvider {
    private functions: Map<string, TestFunction[]> = new Map();

    constructor(private reconContractsView: ReconContractsViewProvider) { }

    public async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const text = document.getText();
        const codeLenses: vscode.CodeLens[] = [];

        try {
            const ast = parser.parse(text, { loc: true, range: true });
            const testFunctions = this.findTestFunctions(document, ast);
            const targetFunctions = await this.findTargetFunctions(document, ast);
            const enabledContracts = await this.reconContractsView.getEnabledContractData();

            this.functions.set(document.uri.toString(), testFunctions);

            // Add CodeLenses for test functions
            for (const func of testFunctions) {
                if (func.isPublicOrExternal && func.name.startsWith('test')) {
                    codeLenses.push(
                        new vscode.CodeLens(func.range, {
                            title: '▶ Run Test',
                            command: 'recon.runTest',
                            arguments: [document.uri, func.name]
                        })
                    );
                }
            }

            // Add target function CodeLenses
            for (const func of targetFunctions) {
                const config = enabledContracts
                    .find(c => c.jsonPath === func.fnParams.jsonPath)
                    ?.functionConfigs?.find(f => {
                        const [funcName] = f.signature.split('(');
                        return funcName === func.name;
                    });

                if (config) {
                    // Mode CodeLenses
                    codeLenses.push(
                        new vscode.CodeLens(func.range, {
                            title: `⚫ ${config.mode === Mode.NORMAL ? '✓' : ''} Normal Mode`,
                            command: 'recon.setFunctionMode',
                            arguments: [document.uri, func.contractName, func.name, 'normal', func.range, func.fnParams]
                        })
                    );
                    codeLenses.push(
                        new vscode.CodeLens(func.range, {
                            title: `🔴 ${config.mode === Mode.FAIL ? '✓' : ''} Fail Mode`,
                            command: 'recon.setFunctionMode',
                            arguments: [document.uri, func.contractName, func.name, Mode.FAIL, func.range, func.fnParams]
                        })
                    );
                    codeLenses.push(
                        new vscode.CodeLens(func.range, {
                            title: `🟡 ${config.mode === Mode.CATCH ? '✓' : ''} Catch Mode`,
                            command: 'recon.setFunctionMode',
                            arguments: [document.uri, func.contractName, func.name, Mode.CATCH, func.range, func.fnParams]
                        })
                    );

                    // Actor CodeLenses
                    codeLenses.push(
                        new vscode.CodeLens(func.range, {
                            title: `👤 ${config.actor === Actor.ACTOR ? '✓' : ''} As Actor`,
                            command: 'recon.setFunctionActor',
                            arguments: [document.uri, func.contractName, func.name, Actor.ACTOR, func.range, func.fnParams]
                        })
                    );
                    codeLenses.push(
                        new vscode.CodeLens(func.range, {
                            title: `👑 ${config.actor === Actor.ADMIN ? '✓' : ''} As Admin`,
                            command: 'recon.setFunctionActor',
                            arguments: [document.uri, func.contractName, func.name, Actor.ADMIN, func.range, func.fnParams]
                        })
                    );
                }
            }
        } catch (e) {
            console.error('Failed to parse Solidity file:', e);
        }

        return codeLenses;
    }

    private findTestFunctions(document: vscode.TextDocument, ast: any): TestFunction[] {
        const functions: TestFunction[] = [];

        parser.visit(ast, {
            FunctionDefinition: (node) => {
                if (node.loc) {
                    const range = new vscode.Range(
                        new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
                        new vscode.Position(node.loc.end.line - 1, node.loc.end.column)
                    );

                    functions.push({
                        name: node.name || '',
                        range,
                        isPublicOrExternal:
                            node.visibility === 'public' ||
                            node.visibility === 'external'
                    });
                }
            }
        });

        return functions;
    }

    private async findTargetFunctions(document: vscode.TextDocument, ast: any): Promise<TargetFunction[]> {
        const functions: TargetFunction[] = [];
        const processedFunctions = new Set<string>();
        const enabledContracts = await this.reconContractsView.getEnabledContractData();

        parser.visit(ast, {
            FunctionDefinition: (node) => {
                if (node.loc) {
                    // Find matching contract for this function
                    const matchingContract = enabledContracts.find(contract => {
                        const expectedPrefix = `${camel(contract.name)}_`;
                        return node.name && node.name.startsWith(expectedPrefix);
                    });

                    if (matchingContract) {
                        const expectedPrefix = `${camel(matchingContract.name)}_`;
                        const actualFunctionName = node.name!.substring(expectedPrefix.length);
                        
                        // Skip if already processed
                        const functionKey = `${matchingContract.name}_${actualFunctionName}`;
                        if (processedFunctions.has(functionKey)) {
                            return;
                        }
                        processedFunctions.add(functionKey);

                        // Find function configuration and ABI
                        const functionConfig = matchingContract.functionConfigs?.find(config => {
                            const [configFuncName] = config.signature.split('(');
                            return configFuncName === actualFunctionName;
                        });

                        const functionAbi = matchingContract.abi.find(item =>
                            item.type === 'function' &&
                            item.name === actualFunctionName
                        );

                        if (functionConfig && functionAbi) {
                            const range = new vscode.Range(
                                new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
                                new vscode.Position(node.loc.end.line - 1, node.loc.end.column + 1)
                            );
                            functions.push({
                                name: actualFunctionName,
                                fullName: node.name || '',
                                range,
                                isPublicOrExternal:
                                    node.visibility === 'public' ||
                                    node.visibility === 'external',
                                contractName: matchingContract.name,
                                fnParams: {
                                    contractName: matchingContract.name,
                                    contractPath: matchingContract.path,
                                    jsonPath: matchingContract.jsonPath,
                                    functionName: actualFunctionName,
                                    abi: functionAbi,
                                    actor: functionConfig.actor,
                                    mode: functionConfig.mode
                                }
                            });
                        }
                    }
                }
            }
        });

        return functions;
    }
}