# Notices

Wouice's own code is under the [MIT licence](LICENSE). A few things in and around
this repository are not Wouice's to license, and are listed here.

## Character sprites

`app/v1/desktop/src/renderer/assets/pet/` holds three sprite sheets for the desktop
companion. Two of them depict characters belonging to other people:

| File | Character | Owner |
| ---- | --------- | ----- |
| `kurisu.webp` | Kurisu Makise, *Steins;Gate* | 5pb. / Nitroplus |
| `bulbasaur.webp` | Bulbasaur, *Pokémon* | Nintendo / Creatures / GAME FREAK |
| `codette.webp` | Codette | included with the project |

The MIT licence above covers Wouice's code, **not** those two characters, and no
claim of ownership or endorsement is made. They are placeholders used while
building the companion. If you own one of them and would rather it were not here,
open an issue and it will be removed.

To run Wouice without them, pick another character under Settings, or drop your own
sprite sheet and its JSON beside the others - see `app/v1/desktop/src/shared/pet.ts`
for the format.

## Models and sidecars

Wouice ships no model weights and no binaries. It downloads and runs:

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) - MIT
- [llama.cpp](https://github.com/ggml-org/llama.cpp) - MIT

and loads model files you fetch yourself, each under its own licence:

- Whisper models (OpenAI, MIT)
- Qwen3 (Alibaba, Apache 2.0)
- Gemma (Google, [Gemma Terms of Use](https://ai.google.dev/gemma/terms))

Read the licence of any model you download; the Gemma terms in particular place
conditions on use and redistribution.
