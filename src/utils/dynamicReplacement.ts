import * as parser from '@solidity-parser/parser';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { getTestFolder } from '../utils';

// ---------- Types ----------

export interface SetupVariable {
    name: string;
    type: string;
    isConstant: boolean;
    mutability: string;
    currentValue: string;
    fullDeclaration: string;
    lineNumber: number;
}

export interface DynamicReplacement {
    target: string;
    replacement: string;
    endOfTargetMarker: string;
    targetContract: string;
}

export interface DynamicReplacementConfig {
    enabled: boolean;
    prepareContracts: DynamicReplacement[];
}

// ---------- Setup.sol Finder ----------

export async function findSetupSolPath(workspaceRoot: string): Promise<string | null> {
    const foundryConfigPath = vscode.workspace.getConfiguration('recon').get<string>('foundryConfigPath', 'foundry.toml');
    const foundryRoot = path.dirname(path.join(workspaceRoot, foundryConfigPath));

    const testFolder = await getTestFolder(workspaceRoot);
    const searchPaths = [
        path.join(foundryRoot, testFolder, 'recon', 'Setup.sol'),
        path.join(foundryRoot, 'test', 'recon', 'Setup.sol'),
        path.join(foundryRoot, 'tests', 'recon', 'Setup.sol'),
        path.join(foundryRoot, 'test', 'Setup.sol'),
        path.join(foundryRoot, 'src', 'test', 'recon', 'Setup.sol'),
    ];

    // Deduplicate paths
    const unique = [...new Set(searchPaths)];

    for (const p of unique) {
        try {
            await fs.access(p);
            return p;
        } catch {
            continue;
        }
    }
    return null;
}

// ---------- Setup.sol Parser ----------

function extractTypeName(typeNode: any): string {
    if (!typeNode) { return 'unknown'; }
    if (typeNode.type === 'ElementaryTypeName') { return typeNode.name; }
    if (typeNode.type === 'UserDefinedTypeName') { return typeNode.namePath; }
    if (typeNode.type === 'Mapping') {
        return `mapping(${extractTypeName(typeNode.keyType)} => ${extractTypeName(typeNode.valueType)})`;
    }
    if (typeNode.type === 'ArrayTypeName') {
        return `${extractTypeName(typeNode.baseTypeName)}[]`;
    }
    return typeNode.name || typeNode.namePath || 'unknown';
}

function extractValueFromLine(line: string): string {
    // Match the assignment operator that isn't part of ==, !=, <=, >=
    const eqMatch = line.match(/(?<!=|!|<|>)=(?!=)\s*(.+?)\s*;?\s*$/);
    if (eqMatch) {
        return eqMatch[1].replace(/;\s*$/, '').trim();
    }
    return '';
}

export async function parseSetupVariables(setupPath: string): Promise<SetupVariable[]> {
    const source = await fs.readFile(setupPath, 'utf8');
    const lines = source.split('\n');
    const variables: SetupVariable[] = [];

    try {
        const ast = parser.parse(source, { loc: true, range: true, tolerant: true });

        parser.visit(ast, {
            StateVariableDeclaration: (node: any) => {
                for (const variable of node.variables) {
                    // Only collect constants and immutables
                    const isDeclaredConst = variable.isDeclaredConst === true;
                    const isImmutable = variable.isImmutable === true;

                    if (!isDeclaredConst && !isImmutable) {
                        continue;
                    }

                    if (!variable.loc) { continue; }

                    const lineNumber = variable.loc.start.line;
                    const fullLine = lines[lineNumber - 1]?.trim() || '';
                    const typeName = extractTypeName(variable.typeName);
                    const mutability = isDeclaredConst ? 'constant' : 'immutable';
                    const currentValue = extractValueFromLine(fullLine);

                    variables.push({
                        name: variable.name,
                        type: typeName,
                        isConstant: isDeclaredConst,
                        mutability,
                        currentValue,
                        fullDeclaration: fullLine,
                        lineNumber,
                    });
                }
            }
        });
    } catch (e) {
        // Fallback: regex-based parsing for files the AST parser can't handle
        console.warn('AST parse failed, falling back to regex:', e);
        return parseSetupVariablesRegex(source);
    }

    return variables.sort((a, b) => a.lineNumber - b.lineNumber);
}

function parseSetupVariablesRegex(source: string): SetupVariable[] {
    const lines = source.split('\n');
    const variables: SetupVariable[] = [];

    // Match lines like:  TYPE constant NAME = VALUE;  or  TYPE immutable NAME = VALUE;
    // Also handles visibility modifiers and array types
    const pattern = /(?:(?:public|private|internal)\s+)?(\w+(?:\s*\[\s*\])?)\s+(constant|immutable)\s+(\w+)\s*=\s*([^;]+);/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Skip comments
        if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
            continue;
        }

        const match = line.match(pattern);
        if (match) {
            const [, type, mutability, name, value] = match;
            variables.push({
                name,
                type,
                isConstant: mutability === 'constant',
                mutability,
                currentValue: value.trim(),
                fullDeclaration: line,
                lineNumber: i + 1,
            });
        }
    }

    return variables;
}

// ---------- recon.json Helpers ----------

export async function loadDynamicReplacementConfig(workspaceRoot: string): Promise<DynamicReplacementConfig> {
    try {
        const reconPath = path.join(workspaceRoot, 'recon.json');
        const content = await fs.readFile(reconPath, 'utf8');
        const json = JSON.parse(content);
        const config = json.dynamicReplacement;
        if (config && typeof config.enabled === 'boolean' && Array.isArray(config.prepareContracts)) {
            return config as DynamicReplacementConfig;
        }
    } catch {
        // File doesn't exist or is malformed
    }
    return { enabled: false, prepareContracts: [] };
}

export async function saveDynamicReplacementConfig(
    workspaceRoot: string,
    config: DynamicReplacementConfig
): Promise<void> {
    const reconPath = path.join(workspaceRoot, 'recon.json');
    let json: Record<string, any> = {};

    try {
        const content = await fs.readFile(reconPath, 'utf8');
        json = JSON.parse(content);
    } catch {
        // Start fresh if file doesn't exist or is malformed
    }

    json.dynamicReplacement = config;

    const newContent = JSON.stringify(json, null, 2);
    await fs.writeFile(reconPath, newContent, 'utf8');
}

// ---------- Replacement Builder ----------

export function buildReplacement(variableName: string, newValue: string): DynamicReplacement {
    return {
        target: `${variableName} =`,
        replacement: `${variableName} = ${newValue};`,
        endOfTargetMarker: '[^;]*',
        targetContract: 'Setup.sol',
    };
}

// ---------- Replacement Application ----------

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyReplacementsToContent(
    content: string,
    replacements: DynamicReplacement[]
): { result: string; applied: number; errors: string[] } {
    let modified = content;
    let applied = 0;
    const errors: string[] = [];

    // Find each replacement's position in the file so we can sort end-to-start
    const withPositions = replacements.map(r => {
        const escaped = escapeRegex(r.target);
        const idx = modified.indexOf(r.target);
        return { replacement: r, position: idx };
    });

    // Sort by position descending (process from end of file to start)
    withPositions.sort((a, b) => b.position - a.position);

    for (const { replacement: rule, position } of withPositions) {
        if (position === -1) {
            errors.push(`Target "${rule.target}" not found in ${rule.targetContract}`);
            continue;
        }

        const escaped = escapeRegex(rule.target);
        // No 'g' flag — replace only the first occurrence
        const regex = new RegExp(`${escaped}${rule.endOfTargetMarker};`);
        const before = modified;
        modified = modified.replace(regex, rule.replacement);

        if (modified !== before) {
            applied++;
        } else {
            errors.push(`Regex replacement failed for target "${rule.target}"`);
        }
    }

    return { result: modified, applied, errors };
}

// ---------- Auto-apply Before Fuzzing ----------

export async function applyDynamicReplacements(): Promise<void> {
    try {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) { return; }

        const config = await loadDynamicReplacementConfig(workspaceRoot);
        if (!config.enabled || config.prepareContracts.length === 0) { return; }

        const setupPath = await findSetupSolPath(workspaceRoot);
        if (!setupPath) { return; }

        const content = await fs.readFile(setupPath, 'utf8');
        const { result, applied, errors } = applyReplacementsToContent(content, config.prepareContracts);

        if (applied > 0) {
            await fs.writeFile(setupPath, result, 'utf8');
            console.log(`[Dynamic Replacement] Applied ${applied} replacement(s) to Setup.sol`);
        }

        if (errors.length > 0) {
            console.warn('[Dynamic Replacement] Warnings:', errors);
        }
    } catch (e) {
        // Silent failure — don't block fuzzing
        console.warn('[Dynamic Replacement] Error:', e);
    }
}

// ---------- HTML Escaping ----------

export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
