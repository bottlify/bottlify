# win32-listen

What a program asks of the system, heard at the engine's door. It runs a program in Node,
headless and unattended, and writes down every request the program makes of the engine's
Windows: each host call with the guest address it came from, its arguments (as text where an
argument was text), the answer, the last error and the thread, and the run's events (processes,
message boxes, unimplemented entries, unresolved imports, faults, the exit).

It only listens. The answers are whatever this build gives; nothing here changes one. Use it on a
program's first run, before deciding what to implement for it: the registry keys it reads, the
files it opens, the libraries and functions it looks up, the processes and named objects it
reaches for, and where it stopped.

```
node tools/win32-listen/listen.mjs <program.exe> [--dir DIR] [--out DIR] [--seconds 120]
    [--turns N] [--args '...'] [--guest-words] [--print REGEX] [--tail 40]
```

| flag | default | what it does |
| --- | --- | --- |
| `--dir DIR` | none | every file of DIR put beside the program before it starts (its own libraries, data) |
| `--out DIR` | `dbg/listen` | where the four files below go |
| `--seconds N` | 120 | wall-clock bound of the run |
| `--turns N` | none | scheduler turns bound of the run |
| `--args '...'` | none | what follows the program's path on its command line |
| `--guest-words` | off | keep WaitForSingleObject, SetEvent, ResetEvent and ReleaseMutex answered in the guest, as a player runs; off by default so those calls are heard |
| `--print REGEX` | off | also print the calls whose name matches as they happen |
| `--tail N` | 40 | how many of the last calls to print when the run ends |

| file | what it holds |
| --- | --- |
| `calls.jsonl` | one call a line, in the order they happened across every process and thread: `seq`, `t` (ms since start), `image`, `thread`, `name`, `from`, `args`, `strings`, `kind`, `answer`, `error` |
| `timeline.txt` | the same, a line a call as a person reads it |
| `summary.txt` | each request once, by question (`registry`, `file`, `module`, `process`, `ipc`, `crypto`, `debug`, `ui`, `environment`, `network`, `thread`, `memory`, `clock`, `other`), in the order first made, with how often and every answer it got |
| `events.jsonl` | the engine's events, a fault with its trace |

What it does not hear: the program's own code, and the calls the engine answers in guest code
without crossing to the host (heap, SList, slim locks, and the handle words unless
`--guest-words` is left off). It hears through `createApp`'s `onCall` with `traceStrings`, which
peeks every pointer argument for text; a run is slower for it (a few microseconds a call), so it
is a tool for a bring-up, not for a measurement.

The sorting into questions is `classify.mjs`, tested by `classify.test.js` (`npm run test:tools`).
