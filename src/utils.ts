import { echidnaLogsToFunctions, Fuzzer, halmosLogsToFunctions, medusaLogsToFunctions } from '@recon-fuzz/log-parser';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';
import { FileBlock } from './types';
import { execSync } from 'child_process';

export function getFoundryConfigPath(workspaceRoot: string): string {
    const configPath = vscode.workspace.getConfiguration('recon').get<string>('foundryConfigPath', 'foundry.toml');
    return path.join(workspaceRoot, configPath);
}

export async function findOutputDirectory(workspaceRoot: string): Promise<string> {
    try {
        const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
        const configContent = await fs.readFile(foundryConfigPath, 'utf8');
        const match = configContent.match(/out\s*=\s*["'](.+?)["']/);
        if (match) {
            // If path is absolute, use it directly; otherwise, make it relative to foundry.toml location
            const outPath = match[1];
            return path.join(path.dirname(foundryConfigPath), outPath);
        }
        return path.join(path.dirname(foundryConfigPath), 'out');
    } catch {
        return path.join(workspaceRoot, 'out');
    }
}

export let srcDirectory: string = 'src';

export async function findSrcDirectory(workspaceRoot: string): Promise<void> {
    try {
        const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
        const configContent = await fs.readFile(foundryConfigPath, 'utf8');
        const match = configContent.match(/src\s*=\s*["'](.+?)["']/);
        if (match) {
            srcDirectory = match[1];
        }
    } catch { }
}


export async function getTestFolder(workspaceRoot: string): Promise<string> {
    const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
    const foundryRoot = path.dirname(foundryConfigPath);

    // Check if custom path is set in settings
    const customPath = vscode.workspace.getConfiguration('recon').get<string>('customTestFolderPath', '');
    if (customPath) {
        return customPath;
    }

    const testPaths = [
        'test',
        'tests',
        'src/tests',
        'src/test',
        'contracts/tests',
        'contracts/test',
    ];

    for (const testPath of testPaths) {
        try {
            await fs.access(path.join(foundryRoot, testPath));
            return testPath;
        } catch {
            continue;
        }
    }

    return 'test'; // default fallback
}

export async function outputDirectoryExist(workspaceRoot: string): Promise<boolean> {
    try {
        const outDir = await findOutputDirectory(workspaceRoot);
        await fs.stat(outDir);
        return true;
    } catch {
        return false;
    }
}

export function stripAnsiCodes(text: string): string {
    // This pattern matches all ANSI escape codes
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

const vmData = {
    roll: true,
    time: true,
    prank: false,
};

export const prepareTrace = (fuzzer: Fuzzer, prefix: string, trace: string, brokenProperty: string) => {
    let finalTrace = "";
    if (fuzzer === Fuzzer.MEDUSA) {
        finalTrace = medusaLogsToFunctions(trace, prefix, vmData);
    } else if (fuzzer === Fuzzer.ECHIDNA) {
        finalTrace = echidnaLogsToFunctions(trace, prefix, brokenProperty, vmData);
    } else if (fuzzer === Fuzzer.HALMOS) {
        finalTrace = halmosLogsToFunctions(trace, prefix, brokenProperty, vmData);
    }
    const functionName = finalTrace
        .split("() public")[0]
        .replace("function ", "");
    const forgeCommand = `// forge test --match-test ${functionName} -vvv`.replace("\n", "");

    // Add 4 spaces to the beginning of each line in finalTrace
    const indentedTrace = finalTrace
        .split('\n')
        .map((line, idx) => {
            if (idx === finalTrace.split('\n').length - 1) {
                return `   ${line}`;
            }
            return `    ${line}`;
        })
        .join('\n');

    return `${forgeCommand}\n${indentedTrace}`;
};

export const getUid = () => {
    // generate a random 4 character string+number
    return Math.random().toString(36).substring(2, 6);
};


export async function cleanupEchidnaCoverageReport(workspaceRoot: string, content: string): Promise<string> {
    const dom = new JSDOM(content, {
        contentType: 'text/html;charset=utf-8'
    });
    const document = dom.window.document;

    // Find all file blocks starting with <b> tags
    const fileBlocks: FileBlock[] = [];
    let currentBlock = document.querySelector('b') as HTMLElement | null;

    while (currentBlock) {
        const filePath = currentBlock.textContent || '';
        const codeBlock = currentBlock.nextElementSibling as HTMLElement | null;

        if (codeBlock && codeBlock.tagName === 'CODE') {
            fileBlocks.push({
                path: filePath,
                content: currentBlock.outerHTML + codeBlock.outerHTML
            });
        }

        // Move to next b tag
        currentBlock = currentBlock.nextElementSibling as HTMLElement | null;
        while (currentBlock && currentBlock.tagName !== 'B') {
            currentBlock = currentBlock.nextElementSibling as HTMLElement | null;
        }
    }

    const foundryConfigPath = getFoundryConfigPath(workspaceRoot);
    const foundryRoot = path.dirname(foundryConfigPath);

    // Filter blocks based on path conditions
    const filteredBlocks = fileBlocks.filter(block => {
        const relativePath = path.relative(foundryRoot, block.path);
        if (relativePath.startsWith(`${srcDirectory}/`)) {
            return true;
        }
        if (relativePath.includes('/recon')) {
            return true;
        }
        return false;
    });

    // Rebuild HTML with proper structure
    const cleanedHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
    ${document.querySelector('style')?.outerHTML || ''}
</head>
<body>
    ${filteredBlocks.map(block => block.content).join('\n<br />\n')}
</body>
</html>`;

    return cleanedHtml;
}

export async function cleanupMedusaCoverageReport(content: string): Promise<string> {
    if (content.includes("<title>Medusa Coverage Report</title>")) {
        // new medusa report
        const dom = new JSDOM(content, {
            contentType: 'text/html;charset=utf-8'
        });
        const document = dom.window.document;

        // Find all source-file divs
        const sourceDivs = document.querySelectorAll('div.source-file');
        sourceDivs.forEach(div => {
            const filePath = div.getAttribute('data-file-path') || '';
            const shouldRemove = !(filePath.startsWith(`${srcDirectory}/`) || filePath.includes('/recon'));
            if (shouldRemove) {
                div.remove();
            }
        });
        return dom.serialize();
    } else {
        const dom = new JSDOM(content, {
            contentType: 'text/html;charset=utf-8'
        });
        const document = dom.window.document;

        // Find all buttons (coverage entries)
        const buttons = document.querySelectorAll('button.collapsible');

        buttons.forEach(button => {
            // Get the path from the last span in the button
            const spans = button.querySelectorAll('span');
            const lastSpan = spans[spans.length - 1];
            const relativePath = lastSpan?.textContent || '';

            // Get the associated container div
            const containerDiv = button.nextElementSibling as HTMLElement;

            // Check if we should keep this entry
            const shouldKeep = relativePath.startsWith(`${srcDirectory}/`) || relativePath.includes('/recon');

            if (!shouldKeep) {
                // Remove both button and container
                button.remove();
                containerDiv?.remove();
            }
        });

        const cleanedHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
    ${document.querySelector('style')?.outerHTML || ''}
</head>
<body>
    ${document.body.innerHTML}
    ${document.querySelector('script')?.outerHTML || ''}
</body>
</html>`;
        return cleanedHtml;
    }
}

export async function cleanupCoverageReport(workspaceRoot: string, content: string): Promise<string> {
    // Detect report type from content and call appropriate function
    if (content.includes('Report generated by medusa') || content.includes('Report generated by Medusa')) {
        return cleanupMedusaCoverageReport(content);
    } else {
        return cleanupEchidnaCoverageReport(workspaceRoot, content);
    }
}

export function getEnvironmentPath(): string {
    const defaultPath = process.env.PATH || '';

    const platformKey =
        process.platform === 'win32'
            ? 'terminal.integrated.env.windows'
            : process.platform === 'darwin'
                ? 'terminal.integrated.env.osx'
                : 'terminal.integrated.env.linux';

    const userPath = vscode.workspace.getConfiguration().get<{ [key: string]: string }>(platformKey)?.PATH || '';

    let shellPath = '';
    if (process.platform !== 'win32') {
        try {
            shellPath = execSync(`${process.env.SHELL || '/bin/bash'} -ilc 'echo $PATH'`, {
                encoding: 'utf8'
            }).trim();
        } catch (e) {
            console.warn('Failed to get shell PATH:', e);
        }
    } else {
        return userPath ? `${userPath}:${process.env.PATH}` : process.env.PATH || '';
    }

    const combined = new Set([
        ...userPath.split(':'),
        ...shellPath.split(':'),
        ...defaultPath.split(':'),
    ].filter(Boolean));

    return Array.from(combined).join(':');
}

export async function checkCommandExists(command: string): Promise<boolean> {
    try {
        const checkCommand = process.platform === 'win32' ? 'where' : 'which';
        execSync(`${checkCommand} ${command}`, {
            encoding: 'utf-8',
            stdio: 'pipe',
            env: {
                ...process.env,
                PATH: getEnvironmentPath()
            },
        });
       return true; 
    } catch (error) {
       return false; 
    }
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) {
    return "0s";
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts = [];
  if (h > 0) {
    parts.push(`${h}h`);
  }
  if (m > 0 || (h > 0 && s > 0)) {
    parts.push(`${m}m`);
  }
  if (s > 0 || parts.length === 0) {
    parts.push(`${s}s`);
  }
  return parts.join(" ");
}
