# Feature: Dynamic Replacement

## Summary
Implements Dynamic Replacement feature as requested in Issue #21. Allows users to replace constants in Setup.sol before running fuzzing tools.

## Changes

### New Features
- **Dynamic Replacement Panel** - New webview panel accessible via Tools menu
- **Constant Detection** - Automatically parses Setup.sol to find all constants and immutable variables
- **Value Editing** - UI to display current values and edit replacements
- **recon.json Integration** - Saves replacements in runner-compatible format
- **Automatic Application** - Replacements are applied to Setup.sol before running fuzzers

### Implementation Details

#### Files Created
- `src/tools/dynamicReplacementView.ts` - Main view provider (541 lines)
- `src/utils/dynamicReplacement.ts` - Utility function for applying replacements

#### Files Modified
- `src/extension.ts` - Registered new command
- `src/commands/fuzzingCommands.ts` - Added automatic replacement application
- `package.json` - Added command and menu entry

### Format Compliance
Replacements are saved to `recon.json` in the exact format expected by the runner:
```json
{
  "prepareContracts": [
    {
      "target": "name = oldValue",
      "replacement": "name = newValue",
      "endOfTargetMarker": "[^;]*",
      "targetContract": "Setup.sol"
    }
  ]
}
```

## Usage Flow

1. User opens Dynamic Replacement panel (via Tools menu or Command Palette)
2. Panel loads constants from Setup.sol automatically
3. User edits replacement values in the UI
4. User clicks "Save Replacements" → saves to recon.json
5. User clicks "Update Setup.sol" → applies changes to file
6. When user runs a fuzzer → replacements are automatically applied first

## Testing

- ✅ No linter errors
- ✅ All imports resolve correctly
- ✅ Command registered in package.json
- ✅ Menu item added to Tools submenu
- ✅ Format matches runner expectations

## Related Issue
Closes #21

## Screenshots/Demo
- Panel shows all constants from Setup.sol
- Each constant has an editable text field
- Save button updates recon.json
- Update button modifies Setup.sol file
- Fuzzers automatically apply replacements before running

