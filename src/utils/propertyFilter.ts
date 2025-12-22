/**
 * Property filter utility for glob pattern matching
 * Used by PR #73 ignorePropertyPatterns feature
 */

/**
 * Simple glob pattern matcher for property names
 * Supports '*' wildcard for any characters
 * 
 * @param propertyName - The property name to check
 * @param pattern - The glob pattern (e.g., "canary_*", "doomday_*")
 * @returns true if propertyName matches pattern
 */
export function matchesGlob(propertyName: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .split('*')
    .map((str) => str.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(propertyName);
}

/**
 * Filter broken properties based on ignore patterns
 * Used in fuzzingCommands and logToFoundryView
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
 * Get all patterns that match a specific property
 */
export function getMatchingPatterns(
  propertyName: string,
  patterns: string[]
): string[] {
  return patterns.filter((pattern) => matchesGlob(propertyName, pattern));
}
