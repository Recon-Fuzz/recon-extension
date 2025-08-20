import * as vscode from 'vscode';

export class StatusBarService {
    private echidnaStatusBarItem: vscode.StatusBarItem;
    private medusaStatusBarItem: vscode.StatusBarItem;
    private halmosStatusBarItem: vscode.StatusBarItem;

    constructor(context: vscode.ExtensionContext) {
        // Create Echidna status bar item
        this.echidnaStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
        this.echidnaStatusBarItem.text = "$(beaker) Run Echidna";
        this.echidnaStatusBarItem.tooltip = "Run Echidna Fuzzer";
        this.echidnaStatusBarItem.command = 'recon.runEchidna';
        this.echidnaStatusBarItem.color = new vscode.ThemeColor('charts.purple');
        this.echidnaStatusBarItem.show();

        // Create Medusa status bar item
        this.medusaStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 19);
        this.medusaStatusBarItem.text = "$(microscope) Run Medusa";
        this.medusaStatusBarItem.tooltip = "Run Medusa Fuzzer";
        this.medusaStatusBarItem.command = 'recon.runMedusa';
        this.medusaStatusBarItem.color = new vscode.ThemeColor('charts.purple');
        this.medusaStatusBarItem.show();

        this.halmosStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 18);
        this.halmosStatusBarItem.text = "$(microscope) Run Halmos";
        this.halmosStatusBarItem.tooltip = "Run Halmos Fuzzer";
        this.halmosStatusBarItem.command = 'recon.runHalmos';
        this.halmosStatusBarItem.color = new vscode.ThemeColor('charts.purple');
        this.halmosStatusBarItem.show();

        // Add to disposables
        context.subscriptions.push(this.echidnaStatusBarItem, this.medusaStatusBarItem, this.halmosStatusBarItem);
    }
}
