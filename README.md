# Wouice

A personal, fully-local, Windows-only voice suite. One user, one machine, no cloud
dependency.

Three surfaces over one shared pipeline:

1. **Dictation.** Hotkey, speak, cleaned English text lands at the cursor. Hindi and
   Hinglish come out as meaning-preserving English.
2. **Meetings.** Two-channel capture, timestamped Me/Them transcripts, generated notes and
   action items you can query.
3. **Companion.** A duplex voice loop that talks back, configurable into a thinking
   partner, a tool-using agent, a persona practice partner, or an ambient assistant.

---

## Where everything lives

```
wouice/
├── docs/
│   ├── product-analysis/     what the competition built, and what we take from it
│   └── design/               what WE are building, and why
└── app/
    └── v1/                   the application  ← code goes here
```

| Go here | For |
|---|---|
| [`docs/design/02-spec.md`](docs/design/02-spec.md) | **The spec.** Contracts, schemas, prompts, failure matrix, acceptance criteria, build sequence. Start here to build. |
| [`docs/design/01-decisions.md`](docs/design/01-decisions.md) | **The decision log.** Every choice, why we made it, what we rejected, what would reverse it. Start here to understand. |
| [`docs/product-analysis/`](docs/product-analysis/README.md) | Source-level analysis of four open-source voice projects, and the patterns worth stealing |
| `app/v1/` | The application itself |

## Versioning

`app/v1/` is version one. When the architecture changes enough that it is a different
thing rather than a newer thing, it becomes `app/v2/` and v1 stays readable. Docs in
`docs/design/` describe the current version; superseded decisions are struck through in
the log rather than deleted, so the reasoning trail survives.

## Status

Design complete and approved. **Next step: the Week 1 spikes in
[spec §10](docs/design/02-spec.md).** No code written yet.

## The machine this targets

```
Windows 11 Home, build 26200        Intel i5-13450HX, 10C/16T
15.7 GB RAM                          NVIDIA RTX 3050 Laptop, 6144 MiB VRAM
node 24 · npm · python 3.14 · uv · ffmpeg · git      (no rust, no .NET)
```

6 GB of VRAM is the constraint every model choice traces back to. See
[decisions §C2 and §A8](docs/design/01-decisions.md).
