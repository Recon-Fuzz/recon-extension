import handlebars from 'handlebars';
import { registerHelpers } from '../../handlebars-helpers';

registerHelpers(handlebars);

export const doomsdayTargetsTemplate = handlebars.compile(`// SPDX-License-Identifier: GPL-2.0
pragma solidity ^0.8.0;

import {BaseTargetFunctions} from "@chimera/BaseTargetFunctions.sol";
import {BeforeAfter} from "../BeforeAfter.sol";
import {Properties} from "../Properties.sol";
import {vm} from "@chimera/Hevm.sol";

abstract contract DoomsdayTargets is
    BaseTargetFunctions,
    Properties
{
    modifier stateless() {
        _;
        revert("stateless");
    }
}`, { noEscape: true });