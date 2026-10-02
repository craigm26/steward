// Steward's board. No framework: the server's board snapshot plus a live event stream, drawn into five views.
// Everything an agent or a model wrote is set as text, never as HTML.
import { silks } from "./silks.js";

// ------------------------------------------------------------------ helpers
function h(tag, props, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props ?? {})) {
		if (v == null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
		else if (k === "svg") el.innerHTML = v; // only ever the silks SVG, built here from a name
		else el.setAttribute(k, v === true ? "" : String(v));
	}
	for (const kid of kids.flat(Infinity)) {
		if (kid == null || kid === false) continue;
		el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
	}
	return el;
}
const $ = (s, r = document) => r.querySelector(s);
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const day = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
const short = (sha) => (sha ? String(sha).slice(0, 7) : "");
const agentOf = (candidateId) => String(candidateId ?? "").split("/")[1] ?? candidateId;

function jersey(name, size = 22) {
	return h("span", { svg: silks(name, size).svg, style: `display:inline-flex` });
}
function agentTag(name, kind, size = 22) {
	return h("span", { class: "agent" }, jersey(name, size), name, kind && kind !== "agent" ? h("span", { class: "kind" }, kind) : null);
}
const stewardName = (key) => state.paths?.project?.stewards?.find((s) => s.key === key)?.name ?? key;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const RANK = { merged: 0, passed: 1, checking: 2, working: 3, claimed: 4, lost: 5, bounced: 6, "over-budget": 7, withdrawn: 8 };
/** Text with `backtick` spans shown as code; every piece still goes in as text. */
function prose(text) {
	return String(text ?? "").split("`").map((part, i) => (i % 2 ? h("code", null, part) : part));
}
function toast(text, bad = false) {
	const t = h("div", { class: `toast${bad ? " bad" : ""}`, role: "status" }, text);
	document.body.append(t);
	setTimeout(() => t.remove(), 4200);
}

// ------------------------------------------------------------------ server
const KEY = "steward.key";
const key = () => localStorage.getItem(KEY) ?? "";
async function api(path, body) {
	const res = await fetch(path, {
		method: body === undefined ? "GET" : "POST",
		headers: { ...(key() ? { authorization: `Bearer ${key()}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let out;
	try {
		out = JSON.parse(text);
	} catch {
		out = text;
	}
	if (!res.ok) throw Object.assign(new Error(out?.error ?? `${res.status}`), { code: out?.code, status: res.status });
	return out;
}

// ------------------------------------------------------------------ state
const state = { board: null, paths: null, who: { kind: "public" }, live: false, selected: null, seenSeq: 0 };

async function refreshBoard() {
	state.board = await api("/api/board");
	const seq = Math.max(0, ...state.board.events.map((e) => e.seq));
	state.seenSeq = Math.max(state.seenSeq, seq);
}
async function refreshPaths() {
	state.paths = await api("/api/paths");
}

let redraw = null;
let pending = null;
function soon() {
	clearTimeout(pending);
	pending = setTimeout(async () => {
		try {
			await refreshBoard();
			if (redraw) redraw();
		} catch (e) {
			console.error(e);
		}
	}, 350);
}

function connect() {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	const ws = new WebSocket(`${proto}://${location.host}/api/board/ws`);
	ws.onopen = () => {
		state.live = true;
		drawWho();
	};
	ws.onclose = () => {
		state.live = false;
		drawWho();
		setTimeout(connect, 2500);
	};
	ws.onmessage = (m) => {
		const msg = JSON.parse(m.data);
		if (msg.type === "event") {
			freshSeqs.add(msg.event.seq);
			if (msg.event.kind === "check") refreshPaths().catch(() => {});
			soon();
		}
	};
	setInterval(() => ws.readyState === 1 && ws.send("ping"), 30000);
}
const freshSeqs = new Set();

// ------------------------------------------------------------------ header
function drawProject() {
	const p = state.paths?.project;
	const el = $("#project");
	el.replaceChildren(p ? h("span", null, h("b", null, p.title), "  ", h("span", { class: "faint" }, p.app)) : "");
}
function drawWho() {
	const el = $("#who");
	const steward = state.paths?.project?.stewards?.[0];
	const live = h("span", { class: `live${state.live ? " on" : ""}`, title: state.live ? "Live" : "Reconnecting" });
	if (state.who.kind === "admin") {
		el.replaceChildren(live, h("span", null, `${steward?.name ?? "Steward"}, steward`), h("button", { onclick: () => { localStorage.removeItem(KEY); state.who = { kind: "public" }; drawWho(); route(); } }, "Sign out"));
	} else {
		el.replaceChildren(live, h("span", null, "Watching"), h("button", { onclick: signIn }, "Sign in as steward"));
	}
}
function signIn() {
	const existing = $(".pop");
	if (existing) return existing.remove();
	const input = h("input", { type: "password", placeholder: "Steward key", autocomplete: "off", "aria-label": "Steward key" });
	const go = async () => {
		localStorage.setItem(KEY, input.value.trim());
		try {
			state.who = await api("/api/whoami");
		} catch {
			state.who = { kind: "public" };
		}
		if (state.who.kind !== "admin") {
			localStorage.removeItem(KEY);
			toast("That key is not a steward key.", true);
			return;
		}
		pop.remove();
		drawWho();
		route();
	};
	input.addEventListener("keydown", (e) => e.key === "Enter" && go());
	const pop = h("div", { class: "pop" }, h("h3", null, "Sign in as steward"), h("p", { class: "small muted" }, "The key stays in this browser."), input, h("div", { class: "row" }, h("button", { class: "primary", onclick: go }, "Sign in"), h("button", { class: "quiet", onclick: () => pop.remove() }, "Cancel")));
	document.body.append(pop);
	input.focus();
}

// ------------------------------------------------------------------ board view
const STATUS_WORDS = { claimed: "Claimed", working: "Working", checking: "Checking", passed: "Passed gate 1", bounced: "Bounced", "over-budget": "Over budget", withdrawn: "Withdrew", merged: "Shipped", lost: "Not chosen" };

function taskState(t, b) {
	const cands = b.candidates.filter((c) => c.task === t.id);
	const decs = b.decisions.filter((d) => d.task === t.id);
	if (t.status === "merged") return "Shipped";
	if (decs.some((d) => d.status === "ready")) return "Waiting for the steward";
	if (decs.some((d) => d.status === "judging")) return "The judge is looking";
	if (!cands.length) return "Waiting for agents";
	return `${cands.length} agent${cands.length > 1 ? "s" : ""} racing`;
}

function checksList(checks) {
	return h(
		"ul",
		{ class: "checklist" },
		checks.map((c) => h("li", { class: c.ok ? "ok" : "no" }, h("span", { class: "mk", "aria-label": c.ok ? "passes" : "fails" }, c.ok ? "✓" : "✕"), h("span", null, c.name), !c.ok && c.detail ? h("span", { class: "why" }, c.detail) : null)),
	);
}

function viewBoard() {
	const b = state.board;
	const tasks = b.tasks;
	const sel = tasks.find((t) => t.id === state.selected) ?? tasks.find((t) => t.status === "open") ?? tasks[0];
	if (sel) state.selected = sel.id;

	const rail = h(
		"aside",
		{ class: "rail" },
		h(
			"section",
			null,
			h("div", { class: "railhead" }, h("h3", null, "Tasks"), state.who.kind === "admin" ? h("button", { class: "quiet small", onclick: () => openTaskForm() }, "Open a task") : null),
			tasks.length
				? h(
						"nav",
						{ class: "tasks", "aria-label": "Tasks" },
						tasks.map((t) =>
							h("a", { href: `#/board/${t.id}`, "aria-current": t.id === sel?.id ? "true" : "false" }, h("span", { class: "tid" }, t.id), h("span", { class: "ttitle" }, t.title), h("span", { class: "tstate" }, taskState(t, b))),
						),
					)
				: h("p", { class: "small muted" }, "No tasks yet."),
		),
		state.paths
			? h(
					"section",
					null,
					h("div", { class: "railhead" }, h("h3", null, "Paths"), h("a", { href: "#/paths", class: "small" }, "The check")),
					state.paths.paths.map((p) => h("div", { class: "pathline" }, h("span", null, p.title), p.auto_merge.on ? h("span", { class: "on" }, "Auto-merge on") : h("span", { class: "off" }, "Steward decides"))),
				)
			: null,
	);

	const feed = h(
		"aside",
		{ class: "feed", "aria-label": "What just happened" },
		h("h3", null, "As it happens"),
		h(
			"ol",
			null,
			[...b.events].reverse().slice(0, 60).map((e) => h("li", { class: `${e.kind}${freshSeqs.has(e.seq) ? " fresh" : ""}` }, h("time", { datetime: e.at }, time(e.at)), h("span", null, e.text))),
		),
	);
	freshSeqs.clear();

	const onPath = sel ? b.candidates.filter((c) => b.tasks.find((t) => t.id === c.task)?.path === sel.path) : [];
	return h("div", { class: "board" }, rail, h("section", null, onPath.length > 12 ? totals(b, sel.path) : null, sel ? taskSheet(sel, b) : emptyBoard()), feed);
}

/** One path of the board in numbers, shown once many agents race on it. */
function totals(board, path) {
	const tasks = board.tasks.filter((t) => t.path === path);
	const ids = new Set(tasks.map((t) => t.id));
	const b = { tasks, candidates: board.candidates.filter((c) => ids.has(c.task)), decisions: board.decisions.filter((d) => ids.has(d.task)) };
	const title = state.paths?.paths.find((p) => p.path === path)?.title ?? path;
	const n = (f) => b.candidates.filter(f).length;
	const ledgerish = b.decisions.filter((d) => d.status === "merged");
	const alone = ledgerish.filter((d) => d.verdict?.kind === "agent" || d.judge?.route?.auto).length;
	const cells = [
		[String(new Set(b.candidates.map((c) => c.agent)).size), "agents"],
		[String(b.tasks.length), "tasks"],
		[String(n((c) => ["passed", "merged", "lost"].includes(c.status))), "passed gate 1"],
		[String(n((c) => c.status === "bounced")), "bounced"],
		[String(n((c) => ["claimed", "working", "checking"].includes(c.status))), "still working"],
		[String(alone), "merged by the judge alone"],
		[String(ledgerish.length - alone), "decided by the steward"],
		[String(b.decisions.filter((d) => d.status === "ready").length), "waiting for the steward"],
	];
	return h("div", { class: "sheet totals", style: "margin-bottom:16px" }, h("p", { class: "small muted", style: "margin-bottom:8px" }, `On the ${title} path`), h("div", { class: "figures" }, cells.map(([v, l]) => h("div", { class: "fig" }, h("b", null, v), h("span", null, l)))));
}

function emptyBoard() {
	return h(
		"div",
		{ class: "empty" },
		h("h2", null, "Nothing is racing yet"),
		h("p", null, "Open a task and agents can claim it. Each gets its own fork; every push is checked; you decide what ships."),
		state.who.kind === "admin" ? h("button", { class: "primary", onclick: () => openTaskForm() }, "Open a task") : h("p", { class: "small muted" }, "Sign in as steward to open one."),
	);
}

function taskSheet(t, b) {
	const cands = b.candidates.filter((c) => c.task === t.id).sort((a, z) => (RANK[a.status] ?? 9) - (RANK[z.status] ?? 9) || a.agent.localeCompare(z.agent));
	const claims = b.claims.filter((c) => c.task === t.id);
	const decs = b.decisions.filter((d) => d.task === t.id);
	const kinds = Object.fromEntries((b.agents ?? []).map((a) => [a.name, a.kind]));
	const fileCount = {};
	for (const c of claims) for (const f of c.files) fileCount[f] = (fileCount[f] ?? 0) + 1;
	const files = Object.keys(fileCount).sort((a, z) => fileCount[z] - fileCount[a] || a.localeCompare(z));
	const pathTitle = state.paths?.paths.find((p) => p.path === t.path)?.title ?? t.path;

	const table = cands.length
		? h(
				"table",
				{ class: "claims" },
				h("caption", { class: "small muted", style: "text-align:left;caption-side:top;padding-bottom:6px" }, "Each row is an agent in its own fork. A filled cell is a file it claimed; a striped cell is a file another agent claimed too, so they are rivals in one decision."),
				h(
					"thead",
					null,
					h("tr", null, h("th", null, "Agent"), files.map((f) => h("th", { class: `file${fileCount[f] > 1 ? " contested" : ""}`, title: f }, f.split("/").pop())), h("th", null, "Gate 1")),
				),
				h(
					"tbody",
					null,
					cands.map((c) => {
						const claim = claims.find((k) => k.agent === c.agent);
						const passed = c.checks.filter((k) => k.ok).length;
						return h(
							"tr",
							null,
							h("td", null, agentTag(c.agent, kinds[c.agent], 30), c.commit ? h("div", { class: "small faint", style: "padding-left:38px" }, h("code", null, short(c.commit))) : null),
							files.map((f) => h("td", { class: "cell" }, claim?.files.includes(f) ? h("span", { class: `claim${fileCount[f] > 1 ? " contested" : ""}`, title: `${c.agent} claimed ${f}` }) : null)),
							h(
								"td",
								null,
								h("span", { class: `state ${c.status}` }, STATUS_WORDS[c.status] ?? c.status),
								c.checks.length ? h("span", { class: "score" }, `  ${passed}/${c.checks.length}`) : null,
								c.note ? h("div", { class: `note${c.status === "bounced" || c.status === "over-budget" ? " bad" : ""}` }, c.note) : null,
								c.checks.length ? h("details", { class: "checks" }, h("summary", null, "Checks"), checksList(c.checks)) : null,
								c.preview_url && c.checks.some((k) => /Preview builds/.test(k.name) && k.ok) ? h("div", { class: "small" }, h("a", { href: c.preview_url, target: "_blank", rel: "noopener" }, "Open its Preview")) : null,
							),
						);
					}),
				),
			)
		: h("div", { class: "empty" }, h("p", null, "No agent has claimed this task yet. Agents see it in their task list and claim the files they will touch.")) ;

	return h(
		"div",
		{ class: "sheet" },
		h(
			"div",
			{ class: "taskhead" },
			h("span", { class: "kicker" }, `Task ${t.id}`),
			h("h1", null, t.title),
			h("p", { class: "muted" }, t.description),
			h("p", { class: "small faint" }, `On the ${pathTitle} path. Opened ${day(t.created_at)} at ${time(t.created_at)}.`),
			t.done?.length ? h("details", { class: "checks" }, h("summary", null, `This task's checks (${t.done.length}), on top of the path's`), checksList(t.done.map((d) => ({ name: d.name, ok: true })))) : null,
		),
		h("div", { class: "tablewrap" }, table),
		state.who.kind === "admin" && t.status === "open"
			? h("div", { class: "row", style: "margin-top:14px" }, h("button", { class: cands.length ? "quiet" : "primary", onclick: (e) => startRace(t.id, e.target) }, "Start the model agents"), h("span", { class: "small muted" }, "Six agents, each on its own Workers AI model, claim this task and race in their own forks."))
			: null,
		decs.length
			? h(
					"div",
					{ class: "decisions" },
					decs.map((d) => {
						const j = d.judge;
						const text =
							d.status === "merged"
								? `Shipped ${agentOf(d.verdict?.pick ?? j?.pick)}'s change as ${short(d.merged_commit)}`
								: d.status === "ready"
									? `The judge proposes ${agentOf(j?.pick)}'s change. Waiting for the steward.`
									: d.status === "judging"
										? "The judge and the referee are looking."
										: d.status === "merging"
											? "Merging into main."
											: d.status === "closed"
												? "Closed with nothing shipped."
												: `${d.candidates.length} rival${d.candidates.length > 1 ? "s" : ""}; waiting for every candidate to finish gate 1.`;
						return h(
							"div",
							{ class: `decisionrow ${d.status}` },
							h("div", { class: "row" }, d.candidates.map((c) => jersey(agentOf(c), 20))),
							h("div", { class: "grow" }, h("b", null, `Decision ${d.id}`), " ", h("span", { class: "muted" }, text)),
							d.status === "open" && state.who.kind === "admin" && cands.some((c) => c.status === "passed")
								? h("button", { class: "quiet", onclick: () => decideNow(d.id) }, "Decide now")
								: null,
							["ready", "merging", "merged", "judging"].includes(d.status) ? h("a", { href: `#/decision/${d.id}` }, d.status === "ready" ? "Open the card" : "See the card") : null,
						);
					}),
				)
			: null,
	);
}

async function startRace(task, button) {
	button.disabled = true;
	try {
		const r = await api("/api/admin/race", { task });
		toast(`${r.lineup.length} agents are on their way: ${r.lineup.map((a) => a.agent).join(", ")}.`);
	} catch (e) {
		toast(e.message, true);
		button.disabled = false;
	}
}

async function decideNow(id) {
	try {
		const r = await api(`/api/decisions/${id}/decide-now`, {});
		toast(r.result === "started" ? "The judge is looking at whoever passed." : "Nobody has passed gate 1 yet.");
	} catch (e) {
		toast(e.message, true);
	}
}

function openTaskForm() {
	const paths = state.paths?.paths ?? [];
	const title = h("input", { placeholder: "What should change", "aria-label": "Title" });
	const desc = h("textarea", { placeholder: "What done looks like, in plain words", "aria-label": "Description" });
	const path = h("select", { "aria-label": "Path" }, paths.map((p) => h("option", { value: p.path }, p.title)));
	const pop = h(
		"div",
		{ class: "pop", style: "top:110px;left:22px;right:auto;width:420px" },
		h("h3", null, "Open a task"),
		title,
		desc,
		path,
		h(
			"div",
			{ class: "row" },
			h("button", { class: "primary", onclick: async () => { try { const t = await api("/api/tasks", { title: title.value, description: desc.value, path: path.value }); pop.remove(); state.selected = t.id; location.hash = `#/board/${t.id}`; toast(`Task ${t.id} is open. Agents can claim it now.`); } catch (e) { toast(e.message, true); } } }, "Open the task"),
			h("button", { class: "quiet", onclick: () => pop.remove() }, "Cancel"),
		),
		h("p", { class: "small muted" }, "Or open one of the demo tasks, with its checks:"),
		h(
			"div",
			{ class: "row" },
			[["bank", "Bank details changed"], ["terms", "Unusual payment terms"]].map(([name, label]) =>
				h("button", { class: "quiet", onclick: async () => { try { const t = await api("/api/admin/demo-task", { name }); pop.remove(); state.selected = t.id; location.hash = `#/board/${t.id}`; toast(`Task ${t.id} is open.`); } catch (e) { toast(e.message, true); } } }, label),
			),
		),
	);
	document.body.append(pop);
	title.focus();
}

// ------------------------------------------------------------------ the card
function patchView(patch) {
	return h(
		"pre",
		{ class: "patch" },
		String(patch ?? "")
			.split("\n")
			.map((l) => h("span", { class: l.startsWith("+") && !l.startsWith("+++") ? "a" : l.startsWith("-") && !l.startsWith("---") ? "d" : l.startsWith("@@") ? "h" : "" }, l + "\n")),
	);
}

async function viewDecision(id) {
	const data = await api(`/api/decisions/${id}`);
	const d = data.decision;
	const rec = data.record;
	const j = d?.judge ?? rec?.judge;
	const referee = d?.referee ?? rec?.referee ?? [];
	const verdict = d?.verdict ?? (rec?.steward ? { ...rec.steward, by_name: rec.steward.by } : rec?.auto ? { kind: "agent", verdict: "auto", pick: j?.pick, grant: rec.auto.grant } : null);
	const candidates = data.candidates?.length ? data.candidates : (rec?.state?.candidates ?? []).map((c) => ({ id: c.id, agent: c.agent, commit: c.commit, status: c.gate1.passed ? "passed" : "bounced", checks: c.gate1.checks, diff: c.diff, tests_added: c.testsAdded, summary: c.summary, preview_url: c.previewUrl }));
	const ready = d?.status === "ready";
	const shipped = d?.status === "merged" || !!rec?.merge;
	const chosen = verdict?.pick;
	const canDecide = ready && state.who.kind === "admin";
	const passedOf = (c) => ["passed", "merged", "lost"].includes(c.status);
	const order = [...candidates].sort((a, z) => (z.id === chosen) - (a.id === chosen) || (z.id === j?.pick) - (a.id === j?.pick) || passedOf(z) - passedOf(a) || a.agent.localeCompare(z.agent));

	const lanes = order.map((c) => {
		const out = !["passed", "merged", "lost"].includes(c.status);
		const obj = referee.find((o) => o.candidate === c.id);
		const isPick = c.id === j?.pick;
		const isChosen = shipped && c.id === chosen;
		const reason = h("textarea", { placeholder: "Why this one, and not the judge's pick?", "aria-label": `Reason for shipping ${c.agent}'s change` });
		const shipBox = canDecide && !out
			? isPick
				? h("div", { class: "ship" }, h("button", { class: "primary", onclick: () => decide(id, c.id) }, `Ship ${c.agent}'s change`))
				: h(
						"details",
						{ class: "ship" },
						h("summary", { class: "small" }, "Ship this one instead"),
						h("div", { class: "reason" }, reason, h("button", { onclick: () => decide(id, c.id, reason.value) }, `Ship ${c.agent}'s change, with this reason`)),
					)
			: null;
		return h(
			"article",
			{ class: `lane${isPick ? " pick" : ""}${isChosen ? " chosen" : ""}${out ? " out" : ""}` },
			h("div", { class: "lanehead" }, agentTag(c.agent, null, 34), isChosen ? h("span", { class: "tag steward" }, "Shipped") : isPick ? h("span", { class: "tag judge" }, "Judge's pick") : out ? h("span", { class: "tag out" }, STATUS_WORDS[c.status] ?? c.status) : null),
			h(
				"div",
				{ class: "frame" },
				c.preview_url && !out && c.checks?.some((k) => /Preview builds/.test(k.name) && k.ok) ? [h("iframe", { src: c.preview_url, title: `${c.agent}'s Preview`, loading: "lazy", sandbox: "allow-same-origin" }), h("a", { class: "open", href: c.preview_url, target: "_blank", rel: "noopener" }, "Open the Preview")] : h("div", { class: "none" }, out ? "Bounced at gate 1: nobody needs to look at it." : "This path's checks read files, so no Preview was built."),
			),
			h(
				"div",
				{ class: "figures" },
				h("div", { class: "fig" }, h("b", null, `${c.checks?.filter((k) => k.ok).length ?? 0}/${c.checks?.length ?? 0}`), h("span", null, "checks pass")),
				c.diff ? h("div", { class: "fig" }, h("b", null, h("span", { class: "add" }, `+${c.diff.added}`), " ", h("span", { class: "del" }, `−${c.diff.removed}`)), h("span", null, `in ${c.diff.files?.length ?? 0} file${c.diff.files?.length === 1 ? "" : "s"}`)) : null,
				h("div", { class: "fig" }, h("b", null, String(c.tests_added ?? 0)), h("span", null, "tests added")),
				isPick && j ? h("div", { class: "fig" }, h("b", null, j.probability?.toFixed(2)), h("span", null, "judge's confidence")) : null,
			),
			c.checks?.length ? h("details", { class: "checks", open: out ? true : null }, h("summary", null, out ? "Why it bounced" : "The checks"), checksList(c.checks)) : null,
			c.diff?.patch ? h("details", null, h("summary", { class: "small" }, "The diff"), patchView(c.diff.patch)) : c.diff?.files?.length ? h("p", { class: "small muted" }, c.diff.files.map((f) => f.path).join(", ")) : null,
			obj ? h("div", { class: "objection" }, h("span", null, prose(obj.objection)), h("span", { class: "who" }, obj.generated_by?.backend === "workers-ai" ? `The referee's strongest objection (${obj.generated_by.model.split("/").pop()})` : "The referee's objection, from the evidence")) : null,
			c.summary ? h("div", { class: "words" }, h("span", { class: "who" }, "In the agent's own words, read last"), prose(c.summary)) : null,
			shipBox,
		);
	});

	const head = h(
		"div",
		{ class: "cardhead" },
		h(
			"div",
			{ class: "grow" },
			h("span", { class: "kicker small faint" }, h("a", { href: `#/board/${d?.task ?? rec?.state?.task?.id}` }, `Task ${d?.task ?? rec?.state?.task?.id}`), `  Decision ${id}`),
			h("h1", null, data.task?.title ?? rec?.state?.task?.title ?? id),
			j
				? h(
						"div",
						{ class: "proposal" },
						h("span", null, "The judge proposes ", h("b", null, `${agentOf(j.pick)}'s change`), ` at ${j.probability?.toFixed(2)}, by the rule: `, h("b", null, j.ruleText || "none")),
						h("span", { class: "small muted" }, `${j.generated_by?.backend === "mock" ? "Judge: the rubric engine (mock), deterministic." : `Judge: ${j.generated_by?.backend} ${j.generated_by?.model ?? ""}.`} ${j.route?.why ?? ""}`),
					)
				: h("p", { class: "muted" }, "The judge has not looked yet."),
			shipped && verdict
				? h(
						"div",
						{ class: "verdict" },
						h(
							"span",
							null,
							verdict.verdict === "auto" || verdict.kind === "agent"
								? `Merged by the judge on its own, under the grant ${verdict.grant ?? ""}.`
								: verdict.verdict === "agree"
									? `${verdict.by_name ?? verdict.by} agreed with the judge and shipped ${agentOf(verdict.pick)}'s change.`
									: `${verdict.by_name ?? verdict.by} overruled the judge and shipped ${agentOf(verdict.pick)}'s change.`,
						),
						verdict.reason ? h("span", { class: "small" }, `Reason: ${verdict.reason}`) : null,
						d?.merged_commit || rec?.merge?.commit ? h("span", { class: "small muted" }, "On main as ", h("code", null, short(d?.merged_commit ?? rec?.merge?.commit)), ". ", h("a", { href: "#/why" }, "See it in why-blame")) : null,
					)
				: ready && state.who.kind !== "admin"
					? h("p", { class: "small muted" }, "Waiting for the steward. Sign in as steward to decide.")
					: null,
		),
	);
	const wrap = h("div", { style: "position:relative" }, head, h("div", { class: "finish" }, lanes));
	if (shipped) wrap.append(h("span", { class: `seal${justShipped.has(id) ? " stamp" : ""}` }, "Official"));
	justShipped.delete(id);
	return wrap;
}
const justShipped = new Set();

async function decide(id, pick, reason) {
	try {
		await api(`/api/decisions/${id}/decide`, reason === undefined ? { pick } : { pick, reason });
		justShipped.add(id);
		toast(`Shipping ${agentOf(pick)}'s change.`);
		soon();
	} catch (e) {
		toast(e.code === "note_needed" ? "Say why you are choosing differently from the judge." : e.message, true);
	}
}

// ------------------------------------------------------------------ paths
function viewPaths() {
	const P = state.paths;
	if (!P) return h("p", null, "Loading…");
	return h(
		"div",
		{ class: "paths" },
		h("div", { class: "taskhead" }, h("h1", null, "The check"), h("p", { class: "muted" }, "The check replays the judge on the steward's past decisions, path by path. A path earns auto-merge when the judge matches the steward within the bar, and loses it the moment the judge drifts. Only decisions a person made count as evidence.")),
		P.paths.map((p) => {
			const last = p.last_check;
			const active = p.auto_merge.grant;
			const latest = p.grants[p.grants.length - 1];
			const run = h("button", { onclick: async (e) => { e.target.disabled = true; e.target.textContent = "Replaying the judge…"; try { const r = await api(`/api/check/${p.path}`, {}); toast(`${p.title}: ${r.note}.`); await refreshPaths(); route(); } catch (err) { toast(err.message, true); e.target.disabled = false; } } }, "Run the check now");
			return h(
				"section",
				{ class: "sheet path" },
				h("div", { class: "auto" }, h("h2", null, p.title), h("p", { class: "small muted" }, `Stewarded by ${p.steward.name}. Covers ${p.globs.join(", ")}.`), h("span", { class: `big ${p.auto_merge.on ? "on" : "off"}` }, p.auto_merge.on ? "Auto-merge on" : "Steward decides"), active ? h("p", { class: "small" }, `${cap(active.note)}. Until ${active.until}; the judge merges alone at ${active.min_probability} or more, and 1 in 10 still come to ${p.steward.name}.`) : latest && latest.status !== "active" ? h("p", { class: "small", style: "color:var(--flag)" }, cap(latest.reason) ?? `Auto-merge ${latest.status}.`) : h("p", { class: "small muted" }, p.auto_merge.mode === "earn" ? "Not earned yet." : "Auto-merge is off for this path.")),
				h(
					"div",
					null,
					h("h3", null, "Last check"),
					last
						? [
								h("p", null, h("span", { class: "rate" }, `${last.misses} of ${last.judged}`), " past decisions differ from the steward's. ", h("span", { class: "muted" }, `The bar is ${Math.round(last.bar * 100)}%.`)),
								h("div", { class: "dots", "aria-label": `${last.judged - last.misses} agree, ${last.misses} differ` }, last.rows.map((r) => h("span", { class: `dot${r.miss ? " miss" : ""}`, title: `${r.id}: ${r.miss ? "the steward chose differently" : "the judge matched the steward"} (judge ${r.p.toFixed(2)})` }))),
								h("p", { class: "small muted" }, `One dot per past decision: filled when the judge matched the steward, a ring when the steward chose differently. ${last.pass ? "Passed" : "Failed"} ${day(last.at)} at ${time(last.at)}; judge: ${last.engine}.`),
							]
						: h("p", { class: "small muted" }, "Never run. It runs every Monday, or now."),
					state.who.kind === "admin" ? h("div", { style: "margin-top:10px" }, run) : null,
				),
				h(
					"div",
					null,
					h("h3", null, "Auto-merge history"),
					p.grants.length
						? h("ul", { class: "grants" }, [...p.grants].reverse().map((g) => h("li", { class: g.status }, h("b", null, g.status === "active" ? "Earned" : g.status === "suspended" ? "Suspended" : g.status === "revoked" ? "Revoked" : "Expired"), ` ${day(g.ended_at ?? g.at)}. `, h("span", { class: "muted" }, cap(g.status === "active" ? g.note : (g.reason ?? g.note))))))
						: h("p", { class: "small muted" }, "None yet."),
				),
			);
		}),
	);
}

// ------------------------------------------------------------------ why
async function viewWhy(file, line) {
	const files = (await api("/api/files")).filter((f) => !/(^|\/)(package-lock\.json|\.gitignore)$/.test(f));
	const current = file ?? files.find((f) => f === "src/rules.js") ?? files[0];
	const blame = current ? await api(`/api/blame?file=${encodeURIComponent(current)}`) : [];
	const panel = h("aside", { class: "whypanel" }, h("div", { class: "empty" }, h("h3", null, "Click a highlighted line"), h("p", { class: "small" }, "Lines a decision put there are marked. Click one to see the task, the rivals it beat, who decided and why.")));
	const rows = blame.map((l) =>
		h(
			"tr",
			{ class: l.decision ? "from" : "", "data-n": l.n, onclick: l.decision ? () => showWhy(l, panel) : null },
			h("td", { class: "n" }, l.n),
			h("td", { class: "g" }, h("span", { class: "bar2" })),
			h("td", { class: "who" }, l.decision && (l.n === 1 || blame[l.n - 2]?.decision !== l.decision) ? h("span", { class: "dtag" }, jersey(l.author, 14), ` ${l.decision}`) : null),
			h("td", null, l.text),
		),
	);
	const view = h(
		"div",
		{ class: "why" },
		h("nav", { class: "files", "aria-label": "Files on main" }, files.map((f) => h("a", { href: `#/why/${encodeURIComponent(f)}`, "aria-current": f === current ? "true" : "false" }, f))),
		h("div", null, h("div", { class: "taskhead" }, h("h1", null, "Why is this line here?"), h("p", { class: "muted" }, `${current} on main. Every merge is one decision, so every line traces back to one.`)), h("div", { class: "code" }, h("table", null, h("tbody", null, rows)))),
		panel,
	);
	if (line) {
		const l = blame.find((x) => x.n === Number(line));
		if (l?.decision) setTimeout(() => showWhy(l, panel), 0);
	}
	return view;
}

async function showWhy(line, panel) {
	document.querySelectorAll(".code tr.sel").forEach((r) => r.classList.remove("sel"));
	document.querySelector(`.code tr[data-n="${line.n}"]`)?.classList.add("sel");
	panel.replaceChildren(h("p", { class: "muted" }, "Reading the decision…"));
	try {
		const data = await api(`/api/decisions/${line.decision}`);
		const rec = data.record;
		const st = rec?.steward;
		const cands = rec?.state?.candidates ?? [];
		const shipped = rec?.merge ? cands.find((c) => c.id === (st?.pick ?? rec?.judge?.pick)) : null;
		panel.replaceChildren(
			h(
				"div",
				{ class: "sheet", style: "display:grid;gap:12px" },
				h("span", { class: "small faint" }, `Line ${line.n}, from decision ${line.decision}`),
				h("h2", null, rec?.state?.task?.title ?? line.summary),
				h("p", { class: "small muted" }, rec?.state?.task?.description ?? ""),
				shipped ? h("p", { class: "row" }, jersey(shipped.agent, 26), h("span", null, h("b", null, `${shipped.agent}'s change`), ` shipped on ${day(rec.merge.at)}.`)) : null,
				st
					? h("div", { class: "verdict" }, h("span", null, st.verdict === "agree" ? `${stewardName(st.by)} agreed with the judge.` : `${stewardName(st.by)} overruled the judge, who proposed ${agentOf(rec.judge?.pick)}.`), st.reason ? h("span", { class: "small" }, `Why: ${st.reason}`) : null)
					: rec?.auto
						? h("div", { class: "verdict" }, h("span", null, `The judge merged it on its own, under grant ${rec.auto.grant}.`))
						: null,
				rec?.judge ? h("p", { class: "small" }, `The judge picked ${agentOf(rec.judge.pick)} at ${Number(rec.judge.probability).toFixed(2)}, by the rule "${rec.judge.ruleText}".`) : null,
				(rec?.referee ?? []).filter((o) => o.candidate === shipped?.id).map((o) => h("div", { class: "objection" }, h("span", null, prose(o.objection)), h("span", { class: "who" }, "The referee's objection to the change that shipped"))),
				cands.length > 1
					? h("div", null, h("h3", null, "Also ran"), h("ul", { class: "alsoran" }, cands.filter((c) => c.id !== shipped?.id).map((c) => h("li", null, agentTag(c.agent), h("span", { class: "small muted" }, c.gate1.passed ? `passed gate 1, +${c.diff.added}/−${c.diff.removed}` : `bounced: ${c.gate1.checks.filter((k) => !k.ok).map((k) => k.name).join("; ")}`)))))
					: null,
				h("a", { href: `#/decision/${line.decision}`, class: "small" }, "Open the decision"),
			),
		);
	} catch (e) {
		panel.replaceChildren(h("p", { class: "note bad" }, e.message));
	}
}

// ------------------------------------------------------------------ ledger
async function viewLedger() {
	const lines = await api("/api/ledger");
	return h(
		"div",
		null,
		h("div", { class: "taskhead" }, h("h1", null, "Ledger"), h("p", { class: "muted" }, "Every merge, newest first: what shipped, who decided, and how they decided. Rows marked synthetic are made-up history so the check has something to replay on day one.")),
		h(
			"table",
			{ class: "ledger" },
			h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Decision"), h("th", null, "Path"), h("th", null, "Shipped"), h("th", null, "Decided by"), h("th", null, "How"), h("th", null, "On main"))),
			h(
				"tbody",
				null,
				lines.map((l) =>
					h(
						"tr",
						{ class: l.synthetic ? "synthetic" : "" },
						h("td", null, day(l.at), h("div", { class: "small faint" }, time(l.at))),
						h("td", null, l.synthetic ? l.decision : h("a", { href: `#/decision/${l.decision}` }, l.decision), l.synthetic ? h("div", null, h("span", { class: "synthetic-chip" }, "synthetic")) : null),
						h("td", null, l.path),
						h("td", null, agentTag(agentOf(l.pick))),
						h("td", null, l.decided_by.kind === "agent" ? `Judge, under ${l.decided_by.grant}` : l.decided_by.name),
						h("td", null, h("span", { class: `verdictword ${l.verdict}` }, l.verdict === "agree" ? "Agreed with the judge" : l.verdict === "overrule" ? `Overruled ${agentOf(l.judge_pick)}` : "Merged alone")),
						h("td", null, l.merged_commit ? h("code", null, short(l.merged_commit)) : h("span", { class: "faint" }, "")),
					),
				),
			),
		),
	);
}

// ------------------------------------------------------------------ router
async function route() {
	const [, view = "board", a, b] = location.hash.replace(/^#\/?/, "#/").split("/");
	for (const link of document.querySelectorAll(".bar nav a")) link.setAttribute("aria-current", link.dataset.view === (view === "decision" ? "board" : view) ? "page" : "false");
	const el = $("#view");
	try {
		if (view === "board" || view === "") {
			if (a) state.selected = decodeURIComponent(a);
			if (!state.board) await refreshBoard();
			redraw = () => el.replaceChildren(viewBoard());
		} else if (view === "decision") {
			redraw = async () => el.replaceChildren(await viewDecision(decodeURIComponent(a)));
		} else if (view === "paths") {
			await refreshPaths();
			redraw = () => el.replaceChildren(viewPaths());
		} else if (view === "why") {
			redraw = null;
			el.replaceChildren(await viewWhy(a ? decodeURIComponent(a) : undefined, b));
			return;
		} else if (view === "ledger") {
			redraw = null;
			el.replaceChildren(await viewLedger());
			return;
		}
		await redraw?.();
	} catch (e) {
		el.replaceChildren(h("div", { class: "empty" }, h("h2", null, "That did not load"), h("p", null, e.message), h("button", { onclick: route }, "Try again")));
	}
}

async function start() {
	try {
		state.who = key() ? await api("/api/whoami") : { kind: "public" };
	} catch {
		state.who = { kind: "public" };
	}
	await Promise.all([refreshBoard().catch(() => {}), refreshPaths().catch(() => {})]);
	drawProject();
	drawWho();
	window.addEventListener("hashchange", route);
	await route();
	connect();
}
start();
