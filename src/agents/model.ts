// One chat call to a Workers AI model, with what each family needs to answer rather than think forever, and the
// usage it reports (an agent's token budget counts it).

export interface Chat {
	text: string;
	tokens: number;
	finish: string | null;
	ms: number;
}

type Message = { role: "system" | "user" | "assistant"; content: string };

/** Reasoning models spend the whole budget thinking unless told not to. */
export function quietOptions(model: string): Record<string, unknown> {
	if (/glm/i.test(model)) return { reasoning_effort: "low" };
	if (/kimi/i.test(model)) return {};
	return { chat_template_kwargs: { enable_thinking: false } };
}

function textOf(result: unknown): { text: string; finish: string | null; tokens: number } {
	const r = result as Record<string, any>;
	const usage = r?.usage ?? {};
	const tokens = Number(usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)) || 0;
	if (typeof r?.response === "string") return { text: r.response, finish: null, tokens };
	if (Array.isArray(r?.choices)) {
		const c = r.choices[0] ?? {};
		return { text: String(c.message?.content ?? c.text ?? ""), finish: c.finish_reason ?? null, tokens };
	}
	if (Array.isArray(r?.output)) {
		for (const item of r.output) for (const c of item?.content ?? []) if (typeof c?.text === "string") return { text: c.text, finish: null, tokens };
	}
	return { text: typeof result === "string" ? result : "", finish: null, tokens };
}

export async function chat(ai: Ai, model: string, messages: Message[], maxTokens: number, temperature = 0.3): Promise<Chat> {
	const t0 = Date.now();
	const first = textOf(await ai.run(model as keyof AiModels, { messages, max_tokens: maxTokens, temperature, ...quietOptions(model) } as never));
	if (first.text.trim() || first.finish !== "length") return { ...first, ms: Date.now() - t0 };
	// A model that still spent its budget on reasoning gets one more try with far more room.
	const second = textOf(await ai.run(model as keyof AiModels, { messages, max_tokens: maxTokens * 4, temperature, ...quietOptions(model) } as never));
	return { text: second.text, finish: second.finish, tokens: first.tokens + second.tokens, ms: Date.now() - t0 };
}
