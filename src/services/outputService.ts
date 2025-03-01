import * as vscode from 'vscode';

export class OutputService {
    private mainOutputChannel: vscode.OutputChannel;
    private fuzzerOutputChannels: Map<string, vscode.OutputChannel> = new Map();

    constructor(context: vscode.ExtensionContext) {
        this.mainOutputChannel = vscode.window.createOutputChannel('Recon');
        context.subscriptions.push(this.mainOutputChannel);
    }

    public getMainChannel(): vscode.OutputChannel {
        return this.mainOutputChannel;
    }

    public createFuzzerOutputChannel(fuzzerName: string): vscode.OutputChannel {
        const timestamp = new Date().toLocaleString();
        const channelName = `${fuzzerName} Output [${timestamp}]`;
        const channel = vscode.window.createOutputChannel(channelName);
        this.fuzzerOutputChannels.set(channelName, channel);
        return channel;
    }
}
