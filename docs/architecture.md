# How Wouice works

The shape of the app, and the two flows that matter: a dictation, and what happens
after a meeting. For installing it, see [setup.md](setup.md).

## The pieces

```
                 ┌──────────────────────────────────────────┐
   your voice ──>│ Electron main process                     │
                 │                                           │
                 │  dictation ─ capture ─ injection          │
                 │  meetings  ─ bot     ─ vocabulary         │
                 │  sidecar supervisor ──┬── whisper.cpp :8178
                 │                       └── llama.cpp   :8179
                 │  SQLite (node:sqlite)                     │
                 └───────────────┬──────────────────────────┘
                                 │ one preload bridge
                 ┌───────────────┴──────────────────────────┐
                 │ renderer: React interface, HUD companion  │
                 └───────────────────────────────────────────┘
```

**Main process** owns everything with power: the microphone, the two model
servers, the database, typing into other applications, and the meeting bot.

**Renderer** is an ordinary React application with no access to files or
processes. It talks to main through a single bridge exposed in preload, and the
build fails if renderer code imports the database or any Node module.

**Sidecars** are two local HTTP servers. The supervisor starts them, polls their
health, restarts them with a backoff, and swaps models - stopping the running
server and waiting for the process to exit before starting the next, so two models
never hold VRAM at the same time.

**Packages** under `app/v1/packages/`:

| Package | What it is |
| --- | --- |
| `asr` | The whisper.cpp client, and WAV handling |
| `llm` | The OpenAI-compatible client, the prompts, streaming, the token budget |
| `dictionary` | Phrase corrections, and biasing the speech model towards your words |
| `store` | SQLite: dictations, meetings, transcripts, tasks, vocabulary, metrics |

They are consumed as TypeScript source and bundled into the app, not built
separately.

## A dictation

1. **The hotkey** is caught globally, or you tap the companion - the same path.
2. **Audio** is captured in frames; a silence policy decides where a chunk ends.
3. **Speech** goes to whisper.cpp, with your vocabulary offered as a hint.
4. **Corrections** from your dictionary are applied to the raw text.
5. **Clean-up** goes to the local language model: fix the speech model's mistakes,
   turn Hindi or Hinglish into English, keep the meaning.
6. **Injection** types the result into the window you were in, through the Windows
   input API, falling back to the clipboard where that does not work.

Two rules hold this together. **Every stage falls back and no stage fails**: if
clean-up stalls you get the corrected transcript, and if correction has nothing to
say you get the raw transcript. And **every result carries the session it belongs
to** and is thrown away if that session is gone - which is what makes `Escape`
actually cancel rather than merely appear to.

## A meeting, and what happens after

While recording, each side is captured separately, so the transcript knows who
spoke. With the bot, the lines come from Meet's own captions instead, assembled
into turns as the caption panel shows them, with Meet's late corrections applied
to lines already stored.

When the call ends, the after-call pass runs, in this order and always inside one
try/finally so dictation comes back whatever happens:

1. **Pause dictation** and take the small models off the card.
2. **Load a larger model** - the best one that measurably fits, checked against the
   card before and after loading, not assumed.
3. **English**, one request per line, several in flight at once, with the lines
   before each as context.
4. **Notes**: the transcript in chunks; per chunk the key points and the work
   items; then one pass that writes the summary.
5. **Restore** the dictation models from your settings.

The summary is checked rather than trusted. Each key point must quote a line it
came from, and share words with it; a point whose quote is not in its lines is
dropped. Sentences in the short summary may only use numbers, names and claims
that the points behind them support. What fails a check is left out - the result
is a shorter summary, never an invented one.

## Where state lives

Everything is under `%APPDATA%\Wouice`:

| | |
| --- | --- |
| `wouice.db` | SQLite, write-ahead logging on: dictations, meetings, transcripts, tasks, vocabulary, metrics |
| `settings.json` | Your settings; a damaged file is merged over the defaults rather than refusing to start |
| `meetings/` | One folder per recording |
| `bot/` | The bot's Chrome profile and a folder per call with its log and screenshots |

Models and sidecar binaries are not here - they sit in the repository checkout, in
`models/` and `sidecars/`.

## Choices worth knowing

- **Node's built-in SQLite**, so there is no native module to rebuild against
  Electron and no Windows build toolchain in the setup.
- **One instance only.** A second would fight over the hotkey and the sidecar
  ports.
- **The vocabulary is offered, never imposed.** Only entries whose spelling or
  sound appears in the text are sent to a model, at most thirty at a time: a long
  list makes models "correct" words into names nobody said.
- **Nothing is deleted to make something look better.** A line the speech model
  wrote over silence is marked, not removed; captions Meet dropped are kept and
  dimmed; a summary point that fails its check is dropped rather than patched.
