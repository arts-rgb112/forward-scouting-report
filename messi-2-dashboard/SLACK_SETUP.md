# Slack audit and command setup for `agent_loop.py`

The integration receives explicit commands over Socket Mode and writes a
redacted audit into the same Slack thread. Claude plans/reviews; Codex only
implements explicit execution commands. There is no internal Codex planner and
no automatic model retry loop.

## Slack app configuration

1. Add bot OAuth scopes `chat:write`, `app_mentions:read`, `channels:read`, and
   `channels:history`.
2. Enable Socket Mode.
3. Generate an app-level token with `connections:write`.
4. Enable Event Subscriptions and subscribe to bot events `app_mention` and
   `message.channels`.
5. Install or reinstall the app to the workspace.
6. Invite the bot to one dedicated execution channel and any read-only report
   channels.
7. Store credentials only as Windows user environment variables:

   - `SLACK_BOT_TOKEN`: bot token beginning with `xoxb-`
   - `SLACK_APP_TOKEN`: app token beginning with `xapp-`
   - `SLACK_CHANNEL_ID`: exact channel ID beginning with `C`
   - `SLACK_CONTEXT_CHANNEL_IDS`: comma-separated IDs for read-only report
     channels; these messages enrich future execution context but never trigger
     Codex, file writes, or tests
   - `SLACK_AUDIT_REQUIRED`: `true`
   - `SLACK_ALLOWED_BOT_IDS`: comma-separated exact Claude bot IDs (`B...`)
   - `SLACK_ALLOWED_APP_IDS`: comma-separated exact Claude app IDs (`A...`)
   - `SLACK_MAX_CODEX_RUNS_PER_THREAD`: default `3`

Only configure the Claude identity actually used in the workspace. A bot
message is accepted when either its exact `bot_id` or `app_id` is allowlisted;
all other bots and the audit bot itself are ignored. Humans in the configured
channel remain allowed. Never use a wildcard or copy token values into these
ID variables.

Do not put credentials in source files, chat messages, `.env` files, command
output, or Git. Restart the terminal/Codex process after changing Windows user
environment variables.

## Message protocol and usage guard

Every actionable message must begin with one of these tags:

- `[PLAN]`: save a Claude/human plan in persistent thread context. Zero Codex turns.
- `[DISCUSS]`: save discussion or a user correction. Zero Codex turns.
- `[APPLY]`: run exactly one Codex executor turn, patch files, then run tests once.
- `[REVISE]`: run exactly one further Codex executor turn using accumulated context.
- `[STOP]`: stop the thread without invoking Codex.
- `[RESET]`: human-only; reopen a stopped thread and reset its execution counter.

Untagged messages are not sent to Codex. `[PLAN]` and `[DISCUSS]` never modify
files or run tests. Thread context is stored atomically under
`.agent-loop-state/` (Git-ignored), survives listener restarts, contains no
credentials, and is size-bounded. The default budget is three explicit Codex
turns per Slack thread; only a human `[RESET]` can replenish it.

The latest human instruction has priority over an earlier Claude plan. This
lets the user join the thread, correct the plan, stop execution, or directly
request an apply/revision without creating a hidden agent-to-agent loop.

Example:

```text
Claude: @MESSI Agent Audit [PLAN] Implement the approved dot-matrix heatmap only.
User:   [DISCUSS] Keep the CCA calculation unchanged.
Claude: [APPLY] Apply the plan and the user's constraint.
Codex:  audit summary + changed-file list + test result
User:   [REVISE] Fix only the failed marker-size assertion.
```

For a new thread, mention the audit app. Thread replies are received through
`message.channels`; therefore `channels:history` and that bot event are needed
for both human and allowlisted-Claude follow-ups.

Messages from `SLACK_CONTEXT_CHANNEL_IDS` are synchronized when the listener
starts and then captured through `message.channels`. The bounded, redacted
snapshot is stored in `.agent-loop-state/shared-slack-context.json` and added
as background context only when a human explicitly sends `[APPLY]` or
`[REVISE]` in the execution channel. The latest explicit human instruction
always wins.

## Codex subscription authentication

The executor runs through the local `codex exec` command, not the
OpenAI Responses API. Authenticate the Codex CLI with the same ChatGPT account
that owns the Codex subscription:

```powershell
codex login status
```

The output must explicitly say that the CLI is signed in with ChatGPT. If it
reports API-key authentication, switch it before starting the listener:

```powershell
codex logout
codex login
```

Choose **ChatGPT** in the browser login flow. `agent_loop.py` fails closed when
it cannot confirm ChatGPT authentication. It also removes `OPENAI_API_KEY` and
related API organization variables from every `codex exec` child environment,
so an existing machine-level API key cannot silently switch the loop back to
usage-based API billing. `CODEX_CLI_PATH` may point to a specific Codex CLI
executable if `codex` is not on `PATH`.

## Connection checks

Send exactly one write probe:

```powershell
python agent_loop.py --check-slack
```

Validate the Socket Mode token and WebSocket handshake without invoking a model
or changing files:

```powershell
python agent_loop.py --check-slack-socket
```

## Run the command listener

```powershell
python agent_loop.py --listen-slack --require-slack
```

In the configured channel, start a task with an explicit tag:

```text
@MESSI Agent Audit [PLAN] <bounded plan>
```

For a no-model connectivity probe, send `@MESSI Agent Audit 연결 확인`.

Each run stays in that Slack thread and records the Slack actor, saved plan or
discussion, `AGENT RUN`, `CODEX → FILES`, `TEST`, and `DONE/STOP` events.
Source code and source-file contents are not posted. ANSI terminal codes,
OpenAI keys, Slack tokens, authorization headers, and webhook URLs are redacted.
Claude is not called by this process; the allowlisted Claude Slack app remains
separately operated by the user.

The listener serializes tasks. A follow-up received while a run is executing is
handled after Slack redelivers or queues the event; it does not interrupt an
in-flight model call or filesystem write.

## Write-only audited loop

To run a local task file without listening for Slack commands:

```powershell
python agent_loop.py --require-slack
```

This local task-file form also performs exactly one Codex executor turn and
one test run. `--max-iterations` is retained only for command compatibility and
does not create extra model turns.

Incoming webhooks remain a write-only, non-thread fallback through
`SLACK_WEBHOOK_URL`; they cannot receive Socket Mode commands.
