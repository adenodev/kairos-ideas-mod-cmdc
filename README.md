# kairos-ideas-mod-cmdc

A [Command Code](https://commandcode.ai) mod that captures ideas as you talk: **[Jev](https://docs.typesafe.ai/)** — TypeSafe's decision model, provided through Command Code — judges whether an idea is worth remembering, and the worthwhile ones are committed to **[Kairos](https://kairos.adeno.ltd)** through the Adeno API so you can circle back to them later.

## What it does

- **`/ideas <text>`** — judge one idea, commit it when it passes the confidence threshold.
- **`kairos_commit_idea` tool** — the agent can capture ideas mid-conversation ("remember this", "we should do X someday").
- **Automatic mode** — when your message reads like brainstorming ("not writing code, just spitballing ideas", "I've been thinking about adding…", "someday…"), the mod tells the agent to route each concrete idea through the Jev-gated tool. Implementation/debug requests are left alone.
- **Key management** — `/ideas api add <key | $ENV_VAR>`, `/ideas api remove`, `/ideas api status`.

## Install

```bash
cmd mods add adenodev/kairos-ideas-mod-cmdc
```

Or keep it local: copy `index.ts` into `~/.commandcode/mods/`.

## Configure

```bash
# Store an Adeno API key (scope: kairos:ingest:write). Persists across runs.
/ideas api add $ADENO_API_KEY

# Check what is configured and where the key comes from
/ideas api status
```

Key resolution order: `--mod-option adeno_api_key=…` → stored key → `ADENO_API_KEY`.

### Options

| Option | Default | Meaning |
|---|---|---|
| `adeno_api_key` | — | Adeno API key (overrides the stored key) |
| `kairos_base` | `https://kairos.adeno.ltd/api/v1` | Kairos API base URL |
| `idea_threshold` | `0.60` | Jev probability an idea must reach to be committed |
| `dry_run` | `false` | Score ideas but never POST to Kairos |
| `jev_model` | `typesafe/jev` | Decision model used for the importance check |

## How it decides

**Jev** — made by [TypeSafe](https://docs.typesafe.ai/), provided through Command Code (which is how this mod uses it) — answers typed questions about a state with probabilities. The mod asks one question — "is this idea specific and important enough to commit to the user's planner so they circle back to it later?" — and weighs the framing (an idea you say you've been thinking about scores high unless it is clearly trivial). Jev is headless-only, so the mod shells out to `cmd -p '<request JSON>' -m typesafe/jev` and reads the probability back.

Above the threshold, the idea is sent to Kairos `POST /v1/ingest`, which parses it into tasks/notes for your account.

## Privacy

The API key is stored locally in `~/.commandcode/mods/.store/kairos-idea.json` (Command Code's mod store). It is only sent to Kairos, in the same request that carries the idea text. No telemetry, no third party.

## Requirements

- Command Code with the `typesafe/jev` decision model available (Jev is TypeSafe's model, offered through Command Code).
- An Adeno API key with the `kairos:ingest:write` scope (mint one in your Adeno account → API).
