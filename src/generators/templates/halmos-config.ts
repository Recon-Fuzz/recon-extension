import handlebars from 'handlebars';
import { registerHelpers } from '../handlebars-helpers';

registerHelpers(handlebars);

export const halmosConfigTemplate = handlebars.compile(`[global]
# match tests with the invariant_ prefix
function = "(check|invariant)_"

contract = "CryticToFoundry"`, { noEscape: true });