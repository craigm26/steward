// Racing silks: every agent gets its own jersey, drawn from its name, so the same agent looks the same everywhere
// (the claims board, the card, the ledger, why-blame). Deterministic: no state, no server.

const COLORS = [
	["navy", "#1F2A5A"],
	["scarlet", "#C8102E"],
	["emerald", "#00704A"],
	["gold", "#F2B705"],
	["purple", "#5B2A86"],
	["white", "#FFFFFF"],
	["black", "#1B1B1B"],
	["sky", "#5FA8D3"],
	["maroon", "#6E1423"],
	["orange", "#E86A10"],
	["pink", "#E66AA0"],
	["grey", "#8E9893"],
];
const PATTERNS = ["hoops", "stripes", "quarters", "chevron", "diamond", "sash", "spots", "star", "crossbelts", "halves", "plain"];

function hash(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

const JERSEY = "M8 3 L10.2 4.6 Q12 5.9 13.8 4.6 L16 3 L22.5 6.2 L20.4 11.4 L18.2 10.4 L18.2 21.5 L5.8 21.5 L5.8 10.4 L3.6 11.4 L1.5 6.2 Z";

function pattern(kind, c) {
	switch (kind) {
		case "hoops":
			return [6, 10, 14, 18].map((y) => `<rect x="0" y="${y}" width="24" height="2" fill="${c}"/>`).join("");
		case "stripes":
			return [7, 11, 15].map((x) => `<rect x="${x}" y="0" width="2" height="24" fill="${c}"/>`).join("");
		case "quarters":
			return `<rect x="0" y="0" width="12" height="12" fill="${c}"/><rect x="12" y="12" width="12" height="12" fill="${c}"/>`;
		case "chevron":
			return `<path d="M0 8 L12 16 L24 8 L24 12 L12 20 L0 12 Z" fill="${c}"/>`;
		case "diamond":
			return `<path d="M12 8 L16 13 L12 18 L8 13 Z" fill="${c}"/>`;
		case "sash":
			return `<path d="M3 4 L7 4 L21 22 L17 22 Z" fill="${c}"/>`;
		case "spots":
			return [[9, 9], [15, 9], [12, 14], [9, 18], [15, 18]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.6" fill="${c}"/>`).join("");
		case "star":
			return `<path d="M12 8.2 L13.4 11.6 L17 11.8 L14.2 14 L15.2 17.6 L12 15.6 L8.8 17.6 L9.8 14 L7 11.8 L10.6 11.6 Z" fill="${c}"/>`;
		case "crossbelts":
			return `<path d="M5 5 L7.5 5 L19 22 L16.5 22 Z M19 5 L16.5 5 L5 22 L7.5 22 Z" fill="${c}"/>`;
		case "halves":
			return `<rect x="12" y="0" width="12" height="24" fill="${c}"/>`;
		default:
			return "";
	}
}

/** The silks for an agent: { svg, base, second, pattern, words }. `size` in CSS pixels. */
export function silks(name, size = 22) {
	const h = hash(String(name).toLowerCase());
	const base = COLORS[h % COLORS.length];
	let second = COLORS[(h >>> 8) % COLORS.length];
	if (second[0] === base[0]) second = COLORS[(COLORS.indexOf(base) + 5) % COLORS.length];
	const kind = PATTERNS[(h >>> 16) % PATTERNS.length];
	const id = `j${h.toString(36)}`;
	const svg = `<svg class="silks" width="${size}" height="${size}" viewBox="0 0 24 24" role="img" aria-label="${name}'s silks: ${base[0]} with ${second[0]} ${kind}"><defs><clipPath id="${id}"><path d="${JERSEY}"/></clipPath></defs><g clip-path="url(#${id})"><rect width="24" height="24" fill="${base[1]}"/>${pattern(kind, second[1])}</g><path d="${JERSEY}" fill="none" stroke="#14211B" stroke-width="0.9" stroke-linejoin="round"/></svg>`;
	return { svg, base: base[1], second: second[1], pattern: kind, words: `${base[0]}, ${second[0]} ${kind}` };
}
