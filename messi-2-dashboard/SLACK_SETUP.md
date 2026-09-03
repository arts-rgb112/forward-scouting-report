# Slack audit and command setup for `agent_loop.py`

The integration writes one redacted audit thread per run and can receive
commands over Socket Mode. New work must begin with an app mention in the one
configured channel. Human replies in that active thread are accepted as
follow-up tasks while the listener process remains running. Messages from bots,
other channels, unrelated channel chatter, and duplicate event IDs are ignored.

## Slack app configuration

1. Add bot OAuth scopes `chat:write`, `app_mentions:read`, and
   `channels:history`.
2. Enable Socket Mode.
3. Generate an app-level token with `connections:write`.
4. Enable Event Subscriptions and subscribe to bot events `app_mention` and
   `message.channels`.
5. Install or reinstall the app to the workspace.
6. Invite the bot to one dedicated public channel.
7. Store credentials only as Windows user environment variables:

   - `SLACK_BOT_TOKEN`: bot token beginning with `xoxb-`
   - `SLACK_APP_TOKEN`: app token beginning with `xapp-`
   - `SLACK_CHANNEL_ID`: exact channel ID beginning with `C`
   - `SLACK_AUDIT_REQUIRED`: `true`

Do not put credentials in source files, chat messages, `.env` files, command
output, or Git. Restart the terminal/Codex process after changing Windows user
environment variables.

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

In the configured channel, start a task with:

```text
@MESSI Agent Audit <bounded task>
```

For a no-model connectivity probe, send `@MESSI Agent Audit 연결 확인`.

Each run stays in that Slack thread and records `USER → AGENT`, `AGENT RUN`,
`PLANNER → CODER`, `CODER → FILES`, `TEST → PLANNER`, and `DONE/STOP` events.
Source code and source-file contents are not posted. ANSI terminal codes,
OpenAI keys, Slack tokens, authorization headers, and webhook URLs are redacted.

The listener serializes tasks. A follow-up received while a run is executing is
handled after Slack redelivers or queues the event; it does not interrupt an
in-flight model call or filesystem write.

## Write-only audited loop

To run a local task file without listening for Slack commands:

```powershell
python agent_loop.py --require-slack
```

Incoming webhooks remain a write-only, non-thread fallback through
`SLACK_WEBHOOK_URL`; they cannot receive Socket Mode commands.
