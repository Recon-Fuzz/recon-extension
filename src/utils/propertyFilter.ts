import * as vscode from "vscode";

/**
 * Property filter utility for glob pattern matching
 * Supports '*' wildcard for any characters
 */

/**
 * Simple glob pattern matcher for property names
 * 
 * @param propertyName - The property name to check
 * @param pattern - The glob pattern (e.g., "canary_*", "doomday_*")
 * @returns true if propertyName matches pattern
 */
export function matchesGlob(propertyName: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .split('*')
    .map((str) => str.replace(/[.+?^${}()|[\\]\\]/g, '\\$&'))
    .join('.*');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(propertyName);
}

/**
 * Alias for matchesGlob for backward compatibility
 */
export function matchesPattern(name: string, pattern: string): boolean {
  return matchesGlob(name, pattern);
}

/**
 * Filter broken properties based on ignore patterns (string array version)
 * 
 * @param properties - Array of property names
 * @param ignorePatterns - Array of glob patterns to filter out
 * @returns Filtered array with ignored properties removed
 */
export function filterBrokenProperties(
  properties: string[],
  ignorePatterns: string[]
): string[] {
  if (!ignorePatterns || ignorePatterns.length === 0) {
    return properties;
  }

  return properties.filter((prop) => {
    // Keep property if it doesn't match any ignore pattern
    return !ignorePatterns.some((pattern) => matchesGlob(prop, pattern));
  });
}

/**
 * Filter ignored properties from object array (reads config automatically)
 * 
 * @param properties - Array of objects with brokenProperty field
 * @returns Filtered array with ignored properties removed
 */
export function filterIgnoredProperties<T extends { brokenProperty: string }>(
  properties: T[]
): T[] {
  const patterns = vscode.workspace.getConfiguration('recon')
    .get<string[]>('ignorePropertyPatterns', []);

  if (!patterns.length) {
    return properties;
  }

  return properties.filter(
    prop => !patterns.some(p => matchesGlob(prop.brokenProperty, p))
  );
}

/**
 * Get all patterns that match a specific property
 * 
 * @param propertyName - The property name to check
 * @param patterns - Array of glob patterns
 * @returns Array of patterns that match the property
 */
export function getMatchingPatterns(
  propertyName: string,
  patterns: string[]
): string[] {
  return patterns.filter((pattern) => matchesGlob(propertyName, pattern));
}