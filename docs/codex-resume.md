# Codex CLI resume tailoring

Resume rewrites default to the local **Codex CLI** using your ChatGPT Plus/Pro
subscription. OpenRouter stays available for scoring helpers, Hacker News
extraction, claim checks (OpenRouter mode), cover letters, and other tasks.

Codex failures are reported as errors. There is **no automatic fallback** to a
paid OpenRouter model unless you set `RESUME_OPENROUTER_FALLBACK=true`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `RESUME_LLM_PROVIDER` | `codex_cli` | `codex_cli` or `openrouter` for resume rewrites only |
| `RESUME_OPENROUTER_FALLBACK` | `false` | Explicit opt-in fallback if Codex fails |
| `CODEX_CLI_PATH` | `codex` | Path or name of the Codex executable |
| `CODEX_TASK_TIMEOUT` | `300000` | Timeout in milliseconds |
| `RESUME_OUTPUT_DIRECTORY` | `data/out` | Where PDF/DOCX artifacts are stored |
| `RESUME_TEMPLATE_PATH` | `resume.tex` | LaTeX master resume / template |

OpenRouter keys are **not** required for Codex mode.

## Setup

1. **Install Codex CLI** in the same environment that runs `npm run worker` and
   the Next.js app (see [Codex CLI docs](https://learn.chatgpt.com/docs/codex/cli)).

2. **Authenticate with ChatGPT** (not an API key):

   ```bash
   codex login
   ```

   Choose Sign in with ChatGPT. Do not pipe `OPENAI_API_KEY` into
   `codex login --with-api-key` for this workflow.

3. **Verify**:

   ```bash
   codex login status
   ```

   Exit code `0` means credentials are present. The app rejects API-key-only
   auth so subscription usage is used instead of token billing.

4. **Configure the app** (`.env`):

   ```bash
   RESUME_LLM_PROVIDER=codex_cli
   RESUME_OPENROUTER_FALLBACK=false
   CODEX_CLI_PATH=codex
   ```

5. **Migrate** (adds tailor run status / DOCX / version columns):

   ```bash
   npm run db:migrate
   ```

6. **Test one job** (uses subscription allowance):

   ```bash
   npx tsx scripts/tailor-one.ts <jobId> --pdf
   ```

   Or open a scored job in the dashboard and press **Tailor Resume**.

## How it works

1. The app prepares a per-job workspace under `data/codex-workspaces/<jobId>/`
   with `AGENTS.md`, a JSON schema, and input files (`job.json`, `resume.json`).
2. Job description text is treated as **untrusted data**, not instructions.
3. `codex exec` runs with `--sandbox workspace-write`, `--output-schema`, and
   `-o` for structured JSON. API key env vars are stripped from the process
   environment so Codex cannot silently switch to API auth.
4. Output is validated, passed through the existing deterministic truth checks,
   then rendered to PDF via your LaTeX template (Tectonic) and to DOCX via a
   deterministic writer.
5. Artifacts land in `data/out/<jobId>/`. Regenerating archives the previous
   version under `data/out/<jobId>/versions/vN/` and never overwrites
   `resume.tex`.

## Dashboard

On a job’s detail panel:

- **Tailor Resume** / **Regenerate**
- Current provider and run status
- Download PDF / DOCX
- Change log and fit notes under “Show changes…”
- Gaps tab (when generated)
- Nothing is submitted to an employer until you approve an application

## Containers / remote workers

Codex must run **in the same environment** as the worker that executes
tailoring. Mount or restore the user’s Codex auth (`~/.codex`) into that
environment; do **not** bake credentials into the image or the git repo.
Prefer running the worker on the host (or a trusted personal machine) when
using ChatGPT login.

## Troubleshooting

| Symptom | What to try |
|---|---|
| `Codex CLI not found` | Install CLI; set `CODEX_CLI_PATH` |
| `not authenticated` | `codex login` with ChatGPT, then `codex login status` |
| `signed in with an API key` | `codex logout`, then `codex login` (ChatGPT) |
| Usage / rate limit errors | Wait for ChatGPT/Codex allowance to reset |
| Timeout | Raise `CODEX_TASK_TIMEOUT`; check network |
| LaTeX / PDF errors | Install Tectonic; keep `resume.tex` valid |
| Unexpected OpenRouter charges | Ensure `RESUME_OPENROUTER_FALLBACK=false` and provider is `codex_cli` |

## ChatGPT subscription limits

Codex CLI usage under ChatGPT auth counts against your ChatGPT/Codex
subscription allowance, not OpenRouter token billing. Heavy batch tailoring can
exhaust that allowance; prefer Tailor Resume on jobs you care about, or lower
worker concurrency.

## Master resume

The app still reads your master resume from `resume.tex` (see README “Make it
yours”). Configure that file and Settings → Extra skills before the first
tailoring run. The agent never invents content that is not in the parsed
profile.
