import handlebars from 'handlebars';
import { registerHelpers } from '../handlebars-helpers';
import * as vscode from 'vscode';

registerHelpers(handlebars);

// Get symExec setting at module load time (defaults to true)
const symExecEnabled = vscode.workspace
    .getConfiguration('recon')
    .get<boolean>('echidna.symExec', true);

export const echidnaConfigTemplate = handlebars.compile(`testMode: "assertion"
prefix: "echidna_"
coverage: true
corpusDir: "echidna"
balanceAddr: 0x1043561a8829300000
balanceContract: 0x1043561a8829300000
filterFunctions: []
cryticArgs: ["--foundry-compile-all"]
deployer: "0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38"
contractAddr: "0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496"
shrinkLimit: 100000
symExec: ${symExecEnabled}`, { noEscape: true });
