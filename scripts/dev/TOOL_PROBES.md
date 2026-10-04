# Local tool probes

These probes generate a random token in a local fixture file. The model receives only
the function declaration, then requests `read_local_probe({ id: "probe" })`. The local
script reads that file, returns its token, and verifies the model's final answer.
The tool accepts no arbitrary file paths and runs no shell commands.

## Entry points

- `localToolProbe.js`: fixture tool and native Gemini two-turn verifier.
- `probePlayground.js`: `runPlayground(page, fixtureDirectory, options)` drives
  Playground's real Function Calling UI, submits the local result, and checks the reply.
- `probeBuildAssistant.js`: `runAssistant(page, fixtureDirectory)` runs a JSON
  **text protocol** in an existing Build assistant conversation. It does not claim
  that Google's internal assistant RPC accepts standard native `tools` declarations.
- `probeBuildPreview.js`: `runPreview(context, options)` runs native Gemini function
  calling in the project's Build Preview. It preserves Google's preview proxy shim
  and replaces only the app entry script in the isolated diagnostic page.

Preview also has a CLI:

```powershell
node scripts/dev/probeBuildPreview.js --auth C:/path/to/storage-state.json --model gemini-3.8-flash
```

Use an authenticated Playwright page/context for the exported functions. Copied
Google cookies may display an account while generation requests fail authentication;
that failure does not establish whether the model supports tools.

## Results on 2026-10-02

| Route           | Environment                                                        | Result                                                                                                                    |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Playground      | Actual logged-in D Chrome page; selected API key; Gemini 3.8 Flash | Native function call, one real local file read, and final token reply succeeded.                                          |
| Build assistant | Actual logged-in D Chrome page; Gemini 3.8 Flash                   | JSON text protocol, one real local file read, and final token reply succeeded. Native tools transport remains unverified. |
| Build Preview   | Separate diagnostic browser using copied session state             | First generation did not respond in 30 seconds. No local tool executed; tool support remains unverified.                  |

The failed isolated-cookie Playground/assistant attempts returned authentication
errors. The successful rows above were tested again in the original signed-in Chrome.
No production server or application implementation was changed by these probes.

## Build's two areas

- Left assistant: helps develop the application. Its own tools act in Google's
  application development environment.
- Right Preview: runs the application. A chatbot inside that application can send
  its own model requests, with tools declared by that application's developer.

For either route, a tool that reads files on the user's PC must be executed by a
local client/adapter; Google's cloud runtime does not acquire local file access
merely because a tool name was mentioned.
