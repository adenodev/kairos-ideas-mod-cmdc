// kairos-idea.ts — judge ideas with Jev and commit the worthwhile ones to Kairos.
//
// Surfaces
//   /ideas <text>             judge one idea, commit it when it passes the threshold
//   /ideas api add <key>      store the Adeno API key (persists across runs)
//   /ideas api remove         forget the stored key
//   /ideas api status         show key source, threshold, base, dry-run state
//   /idea <text>              alias of /ideas <text>
//   kairos_commit_idea tool   model-callable during a session
//
// Automatic mode
//   A standing system-prompt line tells the agent to capture idea-shaped
//   messages, and when typed input reads like brainstorming ("not writing
//   code, just spitballing ideas", "I don't want to code this yet", "I've
//   been thinking about adding…", "thinking out loud", …) the mod appends an
//   instruction routing each concrete idea through the kairos_commit_idea
//   tool — Jev remains the importance gate.
//
// Config (flags via `--mod-option name=value`, or environment variables)
//   adeno_api_key    / ADENO_API_KEY          key with `kairos:ingest:write`
//   kairos_base      / KAIROS_API_BASE        default https://kairos.adeno.ltd/api/v1
//   idea_threshold   / KAIROS_IDEA_THRESHOLD  default 0.60 (Jev probability to commit)
//   dry_run          (flag only)              score + report, never POST to Kairos
//   jev_model        (flag only)              default typesafe/jev
//
// Key resolution order: --mod-option adeno_api_key > stored via /ideas api add
// > ADENO_API_KEY. Jev is a decision model (headless only), so the mod shells
// out to `cmd -p '<request json>' -m typesafe/jev` and reads the probability.

import type {ModApi} from '@commandcode/harness';

const JEV_MODEL = 'typesafe/jev';
const DEFAULT_BASE = 'https://kairos.adeno.ltd/api/v1';
const DEFAULT_THRESHOLD = 0.6;
const STORE_API_KEY = 'adeno_api_key';

function flagString(cmd: ModApi, name: string, fallback: string): string {
	const value = cmd.getFlag(name);
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

type KeySource = 'flag' | 'stored' | 'env' | 'none';

function resolveApiKey(cmd: ModApi): {key: string; source: KeySource} {
	const fromFlag = cmd.getFlag('adeno_api_key');
	if (typeof fromFlag === 'string' && fromFlag.trim()) return {key: fromFlag.trim(), source: 'flag'};

	const stored = cmd.store.get(STORE_API_KEY);
	if (typeof stored === 'string' && stored.trim()) return {key: stored.trim(), source: 'stored'};

	const fromEnv = (process.env.ADENO_API_KEY || '').trim();
	if (fromEnv) return {key: fromEnv, source: 'env'};

	return {key: '', source: 'none'};
}

function kairosBase(cmd: ModApi): string {
	return flagString(cmd, 'kairos_base', process.env.KAIROS_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

function threshold(cmd: ModApi): number {
	const raw = flagString(cmd, 'idea_threshold', process.env.KAIROS_IDEA_THRESHOLD || String(DEFAULT_THRESHOLD));
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD;
}

function jevModel(cmd: ModApi): string {
	return flagString(cmd, 'jev_model', JEV_MODEL);
}

function maskKey(key: string): string {
	if (!key) return '(none)';
	if (key.length <= 12) return '••••';
	return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** Headless output can carry banner lines; pick the JSON object out of it. */
function parseJsonLoose(text: string): any {
	const trimmed = String(text || '').trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		/* fall through */
	}
	const start = trimmed.indexOf('{');
	const end = trimmed.lastIndexOf('}');
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			/* fall through */
		}
	}
	return undefined;
}

// ── Idea-mode detection ─────────────────────────────────────────────────────
// Phrases that signal "I'm brainstorming, not asking for code". Detection only
// adds guidance to the prompt; Jev still decides what is worth committing.

const IDEA_MODE_PATTERNS: RegExp[] = [
	/\bspitball(?:ing|ed)?\b/i,
	/\b(?:do(?:n'?t| not) want to|not planning to) (?:code|write code|build|implement)\b/i,
	/\bnot (?:coding|building|implementing|writing code)\b/i,
	/\bno (?:code|coding)(?: for now| yet)?\b/i,
	/\b(?:just )?brainstorm(?:ing)?\b/i,
	/\bideat(?:e|ing|ion)\b/i,
	/\bthinking out loud\b/i,
	/\bideas? only\b/i,
	/\bshower thoughts?\b/i,
	/\b(?:just )?(?:some )?ideas?\b/i,
	/\b(?:an? )?idea(?:s)? for (?:later|the future)\b/i,
	/\b(?:been |keep )thinking (?:about|of)\b/i,
	/\bthinking about (?:adding|building|making|introducing|creating)\b/i,
	/\bmull(?:ing|ed) (?:over|on)\b/i,
	/\btoying with (?:the )?idea\b/i,
	/\bconsidering (?:adding|building|making|introducing)\b/i,
	/\bexplor(?:ing|e) (?:the )?idea\b/i,
	/\bnot (?:building|implementing|shipping) (?:anything|yet)\b/i,
	/\bwhat (?:if|about) (?:we )?(?:added|built|made|had|adding|building)\b/i,
	/\bwe (?:could|might) (?:add|build|make|introduce)\b/i,
	/\bwould be (?:cool|nice|fun|great) if\b/i,
	/\bsomeday\b/i,
];

function looksLikeIdeaMode(text: string): boolean {
	return IDEA_MODE_PATTERNS.some(pattern => pattern.test(text));
}

const IDEA_MODE_NOTE =
	'\n\n[kairos-idea] The user is brainstorming/spitballing ideas here — not requesting an ' +
	'implementation. For each concrete, self-contained idea in this message, call the ' +
	'kairos_commit_idea tool (it uses Jev to decide whether the idea is important enough and ' +
	'commits worthwhile ones to Kairos). Do not start writing code unless the user explicitly ' +
	'asks for it. If this message is in fact a direct request to implement, fix, or review ' +
	'something, ignore this note and proceed normally.';

// Standing guidance (byte-stable: the provider prompt cache keys off it) so the
// agent captures ideas even when no input pattern matches.
const STANDING_PROMPT =
	'Kairos idea capture: when the user shares or reflects on an idea without asking you to ' +
	'implement it — e.g. "I\'ve been thinking about adding X", "just an idea", "not coding ' +
	'yet", "someday", "would be cool if" — call the kairos_commit_idea tool once per concrete ' +
	'idea so Jev can judge whether it should be remembered. Do not call it for ordinary ' +
	'implementation, debugging, or code-review requests.';

// ── Jev ─────────────────────────────────────────────────────────────────────

interface ScoreResult {
	probability?: number;
	error?: string;
}

/** Ask Jev how important/committable this idea is → p(commit) in [0, 1]. */
async function scoreIdea(cmd: ModApi, idea: string): Promise<ScoreResult> {
	const request = {
		state: {
			idea,
			context:
				'Idea typed by the user in a coding session. Kairos is their personal planning system — ' +
				'committing means creating a task/note they can circle back to later.',
		},
		questions: {
			commit: {
				type: 'noul',
				instructions:
					'Is this idea specific and important enough to commit to the user\'s planner so they circle ' +
					'back to it later? Consider the framing: when the user presents it as an idea they are ' +
					'considering, spitballing, or want to revisit later, that itself signals they want it ' +
					'remembered — score high unless it is clearly trivial. High when it is actionable, useful or ' +
					'novel and would otherwise be forgotten. Low when it is trivial, vague, purely conversational, ' +
					'or an obvious immediate next step of the current work that does not need remembering.',
			},
		},
	};

	let result: {stdout: string; stderr: string; code: number};
	try {
		result = await cmd.exec({
			command: process.env.COMMAND_CODE_BIN || 'cmd',
			args: ['-p', JSON.stringify(request), '-m', jevModel(cmd)],
			signal: AbortSignal.timeout(90_000),
		});
	} catch (err: any) {
		return {error: `could not run Jev: ${err?.message || String(err)}`};
	}

	if (result.code !== 0) {
		const detail = String(result.stderr || '').trim().slice(0, 300) || 'no stderr';
		return {error: `Jev exited ${result.code}: ${detail}`};
	}

	const parsed = parseJsonLoose(result.stdout);
	const probability = parsed?.answers?.commit?.noul;
	if (typeof probability !== 'number' || !Number.isFinite(probability)) {
		return {error: `Jev returned no probability: ${String(result.stdout || '').trim().slice(0, 300)}`};
	}
	return {probability};
}

// ── Kairos commit ───────────────────────────────────────────────────────────

interface CommitResult {
	ok: boolean;
	summary?: string;
	error?: string;
}

/** Commit the idea to Kairos through the public API (v1 ingest). */
async function commitIdea(cmd: ModApi, idea: string): Promise<CommitResult> {
	const base = kairosBase(cmd);
	if (cmd.getFlag('dry_run') === true) {
		return {ok: true, summary: `dry run — would POST ${base}/ingest`};
	}

	const {key, source} = resolveApiKey(cmd);
	if (!key) {
		return {
			ok: false,
			error:
				'no Adeno API key — run `/ideas api add <key>`, set ADENO_API_KEY, or launch with ' +
				'--mod-option adeno_api_key=adeno_…',
		};
	}

	let response: Response;
	try {
		response = await fetch(`${base}/ingest`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${key}`,
			},
			body: JSON.stringify({text: idea}),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err: any) {
		return {ok: false, error: `request failed: ${err?.message || String(err)}`};
	}

	const raw = await response.text();
	const body = parseJsonLoose(raw) || {};
	if (!response.ok) {
		const hint = response.status === 401 ? ` (key source: ${source})` : '';
		return {ok: false, error: `Kairos ${response.status}: ${body.error || raw.slice(0, 200)}${hint}`};
	}

	const intents: any[] = Array.isArray(body.intents) ? body.intents : [];
	const titles = intents
		.map(intent => intent && (intent.title || intent.task_name))
		.filter(Boolean)
		.slice(0, 3);
	const noun = intents.length === 1 ? 'entry' : 'entries';
	const summary = intents.length
		? `${intents.length} ${noun} created${titles.length ? ` (${titles.join('; ')})` : ''}${body.llm_used ? ' · AI parse' : ''}`
		: 'accepted (nothing new — already captured)';
	return {ok: true, summary};
}

interface Outcome {
	committed: boolean;
	needsAttention?: boolean;
	probability?: number;
	text: string;
}

async function evaluateAndMaybeCommit(cmd: ModApi, idea: string): Promise<Outcome> {
	const score = await scoreIdea(cmd, idea);
	if (score.error) return {committed: false, needsAttention: true, text: `Jev unavailable: ${score.error}`};

	const probability = score.probability as number;
	const limit = threshold(cmd);
	if (probability < limit) {
		return {
			committed: false,
			probability,
			text:
				`Not committed — Jev rates this p=${probability.toFixed(2)} (threshold ${limit}). ` +
				`Lower the bar with --mod-option idea_threshold=… if you want it kept.`,
		};
	}

	const commit = await commitIdea(cmd, idea);
	if (!commit.ok) {
		return {
			committed: false,
			needsAttention: true,
			probability,
			text: `Jev rates it p=${probability.toFixed(2)}, but the Kairos commit failed: ${commit.error}`,
		};
	}
	return {
		committed: true,
		probability,
		text: `Committed to Kairos (Jev p=${probability.toFixed(2)}) — ${commit.summary}`,
	};
}

// ── `/ideas api …` key management ───────────────────────────────────────────

/** Resolve `$VAR` / `${VAR}` argument forms so `/ideas api add $ADENO_API_KEY` works. */
function resolveKeyArgument(raw: string): {key?: string; error?: string} {
	const trimmed = raw.trim().replace(/^["']|["']$/g, '');
	if (!trimmed) return {error: 'missing key — usage: /ideas api add <key | $ENV_VAR>'};

	const braced = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
	const bare = trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
	const envName = braced?.[1] || bare?.[1];
	if (!envName) return {key: trimmed};

	const value = (process.env[envName] || '').trim();
	if (!value) return {error: `environment variable ${envName} is not set`};
	return {key: value};
}

function apiStatusMessage(cmd: ModApi): string {
	const {key, source} = resolveApiKey(cmd);
	const sourceLabel = {
		flag: '--mod-option adeno_api_key',
		stored: '/ideas api add (stored)',
		env: 'ADENO_API_KEY',
		none: 'not configured',
	}[source];
	const dry = cmd.getFlag('dry_run') === true ? 'on' : 'off';
	return [
		`API key: ${key ? maskKey(key) : '(none)'} — source: ${sourceLabel}`,
		`Threshold: p ≥ ${threshold(cmd)} · base: ${kairosBase(cmd)} · dry run: ${dry}`,
	].join('\n');
}

// ── Mod ─────────────────────────────────────────────────────────────────────

export default function (cmd: ModApi): void {
	cmd.addFlag('adeno_api_key', {
		type: 'string',
		description: 'Adeno API key with kairos:ingest:write (overrides the stored key).',
	});
	cmd.addFlag('kairos_base', {
		type: 'string',
		default: DEFAULT_BASE,
		description: 'Kairos API base URL.',
	});
	cmd.addFlag('idea_threshold', {
		type: 'string',
		default: String(DEFAULT_THRESHOLD),
		description: 'Jev probability (0–1) an idea must reach to be committed.',
	});
	cmd.addFlag('dry_run', {
		type: 'boolean',
		default: false,
		description: 'Score ideas but never POST them to Kairos.',
	});
	cmd.addFlag('jev_model', {
		type: 'string',
		default: JEV_MODEL,
		description: 'Decision model used for the importance check.',
	});

	// Automatic path: brainstorming prompts get a nudge to route every concrete
	// idea through the Jev-gated tool, and the standing prompt tells the agent
	// to capture ideas even when no input pattern matched.
	cmd.hooks({
		appendSystemPrompt: () => STANDING_PROMPT,
		transformInput: ({text}) => {
			if (!text || !looksLikeIdeaMode(text)) return;
			return {action: 'transform', text: `${text}${IDEA_MODE_NOTE}`};
		},
	});

	const runIdea = async (args: string) => {
		const idea = String(args || '').trim();
		if (!idea) {
			return {message: 'Usage: /ideas <the idea to judge and maybe commit to Kairos>'};
		}
		const outcome = await evaluateAndMaybeCommit(cmd, idea);
		return {message: outcome.text};
	};

	cmd.addCommand({
		name: 'ideas',
		description:
			'Capture ideas: judge with Jev and commit to Kairos; manage the Adeno API key (api add/remove/status)',
		argumentHint: '<idea> | api add <key> | api remove | api status',
		handler: async ({args}) => {
			const raw = String(args || '').trim();
			if (!raw) {
				return {
					message:
						'Usage:\n' +
						'/ideas <idea>              judge it and commit to Kairos when important\n' +
						'/ideas api add <key|$ENV>  store the Adeno API key (persists across runs)\n' +
						'/ideas api remove          forget the stored key\n' +
						'/ideas api status          show key source and settings',
				};
			}

			const parts = raw.split(/\s+/);
			if (parts[0].toLowerCase() === 'api') {
				const sub = (parts[1] || 'status').toLowerCase();
				if (sub === 'add' || sub === 'set') {
					const rest = raw.replace(/^api\s+(?:add|set)\s*/i, '');
					const resolved = resolveKeyArgument(rest);
					if (!resolved.key) return {message: `Cannot store key: ${resolved.error}`};
					await cmd.store.set(STORE_API_KEY, resolved.key);
					const note = resolved.key.startsWith('adeno_')
						? ''
						: '\n(note: this does not look like an Adeno key — expected an adeno_… prefix)';
					return {
						message: `API key stored: ${maskKey(resolved.key)} — it persists across runs.${note}`,
					};
				}
				if (sub === 'remove' || sub === 'clear' || sub === 'delete') {
					await cmd.store.delete(STORE_API_KEY);
					return {message: 'Stored Adeno API key removed.'};
				}
				if (sub === 'status' || sub === 'show') {
					return {message: apiStatusMessage(cmd)};
				}
				return {message: `Unknown api subcommand "${sub}" — use add, remove, or status.`};
			}

			return runIdea(raw);
		},
	});

	cmd.addCommand({
		name: 'idea',
		description: 'Alias of /ideas — judge an idea with Jev and commit it when important',
		argumentHint: '<idea>',
		handler: async ({args}) => runIdea(String(args || '')),
	});

	cmd.addTool({
		schema: {
			name: 'kairos_commit_idea',
			description:
				'Judge whether an idea the user just expressed is important enough to remember, using the ' +
				'Jev decision model, and commit it to their Kairos planner when it passes the confidence ' +
				'threshold. Use when the user shares an idea, says "remember this", "note this down", ' +
				'"we should do X someday", or is brainstorming/spitballing ("not writing code, just ideas") ' +
				'and asks to capture something to circle back to later. Pass the idea in the user\'s own ' +
				'wording, keeping how they framed it ("I\'ve been thinking about…", "just an idea for ' +
				'later…") — the framing signals intent to remember.',
			input_schema: {
				type: 'object',
				properties: {
					idea: {
						type: 'string',
						description:
							'The idea in the user\'s own words, including how they framed it, and ' +
							'self-contained enough to be understood later.',
					},
				},
				required: ['idea'],
			},
		},
		readOnly: false,
		run: async ({input}) => {
			const idea = typeof input?.idea === 'string' ? input.idea.trim() : '';
			if (!idea) return {ok: false, error: 'idea is required'};
			const outcome = await evaluateAndMaybeCommit(cmd, idea);
			if (outcome.needsAttention) return {ok: false, error: outcome.text};
			return {ok: true, content: [{type: 'text', text: outcome.text}]};
		},
	});
}
