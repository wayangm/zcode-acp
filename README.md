# zcode-acp

[Agent Client Protocol](https://agentclientprotocol.com) (ACP) stdio adapter for the
[ZCode](https://zcode.ai) CLI. It lets any ACP client - such as
[OpenBot](https://openbot.run) - run ZCode as one agent of a team.

The adapter starts an ACP server on stdio. One prompt turn runs ZCode headlessly
(`zcode -p "<turn>" --json`) in the session's working folder. The adapter stores the ZCode
session id of each ACP session and resumes it on the next turn, so the agent keeps its
conversation history. A running turn sends a heartbeat on the thought channel every 20 seconds.

## Install

```sh
npm install -g github:wayangm/zcode-acp
```

(or `npm install -g zcode-acp` once published to the npm registry.)

Requirements: [ZCode Desktop](https://zcode.ai) installed and signed in (`zcode login`). The
adapter finds the CLI of the ZCode Desktop install by itself. Set `ZCODE_CLI_PATH` when the
install lives in a custom place.

## Use with OpenBot

1. Settings, then Providers, then add a custom ACP agent (or use the ZCode preset once
   nightly-labs/openbot knows it).
2. Command: `zcode-acp`, arguments: none.
3. Check agent, then add.

## Environment variables

| Name | Meaning |
| --- | --- |
| `ZCODE_CLI_PATH` | Full path of the ZCode CLI entry (`zcode.cjs`). Default: auto-detected. |
| `ZCODE_HOME` | ZCode data folder. Default: `~/.zcode`. |

## Commands

- `zcode-acp` - run the ACP server on stdio.
- `zcode-acp --version` - print the adapter version and exit.

## Notes

- The adapter reports the model that ZCode headless actually runs: the first provider of
  `providerOrder` and its first model, from the same provider config the CLI reads
  (`~/.zcode/v2/provider_config.json`). The ZCode CLI has no headless model switch yet, so the
  picker shows this one model and `session/set_model` refuses other ids. No reasoning-effort
  options are offered for the same reason.
- The adapter logs to `os.tmpdir()/zcode-acp.log`.
- One turn at a time per session. `session/cancel` kills the running turn.
- `session/load` is not supported; a new ACP session maps to a new ZCode session.
- ZCode runs with the permission mode of the CLI (`yolo` by default for `-p`). Only give it
  tasks you trust, and prefer a separate working folder.
