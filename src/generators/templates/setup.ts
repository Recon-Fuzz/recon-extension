import handlebars from 'handlebars';
import { registerHelpers } from '../handlebars-helpers';

registerHelpers(handlebars);

export const setupTemplate = handlebars.compile(`// SPDX-License-Identifier: GPL-2.0
pragma solidity ^0.8.0;

// Chimera deps
import {BaseSetup} from "@chimera/BaseSetup.sol";
import {vm} from "@chimera/Hevm.sol";

// Managers
import {ActorManager} from "./managers/ActorManager.sol";
import {AssetManager} from "./managers/AssetManager.sol";

// Helpers
import {Utils} from "./helpers/Utils.sol";

// Target Contracts
{{#each contracts}}
import "{{this.path}}";
{{/each}}

abstract contract Setup is BaseSetup, ActorManager, AssetManager, Utils {
    {{#each contracts}}
    {{this.name}} {{camel this.name}};
    {{/each}}
    
    /// === Setup === ///
    /// This contains all calls to be performed in the tester constructor, both for Echidna and Foundry
    function setup() internal virtual override {
        {{#each contracts}}
        {{camel this.name}} = new {{this.name}}(); // TODO: Add parameters here
        {{/each}}
    }
}
`, { noEscape: true });