import { type Env, handle } from "./handler";

export default {
	fetch: (request, env) => handle(request, env),
} satisfies ExportedHandler<Env>;
