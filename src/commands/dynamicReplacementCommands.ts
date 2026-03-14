import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getFoundryConfigPath } from '../utils';
import { ServiceContainer } from '../services/serviceContainer';
import { DynamicReplacement, PrepareContract } from '../types';

/**
 * Apply dynamic replacements from recon.json to Setup.sol before fuzzing,
 * and restore the original after fuzzing completes.
 */
export async function applyDynamicReplacements(
    workspaceRoot: string
): Promise<{ originalContent: string; setupPath: string } | null> {
    const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
    const foundryRoot = path.dirname(foundryConfigPath);
    const reconJsonPath = path.join(foundryRoot, 'recon.json');

    let reconData: Record<string, unknown>;
    try {
        const raw = await fs.readFile(reconJsonPath, 'utf-8');
        reconData = JSON.parse(raw);
    } catch {
        return null; // No recon.json or invalid JSON — skip
    }

    const prepareContracts = reconData.prepareContracts as PrepareContract[] | undefined;
    if (!prepareContracts || prepareContracts.length === 0) {
        return null;
    }

    // Find Setup.sol entry
    const setupEntry = prepareContracts.find(
        (c) => c.file === 'Setup.sol' || c.file.endsWith('/Setup.sol')
    );
    if (!setupEntry || !setupEntry.replacements || setupEntry.replacements.length === 0) {
        return null;
    }

    // Locate Setup.sol
    const testFolder = path.join(foundryRoot, 'test');
    const setupPath = path.join(testFolder, 'Setup.sol');

    let originalContent: string;
    try {
        originalContent = await fs.readFile(setupPath, 'utf-8');
    } catch {
        vscode.window.showWarningMessage('Dynamic Replacement: Setup.sol not found, skipping.');
        return null;
    }

    // Apply each replacement
    let modifiedContent = originalContent;
    for (const r of setupEntry.replacements) {
        if (!r.target || !r.replacement) {
            continue;
        }
        // Escape regex special chars in target
        const escaped = r.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = r.endOfTargetMarker
            ? new RegExp(escaped + '.*?' + r.endOfTargetMarker)
            : new RegExp(escaped);
        modifiedContent = modifiedContent.replace(pattern, r.replacement);
    }

    if (modifiedContent !== originalContent) {
        await fs.writeFile(setupPath, modifiedContent, 'utf-8');
        return { originalContent, setupPath };
    }

    return null;
}

export async function restoreDynamicReplacements(
    originalContent: string,
    setupPath: string
): Promise<void> {
    try {
        await fs.writeFile(setupPath, originalContent, 'utf-8');
    } catch (err) {
        vscode.window.showErrorMessage(
            `Dynamic Replacement: failed to restore Setup.sol: ${err}`
        );
    }
}

export function registerDynamicReplacementCommands(
    context: vscode.ExtensionContext,
    _services: ServiceContainer
): void {
    // Commands are registered in extension.ts (toggle)
    // Apply/restore is called from fuzzingCommands.ts
}
