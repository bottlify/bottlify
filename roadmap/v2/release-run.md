# Release run: `cork2` before main

Status: plan, a test scenario; no code. Written 2026-10-09 for the run before `cork2` goes to main.
Every number below that is not a command's output is marked as measured on the author's machine
or as not measured.

Two questions, and the run answers both with measurements:

1. **Old programs do not regress.** In the `default` mode -- what every program runs with when
   nobody chooses -- `cork2` is no slower and no less correct than `main` on the same titles.
2. **New programs run threads at once.** In the `multi` modes the threads a program has ready
   together run on several executors, the program behaves as it does on one, and the run is
   faster where the program has the work to give them.

It is written for an agent running it unattended on a machine with a GPU. The agent changes no
code: it runs, records and reports. A failure is reported with the command that reproduces it.

## Modes

One table names them (`tools/play/modes.js`); the player, the browser harness and the node probe
read the same names:

| Mode | What | `createApp` |
| --- | --- | --- |
| `default` | one executor, the translator as shipped | -- |
| `multi2` | two executors | `executors: 2` |
| `multi` | three executors | `executors: 3` |
| `multi4` | four executors | `executors: 4` |
| `unchecked` | translated reads untested: reserved and `PAGE_NOACCESS` pages read as RAM | `cork: { checkReads: false }` |

- Harness: `node tools/cdp_test/game.mjs <bundle> --mode <name>`; node probe:
  `node tools/launch-probe.mjs <bundle> --mode <name>`. `--executors N` and `--cork-config JSON` go
  over the mode.
- Player (`node tools/play.mjs <bundle>`): the buttons at the top left, `?mode=<name>` in the
  address, or `bottlifyMode('<name>')` in the console, which reloads the page in that mode;
  `bottlifyMode()` lists the modes and says which is on.
- **Executors need a cross-origin isolated page** (a `SharedArrayBuffer`). Without one the program
  runs on one executor and the report says so: the harness prints
  `executors: REFUSED -- 3 asked, 1 run: no SharedArrayBuffer, ...`. Every harness run in a
  `multi` mode is given `--coi`; a run whose report says `REFUSED` is not a multi run and is
  reported as such, never as a result of the mode.

## 0. Conditions

Record once, at the top of the report; a field not recorded is written `not recorded`:

- `git rev-parse HEAD` of `cork2` and of `main` (the base);
- the machine: CPU model and cores (`nproc`), memory, OS, power plan;
- the GPU, its driver, and the browser with its version; the adapter the harness reports
  (`adapter:` in each report);
- `node --version`;
- each bundle's id and `indexSha256` (`bundles/<id>/manifest.json`).

Set up two checkouts side by side, the base for the comparisons:

```
git fetch origin cork2 main
git worktree add ../bottlify-main origin/main
(cd ../bottlify-main && npm ci && npm run build)
git checkout cork2 && git pull && npm ci && npm run build
export CDP_TEST_CHROME=<path to Chrome or Chromium>   # when the harness does not find one
```

Nothing else runs on the machine during a measurement. Steps 2 to 4 measure; step 1 does not.

## 1. Gates (must be green before anything is measured)

In the `cork2` checkout:

```
npm run typecheck && npm run lint && npm test && npm run test:integration \
  && npm run check:boundaries && npm run build
```

- The cork corpus once, if not fetched: `npm run fetch:corpus`.
- A red step stops the run: report the step, the failing test's name and its error, and run nothing
  else. One `todo` in core's integration set is expected (a store through NULL).
- The executor gates in particular, by name, in `modules/core`:
  `node --test src/executors.itest.js src/executors-libraries.itest.js src/executors-unshared.itest.js`.

## 2. Synthetic load: the executors themselves (node)

`tools/executor-sweep.mjs` runs T threads of a generator step and a read-modify-write over E
executors, with host calls (H, every N instructions) and a critical section (K, every N) mixed in.

```
node tools/executor-sweep.mjs --threads 1,2,3 --executors 1,2,3,4 --host 0,4096 \
  --sync 0,256 --reps 3
```

Run it twice. Report the two tables whole (every row with its three raw values), and per row the
`xN vs E=1` of both runs.

What is expected, from the author's run (4-core VM, no GPU, node 22.22.0; two rounds of 3):

- T >= 2, E >= 2: every row faster than E=1 (1.12x to 2.49x measured).
- T = 1, E >= 2: 0.78x to 1.10x measured -- an executor past one costs a program with one thread
  up to a fifth. Reported, not a failure.

A row with T >= 2 and E >= 2 below 1.0x in both runs is a finding: report it with its row.

## 3. Old programs: the translator's benchmark against main (node)

```
node tools/cork-bench/compare.mjs \
  '{"main":["--root","../bottlify-main"],"cork2":[]}' --runs 5
```

Report the table whole and the geometric mean. From the author's run (one run, `--runs 3`,
same VM): geometric mean 0.96x of main, with two known rows -- `calls4096` at 0.83x to 0.85x (the
entry hash, sized for Gothic 3's code) and `patch-x87` at 0.90x to 0.93x (present before this
branch's executor work). Any other row below 0.95x in two runs of `--runs 5` is a finding.

## 4. Programs in the browser, mode by mode

Every run is a harness run: `node tools/cdp_test/game.mjs <bundle> ...`, with `--wait` longer than
`--run-seconds`. Each prints the path of its report (`tools/cdp_test/reports/game-<stamp>.txt`) and
writes beside it the frame times (`game-<stamp>-presents.json`) and a screenshot.

From each report record: `mode:`, `executors:`, `adapter:`, `stopped:`, the run's instructions,
`present gap ms: median, p90, max`, and whether the screenshot shows what the title should be
showing at that point (look at it). Compare two arms' frames over the same span with
`node tools/frame-span.mjs <a-presents.json> <b-presents.json>`.

Each configuration runs **three times**; the report gives every run and the median. The base arm
(`main`) is the same command in `../bottlify-main` with the `--mode` flag removed (main has no
modes; its default is the `default` mode).

Run the titles whose bundles are in `bundles/`; a title without one is `not run (no bundle)`.

### 4.1 Gothic 3 demo (`g3`) -- threads: physics (PhysX) and sound (FMOD) beside the game

The route from the menu into the world needs the save the scenario was built on in
`dbg/g3/save/` (`G3_World_01_0001.g3sav` and `.g3savdat`); without it run the menu route only and
say so.

World route (about 48 minutes a run):

```
G='C:\Documents and Settings\User\My Documents\gothic3'
node tools/cdp_test/game.mjs g3 --worker --coi --screen 1024x768 --memory 2048 \
  --run-seconds 2850 --wait 3300 \
  --click 511,458,400 --click 656,138,450 --click 169,281,500 \
  --file "dbg/g3/save/G3_World_01_0001.g3sav=$G\\G3_World_01_0001.g3sav" \
  --file "dbg/g3/save/G3_World_01_0001.g3savdat=$G\\G3_World_01_0001.g3savdat" \
  --snap-from-start --snap-frame 6200 --snap-every 400 --snap-count 8 --profile-calls \
  --mode <MODE>
```

Menu route (about 5 minutes): the same without the three `--click`s and the `--file`s, with
`--run-seconds 300 --wait 600`.

Modes: `default` (and the base arm), `multi2`, `multi`, `multi4`. What the author saw, in
headless Chromium on SwiftShader (no GPU): the world drawn intact on three executors; frame times
there are a software rasteriser's and say nothing of a GPU's. **Not measured: any of this on a
GPU.**

### 4.2 Tron 2.0 demo (`tron-demo`) -- launcher, then the game in a process of its own

```
node tools/cdp_test/game.mjs tron-demo --entry TRON.exe \
  --command-line '"C:\App\TRON.exe"' --worker --coi --concurrency 2 \
  --click-at 521,158,9000 --click-at 320,401,13000 --run-seconds 90 --wait 400 --mode <MODE>
```

Modes: `default` (and the base arm), `multi`. The author found this title's frame times noisy run
to run; report the spread, and draw no conclusion from one run.

### 4.3 Doom 3 demo (`doom-3-demo`) -- OpenGL

No click route is recorded for the browser: the run measures the start and what the title shows
without input.

```
node tools/cdp_test/game.mjs doom-3-demo --worker --coi --run-seconds 120 --wait 400 --mode <MODE>
```

Modes: `default` (and the base arm), `multi`. In node the same title is measured by
`node tools/launch-probe.mjs doom-3-demo --concurrency 2 --seconds 60 --mode <MODE>`.

### 4.4 Dungeon Siege demo (`dungeon-siege-demo`) -- page protection

The title reads pages it reserved without access and expects the fault; translated code tests
reads by default since 2026-10-10 (`unchecked` turns that off).

```
node tools/cdp_test/game.mjs dungeon-siege-demo --worker --coi --run-seconds 300 --wait 600 \
  --mode <MODE>
```

Modes: `default`, `multi`, `unchecked`. Expected: `default` and `multi` go past that read;
`unchecked` may stop on it (report where). Missing entry points this title asks for are known and are not
findings of this run.

### 4.5 The triangle (`tri-e2e`) -- the smallest program that draws

```
node tools/cdp_test/game.mjs tri-e2e --worker --coi --run-seconds 15 --wait 120 --mode <MODE>
```

Every mode once: the report must say `stopped: exited with 0` and, in the `multi` modes,
`executors: N, ...` -- not `REFUSED`.

### 4.6 Titles run by the person: Gothic 3 (full game), Call of Duty 2, Call of Duty 4, Need for Speed Underground 2

No route for these is recorded in the repository: the bundle id, the entry and the clicks are the
person's, and the author has run none of them on this branch. Each is run the same way as the
titles above, with the route filled in, so its rows land in the same report:

```
node tools/cdp_test/game.mjs <bundle> [--entry <exe in the bundle>] --worker --coi \
  [--click x,y,frame | --click-at x,y,ms ...] [--file HOST=GUEST ...] \
  --run-seconds <S> --wait <S + 300> --mode <MODE>
```

- Modes: `default` on both arms, then `multi2`, `multi`, `multi4` on `cork2`.
- Or in the player, by hand: `node tools/play.mjs <bundle>`, the mode chosen by its button or
  `bottlifyMode('<name>')`; a person's run records the same fields (mode, what the screen showed,
  the frame rate the title itself reports if it has a counter) and says it was a manual run.
- What to read in each report beyond step 4's fields: the threads the title has (the `threads`
  line, by state), and in a `multi` mode the `executors:` line -- how many slices ran on the
  others and the most threads at once. A title whose threads mostly wait gives the executors
  little; that is a measurement, not a finding.
- For a title new to the harness, `node tools/launch-probe.mjs <bundle>` first: its import list
  says whether the title is expected to start at all on this branch.

## 5. What counts as a finding

- A gate red (step 1).
- In `default`, a title that `main` takes further than `cork2` (a different `stopped:`, a later
  screen on `main`'s screenshot), or a median present gap worse than `main`'s by more than the
  spread of the two arms' three runs.
- In a `multi` mode, a title that ends differently from `default` (a fault, a hang, a
  `deadlock:` in `stopped:`, a different screen), or a report saying `REFUSED` on a `--coi` run.
- In a `multi` mode on a title with threads (Gothic 3, Tron), `executors:` reporting `0 slices on
  the others` -- the executors were there and took nothing.
- Anything the screenshots show that the `default` run's do not: missing geometry, black
  surfaces, corrupted textures.

## 6. The report

One file, `release-run-<date>.md`, outside the repository (or in `roadmap/00-*`, which git does not
take), in this order:

1. Conditions (step 0), every field.
2. Gates: each command and its result.
3. Synthetic load: both tables, and the rows that are findings.
4. Benchmark: the table and the geometric mean.
5. Per title, a table:

   | Arm | Mode | Run | `stopped:` | `executors:` | instructions | gap median / p90 / max ms | screen |
   | --- | --- | --- | --- | --- | --- | --- | --- |

   then the median per arm and mode, and `frame-span` between `main default` and each `cork2` mode.
6. Findings (step 5), each with the command that reproduces it and the report's path.
7. What was not run, and why.

Every figure carries its run count and its conditions; a figure not measured is written
`not measured`, never estimated.
