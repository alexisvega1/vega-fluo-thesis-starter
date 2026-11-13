# Start your thesis with Vega Fluo in 15 minutes

Vega Fluo is a writing environment for a LaTeX dissertation that runs on your own computer. You write
LaTeX, or switch to a visual view that hides most of it. The PDF builds locally. Your advisor can
review in a Google Doc, and their suggestions come back as tracked changes on your source. This folder
is a blank University of Michigan (Rackham) dissertation to start from.

How it compares with Word, Pages and Overleaf: [`../docs/COMPARISON.md`](../docs/COMPARISON.md).

## 1. Install (about 5 minutes, macOS)

```bash
curl -fsSL https://bun.sh/install | bash        # Bun runs Vega Fluo
brew install tectonic                           # builds the PDF; fetches LaTeX packages as needed
```

Optional, for dictation:

```bash
brew install whisper-cpp
mkdir -p ~/.cache/whisper
curl -L -o ~/.cache/whisper/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

The speech model is about 550 MB. Audio never leaves your computer.

Optional, for suggestions and claim checking: a local model through [Ollama](https://ollama.com)
(`ollama pull qwen3`). Without it, the rest of Vega Fluo works as usual.

## 2. Get the thesis class (1 minute)

The Rackham class file `thesis-umich.cls` is not included here, because it carries no license
statement. Get it from the **U-M Dissertation LaTeX Template (2023)** by John Meluso and Shreyas
Kousik, which is in Overleaf's template gallery [link not checked], or from your department. Put it
in `thesis/` next to `main.tex`. Check the current Rackham formatting guidelines before you deposit.

## 3. Make it yours (5 minutes)

```bash
cp -R starter ~/my-thesis            # this folder: your thesis, settings and reference library
cd path/to/vega-fluo
bun install
bun server.ts --config ~/my-thesis/config.example.json
```

Open <http://127.0.0.1:4317>. Then:

- Replace the `[BRACKETED]` placeholders in `thesis/main.tex`: title, name, program, committee.
- Put the PDFs and `.bib` files of papers you cite in `library/`. Vega Fluo indexes them and suggests
  citations for the paragraph you are writing.
- Add your field's terms and the surnames you cite most to `vocabulary.txt`, so dictation gets them right.
- Set your name in `config.example.json` → `user.name`; it labels your comments and suggestions.
- `git init` the folder and push it to a private repository. Vega Fluo backs up to it.

## What's in the blank thesis

- `main.tex`: Rackham front matter (title page, committee, dedication, acknowledgments, preface,
  abstract, lists of figures, tables and acronyms).
- `chapters/`:
  - an Introduction, laid out as overview, background, the gap, aims (one per chapter), strategy
    and limitations;
  - three data chapters, each written as a paper with its own reference list;
  - a General Discussion organised by theme.
- `appendices/`: one appendix to start.
- `styles/`: `rackham` (the class as Rackham sets it) or `charter-color` (Charter text, coloured
  links). Switch with Cmd-K → "Thesis style".
- `packages.tex`:
  - per-chapter reference lists;
  - `\figureplaceholder{…}` for figures that aren't final yet;
  - `\figureversion{text|clean}`, to switch every figure to a version with the statistics moved
    into the legend.

## Features you'll use most

- **Visual / LaTeX view**, the PDF beside your text, and jumping between the two (→ PDF).
- **Suggest mode and comments.** Tracked changes live beside your `.tex` and never touch it until
  you accept them.
- **Live Google Doc** (optional): a readable copy for an advisor who doesn't use LaTeX. It shows
  readable math, figure numbers and clean legends. Their suggestions and comments come back as
  tracked changes. You'll need a Google Cloud OAuth client; the app explains the steps.
- **Dictation**, with voice commands ("new paragraph", "new section Results…"). Spoken citations
  such as "Smith et al. 2019" become `\citep{…}` when your library has a clear match.
- **Phone** (optional): the same editor as a Home Screen app over [Tailscale](https://tailscale.com),
  with reminders on your phone.

## Writing practice, built in

A thesis is easy to feel behind on. These tools are meant to keep the next step small and to make
finished work count:

- **A daily bar**: Easy (100 words), Normal (500) or Push (1,500). Pick Easy on a low-energy day; it
  keeps your streak just the same. A writing day ends at 4 a.m.
- **This one thing, and the 45-minute Finish Game.** Name one bounded task ("Figure 2 legend, ugly is
  fine") and press Enter. When the time is up you're asked whether it got done: if yes it becomes a
  stone; otherwise take 15 more minutes or park the rest.
- **Stones at the top**: a log of finished things, so progress is visible.
- **Parking lot** (Alt+P): ideas that would pull you off the current task, kept for later.
- **Reminders** at times you choose, only on days the bar isn't met yet.

A useful order of passes for a first draft: make it exist → make it right → make it clear → make it
pretty. Leave `[TODO]` markers rather than stopping to fix things.
