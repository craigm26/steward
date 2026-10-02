// Reading a model agent's reply. Pure, so tests import it without the Workers runtime.

/** `=== FILE: path === ... === END ===` blocks and the SUMMARY line, from a model's reply. */
export function parseReply(text: string): { files: { path: string; content: string }[]; summary: string } {
	const files: { path: string; content: string }[] = [];
	// A block runs from its FILE line to its END line, or (when a model forgets END) to the next FILE line, the
	// SUMMARY line, or the end of the reply.
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let path: string | null = null;
	let body: string[] = [];
	const close = () => {
		if (path === null) return;
		let content = body.join("\n");
		const fence = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i.exec(content);
		if (fence) content = fence[1]!;
		content = content.replace(/^\n+/, "");
		if (content.trim()) files.push({ path: path.replace(/^\/+/, "").replace(/^[`'"]+|[`'"]+$/g, ""), content: content.endsWith("\n") ? content : content + "\n" });
		path = null;
		body = [];
	};
	for (const line of lines) {
		const start = /^\s*={3,}\s*FILE:?\s*(.+?)\s*={3,}\s*$/i.exec(line);
		if (start) {
			close();
			path = start[1]!;
			continue;
		}
		if (/^\s*={3,}\s*END\b.*={0,}\s*$/i.test(line)) {
			close();
			continue;
		}
		if (/^\s*SUMMARY:/i.test(line)) {
			close();
			continue;
		}
		if (path !== null) body.push(line);
	}
	close();
	const summary = /^\s*SUMMARY:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "";
	return { files, summary };
}
