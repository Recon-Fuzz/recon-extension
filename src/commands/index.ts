import * as vscode from 'vscode';
import { registerFuzzingCommands } from './fuzzingCommands';
import { registerBuildCommands } from './buildCommands';
import { registerTemplateCommands } from './templateCommands';
import { registerCoverageCommands } from './coverageCommands';
import { registerMockCommands } from './mockCommands';
import { registerTestCommands } from './testCommands';
import { registerLibraryCommands } from './libraryCommands';
import { registerWorkerCommands } from './workerCommands';
import { ServiceContainer } from '../services/serviceContainer';


export async function registerCommands(
    context: vscode.ExtensionContext,
    services: ServiceContainer
): Promise<void> {
    // Register each command group
    registerFuzzingCommands(context, services);
    registerBuildCommands(context, services);
    registerTemplateCommands(context, services);
    registerCoverageCommands(context, services);
    registerMockCommands(context, services);
    registerTestCommands(context, services);
    registerLibraryCommands(context, services);
    registerWorkerCommands(context, services);
}
