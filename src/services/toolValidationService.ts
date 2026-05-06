import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { checkCommandExists } from '../utils';

export interface ValidationResult {
    isValid: boolean;
    error?: string;
    command: string;
}

export class ToolValidationService {

    public async validateFuzzer(fuzzerType: 'echidna' | 'medusa'): Promise<ValidationResult> {
        const config = vscode.workspace.getConfiguration('recon');
        const customPath = config.get<string>(`${fuzzerType}.path`, '');

        let command: string;
        let isValid: boolean;

        // If custom path is set, check if it exists
        if (customPath) {
            try {
                await fs.access(customPath);
                command = customPath;
                isValid = true;
            } catch {
                return {
                    isValid: false,
                    command: customPath,
                    error: `Custom ${fuzzerType} path not found: ${customPath}\n\nPlease check your settings or remove the custom path to use the system PATH.`
                };
            }
        } else {
            // Check if command exists in PATH
            command = fuzzerType;
            isValid = await checkCommandExists(fuzzerType);

            if (!isValid) {
                return {
                    isValid: false,
                    command: fuzzerType,
                    error: this.getInstallationWarning(fuzzerType)
                };
            }
        }

        return {
            isValid: true,
            command
        };
    }

    /**
     * Gets installation warning message with guidance
     */
    private getInstallationWarning(fuzzerType: 'echidna' | 'medusa'): string {
        const toolName = fuzzerType.charAt(0).toUpperCase() + fuzzerType.slice(1);
        const installGuides: Record<string, string> = {
            echidna: 'https://github.com/crytic/echidna',
            medusa: 'https://github.com/crytic/medusa'
        };

        return `${toolName} not found. Install it or set a custom path in settings.\n\n${installGuides[fuzzerType]}`;
    }
}
