# Dynamic Replacement Feature Implementation

## Overview
This implementation adds the Dynamic Replacement feature as requested in Issue #21. It allows users to replace constants in Setup.sol before running fuzzing tools.

## Features Implemented

### 1. Dynamic Replacement Panel
- New webview panel accessible via "Dynamic Replacement" command
- Lists all constants found in Setup.sol
- Shows current value for each constant
- Allows editing replacement values
- Saves changes to recon.json in the required format

### 2. Constant Detection
- Parses Setup.sol to find all constant and immutable variables
- Uses regex fallback if compiler output is not available
- Handles various Solidity constant declaration patterns
- Filters out function parameters and local variables

### 3. recon.json Integration
- Saves replacements in the format: `{ target, replacement, endOfTargetMarker, targetContract }`
- Merges with existing replacements (avoids duplicates)
- Updates existing entries if target already exists
- Format matches the runner's expected structure

### 4. Automatic Application
- Replacements are automatically applied to Setup.sol before running fuzzers
- File is updated with new values before tool execution
- Changes are saved to recon.json for persistence

## Files Created/Modified

### New Files
- `src/tools/dynamicReplacementView.ts` - Main view provider for the panel
- `src/utils/dynamicReplacement.ts` - Utility function to apply replacements

### Modified Files
- `src/extension.ts` - Registered new command
- `src/commands/fuzzingCommands.ts` - Added automatic replacement application
- `package.json` - Added command and menu entry

## Usage

1. Open the Dynamic Replacement panel via:
   - Command Palette: "Recon: Dynamic Replacement"
   - Tools menu in Recon Cockpit

2. The panel will automatically load constants from Setup.sol

3. Edit values in the text fields

4. Click "Save Replacements" to save to recon.json

5. Click "Update Setup.sol" to apply changes to the file

6. Run fuzzers - replacements are automatically applied before execution

## Technical Details

### Constant Parsing
- Primary: Uses compiler output AST when available
- Fallback: Regex-based parsing for constants and immutables
- Handles: `constant TYPE NAME = VALUE;` and `TYPE immutable NAME = VALUE;`

### Replacement Format
```json
{
  "target": "name = oldValue",
  "replacement": "name = newValue",
  "endOfTargetMarker": "[^;]*",
  "targetContract": "Setup.sol"
}
```

### File Update Logic
- Uses regex replacement with proper escaping
- Processes replacements in reverse order to maintain indices
- Handles special regex characters correctly

## Testing Checklist

- [ ] Open Dynamic Replacement panel
- [ ] Verify constants are loaded from Setup.sol
- [ ] Edit a constant value
- [ ] Save to recon.json and verify format
- [ ] Update Setup.sol and verify file changes
- [ ] Run a fuzzer and verify replacements are applied
- [ ] Test with missing Setup.sol (should show error)
- [ ] Test with no constants (should show message)

## Known Limitations

1. Constant parsing relies on regex if compiler output unavailable
2. Complex constant expressions might not parse correctly
3. File paths are hardcoded to common Foundry locations
4. No validation of replacement values (user must ensure correctness)

## Future Improvements

1. Add validation for replacement values
2. Support for more complex constant expressions
3. Preview changes before applying
4. Undo/redo functionality
5. Integration with compiler output for better parsing

