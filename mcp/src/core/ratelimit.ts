/**
 * The Rate Limiting bindings (approximate, per location; DESIGN 14): RL_PAGES per IP, RL_AUTHZ per IP
 * on /authorize, RL_REGISTER per IP (these three count an IPv6 caller by its /64), RL_TOKEN per IP
 * and client_id, RL_MCP per person, RL_IP per IP before any token check (/mcp and /oauth/token).
 * The exact per-person limits live in the Vault; the exact daily caps on new sign-ins and
 * registrations live in the Quota object.
 * A binding error fails open, because the Vault's exact limits and the Quota caps still apply.
 */
export async function allowRate(binding: RateLimit | undefined, key: string): Promise<boolean> {
	if (!binding) return true;
	try {
		const { success } = await binding.limit({ key: key.slice(0, 128) });
		return success;
	} catch {
		return true;
	}
}
