import handlebars from 'handlebars';
import { registerHelpers } from '../handlebars-helpers';

registerHelpers(handlebars);

export const targetFunctionsTemplate = handlebars.compile(`// SPDX-License-Identifier: GPL-2.0
pragma solidity ^0.8.0;

// Chimera deps
import {vm} from "@chimera/Hevm.sol";

// Helpers
import {Panic} from "@recon/Panic.sol";

// Targets
// NOTE: Always import and apply them in alphabetical order, so much easier to debug!
{{#each contracts}}
import { {{pascal this}}Targets } from "./targets/{{pascal this}}Targets.sol";
{{/each}}

abstract contract TargetFunctions is
    {{#each contracts}}{{pascal this}}Targets{{#unless @last}},
    {{/unless}}{{/each}}
{
    /// CUSTOM TARGET FUNCTIONS - Add your own target functions here ///


    /// AUTO GENERATED TARGET FUNCTIONS - WARNING: DO NOT DELETE OR MODIFY THIS LINE ///
{{#each functions}}
{{functionDefinition this}}
{{/each}}
}
`, { noEscape: true });