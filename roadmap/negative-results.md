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

### 2026-10-12 -- callees formed in two and three levels deep (`formDepth`)

- **Idea.** A callee of at most 16 blocks / 512 bytes is formed into its caller with one level of
  its own calls; its callees' calls leave as wasm calls with the state written back. Far Cry's
  counts (`mechanisms`, `roadmap/cork/README.md` step 0b) put 22% of its calls out of a region at a
  call inside a callee already formed in. Forming those as well (`formDepth` 2 or 3) would take
  them in.
- **Workload.** cork-bench in the browser (`modules/cork/bench/browser/suite.mjs --scale 10 --reps
  3`), both builds, all eight workloads, one bundle `head` of `cork2` at `7ea60178` with the
  setting, three configurations interleaved: `formDepth` 1 (today), 2, 3. Bundle hash: not
  recorded.
- **Values.** Best of three reps, MIPS, d1 / d2 / d3: x87 vm 3382/3437/3225, entities 802/806/837,
  math 1897/1905/1927, path 2356/2366/2217, lz 4420/4419/4433, containers 2166/2180/2174, spread
  345/356/351, api 773/736/689; sse vm 3351/3173/3281, entities 758/762/779, math 2263/2254/2312,
  path 2063/2313/2185, lz 4333/4386/4490, containers 2106/2059/2029, spread 350/348/346, api
  780/719/788. Geomean 1531 / 1530 (1.00x) / 1526 (1.00x). Noise: the three reps of one
  configuration and workload differed by 13.1% at the median, 24.3% at most (144 runs). Every
  checksum the processor's. Native beside them: geomean 4683, spread 5.3-5.7x, entities 4.6-4.9x.
- **Machine.** Headless Chromium 141.0.7390.37 on SwiftShader, a 4-core x86-64 Linux VM
  (Firecracker). Power plan: not recorded.
- **Why it did not pay.** Not found. The gate's programs (`src/runtime/forming.itest.js`) show the
  setting takes calls in (calls out 3074 / 1358 / 668 / 267 for depths 0-3 over 40 seeds), so the
  calls go; their cost on these workloads is under the noise, or the code formed in again in every
  caller costs what the call saved.
- **Correctness.** The gate: 120 seeded programs of functions calling one another (`ret imm`,
  returns moved past their caller's bytes, stores into another function's code) run interpreted,
  with nothing formed in, leaves alone and one, two and three levels, every observable the same; a
  mutation that took every formed `ret` back to its call failed it at seed 5.
- **Decision.** Left at 1. `formDepth` stays a setting with its gate, for a game measurement on
  the person's machine before it is tried again.

### 2026-10-12 -- predicted virtual calls (`callTargets`) on cork-bench

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

### 2026-10-12 -- transfers inside a placed module as direct tail calls (`dispatch`) on cork-bench

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

### 2026-10-13 -- every register in wasm parameters across guest calls (calling-convention bench, x64)

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

### 2026-10-13 -- loading only what is live after a call (plan step 2a/2b), its ceiling

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

### 2026-10-13 -- indirect call prediction (`callTargets`) in Far Cry, and its knobs, while the sampling took the last calls before a reading

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

### 2026-10-13 -- indirect call prediction (`callTargets`) in Far Cry at a 44% share of its calls

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

### 2026-10-13 -- a call out's cost in Far Cry: a smaller entry hash, and the callee found from the call's own site

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

### 2026-10-13 -- larger regions for an interpreter: every region's caps doubled, and room only for the blocks a call returns to

- **Idea.** Lua 5.1's `luaV_execute` (cork-bench `lua`) is cut by the region caps (128 blocks,
  8192 bytes): the opcode handlers' tails past them, and the blocks its calls to
  `luaV_gettable`, `luaD_precall` and `luaF_close` return to, are left out, so those calls
  leave the region and their returns come back through the entry hash. Two ways to keep them:
  (a) `maxRegionBlocks` 256 and `maxRegionBytes` 16384 for every region; (b) room past the caps
  (64 blocks, 2048 bytes) for a block a call in the region returns to, nothing else.
- **Workload.** cork-bench at `12d1ea54` with the `lua` image of `7e19106c` (built from the
  same sources with a debug dump of the addons' text that the committed image leaves out), run
  on the cork host as bench.mjs runs it (`run-cork.mjs`, not committed), the translator in the
  same thread; frames 201-600, the median of the per-frame times; and the whole bench (21
  workloads then, 3 reps, best rep), each arm twice.
- **Values, Lua.** Medians of per-frame ms, four processes an arm, alternated: base 9.18, 9.03,
  9.81, 9.73; (b) 9.14, 9.17, 9.25, 9.07; (a) 8.23, 8.52, 8.07, 8.75. Block profile over 100
  frames: transfers through the hash 12.60 M base, 11.93 M (b), 10.13 M (a); calls leaving the
  region 1.14 M base, 0 (b), 0 (a). (b) kept the calls but not the handlers' tails, which (a)
  kept.
- **Values, the bench, (a).** Steady time against base, the mean of the two runs' ratios:
  geomean 1.089; load-x87 3.28, game-x87 1.91, calls512-scatter 1.22, fmath-x87 1.10;
  str-x87 0.86, crc-x87 0.91. Cold time geomean 1.037. Every eax the same.
- **Machine.** A 4-core x86-64 Linux VM (Firecracker), Intel Xeon @ 2.80 GHz, Node 22.22.0
  (V8 12.4.254.21), branch hints read (`tools/chromium-v8.mjs`). Power plan not recorded. Run
  to run, a whole-run mean moved by up to 15% (base 9.5-11.6 ms in one campaign); the
  per-frame medians moved by under 9%.
- **Decision.** Neither built. (a) cost the rest of the bench 8.9% (geomean), four workloads
  10-228%, for its 11% on Lua; (b) is within the noise. Built instead: room past the caps for
  the entry's own function
  alone, callees still stopping at the caps (the commit after this entry).

### 2026-10-13 -- x87: code a wasm call returns to tests its stack shape whatever top its region was entered at

- **Idea.** `planStack` gives a block a call returns to the shape it needs, tested after the
  call (`x87AfterCall`), only when the block's state is the region's entry state. A region
  entered mid-loop with registers held -- cork-bench `game-pc24`'s distance loop at 0x4012e0,
  entered at top 6 -- returns from its indirect call (`think[]`) at top 0, knows nothing of
  the stack from there on, and so checks every push of the loop it comes back to, and the
  float path (`floatSingles`, which needs a push known clear) never runs in it. The change
  gave every return block its needs, tested after the call, whatever the entry.
- **Workload.** cork-bench `game-pc24` (sha256 e2781f07...), `bench.mjs --root` of the tree
  at `383b0b04` against the same tree with the change, `node --no-liftoff`, defaults (warm
  20, iters 40, best of 5 reps), usPerIter; processes alternated.
- **Values.** Ten processes an arm: base 346.6 350.6 351.4 356.7 365.5 367.5 374.7 441.1
  465.4 467.6 (median 366.5); with the change 339.9 344.1 353.5 354.3 355.6 359.5 373.6 379.4
  379.8 413.6 (median 357.6): -2.4%, inside the spread. An earlier five each: base median
  329.9, change 330.7. fmath-pc24, the x87 and sse workloads: the same within noise; every eax
  the same. A CPU profile (3 reps, 200 iters) put the 0x4012e0 region at 53.0 ms of self time
  without and 32.5 ms with it, but the block profile shows the steady state running that loop
  inside the region entered at 0x4010a5 (top 0), where the return block is the entry's state
  and was tested already: the region the change speeds runs mostly while warming.
- **Machine.** A 4-core x86-64 Linux VM (Firecracker), Intel Xeon @ 2.80 GHz, Node 22.22.0.
  Power plan not recorded. A run's usPerIter moved by up to 35% between processes.
- **Correctness.** Cork's unit tests (608, with a test of a callee leaving ST(7) held at the
  same top: four shape misses, then checked, the interpreter's result) and integration tests
  (22) passed; core's cpu layer (153) too.
- **Decision.** Not committed: no signal over the noise on the one workload that has the
  shape. Worth measuring again on a title whose hot loops sit in regions entered with
  registers held.

### 2026-10-14 -- invalidated: "x87: code a wasm call returns to tests its stack shape whatever top its region was entered at" (2026-10-13)

- **Reason.** That entry compared separate processes' `usPerIter` of 40 iterations each; on
  this machine one process's figure moves by up to 35%, and ten processes an arm could not
  resolve a 10% change. Its explanation -- the region the change speeds runs mostly while
  warming -- came from a block profile, which changes how regions form: without it the region
  at 0x4012e0 is entered 1.335 times an iteration in the steady state (counted by wrapping the
  runtime's `run`) and is its hottest (a CPU profile: 182.8 ms of self time of 4 reps x 400
  iterations, against 107.6 ms with every region compiled for the wide controls).
- **Measured again.** Paired in one thread (`tools/cork-bench/pair.mjs`, `browser.mjs
  --paired`): blocks of 10 iterations alternated, 100 warm, the median of the rounds' ratios
  with its quartiles. game-pc24, with the change against without: node 22.22.0
  `--no-liftoff` 0.897 [0.858 0.947] (40 rounds; medians 281.4 and 254.2 us); Chrome 141 (V8
  14.1) headless, three tabs of 40 rounds, 0.897 [0.865 0.943] (medians 260.0 and 233.5 us);
  the same tree against itself 1.000 [0.942 1.025]. Every eax the same. The other workloads
  within their quartiles; calls4096-order-x87 read 1.099 once, and 0.959 with the arms swapped
  -- its control (one tree in both arms) reads 1.056, the second host slower on a workload of
  4096 functions.
- **Machine.** A 4-core x86-64 Linux VM (Firecracker), Intel Xeon @ 2.80 GHz. Power plan not
  recorded.
- **Decision.** Committed (the commit after this entry).

### 2026-10-14 -- x87 single precision on floats: other encodings of the range test

- **Idea.** Each f32 operation of the float path (`floatSingles`) tests its result before
  going on: finite for a sum (`(bits & 0x7f800000) != 0x7f800000`), a normal above the
  smallest for a product or a quotient (`(bits & 0x7fffffff) - 0x00800001 <u 0x7effffff`, a
  zero from a zero operand aside). Tried in the float domain instead: a sum's as `r - r == 0`
  (`sub`) and as `|r| <= FLT_MAX` (`abs`), a product's as `|r| > FLT_MIN && |r| <= FLT_MAX`
  (`fpmul`). Two bounds beside, both wrong arithmetic: no test at all (`none`), and the exit
  branch kept on a test of a local that never fails (`branch`).
- **Workload.** cork-bench fmath-pc24 and game-pc24 at `6f1c8ae4`, paired in one thread
  (`pair.mjs` in node 22.22.0 `--no-liftoff`, 40 rounds of 10; `browser.mjs --paired` in
  Chrome 141 headless, two tabs of 40 rounds), 100 warm; the median of the rounds' ratios to
  the committed encoding, with its quartiles. Every eax the same.
- **Values.** node, fmath-pc24: sub 1.079 [1.005 1.133], abs 1.017 [0.965 1.089], fpmul 1.192
  [1.099 1.276], none 0.599 [0.555 0.632], branch 0.665 [0.592 0.706]; game-pc24: sub 1.007,
  abs 0.995, fpmul 1.018, none 0.839 [0.781 0.879], branch 0.842 [0.806 0.912]. Chrome,
  fmath-pc24: sub 1.061, abs 1.028, fpmul 1.172, none 0.603; game-pc24: sub 1.032, abs 1.009,
  fpmul 1.053, none 0.860.
- **Reading.** The branches cost little (branch is within a few per cent of none); the cost is
  the test's own operations -- the float's bits to an integer register and three or four
  operations on them, as many again as the operation they guard in a chain of float
  arithmetic. One test for several operations would save the branches only, and needs the
  machine state rolled back to the first of them when it fails.
- **Machine.** A 4-core x86-64 Linux VM (Firecracker), Intel Xeon @ 2.80 GHz. Power plan not
  recorded. Not measured on arm64, where the transfer of a float's bits costs otherwise.
- **Decision.** The committed encoding stays: no variant is faster on either engine.
