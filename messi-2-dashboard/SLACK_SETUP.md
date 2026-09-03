# Slack audit setup for `agent_loop.py`

The integration is write-only. It posts the local automation transcript to one
Slack channel and does not read messages, users, files, or workspace history.

## Recommended: bot thread

1. Create a Slack app for the intended workspace.
2. Add the bot OAuth scope `chat:write` only.
3. Install the app to the workspace.
4. Invite the bot to a dedicated channel such as `#messi-agent-audit`.
5. Copy the bot token and the channel ID. Do not paste either into source files,
   chat messages, `.env` files, command output, or Git.
6. Add these Windows user environment variables using the Environment Variables UI:

   - `SLACK_BOT_TOKEN`: the bot token
   - `SLACK_CHANNEL_ID`: the dedicated channel ID, for example `C0123456789`
   - `SLACK_AUDIT_REQUIRED`: `true`

7. Restart Codex Desktop so the process inherits the variables.
8. From this directory, run `python agent_loop.py --check-slack`. This sends one
   real connectivity message. Do not run it repeatedly.

Each automation run creates one root message. Planner plans, proposed file names
and byte counts, test results, completion, and stop reasons are replies in that
thread. Source code and source-file contents are not posted. ANSI terminal codes,
OpenAI keys, Slack tokens, authorization headers, and webhook URLs are redacted.

Run the audited loop with:

```powershell
python agent_loop.py --require-slack
```

With `--require-slack`, missing credentials or a Slack delivery failure stops the
loop before the next model call or file mutation instead of silently losing the
audit trail.

## Fallback: incoming webhook

Set `SLACK_WEBHOOK_URL` instead of the bot variables. This requires less setup but
cannot group a run into a Slack thread, so the bot-thread method is preferred.
