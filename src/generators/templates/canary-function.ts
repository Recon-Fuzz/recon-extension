import handlebars from 'handlebars';
import { registerHelpers } from '../handlebars-helpers';

registerHelpers(handlebars);

export const canaryFunctionTemplate = handlebars.compile(`{{canaryFunctionDefinition fn}}`, { noEscape: true });