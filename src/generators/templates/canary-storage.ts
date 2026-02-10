import handlebars from 'handlebars';
import { registerHelpers } from '../handlebars-helpers';

registerHelpers(handlebars);

export const canaryStorageTemplate = handlebars.compile(`// SPDX-License-Identifier: GPL-2.0
pragma solidity ^0.8.0;

abstract contract CanaryStorage {

    /// AUTO GENERATED CANARIES - WARNING: DO NOT DELETE OR MODIFY THIS LINE ///
{{#each canaryVariables}}
    bool {{this}} = false;
{{/each}}

}`, { noEscape: true });
