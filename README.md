# Wouice

A voice suite for Windows that runs entirely on your own machine. Speak, and clean
English text lands where your cursor is. Record a meeting, and get a transcript,
a summary and the tasks that came out of it. Nothing is uploaded, and there is no
account, no API key and no subscription: the speech model and the language model
run on your GPU.

It was built for one machine - a laptop with an NVIDIA RTX 3050 and 6 GB of VRAM -
and every model choice traces back to fitting in that card.

> **Status: working, but early.** There is no installer yet; you run it from the
> source. It is Windows-only by design. See [Limits](#limits).

---

## What it does

**Dictation.** Press `Ctrl+Alt+W`, speak, release. The words are transcribed by
[whisper.cpp](https://github.com/ggml-org/whisper.cpp), tidied by a local language
model, and typed into whatever window you were in. Speak Hindi or Hinglish and the
text comes out as English that keeps your meaning. `Escape` cancels.

**Meetings.** Press `Ctrl+Alt+M` to record a meeting. You and the other side are
captured as separate channels, so the transcript says who said what. Afterwards,
Wouice swaps in a larger model and writes the English, a summary and the tasks -
each task carrying the line it came from.

**A meeting bot.** Instead of recording your own speakers, Wouice can send a bot
into a Google Meet. It joins with its own Chrome profile, takes Meet's own live
captions, and leaves when the call ends - then writes the same notes.

**Vocabulary.** The names and words your meetings use - people, products, tools -
kept in one place, so the models spell them right instead of inventing something
that sounds similar. It learns candidates from your meetings and asks before
adding them.

**A desktop companion.** A small character sits at the edge of the screen and
shows what is happening. Tap it to dictate.

---

## What makes it different

- **Nothing leaves the machine.** No cloud API is called for speech or text. The
  only network traffic is the one-off model download, and Google Meet if you use
  the bot.
- **Every stage falls back, no stage fails.** If the language model stalls, you
  still get the corrected transcript rather than nothing.
- **A summary you can check.** Each key point carries the line it came from; click
  the time and the transcript jumps there. Points the code cannot verify against
  what was said are dropped rather than guessed at.
- **It reports on itself.** Latency, VRAM, what each model did and where a pass
  failed are recorded per meeting, and readable in the app.

---

## What you need

| | |
| --- | --- |
| **OS** | Windows 11 x64. Not macOS or Linux: text injection, audio loopback and process control are written against Windows. |
| **GPU** | An NVIDIA card with CUDA. 6 GB of VRAM is enough and is what it was tuned on. |
| **Node** | 24 or newer. The database uses Node's built-in SQLite, so older versions will not run it. |
| **Disk** | About 8 GB for the models and sidecar binaries. |
| **Chrome** | Only for the meeting bot, and it must be signed in by hand once. |

---

## Setup

```bash
git clone https://github.com/Ayuxh-Pratap/wouice.git
cd wouice/app/v1
npm install
npm run fetch:all      # whisper.cpp + llama.cpp binaries, then the models (~6 GB)
npm run verify         # checks every download against its recorded hash
```

`npm install` runs in `app/v1`, not the repository root.

**One thing to know after fetching.** `fetch:models` downloads Whisper `large-v3`,
while the app's default setting is `turbo`, which it does not download. Either pick
**large-v3** under Settings → Models on first run, or download the turbo file into
`models/`:

```
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

Then start it:

```bash
cd desktop
npm run dev
```

Wouice lives in the tray. The window is the dashboard; closing it leaves the app
running.

Full detail, including the larger meeting models and what to do when a model will
not load, is in **[docs/setup.md](docs/setup.md)**.

---

## Using it

| Action | How |
| --- | --- |
| Dictate | Hold `Ctrl+Alt+W`, speak, release. Or tap the companion. |
| Cancel a dictation | `Escape`, while it is listening or transcribing |
| Record a meeting | `Ctrl+Alt+M` |
| Send the bot to a Meet | Meetings → paste the Meet link → Send the bot |
| Read a meeting | Meetings → open it: Summary, Tasks and Transcript |
| Fix a spelling for good | Vocabulary → add the word, with how it is misheard |
| Change models, microphone, hotkeys | Settings |

If a hotkey is already taken by something else, Wouice picks the next one in a
fallback list and tells you which it took.

---

## How it works

```
hotkey ─> microphone ─> whisper.cpp (:8178) ─> corrections ─> local LLM (:8179) ─> typed into your window
```

Two local servers do the heavy work: **whisper.cpp** for speech and
**llama.cpp** for text. Wouice starts them, watches them, restarts them when they
die, and swaps their models - never holding two on the card at once, because
6 GB does not allow it.

After a meeting it pauses dictation, takes the small models off the GPU, loads a
larger one, renders the English line by line, writes the summary and the tasks,
then puts dictation back exactly as it was - whether that worked, failed or was
cancelled.

The inside of it, flow by flow, is in
**[docs/architecture.md](docs/architecture.md)**.

---

## Where things are

```
wouice/
├── app/v1/              the application; npm workspace root - install and run here
│   ├── desktop/         the Electron app
│   │   └── src/
│   │       ├── main/        sidecars, dictation, capture, injection, meetings, the bot
│   │       ├── preload/     the one bridge the page is allowed to call
│   │       ├── renderer/    the React interface
│   │       └── shared/      the model catalogue, settings, the IPC contract
│   ├── packages/        asr · llm · dictionary · store
│   └── scripts/         fetching models and binaries, benchmarks, probes
├── docs/                setup and architecture
├── models/              model weights you fetch (not in the repository)
└── sidecars/            whisper.cpp and llama.cpp binaries you fetch (not in the repository)
```

Your data stays in `%APPDATA%\Wouice`: `wouice.db` (SQLite - dictations, meetings,
tasks, vocabulary), `settings.json`, `meetings/` (recordings), and `bot/` (the
bot's Chrome profile and run logs). Deleting that folder resets the app.

---

## Developing

```bash
cd app/v1
npm test            # 1000+ tests, no GPU needed
npm run typecheck   # the packages
cd desktop && npm run typecheck && npm run build
```

Tests run without models or sidecars: the model is faked, and the rules are tested
on their own.

---

## Limits

- **No installer.** It runs from the checkout, and finds its models and binaries
  relative to the repository folder.
- **Windows only**, and one user per machine.
- **One GPU's worth of models.** On 6 GB, speech and text models take turns.
- **The Companion surface is not built yet.** It is listed in the app and does
  nothing.
- **Hindi and Hinglish are what the English pass was tuned on.** Other languages
  are whatever Whisper and the model give you.
- **The meeting bot depends on Google Meet's page.** When Meet changes, the bot
  needs changing with it.

---

## Licence

MIT - see [LICENSE](LICENSE). The character sprites and the models are other
people's work under their own terms; see [NOTICE.md](NOTICE.md) before
redistributing.
