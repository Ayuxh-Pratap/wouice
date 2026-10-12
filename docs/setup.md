# Setup

Getting Wouice running on your own machine, and what to do when a piece of it does
not start. Start with the [README](../README.md) for what it is.

## 1. The toolchain

- **Windows 11 x64.** Nothing else is supported.
- **Node 24 or newer** (`node --version`). The store uses Node's built-in
  `node:sqlite`, which does not exist in older versions. This also means there is
  no native database module to compile.
- **An NVIDIA GPU with current drivers.** The binaries fetched are CUDA 12.4
  builds. If your driver is older, fetch the 13.3 set instead with
  `CUDA=13.3 npm run fetch:sidecars`.
- **Git** and about 8 GB of free disk.

## 2. Install

```bash
git clone https://github.com/Ayuxh-Pratap/wouice.git
cd wouice/app/v1
npm install
```

The npm workspace root is `app/v1`, not the repository root. There is no
`package.json` above it.

## 3. The sidecar binaries

```bash
npm run fetch:sidecars
```

This downloads Windows CUDA builds and unpacks them into `sidecars/`:

| Server | Where it lands | Port | From |
| --- | --- | --- | --- |
| Speech | `sidecars/whisper/Release/whisper-server.exe` | 8178 | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) |
| Text | `sidecars/llama/llama-server.exe` | 8179 | [llama.cpp](https://github.com/ggml-org/llama.cpp) |

Both listen on `127.0.0.1` only.

The script exists because two things about these downloads are easy to get wrong:
llama.cpp's "latest release" on GitHub is a marker tag holding no binaries, so the
real daily build has to be found; and llama.cpp ships its CUDA runtime DLLs in a
separate archive, without which `llama-server.exe` starts and immediately dies
looking for `cublas64_*.dll`.

## 4. The models

```bash
npm run fetch:models      # or: npm run fetch:models -- --only whisper,qwen
npm run verify            # re-checks every file against its recorded hash
```

Everything goes directly into `models/`, by exact filename. What the script
fetches:

| File | What for | Size |
| --- | --- | --- |
| `ggml-large-v3-q5_0.bin` | Speech | ~1.1 GB |
| `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | Text clean-up | ~2.5 GB |
| `gemma-3-4b-it-Q4_K_M.gguf` | Text clean-up, the other candidate | ~2.6 GB |

Two gaps to know about:

**The default speech model is not fetched.** The app's default is `turbo`
(`ggml-large-v3-turbo-q5_0.bin`), and the script deliberately fetches `large-v3`
instead, which is better at languages other than English. Either choose
**large-v3** under Settings → Models, or put the turbo file in `models/` yourself:

```
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

**The larger meeting models are not fetched either.** After a call, Wouice prefers
a bigger model for the English and the notes. If those files are absent it uses
your dictation model instead, which works but writes weaker notes. To use them,
place the files in `models/` with exactly these names:

| File | Used for |
| --- | --- |
| `google_gemma-4-E4B-it-Q6_K.gguf` | The English pass |
| `Qwen_Qwen3.5-9B-IQ4_XS.gguf` | The summary and tasks |

The full catalogue - every model, its VRAM cost and the flags it is served with -
is `app/v1/desktop/src/shared/models.ts`.

## 5. Run it

```bash
cd app/v1/desktop
npm run dev
```

Wouice starts in the tray and opens its window. The two sidecars start with it;
the dashboard shows when each is ready. First start is slow, because several GB of
model are being read from disk into the card.

There is no packaged build. `npm start` only previews a build; it is not an
installer, and the app looks for `models/` and `sidecars/` relative to the
repository folder, so keep it in the checkout.

## 6. The meeting bot, if you want it

The bot drives your real installed Chrome, because Google refuses to sign in
inside an automated browser.

1. Install Chrome if it is not there.
2. In Wouice: Settings → Meetings → the bot's profile → sign in by hand, once,
   with the account that will join your calls.
3. Meetings → paste a Meet link → send the bot.

Its profile and per-call logs live in `%APPDATA%\Wouice\bot\`.

---

## When something does not start

**Nothing is transcribed, and the speech server shows as failed.** Check Windows
Smart App Control. In enforcement mode it kills `whisper-server.exe` instantly,
with no error anywhere, because the bundled `whisper.dll` is unsigned. Turning
Smart App Control off is a one-way switch on Windows 11, so decide deliberately;
every file this project downloads is hash-checked as it is written, and
`npm run verify` re-checks them.

**`llama-server.exe` dies a second after starting.** Its CUDA runtime DLLs are
missing - re-run `npm run fetch:sidecars`, which fetches that separate archive.

**"sidecar binary not found" or "model not found".** The path is relative to the
repository root: `sidecars/...` and `models/...`. The app says which path it
looked at; the filename must match the catalogue exactly.

**Writes into the repository folder fail.** Windows Controlled Folder Access
blocks them if the checkout is under `Documents`. Move it somewhere plain, such as
`C:\dev\wouice`, which also avoids spaces in the path.

**The hotkey does nothing.** Something else owns it. Wouice falls back through
`Ctrl+Alt+D`, `Ctrl+Alt+J`, `Alt+Shift+W`, `Ctrl+Alt+Enter`, `F13` and says in the
app which one it took. If your keyboard layout turns `Ctrl+Alt` into AltGr, set a
`Ctrl+Shift` combination in Settings instead.

**A meeting records nothing from the far side.** System audio is captured through
Windows loopback, which needs the app's own handler - it is installed at startup,
so this usually means the app was started in an unusual way. Restart it.

**The model will not fit.** 6 GB holds one speech model and one text model at a
time. Wouice takes one off the card before loading another; if a load still fails
for room, the dashboard says so and keeps the model you had.
