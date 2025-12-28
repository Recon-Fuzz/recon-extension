import * as vscode from "vscode";

export function matchesPattern(name: string, pattern: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(name);
}

export function filterIgnoredProperties<T extends { brokenProperty: string }>(
    properties: T[]
): T[] {
    const patterns = vscode.workspace.getConfiguration('recon')
        .get<string[]>('ignorePropertyPatterns', []);
    
    if (!patterns.length) {
        return properties;
    }

    return properties.filter(
        prop => !patterns.some(p => matchesPattern(prop.brokenProperty, p))
    );
}