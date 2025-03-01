import handlebars from 'handlebars';
import { registerHelpers } from '../../handlebars-helpers';

registerHelpers(handlebars);

export const adminTargetsTemplate = handlebars.compile(`// SPDX-License-Identifier: GPL-2.0
pragma solidity ^0.8.0;

import {BaseTargetFunctions} from "@chimera/BaseTargetFunctions.sol";
import {BeforeAfter} from "../BeforeAfter.sol";
import {Properties} from "../Properties.sol";
import {vm} from "@chimera/Hevm.sol";

abstract contract AdminTargets is
    BaseTargetFunctions,
    Properties
{
    /// CUSTOM TARGET FUNCTIONS - Add your own target functions here ///


    /// AUTO GENERATED TARGET FUNCTIONS - WARNING: DO NOT DELETE OR MODIFY THIS LINE ///
{{#each functions}}
{{functionDefinition this}}
{{/each}}
}`, { noEscape: true });