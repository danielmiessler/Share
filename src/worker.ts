/**
 * Entrypoint. workerd treats every named export of this module as a handler,
 * so it exports nothing but the default; the logic lives in ./share.ts.
 */
import { handleRequest, type Env } from "./share.ts";

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
