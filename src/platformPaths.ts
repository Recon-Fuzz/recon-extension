import * as path from 'path';

export function getPathDelimiter(platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32' ? ';' : ':';
}

export function combinePathSources(
    userPath: string,
    shellPath: string,
    defaultPath: string,
    platform: NodeJS.Platform = process.platform
): string {
    const delimiter = getPathDelimiter(platform);
    const fragments = platform === 'win32'
        ? [...userPath.split(delimiter), ...defaultPath.split(delimiter)]
        : [...userPath.split(delimiter), ...shellPath.split(delimiter), ...defaultPath.split(delimiter)];

    return Array.from(new Set(fragments.filter(Boolean))).join(delimiter);
}

export function normalizeCoveragePath(filePath: string): string {
    return filePath.split(path.win32.sep).join(path.posix.sep);
}

export function isSourceOrReconCoveragePath(filePath: string, sourceDirectory: string): boolean {
    const normalizedPath = normalizeCoveragePath(filePath);
    const normalizedSourceDirectory = normalizeCoveragePath(sourceDirectory).replace(/^\/+|\/+$/g, '');

    return normalizedPath.startsWith(`${normalizedSourceDirectory}/`) || normalizedPath.includes('/recon');
}

export function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
