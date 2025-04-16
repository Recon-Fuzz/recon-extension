import * as vscode from 'vscode';
import { ServiceContainer } from '../services/serviceContainer';
import { FuzzerTool } from '../types';

export function registerGenerationCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): void {
    // Register the "Generate Repro" command that will be accessible from the context menu when text is selected
    context.subscriptions.push(
        vscode.commands.registerCommand('recon.generateRepro', async () => {
            // Get the active text editor
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('No active text editor found');
                return;
            }

            // Get the selected text
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            if (!selectedText) {
                vscode.window.showInformationMessage('No text selected');
                return;
            }

            let fuzzer;
            if(selectedText.includes('💥')) {
            // For now, just log the selected text
             fuzzer = FuzzerTool.ECHIDNA;
            }


            
            // Show a notification that the text was captured
            vscode.window.showInformationMessage(`Text selected (${selectedText.length} characters)`);
        })
    );
}