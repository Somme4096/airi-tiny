# airi-plugin-dusha

An AIRI extension that connects the character to [Dusha](https://github.com/Somme4096/dusha), a service that stores conversation memory, evergreen facts, memos, and affect.

## What it does

| Part | Behavior |
| --- | --- |
| Tools | Gives the chat model 11 Dusha tools. The names match the AstrBot plugin of Dusha. |
| Archive | Stores each user message before AIRI composes the turn, and each reply after the turn. |
| Context | Sends the Dusha injection to AIRI as `context:update` before AIRI composes the turn, so the reply already uses it. |
| Affect shift | Names the emotion that a Dusha decision picked for each user message. Without a decision, it names the dimension that moved the most. |
| Expression | Shows the emotion of the affect shift on the stage model with `character:emotion`, before the reply starts. It also tells the model to open the reply with the same `<\|ACT {"emotion":...}\|>` token. |
| Proactive | Polls Dusha for proactive events and gives each one to the character as `spark:notify`. The character speaks it. |

Tools:

| Tool | Dusha route |
| --- | --- |
| `search_conversation_memory` | `POST /state/v1/memory/search` |
| `get_conversation_record` | `GET /state/v1/memory/{id}` |
| `remember_evergreen_fact` | `POST /state/v1/evergreen/facts` |
| `revise_evergreen_fact` | `POST /state/v1/evergreen/facts/{id}/revisions` |
| `forget_evergreen_fact` | `POST /state/v1/evergreen/facts/{id}/forget` |
| `review_evergreen_facts` | `GET /state/v1/evergreen/facts` |
| `evergreen_fact_history` | `GET /state/v1/evergreen/facts/{id}/history` |
| `yumecho_add` | `POST /state/v1/memo/add` |
| `yumecho_list` | `GET /state/v1/memo/list` |
| `yumecho_done` | `POST /state/v1/memo/{id}/done` |
| `affect_status` | `GET /state/v1/affect` |

Each tool returns JSON with `ok: true`, or `ok: false` with `error`. A Dusha HTTP error also gives `status`, for example `409` for a stale fact revision.

## When to use it

- Use it when you run Dusha and want the AIRI character to share memory and affect with your other Dusha harnesses.
- Use it in stage-tamagotchi. The extension host runs only in the Electron main process.

## When not to use it

- Do not use it in stage-web or stage-pocket. They have no extension host.
- Do not also point the AIRI chat provider at the Dusha OpenAI proxy. Each turn then goes into Dusha two times.

## Set up

1. Start Dusha. See the [Dusha README](https://github.com/Somme4096/dusha#quickstart).
2. Copy the server channel token from AIRI **Settings > Connection**.
3. Write the config file. The default path is `~/.config/airi-dusha/config.json`. Set `AIRI_DUSHA_CONFIG` to use a different path.

   ```json
   {
     "dusha": { "url": "http://127.0.0.1:8765", "token": "<Dusha api_token>" },
     "channel": { "token": "<AIRI server channel token>" }
   }
   ```

4. Build the extension:

   ```sh
   pnpm -F @proj-airi/airi-plugin-dusha build
   ```

5. In AIRI, open the devtools page `/devtools/plugin-host`.
6. Click **Import Folder** and select `plugins/airi-plugin-dusha/dist/extension`.
7. Click **Import Extension**, then **Enable and Load**.

After a change to the config file, click **Disable and Unload**, then **Enable and Load**.

## Config

All keys are optional. The plugin rejects unknown keys, so a typo stops the load with an error.

| Key | Default | Meaning |
| --- | --- | --- |
| `dusha.url` | `http://127.0.0.1:8765` | Dusha base URL. |
| `dusha.token` | `""` | Sent as `X-Companion-Token`. Leave it empty when Dusha has no auth. |
| `dusha.harness` | `airi` | Dusha stores conversations and proactive events under this name. After a rename, the plugin does not get events from the old name. |
| `dusha.conversationId` | `airi` | Dusha conversation ID for all AIRI chat. |
| `dusha.timeoutSeconds` | `60` | Minimum 1. Increase it when Dusha mods are slow. |
| `dusha.includeRecent` | `false` | Adds recent records to the injection. AIRI already sends its own chat history, so keep it off. |
| `channel.url` | `ws://localhost:6121/ws` | AIRI server channel. |
| `channel.token` | `""` | AIRI server channel token. |
| `proactive.enabled` | `true` | Polls and delivers proactive events. |
| `proactive.pollIntervalSeconds` | `30` | Minimum 5. |
| `expression.enabled` | `true` | Adds the affect shift and the expression hint. |
| `expression.minDelta` | `0.03` | A smaller change of the strongest dimension adds no hint. |
| `expression.emotions` | See below | Maps a Dusha dimension to an AIRI emotion. Entries merge over the defaults. |

The default map covers the dimensions of the default Dusha `emotions.json`:

| AIRI emotion | Dusha dimensions |
| --- | --- |
| `happy` | vitality, intimacy, contentment, elation, play |
| `sad` | fatigue, longing, dejection |
| `angry` | jealousy, irritability |
| `awkward` | possessiveness, lust, anxiety |
| `surprised` | fear |
| `think` | protectiveness |
| `curious` | seeking |

The AIRI emotions are `happy`, `sad`, `angry`, `think`, `surprised`, `awkward`, `question`, `curious`, and `neutral`.

## How a turn works

The plugin connects to the server channel with the identity label `chat-prepare`. Before AIRI composes a chat turn, it sends `chat:prepare:request` and waits for the answer:

1. The plugin stores the user message and finds the affect shift.
2. It sends `character:emotion`, so the stage model shows the feeling at once.
3. It sends the Dusha context with the shift hint as `context:update`.
4. It answers with `chat:prepare:response`. AIRI then composes the turn with the new context.

After the reply, the plugin stores the reply from `output:gen-ai:chat:message`.

## How the affect shift works

The plugin reads `GET /state/v1/affect` before and after it stores the user message. Then it selects the dimension that the expression follows:

1. If a Dusha decision picked an emotion, the plugin uses that emotion. An example is the `system_one` mod. The ingest response names the emotion in `affect.emotion`. The decision wins even when mod `deltas` moved another dimension further.
2. If no decision picked an emotion, the ingest response gives `affect: null`. Mod `deltas` can still move affect, so the plugin uses the dimension with the largest change in `base`.

A decided emotion always names its AIRI emotion, also when its value is at the cap. An undecided change must be at least `expression.minDelta`. Only a rise names an AIRI emotion, because no single expression shows a fading feeling.

Example hints:

```text
<affect_shift>The user's last message stirred intimacy: it rose by 0.10 to 0.45. Open your reply with <|ACT {"emotion":"happy"}|> to show it.</affect_shift>
<affect_shift>The user's last message moved irritability the most: it rose by 0.85 to 1.00. Open your reply with <|ACT {"emotion":"angry"}|> to show it.</affect_shift>
```

## Limits

These limits come from the AIRI extension API, not from Dusha:

- **Each turn waits for Dusha.** AIRI holds the turn until the plugin answers `chat:prepare:request`, or for at most 20 seconds. A slow Dusha mod, for example a model call in `decide`, delays the reply by its own time.
- **Proactive text is not archived.** AIRI does not send the spoken reaction back to plugins. The plugin acknowledges `sent` with no text. Dusha counts the send and applies its affect change, but stores no message.
- **No settings page.** Extensions cannot add one, so the config is a file.

## Development

```sh
pnpm -F @proj-airi/airi-plugin-dusha typecheck
pnpm -F @proj-airi/airi-plugin-dusha test
```

`src/index.test.ts` starts the extension in a real extension host, with a real server channel and a fake Dusha over HTTP.

To run the tools against a real Dusha, set `DUSHA_TEST_URL` and `DUSHA_TEST_TOKEN`. The test writes messages, facts, and memos, so use a new companion with no real data. The first command makes one under `/tmp`:

```sh
XDG_CONFIG_HOME=/tmp/dusha-test dusha serve test
DUSHA_TEST_URL=http://127.0.0.1:8765 pnpm -F @proj-airi/airi-plugin-dusha test
```

To load a working copy, link `dist/extension` into `<AIRI userData>/extensions/v1/airi-plugin-dusha` and turn on **Auto Reload** in the inspector.
