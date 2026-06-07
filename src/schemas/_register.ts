// Extends Zod with `.openapi(...)` via the zod-to-openapi plugin and
// re-exports the extended `z`. Schema files import `z` from THIS file
// (not from `zod` directly) so the bundler can't tree-shake the
// extension call as a side-effect-only import — the schemas literally
// use the value we export, which keeps the module body alive.
//
// extendZodWithOpenApi is idempotent (its internal flag is set on the
// Zod prototype), so repeat imports are free.

import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export { z };
