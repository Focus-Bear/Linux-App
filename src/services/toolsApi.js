// The TOOLS API bound to the signed-in user (see toolsApiCore.js).
import { habitApi } from './habitApi.js';
import { createToolsApi } from './toolsApiCore.js';

export const toolsApi = createToolsApi({ request: (...args) => habitApi.request(...args) });
