import * as vscode from 'vscode';

export class OutputService {
    private mainOutputChannel: vscode.OutputChannel;
    private fuzzerOutputChannels: Map<string, vscode.OutputChannel> = new Map();
    private readonly MAX_CHANNELS = 10; // Limit to prevent memory issues

    constructor(context: vscode.ExtensionContext) {
        this.mainOutputChannel = vscode.window.createOutputChannel('Recon');
        context.subscriptions.push(this.mainOutputChannel);
    }

    public getMainChannel(): vscode.OutputChannel {
        return this.mainOutputChannel;
    }

    public createFuzzerOutputChannel(fuzzerName: string): vscode.OutputChannel {
        // Clean up old channels if we exceed the limit
        if (this.fuzzerOutputChannels.size >= this.MAX_CHANNELS) {
            this.cleanupOldChannels();
        }

        const timestamp = new Date().toLocaleString();
        const channelName = `${fuzzerName} Output [${timestamp}]`;
        const channel = vscode.window.createOutputChannel(channelName);
        this.fuzzerOutputChannels.set(channelName, channel);
        return channel;
    }

    /**
     * Dispose a specific fuzzer output channel
     */
    public disposeFuzzerChannel(channelName: string): void {
        const channel = this.fuzzerOutputChannels.get(channelName);
        if (channel) {
            channel.dispose();
            this.fuzzerOutputChannels.delete(channelName);
        }
    }

    /**
     * Clean up oldest channels when limit is reached
     */
    private cleanupOldChannels(): void {
        const channelsToRemove = this.fuzzerOutputChannels.size - this.MAX_CHANNELS + 1;
        const entries = Array.from(this.fuzzerOutputChannels.entries());
        
        // Remove oldest channels (first entries)
        for (let i = 0; i < channelsToRemove && i < entries.length; i++) {
            const [name, channel] = entries[i];
            channel.dispose();
            this.fuzzerOutputChannels.delete(name);
        }
    }

    /**
     * Dispose all fuzzer output channels
     */
    public disposeAllFuzzerChannels(): void {
        for (const [name, channel] of this.fuzzerOutputChannels.entries()) {
            channel.dispose();
        }
        this.fuzzerOutputChannels.clear();
    }

    /**
     * Dispose all channels (main and fuzzer)
     */
    public dispose(): void {
        this.disposeAllFuzzerChannels();
        this.mainOutputChannel.dispose();
    }
}
