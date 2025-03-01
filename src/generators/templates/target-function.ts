import handlebars from 'handlebars';
import { registerHelpers } from '../handlebars-helpers';

registerHelpers(handlebars);

export const targetFunctionTemplate = handlebars.compile(`{{functionDefinition fn}}`, { noEscape: true });