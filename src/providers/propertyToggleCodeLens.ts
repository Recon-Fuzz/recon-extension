import * as vscode from 'vscode';
import { matchesGlob } from '../utils/propertyFilter';

/**
 * CodeLens provider for toggling property ignore patterns
 * Integrates with recon.ignorePropertyPatterns setting from PR #73
 */
export class PropertyToggleCodeLensProvider implements vscode.CodeLensProvider {
  private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  constructor(private context: vscode.ExtensionContext) {
    // Listen for configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('recon.ignorePropertyPatterns')) {
        this.onDidChangeCodeLensesEmitter.fire();
      }
    });
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];
    const ignorePatterns = vscode.workspace
      .getConfiguration('recon')
      .get<string[]>('ignorePropertyPatterns') || [];


    // Only process files that end with "Properties.sol"
    if (!document.fileName.endsWith('Properties.sol')) {
      return lenses;
    }
    // Ultra-flexible regex patterns - try multiple patterns
    const patterns = [
      // Pattern 1: Standard - function name() [visibility] [state] returns (bool)
      /function\s+(\w+)\s*\(\s*\)\s*(?:public|internal|external|private)?\s*(?:view|pure|payable)?\s*(?:returns\s*\(\s*bool\s*\))?/gm,

      // Pattern 2: With asActor or other modifiers
      /function\s+(\w+)\s*\(\s*\)\s+(?:\w+\s+)*(?:public|internal|external|private)?\s*(?:view|pure|payable)?\s*(?:returns\s*\(\s*bool\s*\))?/gm,

      // Pattern 3: Just match function name() - most permissive
      /function\s+(\w+)\s*\(\s*\)/gm,
    ];

    const foundProperties = new Set<string>();
    const propertyLines = new Map<string, { line: number; range: vscode.Range }>();

    for (const pattern of patterns) {
      let match;
      pattern.lastIndex = 0; // Reset regex state

      while ((match = pattern.exec(document.getText())) !== null) {
        const propertyName = match[1];

        // Skip if already found
        if (foundProperties.has(propertyName)) {
          continue;
        }

        const lineNum = document.getText().substring(0, match.index).split('\n').length - 1;

        try {
          const range = document.lineAt(lineNum).range;
          foundProperties.add(propertyName);
          propertyLines.set(propertyName, { line: lineNum, range });
        } catch (e) {
          // Line might not exist, skip
          continue;
        }
      }
    }

    // Create CodeLens for each found property
    for (const [propertyName, { range }] of propertyLines) {
      // Check if property matches any ignore pattern
      const isIgnored = ignorePatterns.some((pattern) =>
        matchesGlob(propertyName, pattern)
      );

      // Create CodeLens command
      const command: vscode.Command = {
        title: isIgnored ? '🟢 Enable Property' : '🔴 Ignore Property',
        command: 'recon.togglePropertyIgnore',
        arguments: [propertyName],
        tooltip: `Toggle "${propertyName}" in recon.ignorePropertyPatterns`,
      };

      lenses.push(new vscode.CodeLens(range, command));
    }

    return lenses;
  }

  public resolveCodeLens?(
    codeLens: vscode.CodeLens,
    token: vscode.CancellationToken
  ): vscode.CodeLens | Thenable<vscode.CodeLens> {
    return codeLens;
  }
}

/**
 * Helper function to get all ignore patterns
 */
export function getIgnorePatterns(): string[] {
  return vscode.workspace
    .getConfiguration('recon')
    .get<string[]>('ignorePropertyPatterns') || [];
}

/**
 * Helper function to set ignore patterns
 */
export async function setIgnorePatterns(patterns: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration('recon');
  await config.update(
    'ignorePropertyPatterns',
    patterns,
    vscode.ConfigurationTarget.Workspace
  );
}

/**
 * Get all properties from open Solidity files
 */
export async function getAllProperties(): Promise<string[]> {
  const properties = new Set<string>();

  // Search through all open text documents
  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId !== 'solidity') {
      continue;
    }

    // Only process files that end with "Properties.sol"
    if (!document.fileName.endsWith('Properties.sol')) {
      continue;
    }

    // Use same regex patterns as CodeLens
    const patterns = [
      /function\s+(\w+)\s*\(\s*\)\s*(?:public|internal|external|private)?\s*(?:view|pure|payable)?\s*(?:returns\s*\(\s*bool\s*\))?/gm,
      /function\s+(\w+)\s*\(\s*\)\s+(?:\w+\s+)*(?:public|internal|external|private)?\s*(?:view|pure|payable)?\s*(?:returns\s*\(\s*bool\s*\))?/gm,
      /function\s+(\w+)\s*\(\s*\)/gm,
    ];

    for (const pattern of patterns) {
      let match;
      pattern.lastIndex = 0;

      while ((match = pattern.exec(document.getText())) !== null) {
        properties.add(match[1]);
      }
    }
  }

  return Array.from(properties).sort();
}
