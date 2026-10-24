import { type Env, handle } from "./relay";

export default {
	fetch: (request, env) => handle(request, env),
} satisfies ExportedHandler<Env>;
