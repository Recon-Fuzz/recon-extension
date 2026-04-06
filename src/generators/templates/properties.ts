import handlebars from 'handlebars';
import { registerHelpers } from '../handlebars-helpers';

registerHelpers(handlebars);

export const propertiesTemplate = handlebars.compile(`// SPDX-License-Identifier: GPL-2.0
pragma solidity ^0.8.0;

import {Asserts} from "@chimera/Asserts.sol";
import {BeforeAfter} from "./BeforeAfter.sol";

// Your deps
{{#each contracts}}
import "{{this.path}}";
{{/each}}

abstract contract Properties is BeforeAfter, Asserts {

    /// CUSTOM PROPERTIES - Add your own properties functions here ///


    /// AUTO GENERATED CANARIES FUNCTIONS - WARNING: DO NOT DELETE OR MODIFY THIS LINE ///
{{#each canaryFunctions}}
{{canaryFunctionDefinition this}}
{{/each}}

}`, { noEscape: true });