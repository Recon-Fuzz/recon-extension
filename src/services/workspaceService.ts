import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getFoundryConfigPath, findOutputDirectory } from '../utils';

export class WorkspaceService {
    /**
     * Gets the workspace root path, or undefined if no workspace is open
     */
    public getWorkspaceRoot(): string | undefined {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return undefined;
        }
        
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    /**
     * Gets the foundry root directory
     */
    public async getFoundryRoot(): Promise<string> {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace folder found');
        }

        const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
        return path.dirname(foundryConfigPath);
    }

    /**
     * Checks if a foundry project is detected in the workspace
     */
    public async isFoundryProject(): Promise<boolean> {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            return false;
        }

        try {
            const foundryConfig = getFoundryConfigPath(workspaceRoot);
            await fs.access(foundryConfig);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Gets the artifact output directory
     */
    public async getOutputDirectory(): Promise<string> {
        const workspaceRoot = this.getWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace folder found');
        }

        return findOutputDirectory(workspaceRoot);
    }

    /**
     * Writes content to a file, ensuring its directory exists
     */
    public async writeFile(filePath: string, content: string): Promise<void> {
        try {
            const dir = path.dirname(filePath);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(filePath, content, 'utf8');
        } catch (error) {
            throw new Error(`Failed to write file ${filePath}: ${error}`);
        }
    }

    /**
     * Reads content from a file
     */
    public async readFile(filePath: string): Promise<string> {
        try {
            return await fs.readFile(filePath, 'utf8');
        } catch (error) {
            throw new Error(`Failed to read file ${filePath}: ${error}`);
        }
    }

    /**
     * Checks if a file exists
     */
    public async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
}
