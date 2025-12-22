import * as vscode from 'vscode';
import { matchesGlob } from '../utils/propertyFilter';
import {
  getIgnorePatterns,
  setIgnorePatterns,
  getAllProperties,
} from '../providers/propertyToggleCodeLens';

/**
 * Command handler for toggling property ignore status
 * Can be called from CodeLens (with propertyName) or Command Palette (without)
 */
export async function togglePropertyIgnore(propertyName?: string): Promise<void> {
  try {
    // If no property name provided, ask user to select from list
    let targetProperty = propertyName;

    if (!targetProperty) {
      const allProperties = await getAllProperties();

      if (allProperties.length === 0) {
        vscode.window.showWarningMessage('No properties found in Solidity files');
        return;
      }

      targetProperty = await vscode.window.showQuickPick(allProperties, {
        placeHolder: 'Select a property to toggle',
      });

      if (!targetProperty) {
        return;
      }
    }

    const ignorePatterns = getIgnorePatterns();

    // Check if property is currently ignored
    const isCurrentlyIgnored = ignorePatterns.some((pattern) =>
      matchesGlob(targetProperty, pattern)
    );

    let newPatterns: string[];

    if (isCurrentlyIgnored) {
      // Remove the property from ignore list
      newPatterns = ignorePatterns.filter(
        (pattern) => !matchesGlob(targetProperty, pattern)
      );

      await setIgnorePatterns(newPatterns);

      vscode.window.showInformationMessage(
        `✅ Property "${targetProperty}" is now ENABLED`
      );
    } else {
      // Add the property to ignore list (exact match)
      newPatterns = [...ignorePatterns, targetProperty];

      await setIgnorePatterns(newPatterns);

      vscode.window.showInformationMessage(
        `⏹️ Property "${targetProperty}" is now IGNORED`
      );
    }

    // Refresh CodeLens
    vscode.commands.executeCommand('codelens.refresh');
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error toggling property: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Show property ignore status
 * Can be called from CodeLens (with propertyName) or Command Palette (without)
 */
export async function showPropertyStatus(propertyName?: string): Promise<void> {
  try {
    // If no property name provided, ask user to select from list
    let targetProperty = propertyName;

    if (!targetProperty) {
      const allProperties = await getAllProperties();

      if (allProperties.length === 0) {
        vscode.window.showWarningMessage('No properties found in Solidity files');
        return;
      }

      targetProperty = await vscode.window.showQuickPick(allProperties, {
        placeHolder: 'Select a property to check status',
      });

      if (!targetProperty) {
        return;
      }
    }

    const ignorePatterns = getIgnorePatterns();
    const isIgnored = ignorePatterns.some((pattern) =>
      matchesGlob(targetProperty, pattern)
    );

    vscode.window.showInformationMessage(
      `Property "${targetProperty}" is currently ${isIgnored ? '🔴 IGNORED' : '🟢 ENABLED'}`
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * List all ignored properties
 */
export async function listIgnoredProperties(): Promise<void> {
  const patterns = getIgnorePatterns();

  if (patterns.length === 0) {
    vscode.window.showInformationMessage('No properties are currently ignored');
    return;
  }

  const message = `Ignored properties (${patterns.length}):\n\n${patterns.join('\n')}`;
  vscode.window.showInformationMessage(message);
}

/**
 * Clear all ignored properties
 */
export async function clearIgnoredProperties(): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    'Clear all ignored properties?',
    'Yes',
    'No'
  );

  if (answer === 'Yes') {
    await setIgnorePatterns([]);
    vscode.window.showInformationMessage('All properties are now enabled');
    vscode.commands.executeCommand('codelens.refresh');
  }
}

/**
 * Add property to ignore list
 */
export async function addPropertyToIgnore(): Promise<void> {
  const allProperties = await getAllProperties();

  if (allProperties.length === 0) {
    vscode.window.showWarningMessage('No properties found in Solidity files');
    return;
  }

  const selected = await vscode.window.showQuickPick(allProperties, {
    placeHolder: 'Select a property to ignore (or type pattern)',
  });

  if (!selected) {
    // Allow manual input
    const manual = await vscode.window.showInputBox({
      prompt: 'Enter property name or pattern to ignore',
      placeHolder: 'e.g., canary_test or canary_*',
    });

    if (!manual) {
      return;
    }

    const patterns = getIgnorePatterns();
    if (patterns.includes(manual)) {
      vscode.window.showWarningMessage(`Property "${manual}" is already ignored`);
      return;
    }

    patterns.push(manual);
    await setIgnorePatterns(patterns);
    vscode.window.showInformationMessage(`✅ Property "${manual}" added to ignore list`);
    vscode.commands.executeCommand('codelens.refresh');
    return;
  }

  const patterns = getIgnorePatterns();

  // Check if already exists
  if (patterns.includes(selected)) {
    vscode.window.showWarningMessage(`Property "${selected}" is already ignored`);
    return;
  }

  patterns.push(selected);
  await setIgnorePatterns(patterns);

  vscode.window.showInformationMessage(
    `✅ Property "${selected}" added to ignore list`
  );
  vscode.commands.executeCommand('codelens.refresh');
}

/**
 * Remove property from ignore list
 */
export async function removePropertyFromIgnore(): Promise<void> {
  const patterns = getIgnorePatterns();

  if (patterns.length === 0) {
    vscode.window.showInformationMessage('No properties to remove');
    return;
  }

  const selected = await vscode.window.showQuickPick(patterns, {
    placeHolder: 'Select a property to remove from ignore list',
  });

  if (!selected) {
    return;
  }

  const newPatterns = patterns.filter((p) => p !== selected);
  await setIgnorePatterns(newPatterns);

  vscode.window.showInformationMessage(
    `✅ Property "${selected}" removed from ignore list`
  );
  vscode.commands.executeCommand('codelens.refresh');
}
