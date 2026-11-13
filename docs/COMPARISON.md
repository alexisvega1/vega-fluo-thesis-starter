# Vega Fluo vs Word, Pages and Overleaf

*Measured on one MacBook Pro (macOS 26), 13 Nov 2026, with `du`, `ps` and `curl` against a running copy.
Items in [brackets] were not measured or not verified.*

## Weight

| | Vega Fluo | Pages | Word | Overleaf |
|---|---|---|---|---|
| On disk | **~60 MB** (8.5 MB code + 52 MB libraries) + 547 MB Whisper model, only if you dictate | 442 MB | 2.8 GB | 0 (runs in the browser) |
| First page load | ~1.3 MB (785 KB script, 474 KB styles), once | — | — | [not measured] |
| Memory | Server 463 MB, most of it the full-text index of a 5,218-paper library; Whisper server 17 MB idle | [not measured] | [not measured] | one browser tab [not measured] |
| CPU at rest | 0.1 % | [not measured] | [not measured] | — |
| Needs the internet | No (only for the optional live Google Doc and phone reminders) | No | No (sign-in aside) | Yes |

How these were taken: `du -sh` on each `.app` bundle and on `node_modules`; `git ls-files | xargs du`
for the code; `ps -o rss` on the running server; `curl` for the page and its assets.

## What each is for

| | Vega Fluo | Word | Pages | Overleaf |
|---|---|---|---|---|
| Writes LaTeX (Rackham class, equations, `\cite`) | Yes | No | No | Yes |
| Where your thesis lives | Your Mac, in git, backed up to GitHub | Your disk / OneDrive | Your disk / iCloud | Overleaf's servers |
| Compile | Tectonic, local | — | — | Remote [free-plan compile time limits apply, not checked] |
| Tracked changes and comments | Yes, on the LaTeX source | Yes | Yes | Yes [track changes is a paid feature, not checked] |
| Reviewer works in Google Docs, changes come back as tracked changes | **Yes, live** | Export/import by hand | No | No |
| Suggestions shown with figure numbers, readable math, clean legends for a non-LaTeX reviewer | Yes | — | — | No |
| Full-text search of your own PDF library while writing; citations suggested for the paragraph | Yes | No | No | No |
| Dictation on the Mac (Whisper, audio never leaves the machine) | Yes | macOS dictation | macOS dictation | Browser/OS dictation |
| Spoken "Peyron et al. 1998" becomes `\citep{…}` | Yes | No | No | No |
| Writing progress: typed/dictated words, wpm, daily bar, streak, reminders (Mac and phone) | Yes | No | No | No |
| Focus tools: 45-minute Finish Game, finished-things log, parking lot | Yes | No | No | No |
| Real-time co-editing in the editor itself | No (the live Google Doc covers reviewers) | Yes (online) | Yes (iCloud) | **Yes** |
| SyncTeX-exact PDF ↔ source jump | Text-matched, not SyncTeX yet | — | — | **Yes** |
| Rich templates gallery | One (Rackham) | Many | Many | **Many** |
| Phone | Home Screen web app over Tailscale | App | App | Browser |

## Where Overleaf is still ahead
Real-time co-editing inside the editor, SyncTeX-exact jumping, a template gallery and zero setup.
These are on Vega Fluo's list (see the parking lot); the first two matter least for a single author
whose advisor reviews in Google Docs.
