# Negative results

Ideas that were measured and did not pay. The file is appended to: a later measurement of the
same idea is a new, dated entry with its own conditions, because a result can depend on the
browser, the driver and the machine, and a no today is not a no for ever. Once, on 2026-11-14,
the owner had it compressed and every entry given a verdict (below); nothing was dropped.

Each entry gives, and writes `not recorded` for what was not saved rather than reconstructing it:

- the date, the workload and the bundle's hash;
- the baseline and the candidate, every raw value, how many runs, the median and the spread, and
  the noise floor of the campaign;
- the browser, the GPU and driver, the operating system and the power plan;
- what was checked for correctness beside the speed;
- the decision: removed, off by default, or left.

A measurement later found wrong goes under **Invalidated**, with the reason, and is not used as
evidence again.

Audit of 2026-11-14: each heading ends with a verdict. **VALID** - the conditions still hold;
the entry is kept to its conditions, raw values, decision and a "revisit when". **STALE** - the
code or conditions it measured changed, or a later commit reversed its decision (superseded);
kept whole with the reason at its top. **DISPUTED** - inconclusive against its own noise, or the
reasoning does not follow from the numbers; kept whole, to be measured again. **INVALIDATED** -
under Invalidated, as a pointer. Entries are in date order; none was dropped.

## Entries

### 2026-10-05 - the system's side of a link waits blocking while calls are recent [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** One run an arm, a 15 us difference of medians inside the p90s, no
  noise floor, a scratch benchmark in node on a Firecracker VM. The same mechanism - look or block
  for a while before an asynchronous sleep - later paid in the executor channel (`lookFor`,
  d4bc2788, 2026-10-22), and `system/link.js` is still how a process in a worker of its own calls
  the engine thread. Re-measure: the link's answer after a pause in Chrome on the M4 and on the
  Parallels VM, `waitAsync` against a bounded `Atomics.wait` look (0.05 and 1 ms, as `lookFor`), 10
  runs an arm, p50 and p90.

- **Idea.** A process in a worker of its own waits 200-500 us for each answer from the engine
  thread that comes after a pause, while the answer itself takes about 12 us. The guess was that
  `Atomics.waitAsync`, on which the engine thread sleeps, wakes slowly, and that blocking on the
  doorbell with `Atomics.wait` (1 ms at a time, the event loop given a turn between) for 50 ms after
  the last call would wake faster.
- **Workload.** A scratch benchmark, not a bundle: one worker calls the engine thread through
  `system/link.js` 300 times, 2 ms of busy work between calls, the handler returning a number.
  Bundle hash: not applicable.
- **Values.** One run each. `waitAsync` (baseline): median 181 us, p90 271 us. Blocking wait
  (candidate): median 196 us, p90 317 us. Spread and noise floor: not recorded.
- **Machine.** Node 22.22.0, a 4-core Linux VM (Firecracker). No browser, no GPU. Power plan: not
  recorded.
- **Why it did not pay.** What costs is waking a sleeping thread in this VM, about 100 us each way,
  whichever call it sleeps in.
- **Correctness.** Not checked; the candidate never left the scratch benchmark.
- **Decision.** Removed. Instead, the calls were taken off the link: the volume's reads are kept
  per drive revision, and opens are settled in shared memory.

### 2026-10-07 - a second executor for Doom 3 and Tron [STALE]

- **Audit 2026-11-14: STALE (superseded).** The counts stand; the decision does not: a527bd121
  (2026-10-16) gives a run that names no cores one fewer than the host's processors (at most eight)
  where the page can share memory, for every title. No re-measurement for the decision; whether the
  scheduler's `parallel` counters survive was not checked.

- **Idea.** Stage 3 of roadmap v2: a process whose threads are ready at the same time runs them on
  two executors. It pays only where two or more of a program's threads are ready for much of the
  time.
- **Workload.** `doom-3-demo` (bundle sha256 `1b34af89...`, `Doom3.exe`, to its menu, and again
  with `+map game/demo_mars_city1`, whether the map loaded not confirmed) and `tron-demo` (`fd154abf...`, `Lithtech.exe` with the
  manifest's command line), each in node through `tools/launch-probe.mjs --series` with
  `--no-raster`, cork at `cork2` f39364f2 with the counters of 540762f9. The scheduler's
  `parallel` counts every slice's host time by how many threads could have run during it.
- **Values.** One run per scenario, rows every 2-3 s. Share of slice time with two or more threads
  ready: Doom 3 to the menu 0-4 % per row (main thread 100 % busy, its other two threads blocked
  nearly throughout); Doom 3 with the map 0-9 % while loading, 1-2 % after; Tron 0-3 %, 1 % after
  loading. Spread across runs and the noise floor: not recorded.
- **Machine.** Node 22.22.0, a 4-core x86-64 Linux VM. No browser, no GPU. Power plan: not
  recorded.
- **Why it would not pay.** With at most a few percent of the time spent with two threads ready,
  Amdahl's law gives a second executor almost nothing, and the atomic variant's tax (not yet
  measured) would make the one busy thread slower.
- **Correctness.** Not applicable: nothing was built, only counted.
- **Decision.** Stage 3 is not started for these titles. The counters stay, so that a title with
  more parallel threads shows it.

### 2026-10-07 - several translation workers for one process, on four cores [STALE]

- **Audit 2026-11-14: STALE.** Four cores only, where one translator already took the spare core.
  The pool was reworked since (1b5378e25, 2026-11-09: at most the host's cores less two for the
  whole run, a resting process gives back its first worker) and the decision's premise, a machine
  with cores to spare, was never measured. Re-measure: a cold load of two titles on the M4, 1 / 2 /
  3 translators lent, seconds to a fixed instruction mark, 3 runs an arm alternated.

- **Idea.** Roadmap v2, stage 2: while a game loads, its one translation worker is busy most of
  the time with work queued behind its batch, so two or three workers, each with a batch of its
  own out and one cache arena between them, would load it sooner.
- **Workload.** `doom-3-demo` (`Doom3.exe`, the manifest's command line) and `tron-demo`
  (`Lithtech.exe`, the manifest's command line), each started cold in node with an empty
  in-memory translation store, `cork.config` `{ feed: 'slice', timings: true, worker: true,
  translators: N }`, `graphics.raster` false, 40 s; the mark is the second at which the guest had
  retired 4.85 G instructions (Doom 3, the end of its loading) or 2.8 G (Tron). `cork2` at
  `4ef1b2f1` (the arena, and the check that a candidate a batch out holds is not formed again;
  the translation worker was reworked to serve ports while the rounds ran, its own scope's
  messages handled as before); N = 1, 2, 3 in turn, three rounds.
- **Values.** Seconds to the mark, three runs each, median in brackets. Doom 3: N=1 14, 16, 18
  (16); N=2 16, 20, 18 (18); N=3 17, 21, 18 (18). Tron: N=1 25, 27, 27 (27); N=2 29, 27, 30 (29);
  N=3 30, 30, 34 (30). The regions published were alike (Doom 3 5440-5827, Tron 4506-5713), but
  the workers' emitting per region grew: Doom 3 1.97-2.57 ms with one, 3.18-3.80 with two,
  3.81-4.94 with three; Tron 1.74-2.14, 2.41-3.46, 3.08-3.97. Cores in use by the whole process,
  sampled each second over a 25 s Doom 3 run, one run each: 2.5-3.6 with one translator while
  loading, 3.3-3.8 with two. The same emitting with no engine, in 1-4 threads at once (the bench
  programs' regions, 12 rounds): 3.20, 6.65, 7.65 and 7.30 rounds a second in all. Noise floor:
  not recorded; the first round without the arena ran 15-23 s for Doom 3 with one translator.
- **Machine.** Node 22.22.0, a 4-core x86-64 Linux VM (Firecracker). No browser, no GPU. Power
  plan: not recorded.
- **Why it did not pay.** On four cores one translator already leaves no core free while a game
  loads: the engine thread, the translator and V8's own threads (compiling the program's modules,
  collecting) take 2.5-3.6 of them. A second translator runs on a core it takes from them, and
  every region costs it more. In isolation two emitters run twice as fast as one.
- **Correctness.** The gates of `translators.test.js` and `arena.test.js` pass.
- **Decision.** Kept, for machines with cores to spare: the pool lends a process more workers
  only where the median rule says they are busy and a check of the yield after each join says the
  process's translation went faster -- on this machine, a joined worker leaves again.

### 2026-10-08 - bundle blocks decoded in the pool rather than on the reading thread [STALE]

- **Audit 2026-11-14: STALE.** Node, the JavaScript decoder, one run a title, loading only. In the
  browser a bundle is read through OPFS and fetch with `--prefetch`, and frames dropped waiting on
  bundle blocks are counted (24-44 a 3DMark2001 SE run, 2026-11-06); what decoding costs the reading
  thread in play was not measured. Re-measure: `decodeMs` and the drops named `fetch` in a browser
  speed run of one title, 3 runs, before deciding whether decoding ahead pays.

- **Idea.** Roadmap v2, stage 2: the zstd blocks a guest read waits for are decoded synchronously
  on the thread that mounted the bundle; decoded in the pool's workers, ahead of the reads, they
  would cost that thread nothing.
- **Workload.** `doom-3-demo` (`Doom3.exe`) and `tron-demo` (`Lithtech.exe`), the manifests' command
  lines, each started cold in node with an empty in-memory translation store, one translator,
  40 s, `cork2` at `aadc3621`; the counts are the app layer's `decoded`, `decodedBytes` and
  `decodeMs` (the JavaScript decoder, which cork uses: `zstd.wasm` is not pinned in this
  checkout).
- **Values.** One run each. Doom 3: 36 blocks, 8.7 MB decoded, 183 ms of the 40 s (0.5 %). Tron:
  207 blocks, 52.5 MB, 460 ms (1.2 %). Spread and noise floor: not recorded.
- **Machine.** Node 22.22.0, a 4-core x86-64 Linux VM (Firecracker). No browser, no GPU. Power
  plan: not recorded.
- **Why it would not pay.** At most about one percent of the reading thread's time while these
  games load, against a read path that answers synchronously today and would have to wait for a
  worker or guess what is read next.
- **Correctness.** Not applicable: only counted.
- **Decision.** Not built. The counts stay in the diagnostics, to be looked at again for a title
  that reads more of its bundle compressed.

### 2026-10-08 - an executor waiting in place for its next slice, rather than through its event loop [VALID]

- **Measured.** A remote executor waiting with `Atomics.wait` up to 2 ms before `waitAsync`.
  `tools/executor-sweep.mjs`, two threads, 400 M iterations, no lock or host call, `executors` 1 / 2
  / 3, `cork2` b497c50e, node 22.22.0, 4-core Firecracker VM, one run each (s): quantum 100 000
  before 1.23 / 2.77 / 1.69 (1.17 / 2.83 / 1.74 in a second series), after 1.23 / 2.78 / 1.76;
  quantum 1 000 000 before 1.00 / 1.40 / 0.77, after 0.98 / 1.57 / 0.82. Timed apart: about 38 us a
  slice in the two handoffs of a round trip, whichever way the worker waited.
- **Decision.** Kept as the idle loop's first wait, not counted as the fix; what paid was fewer
  round trips (`goOn`, a short look). The wait rule is `lookFor` since 2026-10-22.
- **Revisit when.** No need.

### 2026-10-08 - more threads than other executors, or one other executor [STALE]

- **Audit 2026-11-14: STALE.** Its host-call points were invalidated (the 2026-10-16 record:
  GetTickCount never left the executor), and the reason given (the process's executor runs no
  thread; an executor with more than one thread hands each quantum back) describes a scheduler
  rewritten since: the first thread on the process's executor, threads kept there by their rate of
  host calls, a free host, recalls. Re-measure: `executor-sweep.mjs` (GetACP) T 1-4 against E 1-4 on
  the current scheduler, 3-5 runs a point, on the VM and the M4.

- **Idea.** Roadmap v2, stage 3: any number of executors past the process's own would be at least
  as fast as one.
- **Workload.** `tools/executor-sweep.mjs` at `cork2` `b497c50e` plus the slice chaining (the
  commit that adds the tool), 400 M iterations in all over T threads, every combination of T 1-3,
  `executors` E 1-4, a `lock add` every 256 iterations or never, a host call every 65 536 or 4 096
  or never; three runs each, E alternating.
- **Values.** Medians against E=1 for the same T: E=2 with T=2 or 3, x0.64 to x0.86 in every
  combination (e.g. T=2, no lock, no call: 1.20 s against 1.55 s, raw 1.55 1.53 1.62); T=3 on E=3
  x1.18 to x1.47, below T=3 on E=4 (x1.88 to x2.58).
- **Machine.** Node 22.22.0, a 4-core x86-64 Linux VM (Firecracker). No browser. Power plan:
  not recorded.
- **Why it did not pay.** The process's own executor runs no thread, so E=2 is one executor taking
  turns; and an executor with more threads than one to run hands each quantum back to the
  process for the switch, a round trip each, where the process's own executor switches in place.
- **Correctness.** Every run of the sweep exited with the same checksum.
- **Decision.** The mode choice (stage 3) gives a process one executor or one past the process's
  own for each thread it keeps ready at once, never two in all.

### 2026-10-08 - a loop with a call out stays a loop under callReturn [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** Three alternated pairs with a headless Chromium game running on
  the same cores beside both arms; the module grew 3256 -> 5666 bytes and the slowdown was not
  looked into. Regions changed a great deal since (`planPaths`, `returnToCall`, the loop-edge work
  of 2026-10-29). Re-measure: the same loop's bytes in `pair.mjs` (one thread, paired rounds) on the
  current tree, the return address `reentered` against a root, with callgrind counts as the
  deterministic arm.

- **Idea.** `planStructure` makes the return address of a call that leaves the region a root, so
  a loop holding such a call on a cold path is no natural loop and each turn of it goes through
  the region's dispatch (`br_table`). Under `callReturn` the call is a wasm call and comes back
  inside the function, from outside only when the turn ended under it; taking its return address
  as `reentered` (the copies enter it, as a predicted call's) would keep the loop a wasm loop.
- **Workload.** `dbg/g3/hotloop.mjs` (not committed): the bytes of the Engine.dll linear search at
  0x305FBF4D (Gothic 3 demo; 9 instructions an iteration, two calls on the found path) in an outer
  loop, 2100 records, 200 000 searches, 4.2 G iterations, through `createMachine` at `cork2`
  `e8fbb0cc`.
- **Values.** ns an iteration, base then change, three pairs alternating: 3.98 / 6.00, 4.12 /
  5.19, 3.82 / 5.58. Medians 3.98 against 5.58.
- **Machine.** Node 22.22.0, a 4-core x86-64 Linux VM (Firecracker); a headless Chromium run of
  the game was going on beside it on the same cores for both arms. Power plan: not recorded.
- **Why it did not pay.** Not found: the module grew from 3256 to 5666 bytes (the copies), and
  the change was not looked into further.
- **Correctness.** Not run beyond the timing harness.
- **Decision.** Reverted; the dispatch stays.

### 2026-10-09 - the startup stub on a read-only page, for an IsBadWritePtr probe [VALID]

- **Measured.** A SecuROM 7 check calls `IsBadWritePtr(<process-startup base> + 2, 1)`. One harness
  run, `--worker --coi`, headed Chrome, bundle index sha256 f9862be8...: with the startup stub moved
  to a read-execute page the probe still names the arena's base + 2, the PEB's `BeingDebugged` byte,
  writable on Windows, so the answer 0 was already right; the program's error 8007 unchanged. GPU,
  driver, power plan not recorded.
- **Decision.** Not kept.
- **Revisit when.** Never on this ground: the check fails elsewhere.

### 2026-10-09 - not waiting for a render-target copy that stays on the GPU [VALID]

- **Measured.** Not waiting for a `CopyRects` out of a render target that stays on the GPU
  (`copySurface`). RC demo bundle cb83b58a..., main menu, 90 s, harness `--worker --coi`, headed
  Chrome, one run an arm: waits 13 834 before, 13 484 after; average frame 10.87 against 10.81 ms,
  inside run-to-run noise. The title copies into a system-memory surface and locks it read-only
  about 250 times a second: a real read-back the change does not touch. GPU, driver, power plan not
  recorded.
- **Decision.** Not kept.
- **Revisit when.** A profile shows waits on GPU-only copies that nothing locks afterwards.

### 2026-10-09 - Sleep(0) yielding to a ready thread of the caller's priority or higher [STALE]

- **Audit 2026-11-14: STALE (reversed without an entry).** Sleep(0) has yielded to a ready thread of
  the caller's priority or higher since aae122924 (2026-10-15, `yieldTurn` in
  `kernel32/process.js`), and returns in the guest when no thread waits (b31bc3d0b, 2026-10-17). The
  Gothic 3 world load this entry saw stall (one run an arm, one executor, SwiftShader) was not
  measured again. Re-measure: Gothic 3 to its world on the current build with several executors,
  time to the world and Sleep counts, 2 runs, as a new entry.

- **Idea.** `Sleep(0)` returned at once and yielded nothing, so a thread polling another's
  progress -- `do Sleep(0); while (!scene->checkResults(..., false))`, the main thread of the
  Gothic 3 demo waiting on its physics thread -- kept the one executor for its quantum, two host
  calls a look. Windows' single-processor rule (go behind a ready thread of the caller's priority
  or higher) would let the other thread run at once.
- **Workload.** The Gothic 3 demo, bundle `g3`, loading `G3_World_01_0001` and running on in the
  world: `tools/cdp_test/game.mjs g3 --worker --coi --screen 1024x768 --memory 2048
  --run-seconds 2850 --profile-calls`, `cork2` at `1f8012c5` (base) and `f9f13803` (change), one
  run each.
- **Values.** Base: the world from about frame 6200, 1174 world frames, median 1162 ms, p90 1340
  ms; Sleep 71.6 M calls, WaitForSingleObject 71.8 M, 248 s of sampled host time between them.
  Change: Sleep 34.0 M, WaitForSingleObject 34.2 M, 251 s; the load bar full by the end but the
  world never shown in 2850 s, 6026 frames, the last ones about 7.5 s each.
- **Machine.** Headless Chromium 141 (`/opt/pw-browsers/chromium-1194`), SwiftShader, a 4-core
  x86-64 Linux VM (Firecracker). Power plan: not recorded.
- **Why it did not pay.** Not measured; the likeliest reading is that a ready thread of higher
  priority (the run has one at 15) now takes a whole quantum every time the poller yields, where
  on a machine of several processors it runs beside it.
- **Correctness.** The kernel32 and win32 unit tests passed; the game did not reach its world.
- **Decision.** Reverted. The poll stays a cost to remove another way: a thread's progress made
  visible to the poller, or the polled thread on an executor of its own (stage 3).

### 2026-10-09 - client arrays read once a glLockArraysEXT rather than once a draw [VALID]

- **Measured.** Client arrays read once a `glLockArraysEXT` rather than once a draw.
  `tools/graphics-node-bench.mjs --scenes gl-tess --modes remote --draws 600 --frames 30 --warm 10
  --reps 3`, fastest of 3, `cork2` 8b9091b4, node 22.22.0, 4-core VM: program thread 6.64 -> 6.78 ms
  a frame, worker 15.74 -> 15.16 ms, 3842 -> 2505 KiB a frame. Noise floor not measured.
- **Decision.** Reverted: the copy is not where a draw's time goes on either side.
- **Revisit when.** A profile shows client-array copies on either thread.

### 2026-10-10 - reading a fence target back ahead, as each frame is presented [VALID]

- **Measured.** Reading two 16x16 fence targets back ahead at each present. Live launcher, headed
  Chrome in the Parallels VM, RC demo cb83b58a..., first level "Find slaver camp" standing, three 30
  s samples an arm, frame interval of the last 599 frames (`app.presented()`). Without: median 25.9
  / 26.7 / 26.8 ms, CopyRects waits 2 238 / 2 098 / 2 100 per 30 s (10.7-12.5 s waited). With,
  holding the chain: 30.0 / 29.5 / 29.7 ms, waits 938 / 958 / 960; releasing at submit: 29.3 / 30.0
  / 30.2 ms; read-backs 4.3 ms each before, 5.7 ms with it. The recording runs a frame or two ahead
  of the played device, so read-aheads land after the copy that wanted them and each adds a
  read-back. GPU model, driver, power plan not recorded.
- **Decision.** Not kept; kept beside it: a copy out of a target nothing has drawn into since its
  last read-back is answered from its memory (`createTargetReads`).
- **Revisit when.** The played device runs in step with the recording, or a read-back costs less
  than here.

### 2026-10-11 - a draw's reads of a dynamic buffer lent to the graphics worker, not compared [STALE]

- **Audit 2026-11-14: STALE.** The stash is still 16 MiB (`STASH_BYTES`), but what a draw compares
  has changed: written pages kept as bits and the mirror's stamps (b0fb3aeb8, 2026-10-23), index
  ranges kept under a write watch (6e6b067d2), allocations under 64 KB copied rather than lent
  (2bb4398a5). The entry's own next step, comparing less by knowing which pages were written, was
  built. Re-measure: CoD4 The Bog with `r_skinCache 1`, bytes compared and copied and the program
  thread's graphics overhead per guest second, lent against copied, 2 runs an arm.

- **Idea.** Where guest memory is shared, the ranges draws read of dynamic vertex and index
  buffers go to the graphics worker as lends (`lending.js`), read in place before the call is
  played, instead of being compared with a copy on the program's thread and the differences
  copied into the batch (`3c3e58d8`).
- **Workload.** Call of Duty 4 demo, The Bog, `r_skinCache 1`, `tools/cdp_test/game.mjs
  --worker --graphics-worker --coi --screen 1024x768 --run-seconds 1000`, CPU profile of the
  program's thread from 850 s to 1000 s; one run each arm. Bundle: `cod4-demo`, hash not
  recorded.
- **Values.** Before (`87210346`): of 62.3 s busy, guest 33.0 s; comparison 5.74 s, recording
  1.38 s, postMessage 3.22 s -- 0.31 s of graphics overhead per second of guest. After: of
  46.1 s busy, guest 23.2 s; recording 3.37 s, copies of guest memory (`accessors.js`) 1.59 s,
  postMessage 2.48 s -- 0.32 s per second of guest. Batches: 8.64 GB before, 13.63 GB after;
  bytes copied for draws 0.87 GB before, 4.56 GB after; bytes compared 18.97 GB before, 0 after.
  Noise floor: not measured.
- **Machine.** Headless Chromium 141 on SwiftShader, a 4-core x86-64 Linux VM (Firecracker).
  Power plan: not recorded.
- **Why it did not pay.** Draws in the level read hundreds of megabytes of dynamic buffers a
  frame (19 GB compared in the run). The stash a lend reserves room in holds 16 MB, so most
  lends found no room and fell back to copying the range whole: the comparison became a copy
  of the same bytes.
- **Correctness.** The replay contract gate passed in every way, lent ways included.
- **Decision.** Reverted; the bytes compared stay counted (`shipped.compared`). What would pay is
  comparing less: knowing which pages the program wrote, an experiment of its own.

### 2026-10-11 - an unlock of a dynamic vertex buffer that sends and uploads nothing [VALID]

- **Measured.** A dynamic vertex buffer's unlock sending nothing (`abandon`, 4d3426b0). Far Cry demo
  menu and Warcraft III: The Frozen Throne, live, by eye, one or two runs each way, Chrome on the
  Parallels host and guest: the menu's border quads and WC3's textures flicker about once a second;
  bisected to 4d3426b0; `?guestTraps=locks` hides it, `?graphicsWorker=off` does not; the seam gates
  passed with it. No frame rate measured.
- **Decision.** Reverted (964f9dc5): a quad read an earlier cycle of the buffer.
- **Revisit when.** Only with a gate case that fails on it.

### 2026-10-11 - a store into code drops only the regions whose bytes it changed [STALE]

- **Audit 2026-11-14: STALE (superseded).** Landed again the same day as e7ae7813b with the case it
  got wrong (a variable written between two functions kept the page as code; such a store is now
  judged against a copy of the page), and that is how stores into code work today
  (`docs/architecture/cork.md`). The 2 fps here is explained by that case. No re-measurement needed;
  the decision here is not in force.

- **Idea.** `80a50546` (cork): a store into translated code invalidates only the regions whose
  bytes it changed, not every region over the page.
- **Workload.** Far Cry demo in a level, launcher, live runs; bundle hash not recorded.
- **Values.** Not measured with numbers: in the level the frame rate fell to about 2 fps with it.
  `review` at `13ff4938`, `4d3426b0` reverted, `184985de`, `1f27b953`, `25aaa058` and `1b781d92`
  taken on their own: normal frame rate; the same with `80a50546` (the cork2 merge `207a09e9`,
  dropped unpushed): about 2 fps. One run each, the user's reading of the overlay.
- **Machine.** Chrome on the Parallels host; GPU, driver and power plan not recorded.
- **Why it did not pay.** Not profiled. Likely the per-store check of which bytes changed, or
  regions dropped and rebuilt on each store, on code Far Cry writes into or beside.
- **Correctness.** Not checked beyond the frame rate.
- **Decision.** Left out of `review`; with cork to measure (exits, invalidations, the guest
  profile on Far Cry in a level) before it comes back.

### 2026-10-11 - patched code sites formed apart, and store-dropped regions formed again with copies [STALE]

- **Audit 2026-11-14: STALE.** The reason given (every region formed again compiled at once on the
  thread) belonged to the cork host of the time; translation now runs in workers, and e7ae7813b
  changed what a store drops. The mixer's case was solved by the wasm interpreter's MMX forms.
  Re-measure only if a patched loop shows interpreted again: `dfxlike4` on the current runtime, both
  ideas, 3 runs.

- **Idea.** A mixer that turns a voice on or off writes a jump over the voice's block (or the
  load back) at the block's head, inside its whole loop's region, which every such change
  drops. (1) Sites a program's own store has changed (`patched` of `formRegion`) end every
  region that reaches them, and the region headed by one is its one block, so a change drops
  that block alone. (2) Instead, a region the program's store dropped is formed again with
  copies, so its loop's head has an entry the interpreter meets at the loop's next turn.
- **Workload.** A synthetic of the mixer's shape (`dfxlike4`): eight voice blocks of MMX in a
  1024-turn loop, called 2000 times, an indirect call a turn, the position's overflow returning
  through a pushed address into the block's head, four voices jumped over, one voice toggled
  every N calls; the cork host in Node 22 alone, three runs of the baseline, one of each idea.
- **Values.** Baseline (after `e7ae7813`): toggled every call 38.6 s, every 8 calls 12.5 s,
  every 64 calls 0.76 s. (1): 39.0 s, 33.9 s, 29.3 s -- the regions after each site, and the
  rest of the loop, ran on the interpreter. (2): 39.2 s, 10.9 s, 2.83 s; the dropped regions
  had no closed blocks (`closed` empty), so the copies changed nothing that counted.
  Noise floor: not measured.
- **Machine.** A 4-core x86-64 Linux VM (Firecracker), Node 22. Power plan: not recorded.
- **Why it did not pay.** In this host every region formed again is compiled at once on the
  thread, so a change costs its regions' compile, and the turns between run interpreted;
  splitting the loop made more regions and more interpreted entries, not fewer.
- **Decision.** Both reverted. What paid was the interpreter's own speed on MMX: the wasm tier
  runs the MMX forms (the every-call case 38.6 s to 3.1 s).

### 2026-10-12 - callees formed in two and three levels deep (`formDepth`) [VALID]

- **Measured.** `formDepth` 1 / 2 / 3. cork-bench in the browser (`suite.mjs --scale 10 --reps 3`),
  all eight workloads, both builds, `cork2` 7ea60178, headless Chromium 141.0.7390.37 on
  SwiftShader, 4-core Firecracker VM: geomean 1531 / 1530 / 1526 MIPS (best of three); noise between
  reps 13.1% at the median, 24.3% at most (144 runs); the gate counts calls out 3074 / 1358 / 668 /
  267 for depths 0-3 over 40 seeds; every checksum the processor's.
- **Decision.** Left at 1; confirmed on Crysis on 2026-10-23 (`formDepth` 2).
- **Revisit when.** Forming stops copying a callee's code into every caller.

### 2026-10-12 - predicted virtual calls (`callTargets`) on cork-bench [STALE]

- **Audit 2026-11-14: STALE (superseded).** `callTargets` has been on by default since b73438e6 (the
  2026-10-14 Chromium entries); this benchmark result agrees with the 2026-10-14 benchmark entry
  (the whole bench unchanged). Its own doubt is carried by those entries, not this one.

- **Idea.** Far Cry's counts put a third of its calls out of a region at indirect calls with no
  callee predicted; `callTargets` samples them and forms their few callees in. Its README row said
  benchmarks of virtual calls gained 4-5x and games were slower; the plan's step 1c was to find why
  games were slower and turn it on.
- **Workload.** cork-bench in the browser, `--scale 10 --reps 3`, both builds, all workloads, one
  bundle `head` of `cork2` at `08b89c40`, `callTargets` off against on, interleaved. Bundle hash:
  not recorded.
- **Values.** Best of three, MIPS, off / on: x87 vm 3373/3211, entities 772/814, math 1862/1925,
  path 2331/2348, lz 4274/4258, containers 2102/2172, spread 325/348, api 729/755; sse vm
  3255/3069, entities 753/748, math 2290/2224, path 2250/2336, lz 4514/4434, containers 2030/2115,
  spread 341/322, api 744/790. Geomean 1507 / 1521 (1.01x). Noise: reps of one configuration and
  workload 7.6% apart at the median, 20.5% at most (96 runs).
- **Machine.** Headless Chromium 141.0.7390.37 on SwiftShader, a 4-core x86-64 Linux VM
  (Firecracker). Power plan: not recorded.
- **Why it did not pay.** `entities`, the virtual-call workload, is no faster: a node run with
  `blockProfile` shows every one of its calls out unpredicted and the call's cost in the call and
  return code (`call [m]` 379 bytes, `ret imm` 193), which predicting a target does not shorten
  where the callee is not formed in. The 4-5x the README named was not reproduced here.
- **Correctness.** Every checksum the processor's.
- **Decision.** Left off.

### 2026-10-12 - transfers inside a placed module as direct tail calls (`dispatch`) on cork-bench [STALE]

- **Audit 2026-11-14: STALE.** Off on the desktop still, but the iOS path now runs `dispatch: true`
  with `crossTailCalls: false` (`modules/core/src/app.js`). A game measurement of 2026-09-26, before
  this file (7c3df9ee7: WoW start to menu, dispatch alone 57% of the frame rate with neither on,
  cause not found), is cited by `runtime.js`'s comment and is in no entry here. Re-measure: the iOS
  settings in WebKit, `dispatch` on against off with `crossTailCalls: false`, cork-bench paired and
  one title in play, 5 runs an arm; and the 2026-09-26 game result on today's runtime, written down
  as an entry either way.

- **Idea.** A node profile of `spread` put about a quarter of its wasm time in the module's shared
  transfer (the entry hash's probe and `return_call_indirect`); `dispatch` places a module in a
  range of the table and makes a transfer inside it a direct tail call.
- **Workload.** As above, `dispatch` off against on.
- **Values.** Best of three, MIPS, off / on: x87 vm 3156/3274, entities 801/814, math 1831/1890,
  path 2335/2274, lz 4360/4515, containers 2192/2241, spread 354/347, api 770/768; sse vm
  3200/3311, entities 782/737, math 2278/2205, path 2274/2221, lz 4494/4366, containers 2098/2078,
  spread 346/322, api 758/751. Geomean 1530 / 1520 (0.99x). Noise: 5.3% at the median, 12.7% at
  most (96 runs).
- **Machine.** Headless Chromium 141.0.7390.37 on SwiftShader, a 4-core x86-64 Linux VM
  (Firecracker). Power plan: not recorded.
- **Why it did not pay.** Not found; the node profile's share of the transfer did not turn into
  time Chromium saves.
- **Correctness.** Every checksum the processor's.
- **Decision.** Left off.

### 2026-10-13 - every register in wasm parameters across guest calls (calling-convention bench, x64) [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** The rule committed before the runs needed both machines to build
  but one to reject, and only the x64 VM was run; the M4 (arm64, where V8 may pass more wasm
  parameters in registers, and the machine the product is measured on) never was. Long mode,
  priority 1, has sixteen guest registers, which changes the arms. Re-measure:
  `modules/cork/bench/calls` on the M4 in Chrome, depth 8, farcry and spread, 9 runs, `inspect.mjs`
  on arm64; and a 16-register arm for long mode.

- **Idea.** A function tier: a guest call becomes a wasm call that carries all eight registers
  and the budget in parameters and results, instead of cork's state block, spilled registers
  and the transfer's hash probe. Measured before building it, with the decision rule in
  `modules/cork/bench/calls/README.md` committed before the runs (`cef7b45f`).
- **Workload.** `modules/cork/bench/calls` at `a5022c56` (`calls.mjs` sha256 `0b74a3d39a0fd4d7…`,
  `profiles.json` `4fd316bc3ee68f9b…`): the call shapes of the Far Cry block profile and of
  cork-bench spread and entities, from `tools/cork-calls.mjs`; chains of depth 2, 8 and 32; arms
  `state`, `state-direct`, `params`, `params+flags`, all ending with the same registers. 9 runs
  of ~200 ms after 5 warming runs; nanoseconds a guest call.
- **Values (TurboFan, depth 8, median of 9, spread = (max − min) / median).**
  Node 22.22.0 (V8 12.4.254.21): farcry state 47.9 (17%), state-direct 39.4 (25%), params 42.7
  (43%) -- params/state 0.892, params/state-direct 1.085; spread state 65.8 (34%), state-direct
  56.4 (13%), params 45.7 (40%) -- 0.695, 0.809. Chromium 141.0.7390.37 headless: farcry 48.4
  (21%), 43.2 (24%), 41.5 (25%) -- 0.857, 0.959; spread 65.9 (34%), 58.7 (22%), 50.7 (33%) --
  0.770, 0.864. Liftoff, the other depths, entities and params+flags are in the runs' JSON and
  were not decided on (Chromium Liftoff farcry params/state-direct 0.799, spread 0.939). The
  Node TurboFan run overlapped for about a minute with `inspect.mjs` (one core of four); the
  Chromium run, alone, gives the same answer. Noise floor: the spread of one arm, 13–43%.
- **Machine.** A 4-core x86-64 Linux VM (Firecracker), Intel Xeon @ 2.80 GHz; power plan not
  recorded. `inspect.mjs` on this V8: no argument on the stack up to 5 parameters, then one
  `push` for each past the fifth.
- **Why it did not pay.** On x64 V8 passes only five wasm parameters in registers; the rest go
  through the stack at every call, which is the memory the state block uses anyway. What the
  arms do show, inside the noise, is the transfer's probe (`state` over `state-direct`,
  ~10–15% of a call), not the convention.
- **Decision.** Not built: by the rule, `params` above 0.90 of `state-direct` for farcry on one
  machine is negative (1.085 Node, 0.959 Chromium). The M4 (arm64) run is recorded when it
  comes, and does not reopen this; a reason to come back would be a new rule.

### 2026-10-13 - loading only what is live after a call (plan step 2a/2b), its ceiling [STALE]

- **Audit 2026-11-14: STALE (superseded).** Step 2a/2b was built on 2026-10-29 as `planPaths`
  (d4643f20b): ways out store what a way to them wrote, a call's return reloads what is read after
  it (lua -1.84%, calls512-scatter -5.24% machine instructions; the 2026-10-29 entry on the chain of
  stores). The ceiling here (0.95-0.98 of a call's time) agrees that the gain is small. No
  re-measurement needed.

- **Idea.** `roadmap/cork/README.md` step 2: keep cork's call, but after the return load only
  the registers the continuation reads before it writes them, and write back before a call only
  the dirty ones. Measured as a ceiling before any translator code: the arm `state-live` of
  `modules/cork/bench/calls` reloads only esp and the workload's `live after a return`
  registers and no flags, more than the step can reach. Rule committed before the run
  (`12194b8a`, `modules/cork/bench/calls/README.md`).
- **Workload.** The bench at `12194b8a`, depth 8, the Far Cry, spread and entities call shapes;
  `paired.mjs`: `state` and `state-live` alternated in 15 pairs of ~200 ms runs after 3 warming
  pairs; TurboFan (`--no-liftoff`).
- **Values.** Ratio `state-live` / `state` per pair, median [min .. max], pairs it won: farcry
  0.984 [0.759 .. 1.292], 10 of 15; spread 0.972 [0.780 .. 1.100], 12 of 15; entities 0.950
  [0.847 .. 1.139], 12 of 15. A smoke run before it (3 pairs, 50 ms, farcry) gave 0.967–0.970.
  Every pair's times are in the run's JSON (not committed).
- **Machine.** A 4-core x86-64 Linux VM (Firecracker), Intel Xeon @ 2.80 GHz, Node 22.22.0
  (V8 12.4.254.21); power plan not recorded. Chromium not run: the rule checks it only after
  Node passes.
- **Why it did not pay.** Eleven loads from the state block, hits in the first-level cache, are
  2–5% of a call whose cost is the transfer's probe, the shadow stack and the call itself. At
  ~13% of Far Cry's hot bytes in calls that is under 1% of its guest time.
- **Decision.** Step 2a/2b not built (rule: median at most 0.90 and 13 of 15 pairs, for farcry
  and spread). Step 2c (the shadow stack's depth and the budget in one comparison) is a smaller
  part of the same call and is left with it.

### 2026-10-13 - indirect call prediction (`callTargets`) in Far Cry, and its knobs, while the sampling took the last calls before a reading [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** The knob and leaf-limit runs were made while the sampling was
  broken (it took the calls just before each reading), as the entry found afterwards; after the fix
  (cb208adb) only the defaults were measured again. `predictShare` and `predictCallees` are gone;
  `predictAfter`, `callWindow` and the leaf limits (`LEAF_BLOCKS`, `LEAF_BYTES`; 32 / 1024 tried
  here) were never measured with the sampling right. Re-measure: Far Cry in Chromium `--fake-gpu`,
  leaf limits 16 / 512 against 32 / 1024 with `callTargets` on, cold and warm, 3 pairs a phase
  (noise about 6% a pair).

- **Idea.** cork's optional `callTargets`: indirect calls sampled, and a callee that takes a share
  of a site's samples formed into the regions holding the site behind a compare. Measured on a
  game with the GPU out of the way, then the knobs that decide which sites are formed again
  (`predictShare`, `predictCallees`, `reforms`) and the leaf limits (`LEAF_BLOCKS`, `LEAF_BYTES`
  in `modules/cork/src/region.js`) loosened.
- **Workload.** The Far Cry demo bundle (`bundle.btl` sha256 `44530097b2a5a284…`) under
  `tools/launch-probe.mjs --no-draw`, started into the level by its command line (`map fort`),
  one executor and a translation worker, cold (no translation store). The level is in by
  330–420 s; guest MIPS in rows of the run's series from 420 s to the end of the run.
- **Values, prediction on and off** (tree `1e368204`, no block profile, rows of 30 s, 15 rows an
  arm, one run an arm, off first). Off: 169.8 164.5 180.2 175.4 176.8 172.2 177.4 176.0 167.9 166.0
  166.8 169.9 166.0 158.4 163.9 -- median 169.8, spread (max − min) / median 13%. On: 166.7 160.8
  161.0 171.8 171.7 165.7 160.1 168.9 169.5 153.9 153.4 168.5 151.4 161.6 164.8 -- median 164.8,
  spread 12%. On / off 0.971, inside the spread of one run.
- **Values, the knobs** (tree `80d60f6f`, block profile from 420 s, its counts over the window;
  share = `CALL_PREDICTED` / (`CALL_PREDICTED` + `APART_UNPREDICTED`)). Defaults: 19.5M
  predicted, 139.0M unpredicted, share 12.3%, window MIPS 127.0 136.0 136.6 135.2 129.1 129.0.
  `predictShare` 16, `predictCallees` 8, `reforms` 8: 20.2M, 137.8M, 12.8%; MIPS 119.7 125.6
  125.9 129.6 131.1 120.3 102.5. Leaf limits 32 blocks and 1024 bytes (a local change, not
  committed): 18.5M, 129.4M, 12.5%; transfers through the shared function 479.0M against
  519.9M (−8%); MIPS 128.7 125.7 128.1 122.1 134.1 123.9. One run each; the noise floor between
  runs of one setting not measured (two runs of the defaults on neighbouring trees gave window
  medians 137 and 120).
- **Machine.** A 4-core x86-64 Linux VM (Firecracker), Intel Xeon @ 2.80 GHz, Node 22.22.0
  (V8 12.4.254.21). No GPU: `draw: false`. Power plan not recorded.
- **Correctness.** Every run reached the level (the game's own debug output says so) and ran in
  it to the end of the run; cork's unit tests and the forming gate passed on both committed trees.
  The leaf-limit change was checked by the run alone.
- **Why it did not pay.** Found afterwards with a log of the sampled sites (`ac1cc0de`): a
  reading took the sixteen pairs written last, the calls just before it, so a site called
  right before every reading took the samples (up to 10^5 times its share of the calls), and
  64.8% of the window's indirect call executions were at sites that never came due. Knobs that act
  on the sites that came due could not move a share decided by which sites came due.
- **Decision.** Knobs and leaf limits left as they were. The sampling picks its calls by a hash
  of a count across the last thousand (`cb208adb`), measured anew in a later entry.

### 2026-10-13 - indirect call prediction (`callTargets`) in Far Cry at a 44% share of its calls [STALE]

- **Audit 2026-11-14: STALE (superseded).** Node only; the Chromium measurement of 2026-10-14 turned
  `callTargets` on by default. The doubt over that default is in those entries.

- **Idea.** The earlier entry's prediction, with what kept its share at 12–16% fixed: calls
  sampled past the prediction rather than every call of a predicted site (`0f3712db`), each
  region holding a call asked by what it has itself (`c9371c7e`), and room past a region's caps
  for the callees the runtime predicted (`9b222a46`). The question is whether forming more of
  the indirect calls' callees in runs the game faster.
- **Workload.** The Far Cry demo bundle (`bundle.btl` sha256 `44530097b2a5a284…`) under
  `tools/launch-probe.mjs --no-draw` at `9b222a46`, started into the level by its command line
  (`map fort`), one executor and a translation worker, 900 s, guest MIPS in rows of 30 s. The two
  arms ran at once on the same machine, so that what drifts drifts for both; cold, each arm into
  an empty translation store (`--translation-store`), then warm from the store its cold run left
  (on: 16215 hits, 2935 misses; off: 16164 and 2527).
- **Share.** A run of its own with the block profile (from 600 s): `CALL_PREDICTED` 63.7M
  against `APART_UNPREDICTED` 81.5M, 43.9% of the indirect calls predicted (12.3–16% before);
  transfers through the shared function ~10.2 a thousand guest instructions (~11.0 before).
- **Values, cold** (rows 541–1051 s, 18 rows, inside the level for both). On: 138.0 137.1 128.6
  130.1 131.3 130.4 145.7 149.3 142.9 130.9 136.6 144.4 131.3 136.2 131.8 135.9 126.0 139.5 --
  median 136.1, spread (max − min) / median 17%. Off: 141.5 125.4 135.4 143.2 137.6 127.9 135.1
  135.7 150.5 142.4 139.6 150.7 147.9 143.0 139.7 151.5 144.3 156.8 -- median 141.9, spread 22%.
  On / off 0.958; on ahead in 4 rows of 18. The translator did as little in the window in both.
- **Values, warm** (rows 390–1050 s, 23 rows; the level was in by 360 s warm, by 510 s cold).
  On: 151.0 150.0 140.5 151.3 148.9 137.4 132.0 125.0 141.4 137.5 135.5 147.6 154.1 144.3 142.2
  156.8 149.8 147.5 153.1 154.2 146.2 150.3 146.2 -- median 147.5, spread 22%. Off: 154.6 145.9
  148.4 142.2 141.7 141.8 150.3 136.1 143.2 150.8 155.9 153.6 149.0 150.1 142.7 151.0 154.2 150.0
  162.2 163.0 154.4 146.6 160.3 -- median 150.1, spread 18%. On / off 0.983, by row a median of
  0.969; on ahead in 6 rows of 23.
- **Machine.** A 4-core x86-64 Linux VM (Firecracker), Intel Xeon @ 2.80 GHz, Node 22.22.0
  (V8 12.4.254.21). No GPU: `draw: false`. Power plan not recorded. One pair a phase: the
  noise floor between pairs not measured.
- **Correctness.** Both arms reached the level and ran in it to the end; cork's unit tests
  (597), the forming gate with its two predicted paths and the code-writes gate passed at the
  tree measured.
- **Why it did not pay.** The ceiling is small: the shared transfer function was ~5% of the
  worker's time in an earlier profile of this game, and unpredicted indirect calls are about a
  quarter of its transfers, so forming every one of them in is worth 1–2% at most. Against that
  stand regions grown by the callees formed in, the compares before each predicted call and the
  sampling of the calls left; which of them costs the 2–4% was not separated.
- **Decision.** `callTargets` stays off by default, a choice a run makes. The three changes
  stay: they make the option do what it says (the sampling reached the sites it was missing),
  each with its test, and the gate runs its paths.

### 2026-10-13 - a call out's cost in Far Cry: a smaller entry hash, and the callee found from the call's own site [STALE]

- **Audit 2026-11-14: STALE (superseded in part).** The call-site lookup reverted here (fb81120b)
  was built again as `linkedCalls` (a33c94938, 2026-10-23, on by default). The hash-size result
  (2^20 and 2^18 alike) stands. No re-measurement needed.

- **Idea.** In a CPU profile of Far Cry in its level the module's transfer -- the entry hash's
  probe and one indirect tail call for every call out of a module -- was 10% of the program's
  thread, ~30 ns a transfer at ~3 million a second (a share of the time of the thread that runs
  the program; the rate from the block profile's count a thousand instructions). Two guesses at
  why: the hash's 12 MB missing the cache, and one indirect jump for every callee, which the
  processor cannot predict.
- **Workload.** The Far Cry demo bundle (`bundle.btl` sha256 `44530097b2a5a284…`) under
  `tools/launch-probe.mjs --no-draw`, started into the level (`map fort`), one executor and a
  translation worker, cold, a V8 CPU profile of 240 s from 600 s (`--cpu-profile`), two arms run
  at once on the same machine; trees `110cde3b` and `eb1f9dbd`.
- **Values, the hash.** 2^20 slots (12 MB) against 2^18 (3 MB, `hashSlots`; every one of the
  ~200 000 entries fitted in both): the transfer 9.9% and 10.3% of the thread, regions 58.3% and
  58.6%; MIPS in the level the same within the rows (300.3–304.3 and 295.9–307.0 at the end).
- **Values, the site.** A call out to a known address read the slot its address hashes to from
  its own site and, the key and the x87 top matching, called the slot's function through the
  table from there (`eb1f9dbd`). Transfer 10.2% → 7.4% of the thread, regions 57.9% → 60.4%,
  wasm in all 68.9% → 68.7%; guest MIPS 280.8 → 284.9 (median of 8 rows of 30 s, 601–811 s;
  per row 0.931–1.083, ahead in 5 of 8). A loop of call sites in cork's machine did gain: 1
  site 19.0/22.3 → 16.1/16.7 ns a call, 16 sites 24.9/24.5 → 16.4/16.7, 64 sites none
  (36.0/40.3 against 40.0/36.7).
- **What it showed.** A transfer table of N one-instruction callees through one site costs
  21 ns a call at N = 1, 29 ns at 64 in order and 46 at random, 67 ns at 1024 in order and 91 at
  random: past a few callees the cost is the jump into code far from the last, in order as much
  as at random, and it is paid wherever the call is made from.
- **Machine.** A 4-core x86-64 Linux VM (Firecracker), Intel Xeon @ 2.80 GHz, Node 22.22.0
  (V8 12.4.254.21). No GPU: `draw: false`. Power plan not recorded. One pair each.
- **Correctness.** Cork's unit tests (597), the forming gate (with the site path counted taken)
  and the x86 corpus passed with the site's lookup.
- **Decision.** Reverted (`fb81120b`, cache version back to 85); `hashSlots` left at 2^20.
  Fewer calls out is what is left of this cost, and forming more in already did not pay
  (`callTargets`, above).

### 2026-10-13 - larger regions for an interpreter: every region's caps doubled, and room only for the blocks a call returns to [VALID]

- **Measured.** Lua's `luaV_execute` cut by the region caps (128 blocks, 8192 bytes): (a) caps
  doubled for every region, (b) room past the caps for blocks a call returns to. cork-bench
  12d1ea54, the `lua` image of 7e19106c, `run-cork.mjs` (not committed), node 22.22.0, 4-core Xeon
  2.80 GHz VM. Median per-frame ms, frames 201-600, four processes an arm: base 9.18 / 9.03 / 9.81 /
  9.73, (b) 9.14 / 9.17 / 9.25 / 9.07, (a) 8.23 / 8.52 / 8.07 / 8.75; transfers through the hash
  12.60 M / 11.93 M / 10.13 M. The whole bench under (a): steady geomean 1.089 (load-x87 3.28,
  game-x87 1.91, calls512-scatter 1.22, fmath-x87 1.10; str-x87 0.86, crc-x87 0.91), cold 1.037.
  Noise: a whole-run mean up to 15%, per-frame medians under 9%.
- **Decision.** Neither built; room past the caps for the entry's own function instead.
- **Revisit when.** Regions can grow without recompiling the larger module (see the 2026-10-23
  hot-callee entries).

### 2026-10-14 - An indexed draw's dynamic vertices compared over the range its indices name (optional) [STALE]

- **Audit 2026-11-14: STALE (superseded).** Reading the indices became the path for such draws and
  was made cheaper on 2026-10-21 by keeping the ranges under a write watch (`namedRange`,
  6e6b067d2). The road streaks were later seen in builds without any of this right after a level
  loads (the 2026-10-17 invalidation record). No re-measurement needed.

- **Idea.** A recording that sends a dynamic buffer's changed bytes with each draw
  (`drawsFrom`) compares the draw's declared vertex range against what was sent. A Direct3D 9
  program that declares most of a buffer as each draw's range had it compared draw after draw.
  The idea: read the draw's indices from guest memory and compare only from the lowest vertex
  they name to the highest, when reading them costs less than comparing the declared range.
- **Workload.** A first-person shooter demo through the graphics worker, the first seconds of
  its first level, the player standing. Two arms, each on its own fresh start to that spot:
  before (`585e5774` plus the session's uncommitted tree) and the idea. Two 10 s windows each.
  Diagnostics build.
- **Values.** Bytes compared per frame: before 34.5 and 36.4 MB, idea 19.9 and 18.8 MB. The
  ring replay's host time (`ring-take`): before 8.1 ms a frame, idea 6.6 ms. Frames per
  second: before 12.6 and 18.9, idea 13.2, 13.3 and 15.9. The frame was about 53-63 ms, of
  which the guest's code was 32-37 ms. Noise floor: the arms' own spread, 12.6-18.9 fps.
- **Machine.** Parallels VM on Apple silicon, Windows 11, Chrome, Parallels GPU. Power plan:
  not recorded.
- **Why it did not pay.** The comparing it saved was about 1.5 ms of a 55 ms frame, below the
  spread between runs; the frame is the guest's code. One screenshot of the idea's run showed
  streaks over the road that the same spot before did not, not followed up.
- **Decision.** Reverted, then put back the same day at the person's word (optional): what crosses to the graphics worker is what a heavy scene is bound by -- 30-55 MB/s in a fight of a third-person action demo, its worker parsing 200-260 ms of every 500 -- and less of it is the lever there. The streaks are to be checked.

### 2026-10-14 - x87 single precision on floats: other encodings of the range test [VALID]

- **Measured.** Other encodings of `floatSingles`' range test (sub, abs, fpmul; none and branch as
  bounds). cork-bench fmath-pc24 and game-pc24 at 6f1c8ae4, paired (`pair.mjs` node 22.22.0
  `--no-liftoff`, 40 rounds of 10; Chrome 141 headless, two tabs of 40 rounds), 100 warm, median
  ratio to the committed encoding. node fmath: sub 1.079, abs 1.017, fpmul 1.192, none 0.599, branch
  0.665; game: 1.007, 0.995, 1.018, 0.839, 0.842. Chrome fmath: 1.061, 1.028, 1.172, none 0.603;
  game: 1.032, 1.009, 1.053, none 0.860. Every eax the same. 4-core Xeon 2.80 GHz VM.
- **Decision.** The committed encoding stays; the cost is the test's own operations, not its branch.
- **Revisit when.** On arm64 (not measured), where moving a float's bits costs otherwise.

### 2026-10-14 - indirect call prediction (`callTargets`) in Far Cry in Chromium, measured again [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** One pair a phase against a noise floor (about 6%) the size of the
  difference (1.041 cold, 1.064 warm). The 2026-10-15 "all at once" entry found this change and the
  others summed at 1.000 and said none of them is evidence for a default by itself; the default
  stayed on, and `runtime.js` cites this entry for it, while it costs the benchmark's spread about
  9%. Re-measure: Far Cry in Chromium `--fake-gpu`, `callTargets` on against off, cold and warm, 5
  alternated pairs a phase, and one more title with many virtual calls, decided on medians against
  the measured noise.

- **Idea.** The two 2026-10-13 entries above left `callTargets` off: in Node, in the level, it ran
  0.958 and 0.983 of the rate without it. Measured again in the browser the product runs in,
  after its regions formed again were bounded by the engine thread's credit (`d96d7c1b`; formed in
  one call they had held the thread for 33 ms).
- **Workload.** The Far Cry demo bundle (`bundle.btl` sha256 `44530097b2a5a284…`) under
  `tools/cdp_test/game.mjs farcry-demo --worker --coi --no-video --fake-gpu --run-seconds 240`, the
  engine in a worker, the GPU a fake one that draws nothing. Tree `e5128a7c` with
  `--cork-config '{"callTargets":true}'` against `'{}'`, alternated: cold on, cold off, warm on,
  warm off, each arm on a browser profile of its own (its translation store). Guest instructions
  over the whole run (about 259 s, the load included: the translator is quiet after 60 s cold and
  30 s warm).
- **Values.** Cold: on 68.27 G instructions in 259 s, 263.5 M/s; off 65.44 G, 253.1 M/s (on / off
  1.041). Warm: on 68.97 G in 256 s, 269.9 M/s; off 64.67 G in 255 s, 253.7 M/s (1.064). The
  same tree without it, run an hour before (`a24f5d9a`, same harness): 238.4 M/s cold, 244.8 warm.
  One pair a phase; two runs off of one tree differ by up to 6%, so the noise floor is about the
  size of the difference, and every run on was faster than every run off.
- **The engine thread.** On, the translator's longest hold was 32.8 ms cold and 21.3 ms warm
  (holds of 16 ms or more: 14 and 2), against 25.0 and 12.4 ms off (3 and 0), the regions formed
  again in one call; bounded since (`d96d7c1b`), not measured again yet.
- **Machine.** A 4-core x86-64 Linux VM, Intel Xeon @ 2.10 GHz, headless Chromium 141.0.7390.37
  (V8 14.1). Power plan not recorded.
- **Correctness.** Every run ran to the end of its window without the program stopping; whether
  each reached the level was not checked. Cork's unit tests passed with the bound and with the
  option on by default.
- **Decision.** On by default. The earlier entries stand as measured in their conditions (Node, in
  the level for 900 s, without the bound); the difference between them and this one is not
  separated yet.

### 2026-10-14 - indirect call prediction (`callTargets`) on the benchmark, on by default [VALID]

- **Measured.** `callTargets` on by default, on the benchmark. Tree b73438e6. Chromium 141 (V8 14.1)
  `suite.mjs --scale 10 --reps 3`, arms alternated: geomean of sixteen 1358 / 1361 MIPS (1.00);
  spread x87 291 / 321 (on 291 283 266, off 321 319 305: every run on below every run off), SSE 300
  / 321; the other fourteen 0.92-1.06 inside their own runs. Node 22.22.0, spread, three arms
  started together, eight rounds: on / off median 0.965 (7 of 8 below 1), never switched on / off
  0.976. Noise: sequential rounds 0.87-1.15, started together about 4%. The cost: about 2.5% the
  flag's load and branch on every indirect call, about 1% the sampling. 4-core Xeon 2.10 GHz VM.
- **Decision.** Stays on: Far Cry gained more than spread loses.
- **Revisit when.** The Far Cry gain is measured again (the 2026-10-14 Far Cry entries are
  disputed); sampling less while nothing comes due is untried.

### 2026-10-14 - `callTargets` in Far Cry in Chromium, its regions formed again under the credit [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** As the entry above it: 1.018 cold and 1.028 warm, one pair a
  phase, noise about 6%; "every run on was faster than the run beside it" is two pairs. Re-measure
  with it (5 pairs a phase).

- **Idea.** The entry above measured `callTargets` before the regions it forms again were bounded
  by the engine thread's credit (`d96d7c1b`), and left the holds with the bound not measured.
- **Workload.** As in that entry: the Far Cry demo bundle (`bundle.btl` sha256
  `44530097b2a5a284…`), `tools/cdp_test/game.mjs farcry-demo --worker --coi --no-video --fake-gpu
  --run-seconds 240 --cpu-profile 240`. Tree `b73438e6`, `--cork-config '{}'` (on, the default)
  against `'{"callTargets":false}'`, alternated: cold on, cold off, warm on, warm off, each arm on a
  profile of its own. During the last run (warm off) a few unit tests of a few seconds each ran
  beside it.
- **Values.** Guest instructions over the whole run: cold on 68.68 G in 260 s, 264.5 M/s; off
  67.18 G in 258 s, 259.9 M/s (1.018). Warm on 70.17 G in 254 s, 276.2 M/s; off 68.45 G in 255 s,
  268.6 M/s (1.028). One pair a phase; the noise floor about 6%, as before.
- **The engine thread.** The translator's longest hold by its own samples: cold on 23.3 ms, off
  27.3; warm on 16.8, off 14.2. Holds of 16 ms or more: 4 and 3 cold, 1 and 0 warm; none of 33 ms
  or more in any run, against 32.8 ms and 14 of 16 ms or more cold with it on before the bound.
  The slowest slices (0.7 to 1 s, in both arms) are the guest's own while the level loads.
- **Machine.** A 4-core x86-64 Linux VM, Intel Xeon @ 2.10 GHz, headless Chromium 141.0.7390.37
  (V8 14.1). Power plan not recorded.
- **Correctness.** Every run ran to the end of its window; whether each reached the level was not
  checked.
- **Decision.** It stays on: the holds it added are gone with the bound, and every run on was
  faster than the run off beside it.

### 2026-10-14 - an indirect call with nothing to form in sampled no more (quiet calls) [VALID]

- **Measured.** A call with nothing to form in sampled no more (quiet, d207d7e5) against b73438e6,
  `callTargets` on. Far Cry `--fake-gpu` in headless Chromium 141, cold 269.6 / 268.5 M/s (1.004),
  warm 276.2 / 270.6 (1.021), noise about 6%; 19 and 20 calls quiet, every one for a callee too
  large to form in. spread in node, three arms together, eight rounds: median 1.005. 4-core Xeon
  2.10 GHz VM.
- **Decision.** Kept: a quiet call pays nothing for a profile it cannot use.
- **Revisit when.** Far Cry's 50-103 predicted callees too large to form in still go through the
  entry hash.

### 2026-10-15 - the shared layout's bases as other kinds of global [STALE]

- **Audit 2026-11-14: STALE.** Node (V8 12.4) only, never Chrome or arm64. The decision rested on
  the process's own executor running the first thread on its own layout; since 2026-10-21 a free
  host has another executor play a pinned main thread's processor, so a game's main thread can run
  on the shared layout, as every thread off the process's executor does. (The 2026-10-22 entries
  measured executor 0's own layout, per their invalidation, so they say nothing of this cost.)
  Re-measure: shared against own layout on one executor, cork-bench x87 set paired (40 rounds) in
  Chrome on x64 and on the M4; and the share of a game's instructions retired on the shared layout
  today.

- **Idea.** Under the process's shared layout (`sharedLayout`, every executor's translation the
  same bytes) the state block and the tables are addressed from two immutable imported globals,
  `env.stateBase` and `env.tablesBase`. A seven-instruction loop (an LCG step and a
  read-modify-write, 600 million instructions) ran 1.34 times as long under it as under one
  executor's own layout; V8's code for the region kept the loop's `eax` in a stack slot, the base
  read in the prologue staying live through the loop to the exits that write the state back.
  Three ways to keep that value from living across the loop were tried: the globals imported
  mutable (read where used, through the instance's table of imported mutable globals); a second
  pair of immutable globals for every use after the prologue (`split`); and mutable globals the
  module defines, initialised from the imported pair (`defined`).
- **Workload.** The cork benchmark (`tools/cork-bench/bench.mjs`, its 22 workloads) on one
  executor with the shared layout forced on, against the same tree's own layout; 10 reps of each,
  each workload's figure the mean of its three fastest reps (`best3Us`, µs an iteration); the
  checksum (`eax`) the same in every arm. Tree: `cork2` at `a53a1ec6` with the change under way.
  Bundle hash: not applicable. Per-rep values: not recorded (the bench kept the fastest and the
  three fastest's mean).
- **Values.** Geometric mean over the 22 against the own layout, three campaigns in the same
  hour: immutable (as committed) 1.054, 1.069, 1.070; mutable 1.166; split 1.057; defined
  1.073. Mutable won the loop (161 against 215 ms in a micro test of the region, 1710 against
  2249 ms in the engine) and lost calls: through a table of 8 targets 1.45-1.68, of 4096 targets
  1.54, Lua 1.26. Split won the micro test (151 ms) and not the engine (2224 ms). Defined won the
  loop (1633 ms) and lost calls about as much as it won elsewhere. The noise floor: the own
  layout's figure for one workload moved by up to a fifth between campaigns (game-pc24 616-750).
- **Where the time goes.** A small called function's code is a sixth larger under the shared
  layout (488 bytes of machine code against 572): every access adds a base, and the loads of the
  flag record from the state block that its own layout's code drops as dead stay, a load from a
  computed address being one that may fault.
- **Machine.** Node 22.22.0 (V8 12.4.254.21-node.33), a 4-core x86-64 Linux VM, Intel Xeon @
  2.80 GHz. No browser. Power plan: not recorded.
- **Correctness.** Every arm's checksums equal the own layout's.
- **Decision.** The globals stay immutable imports. The process's own executor translates for its
  own layout instead (`cork-host.js`): it runs the first thread and any thread alone, and the
  shared layout is the other executors' alone.

### 2026-10-15 - the speed work of 2026-10-13 and 14 in Far Cry, all of it at once [VALID]

- **Measured.** The Far Cry work of 2026-10-13 and 14 summed. Bundle 44530097b2a5a284..., `game.mjs
  farcry-demo --worker --coi --no-video --fake-gpu --run-seconds 240 --cpu-profile 240`; before
  98303907 (+ the harness's ca67027a), after 0ee30d80; ten runs alternated. Before 201.1, 222.9,
  220.8, 213.4, 226.7 M/s (median 220.8); after 219.3, 218.6, 220.9, 225.4, 222.5 (220.9): 1.000.
  Translated code's own rate 450 against 440 M/s; translated code 49-53% of the engine thread in
  both; ring replay 31.5-35.5 -> 29.0-29.8 s; scheduler turns 691-743 k -> 578-604 k. A different VM
  (Xeon 2.80 GHz) from the entries before it.
- **Decision.** Nothing reverted; the per-change Far Cry gains (1.004-1.064, one pair a phase) are
  not evidence for a default by themselves.
- **Revisit when.** Any default chosen on one pair a phase: this entry is why the `callTargets`
  entries of 2026-10-14 are disputed.

### 2026-10-15 - three host-side costs off Far Cry's engine thread, measured in its rate [VALID]

- **Measured.** Three host-side costs removed: cork's judging of host writes to pages with no code
  (d9a43818), `ringState` after every host entry (a94451fc), bytes compared again by draws
  (cdcee939). Far Cry as above, worktrees alternated, M/s: ddbcdfc4 230.8 cold, 224.9 / 224.0 /
  232.9 warm; a94451fc 226.2 / 228.9 / 232.2 warm (warm medians 1.018); a94451fc 236.3 / 225.1
  against cdcee939 234.8 cold, 228.4 warm. Noise about 4%. Engine thread: host calls 63.5 -> 61.3 ->
  58.4 s; the store judge 5.6 s -> none; the ring's take 29.3 -> 26.3 -> 23.0 s; draws' compared
  bytes 2.87-3.14 GB -> 0.
- **Decision.** Kept: work for nothing, gone in the profile; not past the noise in the rate.
- **Revisit when.** No need.

### 2026-10-15 - the process's executor looking for the others' words between its regions [VALID]

- **Measured.** The process's executor looking for the others' words between its regions
  (`preemption`, `yieldChunk` 10 000). 7-Zip 26.04 x86 `7zr.exe b -md22` (sha256
  256feca8e274e5da...), `createApp` with `cpu: { cores: 1 }`, `cork2` a6925e9b, node 22.22.0, KVM
  Xeon 2.80 GHz, one run each, MIPS compress / decompress / total: off 809 / 1413 / 1111, on 525 /
  667 / 596. A slice back every ~10 us costs as much as the code.
- **Decision.** Not used for the bell; replaced since by the interrupt word read at every back edge
  (`spentTest`, the 2026-10-22 entry).
- **Revisit when.** No need.

### 2026-10-16 - the program's cores chosen from the host's by default (roadmap/v2 C1) [STALE]

- **Audit 2026-11-14: STALE (superseded).** "One core stays the default" was reversed the same day
  by a527bd121 (one fewer than the host's processors, at most eight, where the page can share
  memory), measured on the scheduler of 068c7dff (Far Cry 11.6-12.2 against 12.0-12.7 fps, Gothic 3
  alike). The frames here were on SwiftShader, which the local rules exclude for speed. No
  re-measurement for this decision.

- **Idea.** A run that names no cores, in a browser whose page shares memory, gets one fewer
  than the host's processors (at most eight): the program sizes its threads to them, the
  executors open only as its threads want them (B2), the process's turns stay long while they
  run (B1), and an executor keeps its thread a turn while others wait (B5).
- **Workload.** Far Cry demo (bundle sha256 `ec81f9c260efb780…`) settled 40 s and watched 40 s,
  Gothic 3 (`bundles/g3`) settled 120 s and watched 40 s, in `tools/cdp_test/frames.mjs` with
  the page cross-origin isolated and the engine in a worker of the page in both arms
  (`--coi --worker`); `--cores 1` against `--cores 3` and against `--cores 2`; `cork2` at
  `f72be67b`. Three runs an arm, alternated.
- **Values.** Frames a second. Far Cry, 1 core 13.2 13.0 12.9 against 3 cores 10.8 12.7 12.8;
  1 core 13.0 13.1 12.6 against 2 cores 10.1 11.3 8.5. Gothic 3, 1 core 4.6 4.6 4.8 against
  3 cores 3.4 4.1 4.3; 1 core 4.6 4.5 4.6 against 2 cores 3.4 4.2 4.1.
- **Machine.** Headless Chromium 141 (`chromium-1194`), SwiftShader, a 4-core x86-64 KVM VM
  (Intel Xeon @ 2.80 GHz). Power plan: not recorded.
- **What was found.** Not the program's own path for several processors: Far Cry told of two
  and kept on the process's executor drew 11.6 and 12.7 frames a second, as on one. Not the host
  out of cores: the VM was 77% busy on one core and 71% on two. What changes is a thread running
  on the other executor: the game's sound thread (priority 15, a 10 ms sleep between runs that
  spin on the sound cursor) took it -- 2.39 G instructions in 38 s there, 1126 slices, 0.39 ms a
  call waiting for the answer -- and the renderer on the process's executor retired as many
  instructions as on one core (18.81 G against 18.88 G) and drew a fifth fewer frames, the
  process's executor idle 10.5 s of the 38 waiting for the other. With a fake GPU (no
  SwiftShader) the renderer's rate was the same on one core and three.
- **Tried, without a positive signal.** (1) The process's executor to the thread calling into
  the host more often a millisecond (twice as often and at least once): 9.5, 7.6 frames a second
  on two cores. (2) A thread calling into the host more than once in 30 000 instructions kept on
  the process's executor and called back from another: 9.0, 7.1, 9.2, 8.5, 10.0 -- the sound
  thread spins between its calls and is placed between them as one that computes. (3) An idle
  wait of the process's run loop ended by the other executors' bell: 8.8, 8.0.
- **Correctness.** Every run drew its frames to the end of its window; none of the three was
  judged on the suites.
- **Decision.** One core stays the default; `cpu.cores` and the player's modes give more. None of
  the three placements is kept; the scheduler keeps each thread's calls into the host and their
  rate an instruction (`x` in `byThread`) and the last placements (`recentPlacements`), and
  `frames.mjs` runs the page isolated with the engine in a worker for `--cores` past one -- before
  it, every browser measurement of frames ran the `compatible` mode on the page's own thread,
  where a run asking for cores ran on one (`executorsRefused`).

### 2026-10-16 - a host call's device steps run as the device's methods in the host [VALID]

- **Measured.** `ID3DXEffect::CommitChanges`' device steps answered by the setter's host method
  (`InterfaceMethod.inPlace`). NFS Carbon demo bundle f5aec769a16ce7d8..., first race, 640x480, host
  calls over 10 s, one run each, Chrome in the Parallels VM: about 48 us a commit with host methods;
  34 then 18-24 us with the setter's command appended to the ring (`appendCommand`); before not
  recorded.
- **Decision.** Removed: a step in place only appends the command.
- **Revisit when.** No need: a host method does the device's whole work at once.

### 2026-10-16 - a host answer let in at once, and the renderer kept by its rate of calls, each alone (roadmap/v2 C1) [VALID]

- **Measured.** (a) the process's turn leaves at once while a host answer waits in the event loop;
  (b) with (a), of two threads the one calling the host twice as often keeps the process's executor.
  Far Cry bundle ec81f9c260efb780..., `frames.mjs --coi --worker --cores N --threads`, `cork2`
  20eb483b, headless Chromium 141 on SwiftShader, KVM Xeon 2.80 GHz. fps: (a) 1 core 13.4 / 13.8 /
  13.6, 2 cores 5.7 / 11.1 / 10.5; (b) 2 cores 10.4; before 10.1 / 11.3 / 8.5.
- **Decision.** Neither alone; (a) is part of the change kept (a thread kept on the process's
  executor by its rate of host calls), (b) replaced by it.
- **Revisit when.** No need.

### 2026-10-16 - a translation store without relinked modules [VALID]

- **Measured.** A translation store without relinked modules. Far Cry, `game.mjs --worker --coi
  --no-video --fake-gpu --args "map fort" --run-seconds 200 --executors 1 --store local`, fresh
  profile, one cold and two warm runs, headless Chromium 141, KVM VM: cold stored 404 MB against
  about 1.1 GB; warm runs relinked again: translation worker 56 / 58 s against 23 / 20, the map at
  128 / 132 s against 121 / 122, first minute 18.7 / 17.3 fps against 20.5 / 19.6.
- **Decision.** Not taken: a relink's module is stored, and a batch module no record names is dead
  at the next opening.
- **Revisit when.** Relinks become cheap or go away.

### 2026-10-16 - an effect's constants handed to the setter where the parameter lies [VALID]

- **Measured.** An effect's constants handed to the setter where the parameter lies, sparing
  `Walk`'s copy. NFS Carbon f5aec769a16ce7d8..., first race, 640x480, one run each, scenes differed:
  the overlay's share of the buckets holding `Walk` 28% -> 30%; the worker's CPU profile put `Walk`
  at 2.0% of the worker (about 4% of the guest). Few constants have an identity layout (D3DX
  transposes matrices). Chrome in the Parallels VM.
- **Decision.** Removed. A routine's cost is read from the CPU profile: the guest sampler credits a
  whole slice to the bucket where it ended, so a routine full of calls is overstated there.
- **Revisit when.** No need.

### 2026-10-16 - less garbage on the Direct3D path, against a frame rate that floats [VALID]

- **Measured.** Less garbage on the Direct3D path (views and buffers reused). NFS Carbon, first
  race: allocation 152-182 -> 88 MiB/s (8 s, one run each, scenes differed). The collector's 7.3%
  was the hidden tab's Idle priority: visible and at normal priority, 1.5% of the busier worker (one
  10 s trace), 0.5% in its CPU profile; frames p10 17.3, p50 21.5, p90 34.0, max 104.6 ms (239
  frames), the spread from the VM's vCPUs slowing together (an unrelated loop at 67-68% of its speed
  in the slowest tenth). Chrome in the Parallels VM.
- **Decision.** Kept as less garbage, no frame rate claimed; a frame spread on this VM is set
  against an unrelated loop before it is read as the engine's.
- **Revisit when.** No need.

### 2026-10-17 - a dynamic buffer's DISCARD made in the guest by trading two storages [STALE]

- **Audit 2026-11-14: STALE (superseded).** The trade came back on 2026-10-18 (6d0a42363:
  `AddStorage`, `Buffer.Rename`, `d3d8/storages.js`) with gates that found the renderer's compared
  ranges kept across a move; a node stand had host buffer locks 176 -> 1 and 5.00 -> 4.44 ms a
  frame. Its picture was invalidated (the record below). The 15.1 -> 5.7 fps here was not measured
  again on the landed version. Re-measure: CoD4's first level, the landed trade against host
  DISCARDs (a switch for it was not looked for), 3 runs an arm, frame rate and host locks.

- **Idea.** A DISCARD lock under a draw the command ring held, or over bytes lent to the graphics
  worker, goes to the host: a pause of the ring each time. Give each dynamic buffer of Direct3D 8
  and 9 a second storage; the guest's lock routine trades the two and writes the trade into the
  ring (`Buffer.Rename`), which the host makes in order with the draws, sending what was written
  into the new storage between runs of the ring. Commits 4ebf2f66 and 1a3040ca on `review`,
  reverted by 43dc6cff and c4fa8cc6.
- **Workload.** The Call of Duty 4 demo bundle (`1e3e2212825afcbe2415f0cd`, `bundle.btl` hash not
  recorded), its first level from the player's spawn under the Autostrad sign, the player
  standing; a 60 s window between two launcher reports taken about 3 minutes after Start Game.
  One run each arm.
- **Values.** Before (the engine at e1ed9944): 914 frames in 60 s, 15.1 fps; host calls 10.3 s, of
  which no buffer Lock or Unlock among the first sixteen. After (4ebf2f66 + 1a3040ca): 345 frames,
  5.7 fps; host calls 10.5 s, Lock and Unlock 21.9 a frame each at 18-20 us; 2449 trades in the
  window. Bytes to the worker per frame about the same (2.7 MB both; compared 20 and 17 MB).
  Noise floor not measured.
- **Picture.** After, the road in front of the player was drawn streaked and its lane line was
  gone; before, it was drawn right. The frame gates (`frames-contract-*-worker`, the locks
  contract with trades) passed: they do not hold the case.
- **Machine.** Chrome in a Parallels Windows 11 VM (4 vCPUs, Apple Silicon host) on its virtual
  GPU, the driver tab (`tools/cdp_test/live/drive.mjs`) headed; versions and power plan not
  recorded.
- **Why it did not pay.** In this scene the buffer locks were not crossing into the host at all
  (the 270 us locks of an earlier report were from a run that included loading), and the trade
  cost a third of the frame rate and drew wrong. Where the rate went was not found.
- **Decision.** Reverted. Before another attempt: find which host Locks of which buffers cross in
  the scene that is to be sped up, and a gate that draws what the road drew wrong.

### 2026-10-17 - a region stopping at every block another region has an entry for [VALID]

- **Measured.** A region stopping at every block another region has an entry for (`regionStops`).
  Far Cry `--executors 1 --store local`, a fresh profile, one cold run a mode on 6328903b; transfers
  counted (`countTransfers`) for xz 5.8.4 (`-3 -T1`, 16 MiB), Stockfish 8 (`bench 16 1 12`), 7-Zip
  (`7zr b -md22`). Any block / another region's entry only / never: Far Cry stored 246 / 336 / 345
  MB; xz 179.3 / 116.2 / 103.0 M transfers; Stockfish 137.5 / 101.8 / 100.9 M; 7-Zip 74.4 / 68.3 /
  68.3 M. The CPU suite on a loaded machine: xz 10-17%, Stockfish 3-5% slower. KVM Xeon 2.80 GHz,
  node 22.22.0, Chromium 141.
- **Decision.** Off by default, then removed (d6ffca62c, 2026-10-31). The covering of regions on
  their way to being published stays (Far Cry 842 -> 345 MB, no transfer added).
- **Revisit when.** A stop kept out of hot code (only in cold code, or formed again without stops
  once a stop turns hot); the store's size on a phone.

### 2026-10-21 - the process's executor makes a Direct3D ring ahead while it has nothing to run [VALID]

- **Measured.** The process's idle executor making the Direct3D ring ahead (`graphics.drainIdle`,
  d2ddaf75). CoD4 demo `bog_a` firefight, `game.mjs cod4-demo --worker --coi --no-video --fake-gpu
  --gpu sm3 --memory 2048 --screen 1024x768 --executors 3 --run-seconds 420 --series 100`, warm
  profile, window 240-420 s, manifest sha256 ead9cfb87a8147ce..., one run a line, alternated. ms a
  frame (host / guest): without 64.0 (34.9 / 29.1), 60.3 (34.0 / 26.2), 70.2 (36.6 / 33.5); made
  whenever idle 65.8 (30.7 / 35.1), 64.3 (30.5 / 33.8), lock found taken 43 228 and 44 770 times
  against about 2 000; once the head stood still 59.8, 66.0. One arm varies by 5 ms. KVM Xeon 2.10
  GHz, Chromium 141.
- **Decision.** Removed (62215e9ea): host time saved came back as guest time.
- **Revisit when.** A ring taken without the device's lock (records copied out under it, played
  after), which is open.

### 2026-10-22 - an executor's look for its next slice counted among the cores taken [VALID]

- **Measured.** An executor's look for its next slice counted among the cores taken. The Direct3D
  stand (scratchpad `d3dstand/run-wake.mjs`, 200 frames, the fake GPU), C = 2 and 3, 4 runs an arm,
  best three's median ms a frame: two executors fixed 0.05 ms 6.225, the rule 5.890, counted 6.130;
  three: 7.186, 7.131, 7.483. KVM Xeon 2.80 GHz, node 22.22.0.
- **Decision.** Reverted; the rule (`lookFor`, d4bc2788) stays.
- **Revisit when.** On a host with many cores, where the rule's spare-core branch was never
  measured.

### 2026-10-22 - the interrupt word looked at every 64th back edge [VALID]

- **Measured.** The interrupt word loaded atomically only every 64th back edge (a counter in a
  local). cork-bench, `browser.mjs --paired`, 40 rounds, warm 100, the two-executor layout (atomic)
  against the base's one- and two-executor layouts, base 0e803748; ratio to one executor: crc base
  0.987, counter 1.097; fmath 1.049 / 1.096; sort 1.099 / 1.387; vm 1.091 / 1.257; fmath-pc24 1.043
  / 1.035; game 0.990 / 0.997. Chromium 141.0.7390.37 (V8 14.1.146.11), KVM Xeon 2.80 GHz.
- **Decision.** Not taken; a plain load instead (0-3%), the contract kept.
- **Revisit when.** V8 hoists such a load out of a loop that stores nothing (12 and 14 do not). The
  word is executor 0's own code, so the 2026-10-22 invalidation does not reach it.

### 2026-10-22 - a block's budget charge carried into the one block it enters [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** Its arm64 counts come from `tools/cork-asm.mjs --blocks` before
  ab02ac9 (2026-10-29), which misread block marks built in x27 (`cp`) - one block was weighed at 13
  840 instructions; the invalidation record names only the 2026-10-28 and 29 entries, but this one
  used the same reading. Re-measure: the same regions with the fixed cork-asm, or callgrind counts
  on x64 with a patch.

- **Idea.** Every block charges its instructions to the budget at its exit (`charge`, one
  `sub` an executed block). A block entered only from one block before it could take that
  block's count as its own and charge both at its own exit, sparing a `sub` on that edge;
  since the dispatch enters any block, its entry from there would give the carried count back.
- **Workload.** The machine code V8 makes of Crysis's hottest regions, weighed by block
  profiles (`tools/cork-asm.mjs --blocks --count`, V8 14.6 arm64 under qemu, stores under the
  trap handler as on macOS): the 30 regions holding 51 % of the block runs of the CPU
  benchmark's timedemo (a node stand's profile from 350 s on), and the 8 regions holding 79 %
  of a whole run with its load.
- **Values.** Charges are 2.5 % of the executed arm64 instructions in the timedemo's code
  (6.2 % with the load's inflate loops); blocks entered from one block only are 39.9 % of the
  block runs (38.3 %); fall-throughs and jumps into such a block, the chains a charge could be
  merged along with no change to the dispatch, 0 %.
- **Machine.** Counted instructions, not timed: the 4-core KVM VM, qemu-aarch64 8.2.2, node
  26.12.1 (V8 14.6.202.34).
- **Decision.** Not taken: about 1 % of the timedemo's executed instructions for a second
  entry path into nearly every block inside a loop, which needs a gate of its own.

### 2026-10-23 - a call's register reloads left out where the value lives on in a local [VALID]

- **Measured.** A call's register reloads left out where the value lives on in a local
  (callee-saved). `tools/cork-asm.mjs --blocks --classes`, the Crysis timedemo's 400 heaviest
  main-thread blocks, macOS arm64 model, atomic: 7.553 -> 7.579 machine instructions an executed
  guest instruction (+0.3%); state-block traffic 2.457 -> 2.285, spills 0.284 -> 0.498. Counts read
  before the cork-asm fix ab02ac9; the same idea timed on x64 on 2026-10-27 (callee-saved registers
  kept) agrees.
- **Decision.** Not taken: a wasm call keeps nothing in registers across it.
- **Revisit when.** Wasm or V8 keep values in registers across a call.

### 2026-10-23 - the callee's flag record taken back only where code after the call reads a flag [VALID]

- **Measured.** The callee's flag record taken back only where code after the call reads a flag.
  Same tool and regions as above (arm64, before ab02ac9): base 7.553, stale locals 7.613 (+0.8%),
  zeroed 7.538 (-0.2%). Measured again 2026-10-28 on x64 by exact counts (-0.006%) and 2026-10-29 on
  arm64 (-0.04%).
- **Decision.** Not taken.
- **Revisit when.** No need.

### 2026-10-23 - callees formed into their callers one level deeper (`formDepth` 2) [VALID]

- **Measured.** `formDepth` 2 on a game. Crysis demo `benchmark_gpu`, node stand
  (`launch-probe.mjs`, one executor, atomic, 2048 MB, a store an arm, 700 s), timedemo Run 0 fps,
  depth 1 / 2: cold 7.57 / 6.58; warm 8.50, 8.37 / 8.15, 8.64; Run 1 9.43, 9.69, 9.05 / 9.18. Noise
  between warm runs about 3%. Static (cork-asm arm64, before ab02ac9): 7.553 -> 7.681 (+1.7%), calls
  447 -> 431 M. Node 22.22.0, KVM Xeon 2.80 GHz.
- **Decision.** Not taken; `formDepth` stays 1, `cork-asm --form-depth` kept.
- **Revisit when.** As the 2026-10-12 entry: formed callees stop being copied per caller.

### 2026-10-23 - hot direct callees formed into their callers past the caps [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** The cause given (backward edges) was invalidated by the next
  entry; the Crysis runs were 593 against 735 and 435 ms a frame with one base run lost (the arm's
  noise 435-735); lua-x87 in Chromium 1.38x at warm 800 is unexplained, and in node the warm patch
  ran at the base's speed. What it targets is large: in Crysis's 21 main-thread regions 107.5 M
  region-full and 66.8 M too-large direct calls a profile. Re-measure: on today's ways out
  (`planPaths`, `EXIT_KINDS`), callgrind counts on lua and on a Crysis-shaped call profile, then
  Crysis `benchmark_cpu` warm, 3 runs an arm on the hardware adapter.

- **Idea.** A direct call whose callee forming left out for its size (more blocks than a
  leaf's, or a region already full of its own function) is sampled as an indirect call is;
  once hot, its region is formed again with the callee in, which may take up to 256 blocks
  and 8192 bytes past the caps, formed at its caller's depth (its own callees in as in its own
  region), at most two calls a region to one such callee. Each call formed in saves the wasm
  call's ~110 machine instructions at the caller.
- **Workload.** Statically: the Crysis demo timedemo's 21 main-thread regions, weighed by its
  block profile (node stand, from 350 s on). Timed: cork-bench in Chromium (`browser.mjs
  --paired`, against the parent a33c9493); cork-bench in node; a loop calling a function of 25
  blocks a million times; the Crysis demo `benchmark_cpu` (High, every setting before `+map`,
  3 executors, fake GPU, 2048 MB, 330 s, each arm warmed once on a Chrome profile of its own),
  ms a frame over timedemo frames 10-60.
- **Values.** Static: 276 M calls out of these regions (direct, region full 107.5 M; direct,
  callee too large 66.8 M; indirect, no callee predicted 94.4 M), the 25 hottest direct ones
  84 M. Named hot, 40 M of them formed in with 64 blocks of room, 60 M with 128, 81 M with
  256, the regions two fifths larger; held to a leaf's size, 17.7 M. Micro: 20 -> 7 ns a
  call. lua-x87 in Chromium: 1.87 and 1.93 times as long (warm 100, 2 x 60 rounds, interquartile
  1.49-2.31), 1.38 (warm 800, 40 rounds, 1.17-1.92); tree, game-x87, vm, vcall within the
  noise. lua-x87 in node: best rep 2.33 -> 2.94-3.29 ms an iteration; its emitted modules 7.2 ->
  20.8 MB, regions formed again 21 -> 200. Crysis: base 593 ms a frame (median 440); with it
  735 (median 685) and 435 (median 409); the base's second run stopped at start (the OPFS
  "file not found" of a reused profile).
- **Why.** A callee formed in keeps its blocks in address order, so of the call and the
  return one edge runs backward: the budget test and, unless to a loop's head, the region's
  dispatch, a `br_table` whose target changes with every caller, where a wasm call and its
  return are a direct call and a return the processor predicts. In the 21 regions the callees
  formed in already take 89.5 M calls a profile, 43.3 M of them backward and 33.7 M of their
  returns. Large callees in an interpreter's loop also made its region's code larger and its
  hot paths slower.
- **Machine.** The 4-core KVM VM (Xeon 2.80 GHz); Chromium 141 (V8 14.1); node 22.22.0 (V8 12.4).
  Noise between Crysis runs of one arm: 435 vs 735 ms a frame.
- **Decision.** Not taken. Before forming more in, a callee formed in should be laid out between
  its call and the call's return, so both edges branch forward; then this is worth measuring again
  (the patch and its gate are kept outside the tree).

### 2026-10-23 - what a shader draw's samplers read, kept by the words it is made from [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** Four runs an arm that overlap (A 42.88-45.76, B 41.16-48.21 ms)
  and no cause measured, against a profile that put `samplingOf` at 5.4% of the played side. The
  graphics worker's garbage and batches changed since (2026-11-06). Re-measure:
  `graphics-replay.mjs` on the CoD4 capture, 10 runs an arm alternated, with a CPU profile of
  `samplingOf` in each.

- **Idea.** `samplingOf` in the Direct3D renderer makes, for every shader draw, key strings and
  lists of what its samplers read beyond its shaders (the channels a texture of fewer than four
  lacks, a level-of-detail bias, mirror-once and border addressing). A draw reads the same as
  some draw before it nearly always: number the textures' channels and the sampler states it
  reads as words, and keep what was made by that number.
- **Workload.** A capture of the graphics worker's input in the Call of Duty 4 demo's firefight
  (300 frames after the mark, 2254 draws a frame), played in node over the quiet fake GPU
  (`tools/graphics-replay.mjs`). Arms: the tree with written pages as bits and the last group
  bound kept (A), and A with the sampling kept (B); four runs each, alternated.
- **Values.** Milliseconds a frame of the played side: A 42.96, 43.86, 42.88, 45.76; B 46.61,
  41.16, 48.21, 45.86. The profile before it put `samplingOf` at 5.4 % of the played side's time,
  the key strings (`onesKey`) at 1.0 %. The gate (every draw given the same shaders with the
  sampling made again; it caught each word left out) passed.
- **Why.** Not measured: whether the words cost each draw what the strings did, or the
  profile's share overstated the strings, no run here says.
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz); node 22.22.0 (V8 12.4). Spread between runs of
  one arm: 42.9 to 45.8 ms a frame.
- **Decision.** Not taken. The patch and its gate (`d3d9/sampling.itest.js`) are kept outside the
  tree.

### 2026-10-24 - a smaller start in WebKit through cork's region and module sizes, and through JavaScriptCore's tiers [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** Most levers one run each against a 500 MB spread of the peak, in
  WPE WebKit 26.6 on Linux, which is not the phone; its own conclusion was to read the phone's
  JetsamEvent. Since: the iOS settings (`crossTailCalls: false`, `dispatch`, `callDepth` 64, a
  `cacheBytes` ceiling), `machineMemory`, and the 2026-10-26 finding that the phone charges every
  page touched. Re-measure: on an iPhone with its jetsam report, the levers on module bytes
  (`relinkAfter`, `maxRegionBlocks`) and JavaScriptCore's tiers, 3 runs an arm.

- **Idea.** Safari on an iPhone (iOS 26) reloads the page at every game's start while Safari on a
  Mac runs it, which is the page's process killed for its memory. The process was measured in
  Playwright's WebKit (26.6, WPE, headless) on Linux while the launcher starts the Quake III Arena
  demo, and the guess was that what cork compiles at once makes the peak: smaller regions, no
  relinked modules, or JavaScriptCore's optimizing tiers kept out would lower it.
- **Workload.** The launcher (`bottlify-ui` at 2882751) on this tree (597e6d4), the demo's bundle
  `baf676901226a7e870606221` (`bundle.btl` sha256 e074da0d...c5f8), 512 MB of guest memory, one
  core, sound on; WebKit has no WebGPU, so the engine and graphics workers were built with the fake
  device (`fake-device.js`) standing in for `navigator.gpu`; 30 s from the press, the isolated web
  process's RSS read from `/proc` once a second. Peak and the median from 15 s on, MB.
- **Values.** One run each unless counted: as it is, 1595, 1949, 2071, 1920 peak (2875 in a fifth,
  two engines at once, the launcher's double start since fixed) and 1144-1184 after; `relinkAfter:
  0`, 1989 / 1083; `relinkRegions: 64`, 1491 / 1145; `maxRegionBlocks: 64, maxRegionBytes: 4096`,
  2024, 1856, 1360 / 1143-1166; 32 and 2048 with `leafCalls` off, 1876, 1783, 1893 / 1092-1133;
  `translate: false`, 1244 / 943; `cork.worker: false`, 1366, 1883 / 1149-1168;
  `JSC_useOMGJIT=false`, 1624 / 1081; `JSC_useBBQJIT=false`, 1629 / 1174; both, 1708 / 1174;
  `JSC_useFTLJIT=false`, 1957 / 1112; `JSC_useDFGJIT=false`, 2023 / 1399;
  `JSC_numberOfWasmCompilerThreads=1`, 2098 / 1309; `JSC_jitMemoryReservationSize` 32 MB and
  16 MB (the option is honoured: the JIT region was 16 MB instead of 1024), 1823 / 974 and 1512 /
  1209, no crash. The page alone with the engine loaded idle: 275 MB anonymous.
- **Why.** Not one lever moved the peak beyond the spread of runs of one arm (1595 to 2071); the
  peak follows when the collector runs. The JS heaps' live objects were small (the engine worker
  about 60 MB in a heap snapshot); what did move was garbage: in Chromium the engine worker
  allocated 388 MiB/s, three quarters in PeekMessage, recvfrom and WSAGetLastError, which the game
  calls 900 000 times a second each while it waits for a frame (fixed in user32 and wsock32, 130
  MiB/s after). The same fix measured in WebKit by RSS: 1702, 2044, 1724 peak, no change seen.
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz), 15 GB, Ubuntu 24.04, no GPU; Playwright 1.63.0.
  Spread between runs of one arm: about 500 MB at the peak, 100 MB after.
- **Decision.** None of the settings changed. What the phone's process holds at the moment it is
  killed is to be read from its own JetsamEvent report.

### 2026-10-25 - the translation worker nudged into collecting sooner, as the engine's thread is [VALID]

- **Measured.** The translation worker nudged into collecting sooner (`gcNudge` sent with `ready`).
  The engine's test page, fake GPU in a graphics worker, 66fd44b5, Q3A demo bundle
  baf676901226a7e870606221, 512 MB, one core, 60 s, WPE WebKit 26.6 (Playwright 1.63.0) on Linux,
  KVM Xeon 2.10 GHz; RSS median from 15 s, MB: head 941, 1028, 1001 (peaks 1249, 1317, 1196); nudged
  948, 1055, 944 (1259, 1191, 1311); 201 collections in 30 s instead of 26; spread about 100 MB.
- **Decision.** The translation worker is not nudged; the graphics worker is (`nudgeWhenAsked`,
  fd6cac585).
- **Revisit when.** On the phone itself, or once libpas's return of freed pages is understood.

### 2026-10-25 - a DXT level's blocks let go in the graphics worker once uploaded [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** By 125 s only 10 of the 47 MB of blocks had been uploaded, so the
  arms differed by 10 MB against a 300 MB spread of the peak; two pairs; the higher peaks
  unexplained. On a device without BC formats (the phone's WebGPU) every DXT level is decoded in the
  worker, so all 47 MB is the question. Re-measure: past the whole level load, in WebKit and on the
  phone, 3 pairs.

- **Idea.** On a device that takes no BC blocks the worker decodes a compressed level for its
  upload and keeps the blocks for nothing else: after 2c521083 lets uploaded texels go, letting the
  blocks go too (a data property in place of the decoding getter, `compressed` null) would give
  back the 47 MB of DXT blocks the Doom 3 demo's first level loads.
- **Workload.** The engine's test page built as the package is (minified, diagnostics off), fake
  GPU in a graphics worker, the Doom 3 demo's bundle `3f84befac918afe335547b36` straight into
  `game/demo_mars_city1`, 2 GB of guest memory, one executor, 130 s; the web process's RSS once a
  second. Arms alternated, two pairs: 2c521083 against it with the blocks let go.
- **Values.** RSS 80-125 s: 1975, 1980 against 2057, 2100 MB; highest by 125 s: 2324, 2431
  against 2772, 2787; anonymous memory at 120 s: 1377, 1430 against 1350, 1438. Bytes let go in
  the worker 175 MB against 185 MB: of the 47 MB of blocks, 10 MB had been uploaded by then.
- **Why.** The gain is 10 MB at that point; the higher peaks are not explained (both pairs).
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz), 15 GB, Ubuntu 24.04, no GPU; Playwright 1.63.0
  (WebKit 26.6, WPE, headless). Spread between runs of one arm in that level: about 300 MB at the
  peak, 50 MB in the mean.
- **Decision.** Not kept; the blocks stay. The patch (28 lines and its test) is not in the tree.

### 2026-10-25 - a smaller translation arena, and no relinks, for the page's memory [VALID]

- **Measured.** An 8 MB translation arena, and no relinks, for the page's memory. The engine's test
  page as packaged, fake GPU in a graphics worker, Doom 3 demo bundle 3f84befac918afe335547b36, 2
  GB, one executor, WPE WebKit 26.6 on Linux, KVM Xeon 2.10 GHz. Menu, 60 s, arena 8 MB against head
  (95438a8f): median 1231, 1189, 1195 against 1205, 1208, 1205 MB; highest 1328, 1379, 1314 against
  1460, 1417, 1344. First level, 130 s, `relinkAfter: 0` against head (632a0aa5), two pairs: mean
  1879, 1891 against 1920, 1929; highest 2322, 2308 against 2055, 2542; modules emitted 100, 103
  against 195, 202 MB. Spread: 10 MB in the menu's median, 300 MB in the level's highest.
- **Decision.** Neither default changed.
- **Revisit when.** On the phone (its jetsam report), where module bytes may weigh otherwise.

### 2026-10-25 - a context that keeps no texels reads a program's pixels without converting them [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** The effect sought (about 160 MB of garbage) is a third of the
  highest's spread (450 MB) over three pairs; "not what sets its highest" does not follow from
  numbers that cannot show it. The phone charges every page touched (2026-10-26). Re-measure: the JS
  heap's high-water mark in both arms, and the phone's footprint or 5 pairs in WebKit.

- **Idea.** On the engine's thread an OpenGL context recorded for the graphics worker keeps no
  texels (2c521083), yet every glTexImage2D and glTexSubImage2D still turned the program's pixels
  into RGBA, digested them and threw them away: about 160 MB of garbage in the Doom 3 demo's first
  level load. Read the bytes (the read is what sends them to the worker) and convert nothing;
  digest an upload only in a build with diagnostics.
- **Workload.** The engine's test page built as the package is (minified, diagnostics off), fake
  GPU in a graphics worker, the Doom 3 demo's bundle `3f84befac918afe335547b36` straight into
  `game/demo_mars_city1`, 2 GB of guest memory, one executor, 130 s; the web process's RSS once a
  second. Arms alternated, three pairs: 270100b7 against it with the change.
- **Values.** RSS 80-125 s: 1994, 1897, 1947 against 1918, 1979, 1971 MB; highest by 125 s:
  2610, 2343, 2153 against 2078, 2302, 2374; anonymous memory at 120 s: 1389, 1368, 1360 against
  1383, 1384, 1394.
- **Why.** Garbage the collector takes back in the load: not what the process holds, and not
  what sets its highest, which moves 450 MB between runs of one arm.
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz), 15 GB, Ubuntu 24.04, no GPU; Playwright 1.63.0
  (WebKit 26.6, WPE, headless).
- **Decision.** Not kept; the patch (`readPixels` with a `convert` flag, digests by
  `BOTTLIFY_DIAGNOSTICS`) is not in the tree.

### 2026-10-26 - a guest page written out and zeroed gives the tab no memory back on an iPhone [VALID]

- **Measured.** A guest page written out and zeroed, on an iPhone. A test page, one unshared
  `WebAssembly.Memory` of 2048 MiB written in 64 MiB chunks of xorshift output 200 ms apart; mode A
  keeps, mode B zeroes each chunk; progress in `localStorage`. A ended by the system at 1856 and
  1664 MB written; B at 1728 and 1728 MB; order A, B, B, A. The user's iPhone in the Claude app's
  viewer; model and iOS version not recorded.
- **Decision.** No page file over guest memory: the tab is charged for every page it ever touched.
- **Revisit when.** WebAssembly gains a way to give pages back on iOS.

### 2026-10-26 - a long-mode doubleword register read left unmasked after a doubleword write [STALE]

- **Audit 2026-11-14: STALE.** Measured on the long runner (`cork/src/long`), retired on 2026-10-27
  (435978ebe); long mode runs on the shared emitter. Two runs an arm, spread wider than any
  difference. Re-measure, if the shared emitter's 64-bit reads still mask a dword written in the
  block: callgrind counts (`ir.sh`, x64 images), one run an arm.

- **Idea.** The long-mode translator keeps each register in an i64 local and masks a 32-bit read
  with `i64.and 0xffffffff`, 217 of them in one hot match-finder region of 7-Zip. A register
  written as a doubleword earlier in the same block, not in a branch and not since as a
  quadword, has its upper half zero already, so the read needs no mask.
- **Workload.** 7-Zip 23.01 x64 (`7za.exe b -md18 -mmt1`) under the engine in node, the whole
  benchmark, its total rating; both arms snapshots of the tree at cf1c5d31, one with the change.
- **Values.** Before 1347 and 1255, after 1267 and 1270; two runs an arm, alternated. The arms'
  spread (1255 to 1347 for the same code) is wider than any difference.
- **Why.** Not measured further; V8 may drop the mask itself, or it costs too little to see.
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz), 15 GB, node 22.22.
- **Decision.** Not kept; the patch (a `narrow` set in the block emitter and a directed test of a
  block entered with a wide register after a doubleword write) is not in the tree.

### 2026-10-26 - long-mode regions laid out with wasm loops instead of the dispatch loop [STALE]

- **Audit 2026-11-14: STALE (superseded).** Measured on the long runner; since 2026-10-27 long-mode
  regions are formed and emitted by the shared emitter (cef17b7d6, 435978ebe), which lays regions
  out with its structured loops (not checked line by line for 64 bits). No re-measurement for this
  layout.

- **Idea.** A long-mode region runs its blocks inside one dispatch loop: every jump back goes
  round it through a `br_table`, 668 M of them in a 7-Zip benchmark run, one per 51 guest
  instructions. Laid out as the 32-bit translator lays its regions (`planStructure`'s order and
  natural loops), each loop a wasm `loop` whose jumps back are its own branch, forward jumps
  `block`s opened before any loop they would cross, and only blocks outside every loop (or a
  loop's head) filed as ways in, the dispatch would be left to entries and the rare jump back
  to a block that heads no loop around it.
- **Workload.** 7-Zip 23.01 x64 (`7za.exe b -md18 -mmt1`) under the engine in node, the whole
  benchmark, its total rating; both arms snapshots of the tree at 2d8f1e52, one with the layout.
  The long gate (with a new generator of nested loops, jumps out of and into them) passed on
  both, and the layout's mutations (loop depth, entries, hoisting) were caught.
- **Values.** Before 1520, 1474, 1489, 1572, 1558 (mean 1523); after 1493, 1601, 1552, 1534,
  1384 (mean 1513). Five runs an arm, alternated.
- **Why.** Not measured further; V8's code for the dispatch's `br_table` is predicted well enough
  that a branch of its own buys nothing here.
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz), 15 GB, node 22.22.
- **Decision.** Not kept. The generator of nested programs stays in the long gate; the layout
  (`structureOf`, a control stack in the block emitter, entries filed by it) is not in the tree.

### 2026-10-26 - a long-mode store's page test as one load of two pages' flags [STALE]

- **Audit 2026-11-14: STALE (superseded).** Long runner retired; the shared emitter's `checkAccess`
  is the one-load form, and the window test was folded into it later (c81719f9d, the 2026-10-29
  entry). No re-measurement needed.

- **Idea.** A long-mode store tests its address below 4 GiB, its page's flags, and, when it may
  reach the next page, that page's flags: three branches. As the 32-bit translator's
  `checkAccess` does, one `i32.load16_u` of the flags of the page and the next with the address's
  high half `or`ed in makes it one branch, the exact page and 4 GiB tests left to a slow path.
- **Workload.** 7-Zip 23.01 x64 (`7za.exe b -md18 -mmt1`, then `b 4 -md18 -mmt1` for a steadier
  rating) under the engine in node; both arms snapshots of the tree at ef381217, one with the
  change. The long gate passed with it, with a new case (an address past 4 GiB whose low half
  lies on an open page) that its mutations failed.
- **Values.** One pass: before 1389, 1569, 1479; after 1475, 1397, 1639. Four passes: before
  1616, 1576; after 1569, 1542. Runs alternated.
- **Why.** Not measured further; the always-taken 16-bit load and the folded high half cost
  about what the branches they replace did.
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz), 15 GB, node 22.22.
- **Decision.** Not kept; the new gate case is.

### 2026-10-26 - no flag record for a long-mode write whose flags no one reads [STALE]

- **Audit 2026-11-14: STALE (superseded).** Long runner retired; long mode is emitted by the shared
  emitter with its own dead-flag analysis (whether `deadFlagPass` runs at 64 bits was not checked).
  No re-measurement needed unless it does not.

- **Idea.** As the 32-bit translator's `deadFlagPass` finds, a flag-writing instruction whose
  flags are all written again before any read needs no record: the long-mode emitter's
  `record()` returning at once when nothing it writes is live.
- **Workload.** 7-Zip 23.01 x64 compressing the same 8.4 MB file (`a -mx5 -md18 -mmt1`) under the
  engine in node, wall time of the whole job; callgrind on the same job over 1 MB. Both arms
  snapshots of the tree at 3aa6df06, one with the change. The long gate passed with it and its
  mutations were caught.
- **Values.** Wall time, before 10753, 8718, 9495 ms; after 9269, 9224, 9027 ms (alternated).
  Host instructions (callgrind), before 24.32 G, after 24.36 G.
- **Why.** V8 already drops a local written and never read: the record the change leaves out
  was not in the machine code.
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz), 15 GB, node 22.22.
- **Decision.** Not kept.

### 2026-10-26 - a long-mode region of more or fewer blocks than 256 (16 KiB) [STALE]

- **Audit 2026-11-14: STALE.** Measured on the long runner (`REGION_LIMIT` 256, 16 KiB). Since its
  retirement long mode forms with the shared runtime's `maxRegionBlocks` 128 and 8192 bytes
  (`runtime.js`, `region.js` defaults; no 64-bit override in cork or core), the size this entry
  found costs Stockfish about 10%. No entry records the change. Re-measure: Stockfish 8 x64 bench
  and 7-Zip x64 on the shared runtime, 128 / 8 KiB against 256 / 16 KiB, 5 pairs each, plus
  callgrind counts.

The long-mode translator's regions take up to 256 blocks and 16 KiB of code (`REGION_LIMIT`,
`REGION_BYTES` in `modules/cork/src/long/runtime.js`). Measured at 128/8 KiB, 512/32 KiB and
1024/64 KiB against 256/16 KiB, node 22, the project's 4-core VM with other work on it (load
1-2), arms alternated, each a fresh process:

- Stockfish 8 x64, `bench 16 1 12`, nodes a second, 3 pairs each: 128 gave 163 657 / 158 749 /
  150 741 against 176 443 / 173 865 / 176 653; 512 gave 184 656 / 194 036 / 201 026 against
  171 690 / 184 466 / 179 770; 1024 gave 200 825 / 203 746 / 184 366 against 512's 189 614 /
  186 487 / 194 546.
- 7-Zip 23.01 x64 compressing the 8.4 MB file (`a -mx5 -md18 -mmt1`), ms: 512, 5 pairs,
  8268 8676 8118 8325 7932 (median 8268) against 8054 7054 7466 8128 8186 (median 8054), and 3
  earlier pairs 9460 6990 8276 against 9797 9054 8342; 1024, 3 pairs, 8349 9254 8771 against
  8060 8444 8207.

Larger regions helped Stockfish (+7 % at 512) and cost 7-Zip (-2.6 % at 512, -5 % at 1024);
smaller ones cost Stockfish 10 %. No size won both; 256 kept.

### 2026-10-26 - long-mode indirect-call prediction on real programs [STALE]

- **Audit 2026-11-14: STALE.** Long runner retired; long mode now takes the shared runtime's default
  `callTargets: true` (no 64-bit override found in cork or core), and the reason given (forming on
  the run's own thread) no longer holds: the shared runtime forms on its translation worker.
  Re-measure: x264 and zstd win64 as here, on against off on the current tree, 3 rounds alternated.

- **Idea.** The long-mode runner's `callTargets` (an indirect call sampled, its small callees
  formed into its regions, those regions formed again), as the 32-bit runtime's; on cork-bench
  in Chromium (paired, 40 rounds, after 100 warm iterations) it gave vcall-x64 0.650,
  calls8-scatter 0.713, game-x64 0.874 of the time without it.
- **Workload.** x264 r3222 win64 (`--threads 1`, 200 frames of a 320x240 clip, fps) and zstd
  1.5.7 win64 (`-b3 -i5 -T1 --zstd=wlog=18`, MB/s) under the engine in node 22.22, one executor.
  Arms (snapshots of the tree at 9e38bce3 plus this change's store test): prediction off; on,
  only regions of at most 32 blocks formed again; on, every region holding the call formed
  again, a quiet decision dropping none and the forming held to 5 % of the run's time. Three
  rounds, arms alternated within each.
- **Values.** x264 fps, off 12.65 13.05 12.32 (median 12.65); small regions 12.66 12.96 12.63
  (12.66); every region 11.16 12.05 11.12 (11.16). zstd MB/s, off 67.0 63.8 66.8 (66.8); small
  regions 53.2 59.9 59.3 (59.3); every region 59.2 63.7 61.6 (61.6). Before the quiet decisions
  and the time share, every decision dropping its regions: x264 6.38-7.40 against 12.88-13.92
  off (single runs, 173 053 blocks formed against 27 778).
- **Why.** The forming is the run's own thread here (the 32-bit runtime forms on its translator
  worker), and a region formed again starts over on V8's first tier; x264's 183 sampled calls sit
  in regions of 40-260 blocks. Left to the sampling alone (small regions), zstd still lost: the
  profile is written on every indirect call in one run of two.
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz), 15 GB, node 22.22.
- **Decision.** Off by default (`callTargets: false`); the long tests run with it on.

### 2026-10-26 - long-mode packs merged by levels [STALE]

- **Audit 2026-11-14: STALE.** Long runner retired; the shared runtime relinks (`relinkAfter`,
  `mergeAfter`), and packs merged by levels is no current mechanism. Re-measure only if long mode's
  module count shows in its crossings.

- **Idea.** Beside the long-mode runner's packs of 32 regions (a8bc8c90), merge packs as they
  pile up, two of a level into one of the next (32, 64, 128, ...), so a program of thousands of
  regions has few modules and its transfers and calls stay inside one instance more often.
- **Workload.** cork-bench at 64 bits, every x64 workload. Arms: the tree at a8bc8c90 as it is,
  and the same with the merging; `core`, `tools` and `node_modules` shared. Chromium
  (`browser.mjs --bits 64 --paired --rounds 40`, 100 warm iterations, Chrome for Testing
  153.0.8010.12 headless), two independent runs; node 22.22 (`bench.mjs --warm 30 --iters 50
  --reps 3`), arms alternated, two runs an arm. Checksums equal in every run.
- **Values.** Chromium, merged / packs, median ratio [q25 q75], run 1 then run 2: patch-x64
  1.103 [1.019 1.167], 1.138 [1.051 1.204]; load-x64 1.279 [0.988 1.422], 1.171 [0.989 1.382];
  calls4096-scatter 0.947 [0.929 1.001], 0.993 [0.926 1.053]; lua 0.993, 0.992; the other 14
  within 0.977-1.023. Node: calls4096-scatter steady 6195 / 5848 -> 4638 / 4455 us an iteration;
  lua cold 779 / 767 -> 1138 / 974 ms; load steady 976 / 885 -> 1335 / 946 us. In the long tests
  the merges did happen (by level 103, 52, 21, 10, 5, 1, 1).
- **Why (not measured).** Every merge compiles a growing module again and its code starts over on
  V8's first tier; patch and load drop and form regions all the time.
- **Machine.** A cloud container (Xeon 2.10 GHz, 4 cores), node 22.22; GPU, driver and power
  plan not recorded.
- **Decision.** Not taken; packs of 32 stay. A later try would merge only packs that have lost
  no region for a while.

### 2026-10-26 - the 32-bit translator's store into code, its slow path cut or moved out [VALID]

- **Measured.** The 32-bit translator's store-into-code slow path cut (min, min2) or moved to one
  shared helper (outl). cork-bench, every 32-bit workload; Chrome for Testing 153.0.8010.12 (V8
  15.3.76.4) `browser.mjs --paired --runs 1 --rounds 40`, two runs; node 22.22 `run.mjs --reps 3`,
  three rounds an arm; base a8bc8c90; checksums equal. min and min2 invalid as a measure (a leave
  before a block's first instruction splits regions: sort 5 -> 44 regions, 4.2-5.4x slower). outl:
  Chromium every workload 0.95-1.05, none past the noise the same way twice; node geomean 1619 /
  1607 / 1662 against 1677 / 1677 / 1625 MIPS (base spread 3.4%); module bytes -2.9 to +1.3%.
- **Decision.** Not taken; the long-mode scheme is not ported.
- **Revisit when.** A profile shows `noteCodeStore` paths hot.

### 2026-10-27 - long mode's window test folded into the page test [STALE]

- **Audit 2026-11-14: STALE (superseded).** The fold went in afterwards for group checks and then
  single accesses (c81719f9d; "2026-10-29 - long mode's window test of a single access folded into
  its page-flag test"), so this "not taken" is not in force. No re-measurement needed.

- **Idea.** A long-mode operand access tests the 4 GiB window (`windowAddress`: the address and
  its last byte or'd, shifted down 32 bits, a branch) and then the page flags (`checkAccess`: a
  branch). Kept in an i32 local and or'd into the page test's word, the two tests are one branch
  on the hot path.
- **Workload.** cork-bench x86-64 images, `--bits 64 --cork '{"long":"shared"}'`; the measure is
  machine instructions an iteration under callgrind (node 22.22 `--no-liftoff`, 20 warm
  iterations, the run of 10 + K iterations less the run of 10, divided by K), base c23d5167.
- **Values.** vm-x64, K = 200: base 2.927 M an iteration (5.11 a guest instruction), folded
  3.017 M (5.26); K = 100 runs before: 5.20 base, 5.30 folded. tree-x64 (K = 50) 5.89 -> 5.73,
  sort-x64 4.53 -> 4.50, within the 0.1 a guest instruction the measure moves between runs.
- **Why.** Not attributed; the local carried from the window test to the page test is one more
  value live across the address computation in handlers already spilling.
- **Machine.** A cloud container (Xeon, 4 vCPU), node 22.22, valgrind 3.22.
- **Decision.** Not taken.

### 2026-10-27 - long mode's push and pop without the 4 GiB test under loose stacks [STALE]

- **Audit 2026-11-14: STALE (superseded).** Measured again on 2026-10-28 with tree-x64 (calls and
  pushes): -8.0%, taken; that entry says this one's decision does not stand.

- **Idea.** Under `looseStacks` a store through rsp alone tests no page; its 4 GiB window test
  (`windowAddress` in `push` and `stackAccess`) could go the same way, the address taken as rsp's
  low half.
- **Workload.** cork-bench sort-x64, `--bits 64 --cork '{"long":"shared"}'`; machine instructions
  an iteration under callgrind (node 22.22 `--no-liftoff`, 20 warm iterations, the run of
  10 + K iterations less the run of 10, divided by K, K = 100), base 64751605, one run an arm.
- **Values.** base 5.813 M an iteration (4.38 a guest instruction), without the test 5.885 M
  (4.43): within the measure's run-to-run spread. lua-x64 base 67.4 M (10.84); its other arm was
  not measured (the run hit the shell's time limit).
- **Why.** Not attributed; the test is a few instructions a call and a return, and the hot
  regions' cost is elsewhere (V8 spills: 2.0 machine instructions a guest one in sort-x64's main
  region against 0.89 at 32 bits, `cork-asm --classes`).
- **Machine.** A cloud container (Xeon @ 2.80 GHz, 4 vCPU), node 22.22, valgrind 3.22.
- **Decision.** Not taken; the rsp-only window keeps its test.

### 2026-10-27 - callee-saved registers kept across a guest call [VALID]

- **Measured.** ebx, ebp, esi, edi kept in the caller's locals across a guest call. cork-bench
  vcall, game, tree, sort, str, lua (x87), `pair.mjs` in node 26.12 (V8 14.6) `--no-liftoff`, off /
  on / off again, warm 200, 40 rounds of 10; median ratio: vcall 0.993, game 0.989 (off again
  0.988), tree 0.999, sort 1.025, str 0.999, lua 1.015 (off again 1.048); vcall's call blocks
  statically -2.7%. Cloud container, Xeon 2.10 GHz, 4 vCPU.
- **Decision.** Not taken: the reloads read a line the callee just wrote, off the critical path.
- **Revisit when.** On arm64 (not measured). Noted and unexplained: a third and fourth host in one
  process ran vcall at 196-205 against 102-109 us with six times the untranslated exits.

### 2026-10-27 - a byte copy loop done at once [VALID]

- **Measured.** A `movs`/`stos` copy loop done at once. cork-bench sort (37% of its guest
  instructions in such a loop, 12 bytes a call), callgrind, node 26.12 (V8 14.6) x64 `--no-liftoff`:
  base 5.140 M machine instructions an iteration, `memory.copy` 5.161 M, short runs in wasm 5.138 M;
  native 1.368 M. Gated; mutations failed the gate.
- **Decision.** Not taken; patch and gate kept outside the tree.
- **Revisit when.** A program copies long runs through gcc's freestanding loop (MSVC uses `rep
  movs`, which has a run path).

### 2026-10-28 - the flag record not read back after a guest call where the code after it writes the flags first [VALID]

- **Measured.** The flag record not read back after a call where the code after it writes the flags
  first. cork-bench tree and vcall, callgrind per instruction, node 26.12.1 (V8 14.6) x64
  `--no-liftoff --no-wasm-dynamic-tiering --predictable`, warm 300, 300 iterations, exact to 0.01%:
  tree 1 795 465 068 -> 1 795 362 891 (-0.006%), vcall 1 098 913 802 -> 1 098 953 287 (+0.004%).
- **Decision.** Not taken.
- **Revisit when.** No need.

### 2026-10-28 - a scalar SSE load that owes its vector on an x64 host [VALID]

- **Measured.** A scalar `movss`/`movsd` load owing its zeroed vector on an x64 host. fmath-sse and
  game-sse, callgrind over node 26.12.1 x64, 1000 warm, 1000 counted (two runs of one tree within
  0.23%): fmath 809 730 and 808 950 -> 795 922 (-1.7%); game 1 135 728 and 1 135 993 -> 1 152 080
  (+1.4%). Low-lanes gate on both hosts' features.
- **Decision.** Not taken: x64 loads the vector; arm64 owes it (a186f4289).
- **Revisit when.** No need.

### 2026-10-28 - long mode's push and pop without the 4 GiB test under loose stacks, measured again [VALID]

- **Measured.** Long mode's push and pop without the 4 GiB test under loose stacks, again. sort-x64
  and tree-x64, `ir.sh` at 73ed219 (callgrind, WARM 1000, 100 iterations), medians of two or three
  counts, node 26.12.1 (V8 14.6.202.34): sort 6 026 075 -> 5 989 352 (-0.6%), tree 4 016 095 -> 3
  696 743 (-8.0%). Noise 0.1-0.7% (switch 1.9%).
- **Decision.** Taken, with a return's 4 GiB test moved past its compares (`returnLong`); the
  2026-10-27 decision does not stand.
- **Revisit when.** No need.

### 2026-10-28 - long mode's field reads off one wrapped sum, grouped by register name [VALID]

- **Measured.** Long mode's `wrappedFirst` grouped by register name. x64 images as the entry above:
  fmath 817 357 -> 779 192 (-4.7%), game +0.1%, vm +0.8%, sort +0.2%.
- **Decision.** By name not taken; by the values the registers hold (`operandValues`) taken: vm
  -0.7%, sort -0.3%, fmath and game the same wasm.
- **Revisit when.** No need.

### 2026-10-29 - a plain self-loop run two turns a wasm turn [VALID]

- **Measured.** A plain (unhoisted) self-loop run two turns a wasm turn. cork-bench crc, vm, switch,
  sort, fmath, tree, str, game, vcall (x87), `ir.sh` WASM=1, node 26.12.1 x64, CLOCK=0.001, 1000 +
  1000 iterations, one run an arm (two base runs identical): crc 1 707 993 -> 1 706 399 (-0.09%),
  sort -0.04%, the rest unchanged.
- **Decision.** Not taken; the hoisted unchecked copy two turns a wasm turn paid (crc -3.0%, str
  -10.2%) and went in.
- **Revisit when.** No need.

### 2026-10-29 - long mode's window test of a single access folded into its page-flag test [VALID]

- **Measured.** Long mode's window test of a single access folded into its page-flag test. tree-x64,
  `ir.sh` WASM=1, node 26.12.1, 1100 - 1000 over 100, cork2-x64 cc16b41: 3 445 305 -> 3 445 783
  (+0.01%).
- **Decision.** Left in: fewer instructions wherever such an access runs.
- **Revisit when.** No need.

### 2026-10-29 - the flag record not taken back after a guest call, measured again on the arm64 model [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** arm64 counts from cork-asm on the Crysis regions, named by the
  2026-10-29 invalidation as possibly misread and "not to be cited until re-measured"; never
  re-measured. The x64 exact count (2026-10-28, -0.006%) points the same way. Re-measure with the
  fixed cork-asm, one run an arm.

- **Idea.** The idea of the 2026-10-28 entry (measured there on x64): after a guest call made as
  a wasm call the region reloads the callee's flag record for every field its body uses; where
  the code at the return address writes every arithmetic flag before it reads one or leaves
  (`flagsLiveAt(next)` has no arithmetic flag), take back the flags word alone (it holds DF)
  and empty the record's locals (`clearRecord`, kind EAGER).
- **Workload.** cork-asm on the Crysis timedemo's 21 main-thread regions (n14 block profile),
  macOS arm64 model: node 26.12.1 arm64 (V8 14.6) under qemu-aarch64 8.2.2,
  `--no-wasm-bounds-checks`, `--atomic`, RAM at 0; machine instructions an executed guest
  instruction, deterministic (one run an arm).
- **Values.** On cork2-x64 at 8740b9eb with the linked call's single load (an earlier form of
  fe40382e): 5.413 without, 5.411 with (-0.04 %). Record loads after a call 0.038 -> 0.016 an
  executed guest instruction; the "after the call" part 10.8 -> 12.0 instructions a call.
- **Why.** Under the macOS model (no explicit bounds checks) V8 already drops a reload whose
  value nothing reads; the reloads left are live through the shared epilogue's stores, and the
  zeros put in their place cost a move each at the joins after the call, about what the loads
  did.
- **Machine.** A cloud container (Intel Xeon @ 2.10 GHz, 4 vCPU), shared with other runs.
- **Decision.** Not taken.

### 2026-10-29 - a guest call's depth and budget tests as one condition [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** The same tool and caveat as the entry above; the linked call's one
  condition did pay on arm64 (fe40382e). Re-measure with the fixed cork-asm.

- **Idea.** Before a guest call made as a wasm call, `depth >= LIMIT` and `budget <= 0` were
  two branches to the plain way out; or'ed into one condition V8 makes a cmp, a ccmp and one
  branch on arm64. Tried as `geU` and as `depth & -LIMIT` (LIMIT a power of two).
- **Workload.** As the entry above (cork-asm, arm64 model, 21 regions, n14 profile).
- **Values.** At the same tree: 5.413 with two branches; one condition by `geU` 5.417
  (+0.07 %), by the mask 5.418 (+0.09 %). The call site's test stays four instructions either
  way: V8 moves 256 into a register to compare it (`geU`), or makes an `and` and a `cmp` of the
  mask, before the ccmp.
- **Machine.** As above.
- **Decision.** Not taken. (The linked call's key and top tests as one condition did pay on
  arm64, fe40382e: both compare against a register or a small immediate.)

### 2026-10-29 - every planned access off a lone register takes its displacement as its offset [VALID]

- **Measured.** Every planned access off a lone register with its displacement as the load's offset.
  arm64 model, cork-asm on the Crysis regions (before ab02ac9): 5.385 -> 5.384 (-0.02%).
- **Decision.** Not taken, on correctness: off a pointer in the top 64 KiB the unwrapped sum traps
  where a wrapped one reads the null page.
- **Revisit when.** No need.

### 2026-10-29 - a cmovcc from a register as a select [VALID]

- **Measured.** Every 32-bit cmovcc as a `select`. cork-bench x87, `ir.sh` WASM=1, ITERS=300, node
  26.12.1 x64, base 3078203: tree 2 848 928 -> 2 800 184 (-1.7%), game 1 091 219 -> 1 138 179
  (+4.3%, spills: stack-slot traffic 129 M -> 154 M); others unchanged.
- **Decision.** Taken from memory only (4f54a94); from a register it stays a branch.
- **Revisit when.** On arm64 (not measured).

### 2026-10-29 - an x87 integer store through the quadword saturating conversion [VALID]

- **Measured.** x87 `fist`/`fistp` through `i64.trunc_sat_f64_s`. V8 14.6 x64 code of `fldcw; fistp
  dword; fldcw` counted by hand: 19 instructions against 17.
- **Decision.** Not taken; the value plus 1.5 x 2^52 went in (1a635af, 11 instructions, game
  -2.64%).
- **Revisit when.** No need.

### 2026-10-29 - a self-loop that only reads, hoisted as a loop with stores is [VALID]

- **Measured.** A read-only self-loop hoisted as a loop with stores is. `ir.sh`, one run an arm:
  window as page flags: crc -3.6%, str -7.0%, sort +4.6%; window as a compare against RAM: crc
  -3.6%, str -8.3%, sort +2.8%.
- **Decision.** Not taken in this shape; a read loop hoisted with no loop around its test
  (`emitReadLoop`) went in.
- **Revisit when.** No need.

### 2026-10-29 - a single read off a register through the register's wrapped sum [VALID]

- **Measured.** A lone read off a register through the register's wrapped sum. `ir.sh` x87 images,
  one run an arm: every small displacement: crc +1.6%, str +0.2%, tree -1.9%, switch -0.6%, vcall
  +0.7%, game +0.1%; any but 0: crc +1.7%, str +1.1%, tree -1.9%, switch -0.6%, vcall +0.7%.
- **Decision.** Not taken: one more value live, V8 spilled for it.
- **Revisit when.** No need.

### 2026-10-29 - a loop of several blocks paired up to 64 instructions [VALID]

- **Measured.** Loops of several blocks paired up to 64 instructions (`PAIRED_MAX` 32). `ir.sh` on
  30c1205: switch, fmath, tree unchanged, vcall +0.7%.
- **Decision.** The limit stays 32.
- **Revisit when.** No need.

### 2026-10-29 - entry-test locals for jumps forward, and locals cleared in shallower loops [VALID]

- **Measured.** Entry-test locals for jumps forward (a), and cleared in shallower loops (b). `ir.sh`
  on 30c1205: jumps back alone (taken): game 1 062 421 -> 1 030 109; (a) sort +2.2%, crc -0.1%;
  (a)+(b) crc -4.9%, game -3.9%, sort +4.6%; every clearing block, sort +5.2%.
- **Decision.** Neither taken: jumps back only.
- **Revisit when.** V8's register allocation of large functions changes (sort's loss is spills).

### 2026-10-29 - a guest call's ways out storing what a way to them wrote, through a chain of stores [VALID]

- **Measured.** A call's ways out storing what a way to them wrote, as one chain of stores. `ir.sh`
  in-wasm, base a9c1412: lua -1.49%, calls512-scatter -4.11%, calls8-order -3.36%, tree -0.46%,
  vcall +1.02%, str +1.95% (41 moves more at str's hottest way out).
- **Decision.** Not taken as a chain; the epilogue stores a few kinds of set (`EXIT_KINDS`): eight
  kinds lua -1.84%, str -0.04%, calls512-scatter -5.24%, taken.
- **Revisit when.** No need.

### 2026-10-29 - callees of a few instructions formed in past the region's caps [VALID]

- **Measured.** Callees of at most 2 blocks / 32 bytes formed in past the caps. Mechanism counts
  over 10 iterations after 50, node 22.22.0: lua `APART_FULL` 2 587.5 an iteration either way; no
  count changed on eight workloads; all such callees were formed in already.
- **Decision.** Not taken.
- **Revisit when.** Crysis's 107.5 M region-full calls (2026-10-23) are sized: never measured.

### 2026-10-29 - a `ret` back to its call without the empty stack's test [VALID]

- **Measured.** A `ret` to its call without the empty stack's test (a hack). `ir.sh` in-wasm: lua
  -0.31%, calls512-scatter -1.30%, tree +0.12%.
- **Decision.** Not taken: no 32-bit word is one a `ret` cannot pop; a tagged form or an exact way
  back with a gate would be needed.
- **Revisit when.** The return stack's entries change form for another reason.

### 2026-10-29 - a predicted call to a callee not formed in made as a wasm call [VALID]

- **Measured.** A predicted call's other targets made as a wasm call. `ir.sh` in-wasm: calls8-order
  -18.4% (through the transfer 3 310 493), vcall +21.1%; game, tree, lua unchanged; vcall's modules
  +14.6%.
- **Decision.** Not taken.
- **Revisit when.** For sites whose samples show many other targets, with the call kept out of the
  hot function.

### 2026-10-29 - long mode's owed compare result answered for je/jne by an i64 compare [VALID]

- **Measured.** Long mode's owed compare for je/jne as an i64 compare. x64 images, `ir.sh`
  ITERS=1000, node 26.13.0, 8740b9eb: tree 3 117 594 -> 3 160 406 (+1.4%), sort 4 029 716 -> 3 793
  562 (-5.9%), crc and vm the same.
- **Decision.** Not as such: a narrower compare's operands compared as i32, a quadword's as i64
  (tree 3 117 594, sort 3 791 850).
- **Revisit when.** No need.

### 2026-10-29 - a linked call's slot read in one quadword load on an x64 host [VALID]

- **Measured.** A linked call's slot in one quadword load on an x64 host. cork2-x64-speed 35c25a0,
  `ir.sh` ITERS=1000, node 26.13.0, two runs identical; one load -> three: calls512-order 5 242 588
  -> 5 128 910 (x32), 5 998 645 -> 5 843 891 (x64); calls512-scatter 5 251 383 -> 5 139 761, 4 989
  406 -> 4 825 586; load and lua lower too; none higher.
- **Decision.** Three loads on an x64 host; arm64 keeps the one load (not measured here).
- **Revisit when.** No need.

### 2026-10-31 - a run loop in a worker that sleeps until something happens (`pacing: 'event'`) [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** Nothing recorded but two figures from a code comment: title,
  build, date, runs and browser unknown. The cause named (a host answer waking the loop for a turn
  that retired nothing, about 70 000 times) is a defect of that loop that could be fixed, not a
  property of event pacing; the multi-worker runner is priority 1. Re-measure: a title's menu and
  play in the launcher, the page's pacing against an event loop that batches host answers, 5 runs an
  arm, guest instructions and frames.

- **Idea.** A run loop in a worker of its own needs no short timer: it could sleep until the
  guest's next deadline, a host answer or a message from the page, and yield to the event loop
  only when something is pending, where the page's pacing yields on its interval and looks again
  on a short timer while idle.
- **Workload.** A real title's menu through the launcher, the same build in the same worker, 30 s
  an arm. The title, the bundle's hash and the build: not recorded. Recorded here from the
  comment the option carried in `modules/core/src/host/messages.js` (present on 2026-10-24); the
  date of the measurement: not recorded.
- **Values.** `page` (the default): 1.95 G guest instructions, 866 frames presented; `event`:
  1.07 G, 469 frames. Runs per arm, median, spread and noise floor: not recorded.
- **Why.** A host call answering woke the loop for a turn that retired nothing, about seventy
  thousand times in the run; the page's short look batches those answers.
- **Machine.** Browser, GPU, driver, operating system and power plan: not recorded.
- **Correctness.** Not judged.
- **Decision.** Removed: `pacing: 'event'` (the worker pacing that slept on a message from the
  page) and the harness's `--pacing` flag are gone; a worker runs the page's pacing at the
  worker's interval.

### 2026-10-31 - a call to an empty function answered at its own site (`emptySites`) [VALID]

- **Measured.** Nothing recorded: SETTINGS.md said a call to an empty method took about a third of
  the transfer's time and every other call out one more slot read (about a nanosecond).
- **Decision.** Removed (never on): `linkedCalls` reads the same slot after it; `emptyCalls` at the
  transfer stays.
- **Revisit when.** Empty calls show hot in a profile; then measure first.

### 2026-10-31 - the hottest regions gathered into one module (`gatherAfter`, `gatherRegions`) [STALE]

- **Audit 2026-11-14: STALE.** One run each, on the iOS path in WebKit 27.2; since, the translator
  lets modules go past its share (`cacheBytes` ceiling on the iOS path, `machineMemory`), and
  crossings had halved with it (1.83 / 1.33 against 3.54 / 3.32 M per G instructions, mixed with
  other changes). Whether WebKit gives a let-go module's memory back decides it. Re-measure: in
  WebKit and on the phone with the iOS ceiling, gathering on against off, memory at the end of the
  load and crossings, 3 runs.

- **Idea.** Where a tail call into another wasm instance faults (WebKit before the fix the iOS
  path waits for) every transfer out of a module goes through the runtime's loop. After a number
  of such crossings, build the regions that took nearly all the heat, wherever they lie, into one
  module, so the hot paths cross less.
- **Workload.** The Doom 3 demo with the iOS path's settings (`crossTailCalls: false`,
  `dispatch`), cold store. Crossings: 300 s a run; host and executors not recorded. Memory: the
  demo's load in WebKit 27.2 (Playwright, the engine's test page, fake GPU), 180 to 240 s, one
  run each.
- **Values.** Crossings per thousand million guest instructions, two runs: without the night's
  change 3.54 M and 3.32 M, with it 1.83 M and 1.33 M; that change also brought region heat and
  cold relinks, and gathering alone was not separated. The web process at the end of the load:
  3090 MB gathering, 1110 MB not; an iPhone 13 Pro Max ends a tab at 1720 MB.
- **Why it did not pay.** Each gathering builds its regions again, and WebKit keeps every module
  it compiled: the memory a gathering costs outweighs the crossings it saves on the one host it
  was for.
- **Machine.** A 4-core x86-64 Linux VM; power plan not recorded.
- **Correctness.** Not judged beyond the runtime's tests.
- **Decision.** Off on the iOS path (`gatherAfter: 0`), and needing `crossTailCalls: false` it
  ran nowhere else; removed with its code.

### 2026-10-31 - the cpu layer's guest sampler switched off (`sampling: false`) [DISPUTED]

- **Audit 2026-11-14: DISPUTED (low).** No figures, title, build or runs: a comment's "unchanged".
  Re-measure only if the sampler's cost matters: cork-bench paired and one title, a patch switching
  it off.

- **Idea.** The sampler that credits every slice to where it ran (a register read and a table
  update a slice) could be switched off to give its cost back.
- **Workload.** Not recorded: the measurement is the cpu layer's own comment, which says the
  sampler was measured to leave the guest phase's ms a frame unchanged; title, build, runs and
  date not recorded.
- **Values.** Guest phase ms a frame: unchanged on and off (the comment's words; figures not
  recorded).
- **Why it did not pay.** Its cost is below what a frame's time can show.
- **Machine.** Not recorded.
- **Correctness.** Not concerned.
- **Decision.** Always on; the option to switch it off is removed.

### 2026-10-31 - threads placed by trial and on reckoned gains, and the trade of a pinned processor [VALID]

- **Measured.** Threads placed by trial, by reckoned gains, and the trade of a pinned processor.
  4-core VM: Crysis timedemo warm one executor 119.2 / 118.9 ms a frame, trial 119.0 (first version
  flapped, 170.9); CoD4 bog_a two executors: no trade 77.4, trade held 86.7, checked and undone 76.5
  (rows 68-97); three executors gains against spread 107.8 / 119.0; a synthetic pipeline 3566-4153
  against 2561-2797 ms. The owner's M4 (Chrome 155-156, CoD4): trials showed as dips (64 against 28
  ms), the trade held: median 34 ms, p95 130 ms; spread without the trade about 45 fps.
- **Decision.** Removed with `freeHost`, `playPinned` and `placementTiming` (a free host the default
  since 2026-10-21); `placement: 'concentrate'` stays for debugging.
- **Revisit when.** No need.

### 2026-10-31 - a job thread's executor chosen by where the other threads will run [VALID]

- **Measured.** A job thread's executor chosen by where the other threads will run.
  `tools/sync-handoff-bench.mjs --frames 150 --jobs 12 --work 100000 --main-work 6000000 --executors
  3 --pin-main`, node 22.21.0 (V8 12.4), guest-semaphores 38e36c60, two runs an arm, Parallels ARM
  VM: before 8.716, 8.866 ms a frame (workers ready-waiting 6.76, 6.67 ms); candidate 8.777, 8.657
  (6.13, 7.73). Placements moved, ready time did not.
- **Decision.** Removed; `--pin-main` reproduction stays in the bench.
- **Revisit when.** Open: Deus Ex: Human Revolution's job threads wait ready about 9.5 ms a frame
  while the third executor idles 22 ms.

### 2026-10-31 - a CM Multi inflated in GameHub's worker without a Blob [VALID]

- **Measured.** A CM Multi inflated in GameHub's worker without a Blob. `tools/gamehub-bench.mjs`,
  704 app ids, headless Chrome 156, gamehub-speed 0835b98b: idle worker info 2441, 10007, 2002 ms
  (inflate 464, 6389, 60); with four cores busy, after the change 44657 ms (inflate 17222, parsing
  13251); the page 1078-3553 ms; the worker's idle spread 1.4-25 s. Parallels ARM VM.
- **Decision.** Reverted: the extension's service worker runs at low priority and everything in it
  waits.
- **Revisit when.** Where GameHub's protocol work runs is decided (the owner's call).

### 2026-10-31 - a Direct3D 10 dynamic buffer given 32 MiB of storages instead of 4 MiB [VALID]

- **Measured.** A Direct3D 10 dynamic buffer's storages capped at 32 MiB instead of 4
  (`STORAGE_BYTES`). Crysis SP demo bundle 354fedbfb099f88d57eb9eed (bundle.btl sha256 32579caa...),
  `-dx10 -DEVMODE +map island +exec benchmark_cpu`, `game.mjs --worker --graphics-worker
  --run-seconds 1200`, hardware adapter, one run an arm: 4 MiB capped 177 474, timedemo 4.10 / 4.97
  fps, Map 178 609 traps; 32 MiB capped 172 241 at the count cap, `cappedBytes` 0, 3.59 / 6.18 fps;
  the same tree gave 3.61 / 6.28 and 4.10 / 4.97. Parallels ARM VM.
- **Decision.** Back to 4 MiB; the counters stay.
- **Revisit when.** The count cap (32 storages, the FREE word's bits) is raised: that is what
  stopped every trapped DISCARD.

### 2026-11-05 - eager WebAssembly compilation against 3DMark2001 SE's frame drops on new code [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** One run of the arm against three without, inside their spread
  (105-167 drops); the later holdMs entry says two runs an arm on this VM cannot tell such an
  effect. Re-measure on the node bench of new code met mid-frame that entry calls for, or 5 runs an
  arm.

- **Idea.** V8 compiles a wasm function lazily, on its first call, on the thread that calls it
  (`--wasm-lazy-compilation` is on by default in V8 12.4), so a region the translator worker
  compiled would still be compiled again on the engine's thread when first entered, inside the
  guest's slice. If that were the frames that dropped on new code, compiling eagerly would
  remove them.
- **Workload.** 3DMark2001 SE bundle (bundle.btl sha256 d0af85f2...), route `--press Benchmark`,
  `game.mjs --worker --store local --prefetch --run-seconds 600` on a fresh browser profile each
  run, hardware WebGPU adapter (adapter info empty), Chrome version not recorded; review at
  a865ef84b. The arm: `--chrome-flag --js-flags=--no-wasm-lazy-compilation`.
- **Values.** Drops named `translation` (the guest's time grew with translating, interpreting or
  instantiating) in the Car Chase low scene: 105, 167 and 134 in three cold runs without the
  flag (17-26-08, 17-41-44, 17-54-48), 150 with it (18-06-46); the scene's 1% low 7.7, 5.9, 7.5
  without, 10.5 with. One run of the arm.
- **Why.** Not determined by this; the drop frames retire about the instructions an ordinary
  frame does in three times the guest's time, with seven times its exits from translated code,
  and neither the translator's time on the thread nor the interpreter's instructions account for
  it. The next step is a profile of the drop frames themselves (`tools/drop-profile.mjs`).
- **Machine.** Parallels ARM VM, Windows 11, 4 vCPU; power plan not recorded.
- **Decision.** No change; V8's defaults stay.

### 2026-11-05 - a smaller share of the engine thread for the translator (holdShare 0.15) [DISPUTED]

- **Audit 2026-11-14: DISPUTED.** Declared inconclusive by "2026-11-05 - the translator's longest
  hold on the engine thread (holdMs 1 against 4), and a correction": two runs an arm on this VM
  cannot tell an effect of this size. Re-measure with that entry.

- **Idea.** The translator's work on the engine thread refills at half the time that passes
  (`holdShare` 0.5, with `holdMs` 4); a smaller share would leave a frame more of its time when a
  scene meets new code, and fewer frames would drop there.
- **Workload.** 3DMark2001 SE bundle (bundle.btl sha256 d0af85f2...), route `--press Benchmark`,
  `game.mjs --worker --store local --prefetch --run-seconds 130 --cork '{"timings":true,
  "holdShare":S}'` on a fresh browser profile each run, the arms alternated, two runs each;
  hardware WebGPU adapter (adapter info empty), Chrome version not recorded; review at c8b065ddd.
- **Values.** Car Chase low, fps / 1% low / drops: 0.5: 135.7 / 10.4 / 236 and 145.7 / 11.8 /
  205; 0.15: 115.3 / 9.8 / 234 and 117.7 / 9.3 / 204.
- **Why.** The drops on new code are not the translator's share of the thread: a dropped frame's
  profile (`tools/drop-profile.mjs`) holds about 3 ms of translating beside more Direct3D work
  and more time in a few regions; a smaller share only kept code interpreted longer.
- **Machine.** Parallels ARM VM, Windows 11, 4 vCPU; power plan not recorded.
- **Decision.** `holdShare` stays 0.5; the setting stays for the next measurement.

### 2026-11-05 - wasm compiled straight to TurboFan against 3DMark2001 SE's drops on new code [VALID]

- **Measured.** Every wasm function compiled by TurboFan eagerly
  (`--no-wasm-dynamic-tiering,--no-wasm-lazy-compilation`). 3DMark2001 SE bundle d0af85f2...,
  `--press Benchmark`, `game.mjs --worker --store local --prefetch --run-seconds 130`, fresh profile
  each run, alternated, two runs each, hardware adapter, Parallels ARM VM. Car Chase low fps / 1%
  low / drops: default 112.0 / 7.0 / 240; TurboFan 64.7 / 8.6 / 117 and 52.2 / 6.2 / 231. High: 86.7
  / 13.2 / 37 against 47.0 / 6.4 / 74 and 20.1 / 3.1 / 102.
- **Decision.** V8's defaults stay.
- **Revisit when.** No need.

### 2026-11-05 - the translator's longest hold on the engine thread (holdMs 1 against 4), and a correction [DISPUTED]

- **Audit 2026-11-14: DISPUTED (self-declared).** Two runs of one arm differ more than the arms
  (79.6 and 141.7 fps). Its decision names a node bench of new code met mid-frame for pacing
  changes; whether it exists was not checked. Re-measure: that bench with `holdMs` 1 / 4 and
  `holdShare` 0.15 / 0.5, or 6 runs an arm on the hardware adapter.

- **Idea.** A dropped frame on new code held about 3 ms of translating, near `holdMs` (4 ms at a
  stretch); a hold of 1 ms would cut the share of it any one frame takes.
- **Workload.** As the holdShare entry above, `--cork '{"holdMs":H}'`, alternated, two runs each.
- **Values.** Car Chase low, fps / 1% low / drops: 4: 79.6 / 5.5 / 428 and 141.7 / 11.0 / 185;
  1: 127.4 / 8.1 / 207 and 105.2 / 7.6 / 283.
- **Why.** Not measured: two runs of the same arm differ by more than the arms do (79.6 and 141.7
  fps). Two runs an arm on this VM cannot tell an effect of this size, and the holdShare entry
  above, measured so, is as inconclusive rather than refuted.
- **Machine.** Parallels ARM VM, Windows 11, 4 vCPU; power plan not recorded.
- **Decision.** `holdMs` stays 4. Changes to the translator's pacing are judged on a node bench
  of new code met mid-frame, not on these runs.

### 2026-11-06 - less garbage a draw in the graphics worker (Direct3D 8/9 `render.js`) [VALID]

- **Measured.** Less garbage a draw in the graphics worker (`render.js` scratch arrays, one uniform
  object, `samplingOf` kept). 3DMark2001 SE `--route`, `--worker --graphics-worker --coi --store
  local --prefetch`, fresh profile, 470 s, CPU and heap profiles 355-455 s, ce2d250db, one run each:
  heap bytes sampled 1901 -> 1607 MB; collector 3800 -> 3608 ms of 100 s; 185.6 against 196.6 fps,
  1% low 6.9 against 7.1 (eight unchanged runs 190-235 fps). Parallels ARM VM, hardware adapter.
- **Decision.** Not kept; the lever was the batches' memory (the next entry).
- **Revisit when.** No need.

### 2026-11-06 - a batch's buffer sent back and written on again (graphics remote, frame rate) [VALID]

- **Measured.** A batch's buffer sent back and written on again (1c4ef4b14). 3DMark2001 SE
  `--route`, `--worker --graphics-worker --coi --graphics-config '{"compressedTextures":true}'
  --store local --prefetch`, 600 s, one profile for six runs an arm, runs 2-6: before (1150e0170)
  255.2, 246.7, 241.6, 264.2, 251.1 fps (median 251.1); after 254.8, 265.0, 266.3, 257.1, 259.0
  (259.0); Mann-Whitney U 4 of 25 (p about 0.15). Collector 48% less, engine allocation 30% less
  (one profiled run each).
- **Decision.** Kept for memory and collection, not counted as a frame-rate gain.
- **Revisit when.** No need.

### 2026-11-06 - a block formed into a caller's region and held at its own start gets a region of its own (cork, frame rate) [VALID]

- **Measured.** A block held at its own start in a caller's region gets a region of its own
  (`heldEntries`, 4307bd214). 3DMark03 `--route`, as above, 420 s cold, five runs an arm: forced
  steps 64-153 against 368 161-660 886; fps median 102.2 against 108.3 (84-112 across runs); scene 4
  drops 476 against 459.
- **Decision.** Kept (removes a loop and its interpreter work), not a frame-rate gain.
- **Revisit when.** No need.

### 2026-11-06 - heavy frames inside 3DMark03's tests are not cold code waiting for its translation (cork, frame pacing) [VALID]

- **Measured.** Heavy frames inside 3DMark03's tests are not code waiting in the translation queue.
  3DMark03 `--route`, as above, cold, 8 runs on 4307bd214 to 4c4bb5ac6: queued to published 10-140
  ms; the worker busy 22-27 s for 6000-6150 regions (emit 16.6-21.0 s); heavy frames of 0.5-1.5 s
  with the engine thread idle 0.3-0.5 s or 750-960 M translated instructions and nothing
  interpreted.
- **Decision.** Batch sizes and the worker left; the two stalls are open questions.
- **Revisit when.** No need for this lever.

### 2026-11-11 - a shared translation store does not speed up the .NET Framework 4 setup's ngen (cork, multi-process) [STALE]

- **Audit 2026-11-14: STALE (superseded).** Measured again on 2026-11-12 under Node 26 with the
  translator pool: a shared store pays from the second assembly on, and that entry supersedes this
  decision.

- **Idea.** The setup's `ngen executeQueuedItems` starts one `mscorsvw.exe` per assembly, about 45
  in all, and each loads `clr.dll` and `clrjit.dll` afresh; under `tools/install-watch.mjs` in Node
  there is no translation store, so the guess was that every worker translated the runtime again.
- **Workload.** `dotNetFx40_Full_x86_x64.exe /q /norestart` (4.0.30319, from a Steam game's
  `_CommonRedist`) under `install-watch.mjs`, one run each arm; the store arm had a folder-backed
  `createDirectoryTranslationStore` passed as `cork.config.store` (790 MiB written by the fourth
  worker). Hash of the setup not recorded.
- **Values.** Seconds between consecutive `mscorsvw.exe` starts, first five: without the store 78,
  18, 65, 70, 42; with it 103, 15, 65, 71. The setup reached ngen at 114 s without the store and
  155 s with it.
- **Why.** The time is the CLR's JIT compiling assemblies as guest code, not cork translating the
  runtime; a store spends its writes for nothing a worker reuses.
- **Machine.** Parallels ARM VM, Windows 11, 4 vCPU, Node 22.21; power plan not recorded.
- **Decision.** No store flag in `install-watch`; the Framework is installed once and its layer
  reused, rather than the ngen pass made faster.

### 2026-11-12 - cork's interpreter and volatile-page levers do not speed up ngen's compile (cork) [DISPUTED]

- **Audit 2026-11-14: DISPUTED (low).** One run an arm, each inside the two default runs' 2.6 s; the
  interpreted addresses, its named next step, were not looked at. Re-measure after `install-watch
  --cork-figures` with `timings` says where the interpreted instructions go, 3 runs an arm.

- **Idea.** A main-thread profile of `mscorsvw.exe` compiling an assembly put 14.3% of the thread
  in the wasm interpreter (`runInteger`) and about 4.5% in the checks of code pages for writes
  (`maskedFingerprint`, `isAt`, `noteRead`), so the guess was that code was interpreted for want
  of translations, or for pages the CLR writes beside its code.
- **Workload.** The installed .NET Framework 4 bundle `net40b` (manifest sha256 d8ac6588...),
  `ngen.exe executeQueuedItems` under `tools/install-watch.mjs`, `concurrency` 1, translator pool
  on (`{"worker":true}`); measured: the seconds between ngen's `Compiling assembly System.Data`
  and its line for System.Data done. One run each arm.
- **Values.** Default 52.9 s and, run again, 55.5 s (the noise between two runs: 2.6 s);
  `volatileAfter` 10^9 (no page ever left to the interpreter for its writes) 50.9 s;
  `wasmInterpreterAfter` 0 (the wasm interpreter from the first instruction) 53.8 s.
- **Why.** Every arm is within the two default runs' spread; not measured yet is where the
  interpreted instructions go (`install-watch --cork-figures` with `timings`).
- **Machine.** Linux container, 4 vCPU, 15 GB, Node 26.13; power plan not recorded.
- **Decision.** Neither setting changed; the next step is the interpreted addresses themselves.

### 2026-11-12 - the shared translation store, measured again, pays for ngen's second assembly on (cork, multi-process) [VALID]

- **Measured.** A run-wide translation store for ngen's workers, again. Bundle `net40b` (manifest
  sha256 d8ac6588...), `ngen.exe executeQueuedItems` under `install-watch.mjs`, `concurrency` 1,
  `{"worker":true}`, alternated, two runs each, Node 26.13, Linux container 4 vCPU: System.Data none
  52.0, 50.3 / store 48.6, 53.1 s; System.Drawing 20.9, 21.6 / 16.4, 17.9; System.Windows.Forms none
  over 69 s / store 72.1, 67.8.
- **Decision.** `install-watch --store memory` again.
- **Revisit when.** No need.

### 2026-11-12 - formed regions kept for the processes sharing a store (`sharedFormed`) slow ngen down (cork, multi-process) [VALID]

- **Measured.** Formed regions kept run-wide for processes sharing a store (`sharedFormed`).
  `dotNetFx40_Full_x86_x64.exe` (sha256 65e06425...) under `install-watch.mjs --minutes 16 --memory
  2048 --store memory`, Node 26.13.1 (8 GB heap), baa8d5a, third to 56th `mscorsvw.exe` start: 32
  768 kept alone 817.5 s against 717.8, 731.0, 691.5 (noise 40 s), heap 2.30 against 0.51-0.61 GB.
  At 8 192 beside shared modules (to the 62nd): 617.7, 632.4, 603.6 against 655.1, 691.2, 672.2,
  648.7 (modules alone) and 733.9, 747.3, 708.0 (neither).
- **Decision.** Kept at 8 192 (`sharedFormed`, `shared-forms.js`).
- **Revisit when.** A region is kept in fewer objects.

### 2026-11-12 - a target the store's map knows, a candidate at its first exit (`storedThreshold`), does not speed up ngen (cork, multi-process) [DISPUTED]

- **Audit 2026-11-14: DISPUTED (low).** One run inside a 39 s noise floor; the setting was removed.
  Re-measure only if a later process's start shows cold misses waiting for 64 exits.

- **Idea.** A process started again interprets each address 64 times (`missThreshold`) before it
  is a candidate, though the store's map of blocks says an earlier process had an entry there and
  the region is a hit; at the first exit the region would be there sooner.
- **Workload.** As the entry above (commit baa8d5a), `storedThreshold` 1 with the other two levers
  off; to the 62nd `mscorsvw.exe` start. One run.
- **Values.** 729.9 s against 733.9, 747.3 and 708.0 without; the gaps under 6 s 93.1 s against
  88.1-90.8, the larger ones 636.8 s against 619.9-656.5.
- **Why.** Within the noise of the three runs without it (39 s): the regions a later process
  waits for are the hot ones, which reach 64 exits in moments anyway, and the cold ones taken at
  once cost the short processes their publishing.
- **Machine.** Linux container, 4 vCPU, 15 GB, Node 26.13.1; GPU and power plan not recorded.
- **Decision.** Removed.

### 2026-11-12 - more room for the processes' shared compiled modules (`sharedModuleBytes` 1 GiB) (cork, multi-process) [VALID]

- **Measured.** `sharedModuleBytes` 1 GiB. As above at df9cfac, one run: 671.1 s against 655.1,
  691.2, 672.2 at 256 MiB; 2 533 modules (515 MiB) held, none let go; RSS 6.7 against 6.3 GB.
- **Decision.** 256 MiB stays: the modules let go are ones the later processes do not ask for.
- **Revisit when.** A run whose later processes ask for modules let go.

### 2026-11-12 - the shared formed regions (`sharedFormed` 8192) cost ngen's short processes what they save its long ones (cork, multi-process) [VALID]

- **Measured.** `sharedFormed` 8192 at its commit (0d43f09) against 0. To the 62nd start: 685.2,
  618.7 against 654.8; five runs each with and without: median 618.7 against 655.1 s; short gaps
  89.7-101.8 against 81.0-84.9 s, long ones 513.4-583.4 against 567.7-607.5; heap 1.17-1.26 against
  0.54-0.61 GB.
- **Decision.** Kept at 8 192 (5.5% shorter by the median).
- **Revisit when.** What a short process pays is taken back (a region kept in fewer objects).

### 2026-11-13 - a .NET game's loader with its commonest kernel32 calls in the guest starts no faster (core, executors) [VALID]

- **Measured.** A .NET game's loader with MultiByteToWideChar, WideCharToMultiByte (ASCII) and
  FlushInstructionCache in the guest (cb74108de). Warm start in the launcher, one run an arm,
  Parallels ARM VM, hardware adapter: the loader's crossings 110 539 -> 33 025 (4.47 G and 4.25 G
  instructions), on executor 1 for 3.75 G of them; slices there 336 s, 84 s waiting for answers (31
  355 traps, 37% over 1 ms), recalled 2 861 times. Its "to the menu" times (626 against 396, 490,
  596 s) are invalidated (2026-11-14).
- **Decision.** Kept: correct, two thirds of the crossings gone; the start is answer latency's and
  recall's to fix.
- **Revisit when.** No need.

### 2026-11-14 - a thread elsewhere is called back at once only when one it woke here waits on something it can end (core, executors) - no fewer recalls [VALID]

- **Measured.** A hand-off recall only when a thread woken here waits on something it can end
  (`timeOnly` waits left out). The game's warm start, Continue pressed until the level draws, two
  runs: the loader's recalls 1 501 (1 182 before, one run); to the level 367, 368 s against 357,
  378.
- **Decision.** Reverted, not committed: the recalls come from `IDLE_RECALL_MS` or another hand-off.
- **Revisit when.** No need.

### 2026-11-14 - a .NET game's own assembly compiled to a native image (ngen) - the JIT's share unchanged [VALID]

- **Measured.** A .NET game's executable compiled to a native image (`ngen install`). Warm start,
  one timed and one profiled run: ngen 11 minutes, a 4.8 MB image mapped; to the level 367 s at
  15.66 G instructions (317-450 s before); clrjit.dll 21.0% of block executions, JIT code 9.9%, the
  image 0.4%.
- **Decision.** Not a default: its libraries load from bytes (AssemblyResolve), which never pair
  with a native image.
- **Revisit when.** A program whose assemblies are files.

### 2026-11-14 - one machine memory with page tables costs a third to two thirds of translated code (cork) [VALID]

- **Measured.** One machine memory with page tables (a software MMU), a stand patch, cork-bench
  32-bit images, one executor, 16 MiB RAM, exact counts (repeats within 0.2%): x64 `ir.sh` node
  26.13.1, arm64 qemu-aarch64 8.2.2 with node 26.13.1 arm64 `--no-wasm-bounds-checks`. Geomeans
  against the plain arm: x64 floor +5.5% (5 workloads), paged +36.5% (4), tails +43.5% (3),
  paged+cross +63.7% (4); arm64 floor +3.9%, paged +47.1%, tails +58.5%, paged+cross +70.1% (8
  each); per workload, arm64 paged +25.6% (switch) to +74.4% (fmath).
- **Decision.** Not taken: it makes the translator an emulator; a process keeps its flat memory;
  processes at offsets in one buffer (`floor`) cost a few per cent if one buffer is ever wanted.
- **Revisit when.** Wasm gains multiple memories or mapping primitives the host can use cheaply.

## Invalidated

### 2026-10-13 - x87: code a wasm call returns to tests its stack shape whatever top its region was entered at [INVALIDATED]

- Invalidated by the 2026-10-14 record below: separate processes' `usPerIter` (35% apart) could not
  resolve 10%, and its block profile changed how regions form. Paired again: 0.897 in node and in
  Chrome; committed.

### 2026-10-14 - invalidated: "x87: code a wasm call returns to tests its stack shape whatever top its region was entered at" (2026-10-13) [INVALIDATED]

- **Reason.** The 2026-10-13 entry compared separate processes' `usPerIter` (one process's figure
  moves by up to 35%); its explanation came from a block profile, which changes forming (without it
  the region at 0x4012e0 is the hottest, entered 1.335 times an iteration).
- **Measured again.** Paired in one thread (`pair.mjs`, `browser.mjs --paired`, blocks of 10, 100
  warm), game-pc24 with against without: node 22.22.0 `--no-liftoff` 0.897 [0.858 0.947] (40
  rounds); Chrome 141 (V8 14.1) 0.897 [0.865 0.943]; the tree against itself 1.000 [0.942 1.025].
  4-core Xeon 2.80 GHz VM. Committed.

### 2026-10-14 - invalidated: the "before" of "cork: the store's hits compiled off the engine thread and published a few at a call" (3cc3e7c4) [INVALIDATED]

- 3cc3e7c4's "before" arm (lua-x87, headless Chrome 141) was measured on an intermediate build that
  already compiled hits off the thread, not on a0ac139c; not cited again. The change stays.

### 2026-10-16 - invalidated: the host calls of `tools/executor-sweep.mjs` (2026-10-08 to 2026-10-16) [INVALIDATED]

- **What was wrong.** The sweep's host call was GetTickCount, answered in the guest: no point
  measured a call into the host. Cited as host calls in "2026-10-08 - more threads than other
  executors, or one other executor" and in roadmap/v2's sweep measurements.
- **Measured again with GetACP** (node 22.22.0, KVM Xeon 2.80 GHz, `cork2` 9791153d, 200 M turns,
  five runs a point, mean of the fastest three): a call every 256 turns x0.58-0.74 on two and four
  executors; every 1024 x0.91-1.18; every 4096 x1.04-1.28; computing alone x1.24-1.45 on two. The
  sweep now fails at a point whose workers' calls never reached the host.

### 2026-10-17 - invalidated: the streaked road in "a dynamic buffer's DISCARD made in the guest by trading two storages" (2026-10-17) [INVALIDATED]

- The road drawn streaked in "2026-10-17 - a dynamic buffer's DISCARD made in the guest by trading
  two storages" appears in any build right after the level loads and is gone 25 s later; the picture
  is not evidence against the trade. Its rates (15.1 against 5.7 fps, one run each) stand.

### 2026-10-17 - invalidated: the scene of "d3dx9: a state's preshader expression is worked out in the guest" (10321baf) [INVALIDATED]

- 10321baf's numbers (frames 18 463 -> 21 276, host time 55.9 -> 31.1 s, crossings 3.61 -> 0.84 M)
  were taken at the Most Wanted demo's "CLICK to continue" card, not in a race; they compare that
  card only. The race: about 66-81.7 fps by the user, conditions not recorded.

### 2026-10-22 - the shared layout's state and table bases held in locals [INVALIDATED]

- "2026-10-22 - the shared layout's state and table bases held in locals" measured executor 0's own
  layout, which every arm ran on: the change was not in the arms' code. Its conclusion about
  imported globals is not to be cited.

### 2026-10-22 - invalidated: "the shared layout's state and table bases held in locals" [INVALIDATED]

- The record that invalidates "the shared layout's state and table bases held in locals": executor 0
  keeps its own layout with any number of executors; only the others translate for the shared one.

### 2026-10-23 - the backward edges given as the cause in the entry above, invalidated [INVALIDATED]

- The cause given in "2026-10-23 - hot direct callees formed into their callers past the caps" is
  wrong: a structured region lays a formed callee between its call and the call's return, so all
  89.5 M formed calls and their returns run forward. lua-x87 in node per 1000 guest instructions
  (base, patch): calls formed in 5.18, 10.80; direct wasm calls 8.55, 2.78; rets that left 0.31,
  1.10; transfers 2.20, 3.95; warm iteration 7564 / 7716 us without the profile; 100 iterations from
  the start 4.3 and 9.6 s, regions formed again 21 and 187, modules 10.7 and 29.2 MB. The wasm calls
  saved are paid back by new ways out; the short runs' loss is forming again and compiling. One run
  an arm, node 22.22.0.

### 2026-10-29 - invalidated: arm64 executed counts of `tools/cork-asm.mjs` read before ab02ac9 [INVALIDATED]

- arm64 executed counts of `tools/cork-asm.mjs` before 0b6ac60 and ab02ac9 misread block marks built
  in x27 (`cp`); lua 11.10 instructions a guest instruction read as 3.25 once fixed. 0b6ac60's arm64
  table and the arm64 figures of the 2026-10-28 and 29 Crysis entries are not cited until
  re-measured. Audit 2026-11-14: the 2026-10-22 and 23 entries that used `cork-asm --blocks` on
  arm64 predate the fix too and are marked here.

### 2026-11-14 - invalidated - "to the menu" is no measure of a .NET game's start [INVALIDATED]

- "To the menu" is no measure of a .NET game's start (the menu comes up at about 5.6 G or 13.2 G
  instructions while loading goes on): the 2026-11-13 entry's and commits 9874ad48e and 0fb0f07fd's
  such times are not cited. A start is measured to the level's first frame with more than 50 draws:
  447, 417, 488 s (2026-11-13 builds); 317, 348 s (b59558494, 9db0f99e7, bf4547d36); 378, 357 s
  (with 1e2e2093d).
