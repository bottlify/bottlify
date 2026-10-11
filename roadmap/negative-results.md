# Negative results

Ideas that were measured and did not pay. The file is appended to and never rewritten: a later
measurement of the same idea is a new, dated entry with its own conditions, because a result can
depend on the browser, the driver and the machine, and a no today is not a no for ever.

Each entry gives, and writes `not recorded` for what was not saved rather than reconstructing it:

- the date, the workload and the bundle's hash;
- the baseline and the candidate, every raw value, how many runs, the median and the spread, and
  the noise floor of the campaign;
- the browser, the GPU and driver, the operating system and the power plan;
- what was checked for correctness beside the speed;
- the decision: removed, off by default, or left.

A measurement later found wrong goes under **Invalidated**, with the reason, and is not used as
evidence again.

## Entries

### 2026-10-05 -- the system's side of a link waits blocking while calls are recent

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

### 2026-10-07 -- a second executor for Doom 3 and Tron

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

### 2026-10-09 -- the startup stub on a read-only page, for an IsBadWritePtr probe

- Idea: a SecuROM 7 check calls `IsBadWritePtr(<process-startup base> + 2, 1)`; the guess was
  that this is the entry point's return address, read-only code on Windows, and that moving the
  startup stub to a page of its own with read-execute access would pass it.
- Measured (one harness run, `--worker --coi`, headed Chrome, bundle index sha256 f9862be8...):
  with the stub moved, the probe still names the arena's base + 2, which is now the process
  environment block's `BeingDebugged` byte -- writable on Windows, so the answer 0 was already
  right. The program's error (8007) did not change. The change was not kept.
- Not recorded: GPU, driver, power plan.

### 2026-10-09 -- not waiting for a render-target copy that stays on the GPU

- Idea: the recorder waits for the renderer's answer on every `CopyRects` out of a render
  target; one into the device's memory in the same format is made on the GPU (`copySurface`)
  and has nothing to answer, so skipping that wait would shorten a frame that copies its
  target each frame.
- Measured (harness, `--worker --coi`, headed Chrome, the RC demo bundle cb83b58a..., main
  menu, 90 s, one run each arm): waits on CopyRects 13 834 before, 13 484 after; average frame
  10.87 ms before, 10.81 ms after -- inside run-to-run noise. The title copies into a
  system-memory surface and locks it read-only, about 250 times a second: a real read-back,
  which the change does not touch. Not kept.
- Not recorded: GPU, driver, power plan.

### 2026-10-10 -- reading a fence target back ahead, as each frame is presented

- Idea: the RC demo reads back two 16x16 render targets every frame (1024 bytes each, locked
  read-only: a fence against the GPU running ahead), drawing into each after copying it; the
  played device could read each changed target back again at every present and tell the
  recording which drawing its memory held, so the next frame's copy is answered without a
  round trip. Kept beside it, and not part of this entry: a copy out of a target nothing has
  drawn into since its last read-back is answered from its memory (`createTargetReads`).
- Measured (live launcher, headed Chrome in the Parallels VM, RC demo bundle cb83b58a...,
  first level "Find slaver camp" standing still, three 30 s samples each; frame interval from
  `app.presented()`, the last 599 frames): without the read-ahead, median 25.9 / 26.7 /
  26.8 ms (one sample earlier in the session), CopyRects waits 2 238 / 2 098 / 2 100 per 30 s,
  10.7-12.5 s waited. With it, read-ahead holding the frame chain until its bytes: median
  30.0 / 29.5 / 29.7 ms, waits 938 / 958 / 960, 7.4-7.6 s. With it releasing the chain at
  submit: median 29.3 / 30.0 / 30.2 ms, waits 937 / 945 / 958; read-backs 4.3 ms each before,
  5.7 ms with it (`timing.readBackMs`); a frame becomes GPU work in 0.46 ms
  (`timing.replayMs`). Half the waits went, the frame got about 3 ms slower: the recording runs
  a frame or two ahead of the played device, so most read-aheads land after the copy that
  wanted them, and every one adds a read-back to the GPU's queue. Not kept.
- Not recorded: GPU (Parallels display adapter, model not recorded), driver, power plan.

## Invalidated

None yet.

### 2026-10-07 -- several translation workers for one process, on four cores

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

### 2026-10-08 -- bundle blocks decoded in the pool rather than on the reading thread

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

### 2026-10-08 -- an executor waiting in place for its next slice, rather than through its event loop

- **Idea.** Roadmap v2, stage 3: a remote executor (`executor.worker.js`) waited for the process's
  next slice with `Atomics.waitAsync`, its wake going through the worker's event loop; waiting
  with `Atomics.wait` for up to 2 ms first would take the slice the moment it is asked for, which
  was thought to be the cost that made a thread on another executor slower than on the process's.
- **Workload.** `tools/executor-sweep.mjs`, two threads, 400 M iterations of its kernel in all, no
  lock, no host call, `executors` 1, 2 and 3, the kernel's quanta 100 000 and 1 000 000; `cork2`
  at `b497c50e` with and without the wait in place.
- **Values.** One run each (s): quantum 100 000 -- before E=1 1.23 (1.17 in a second series),
  E=2 2.77 (2.83), E=3 1.69 (1.74); after 1.23, 2.78, 1.76. Quantum 1 000 000 -- before 1.00,
  1.40, 0.77; after 0.98, 1.57, 0.82. Spread: not measured beyond the repeat of the first row.
- **Machine.** Node 22.22.0, a 4-core x86-64 Linux VM (Firecracker). No browser. Power plan:
  not recorded.
- **Why it did not pay.** The wake was not the cost. Timed apart (a remote executor alone, 14 000
  slices of 100 000): the worker spent 598 ms inside its slices against 505 ms for the same work
  on the process's own host, and about 38 us a slice went to the two handoffs of each round trip
  -- whichever way the worker waited. What paid was making fewer round trips: an executor goes on
  with its thread slice after slice while no ready thread waits for one (`goOn`), and a short look
  at the word before sleeping on it. Measured in the sweep's entry in `roadmap/v2/README.md`.
- **Correctness.** Unchanged: the executors' tests passed either way.
- **Decision.** Kept as the first wait of the idle loop (it costs nothing), not counted as the fix.

### 2026-10-08 -- more threads than other executors, or one other executor

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

### 2026-10-08 -- a loop with a call out stays a loop under callReturn

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

### 2026-10-09 -- Sleep(0) yielding to a ready thread of the caller's priority or higher

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

### 2026-10-09 -- client arrays read once a glLockArraysEXT rather than once a draw

- **Idea.** A Quake 3 renderer locks a surface's client arrays and draws them once a stage; the
  recording read -- and sent its twin -- every range again at each glDrawElements. Reading each
  range once a lock (the extension's promise that the arrays do not change) would cut what a
  draw costs the program's thread. Prompted by a Call of Duty Dawnville demo report where
  glDrawElements was 248 082 calls and 12 163 ms of host time (49 us a call).
- **Workload.** `tools/graphics-node-bench.mjs --scenes gl-tess --modes remote --draws 600
  --frames 30 --warm 10 --reps 3` (the scene added in `e9469170`), fastest of 3, `cork2` at
  `8b9091b4` against the change on it.
- **Values.** Base: program thread 6.64 ms a frame, worker 15.74 ms, 3842 KiB a frame. Change:
  6.78 ms, 15.16 ms, 2505 KiB. Noise floor: not measured.
- **Machine.** Node 22.22.0, a 4-core x86-64 Linux VM (Firecracker). Power plan: not recorded.
- **Why it did not pay.** The bytes fell by a third and neither thread's time moved: the copy
  is not where a draw's time goes on either side.
- **Correctness.** Not run beyond the bench.
- **Decision.** Reverted.

### 2026-10-11 -- a draw's reads of a dynamic buffer lent to the graphics worker, not compared

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

<<<<<<< HEAD
### 2026-10-11 -- an unlock of a dynamic vertex buffer that sends and uploads nothing

- **Idea.** Every draw from a dynamic vertex buffer takes the bytes it reads from guest memory
  itself (`readHeld`, `drawsFrom`), so its unlock need not: the unlock gives the lock back with
  nothing taken (`abandon`), saving CoD4's whole 4.7 MB skinning-buffer unlocks (`4d3426b0`;
  its own account: 19,718 unlocks, 28.4 s of host time, 1.4 ms each).
- **Workload.** Far Cry demo, main menu, on the launcher (`192.168.100.22:5180`), graphics worker
  on and off; Warcraft III: The Frozen Throne. Observed by eye in live runs, one or two each way;
  bundle hashes not recorded.
- **Values.** No frame rate was measured for it. Far Cry's menu: the top, left and bottom border
  quads (2D quads appended to an 11,200-byte dynamic buffer with `Lock(NOOVERWRITE)`/`Unlock` per
  quad, `DISCARD` at offset 0 on wrap, `DrawPrimitive` fans) flicker with it, about once a second.
  Bisected over builds of `review`: `d9c743e1` and `edf92cd5` clean, `4d3426b0` flickers;
  `?guestTraps=locks` (the locks as traps, the draws still in the command ring) hides it;
  `?graphicsWorker=off` does not. Warcraft III's textures flicker the same way and
  `?guestTraps=locks` hides it there too.
- **Machine.** Chrome on the Parallels host and on the Windows guest (`chrome-profile-2`); GPU,
  driver and power plan not recorded.
- **Why it did not pay.** It traded correctness for host time: a quad read the vertices of an
  earlier cycle of the buffer. Where exactly the GPU copy goes stale was not found; the seam gates
  (`locks-contract`, `frames-contract`) passed with it, so they miss the case. CoD4's models draw
  correctly without it (the user's check).
- **Correctness.** The flicker itself; see above.
- **Decision.** Reverted (`964f9dc5`). It comes back only with a gate case that fails on it.

### 2026-10-11 -- a store into code drops only the regions whose bytes it changed

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
=======
### 2026-10-11 -- patched code sites formed apart, and store-dropped regions formed again with copies

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
>>>>>>> 48ed9f87 (cork interpreter tier in wasm: the MMX forms run there, not one at a time in JavaScript)
