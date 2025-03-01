import handlebars from 'handlebars';
import { registerHelpers } from '../handlebars-helpers';

registerHelpers(handlebars);

export const propertiesTemplate = handlebars.compile(`// SPDX-License-Identifier: GPL-2.0
pragma solidity ^0.8.0;

import {Asserts} from "@chimera/Asserts.sol";
import {BeforeAfter} from "./BeforeAfter.sol";

abstract contract Properties is BeforeAfter, Asserts {
    
}`, { noEscape: true });