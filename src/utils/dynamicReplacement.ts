import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getFoundryConfigPath } from '../utils';
import { DynamicReplacement } from '../tools/dynamicReplacementView';

/**
 * Apply dynamic replacements to Setup.sol before running tools
 * This function reads replacements from recon.json and applies them to Setup.sol
 */
export async function applyDynamicReplacements(): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
        return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const reconJsonPath = path.join(workspaceRoot, 'recon.json');

    try {
        const content = await fs.readFile(reconJsonPath, 'utf8');
        const reconJson = JSON.parse(content);

        if (!reconJson.prepareContracts || !Array.isArray(reconJson.prepareContracts)) {
            return; // No replacements configured
        }

        const replacements: DynamicReplacement[] = reconJson.prepareContracts;
        if (replacements.length === 0) {
            return; // No replacements to apply
        }

        // Find Setup.sol file
        const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
        const foundryRoot = path.dirname(foundryConfigPath);
        const possiblePaths = [
            path.join(foundryRoot, 'test', 'recon', 'Setup.sol'),
            path.join(foundryRoot, 'test', 'Setup.sol'),
            path.join(foundryRoot, 'tests', 'recon', 'Setup.sol'),
            path.join(foundryRoot, 'src', 'test', 'recon', 'Setup.sol'),
        ];

        let setupPath: string | null = null;
        for (const setupPathCandidate of possiblePaths) {
            try {
                await fs.access(setupPathCandidate);
                setupPath = setupPathCandidate;
                break;
            } catch {
                continue;
            }
        }

        if (!setupPath) {
            return; // Setup.sol not found, skip
        }

        // Apply replacements
        let fileContent = await fs.readFile(setupPath, 'utf8');
        const sortedReplacements = [...replacements].sort((a, b) => {
            const aIndex = fileContent.lastIndexOf(a.target);
            const bIndex = fileContent.lastIndexOf(b.target);
            return bIndex - aIndex;
        });

        for (const replacement of sortedReplacements) {
            const escapedTarget = replacement.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const fullPattern = escapedTarget + (replacement.endOfTargetMarker || '[^;]*');
            const regex = new RegExp(fullPattern, 'g');
            const escapedReplacement = replacement.replacement.replace(/\$/g, '$$$$');
            fileContent = fileContent.replace(regex, escapedReplacement);
        }

        await fs.writeFile(setupPath, fileContent, 'utf8');
    } catch (error) {
        // Silently fail - don't block fuzzing if replacement fails
        console.warn('Failed to apply dynamic replacements:', error);
    }
}

