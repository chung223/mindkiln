# Nuwa Studio (女媧工坊)

*Distill a conversable mind from a pile of documents.*

A local-first tool for **persona distillation and conversation**, adapting the methodology of [nuwa-skill](https://github.com/alchaincyf/nuwa-skill). Drop documents about a person into a folder, run the distillation pipeline, then chat with the persona, predict their reactions, process a relationship, or convene an advisory board.

> The UI is currently in Traditional Chinese. This document summarizes what the tool does for non-Chinese readers; contributions for full UI i18n are welcome.

## Install

Requires **Node.js 20+**.

```bash
git clone https://github.com/chung223/mindkiln.git
cd mindkiln
npm install
npm start
# open http://localhost:5723
```

Or with Docker (no Node needed):

```bash
docker build -t mindkiln .
docker run -p 5723:5723 -v ~/nuwa-data:/data mindkiln
```

On first run, open Settings (bottom-left) and add an Anthropic or MiniMax API key — or point it at a local model (Ollama / LM Studio / llama.cpp, OpenAI-compatible). Keys and all data stay on your machine.

## What it does

- **Distillation pipeline** — 6 research dimensions (writings, conversations, expression DNA, external views, decisions, timeline) → mental-model synthesis with triple verification → a runnable `persona.md`. Includes a quality-audit gate (flags fabricated quotes and fake mental models), cost estimation, per-dimension re-runs, and corpus caching.
- **Chat / Predict / Conditions** — roleplay as the persona; predict their reaction to a scenario with reasoning and confidence; pin situational conditions for a whole conversation.
- **Emotional processing modes** (borrowed from counseling techniques) — rehearse a hard conversation, write an unsent letter and receive a reply in their voice, see an event from their perspective, or reflective companionship.
- **Relationship practice with a coach** — pick a scenario (small talk → re-icebreak → say it clearly → invite → repair → set a boundary → confess → face ambiguity, with difficulty ratings); an impartial coach gives per-message feedback on rhythm, authenticity, momentum, emotional awareness, and goal alignment, plus a scored end-of-session review. The coach never writes scripts, judges the other person, or teaches manipulation.
- **Advisory board** — 2+ distilled personas discuss the same question in sequence, seeing and disputing each other's takes; an optional moderator summarizes consensus, disagreements, and blind spots.
- **Relationship dashboard** — turns chat corpora into visible statistics (monthly volume, who initiates, late-night density, message length, stickers/media — zero model cost) plus an LLM-generated **emotional arc**: monthly tone (-2..+2) and turning points, cached to disk.
- **A/B rehearsal** — try two phrasings at the same point in a conversation, see both likely replies side-by-side, adopt one.
- **Incremental corpus updates** — drop new chat exports later; the tool detects new files and updates timeline → synthesis → persona without a full re-distillation.
- **Cross-chat memory, persona version history, verifiable predictions, growth journal, voice (Web Speech TTS/STT), full-text chat search, Markdown export, import/export of nuwa-skill personas** (imports are scanned for prompt-injection patterns and require confirmation when suspicious).
- **Persona evolution (Darwin loop)** — methodology adapted from [darwin-skill](https://github.com/alchaincyf/darwin-skill): an independent evaluator scores the persona against research evidence **plus behavioral probe tests** (5 fixed probes asked to the running persona); one evolution round targets only the weakest dimension, re-tests with the same probes, and **keeps the rewrite only if the total score improves — otherwise auto-reverts** (ratchet; old versions always in history). Question-writer, evaluator, and rewriter are three separate prompts; predictions you marked as "missed" feed in as real-world corrective evidence. Every round is human-triggered.
- **Mobile-friendly + PWA** — responsive drawer layout, add-to-home-screen; pair with Tailscale/Cloudflare Tunnel and set `NUWA_PASSWORD` for password-protected personal remote access (data never leaves your machine).
- **Traditional Chinese guarantee** — OpenCC (s2twp) deterministically converts model output for personas distilled from Simplified-Chinese sources.

## Configuration

| Env var | Purpose | Default |
|---|---|---|
| `NUWA_DATA_DIR` | Data directory (recommend outside the repo, e.g. `~/nuwa-data`) | `./data` |
| `PORT` | Server port | `5723` |
| `HOST` | Bind address (`0.0.0.0` for containers/LAN) | `127.0.0.1` |
| `NUWA_PASSWORD` | Enables cookie-based login. **Set this whenever the server is reachable beyond localhost.** | disabled |
| `ANTHROPIC_API_KEY` | Anthropic key (can also be set in the UI) | — |

`.env` in the project root is auto-loaded.

## Honest boundaries

What you distill is a mirror, not the person. It cannot predict how a real human will respond to genuinely new situations, and public expression may differ from private thought. **Get consent before distilling a living, non-public person.** For relationship processing especially: the persona helps you see patterns and rehearse — it is not a substitute for the real conversation.
