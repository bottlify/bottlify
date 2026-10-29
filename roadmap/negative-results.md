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

### 2026-10-15 -- the shared layout's bases as other kinds of global

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

### 2026-10-14 -- An indexed draw's dynamic vertices compared over the range its indices name (optional)

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

### 2026-10-14 -- invalidated: the "before" of "cork: the store's hits compiled off the engine thread and published a few at a call" (3cc3e7c4)

- **Reason.** The commit message's "before" arm (the store-hit run of lua-x87 in headless
  Chrome 141, 3 runs: synchronous compiles 6-7 of 10.5-19.6 ms, `instantiateMs` 13-23, the
  longest `translatePending` calls 6.4-10.3 ms, the longest guest slices 56-60 ms, the three
  iterations 1641-1784 ms) was measured on an intermediate build of the change, which already
  compiled a hit off the thread once the translation worker had loaded, not on its parent
  (`a0ac139c`). Those values are not the parent's and are not cited again; the "after" arm was
  measured on the commit itself.
- **Measured again.** Not on lua-x87. The Far Cry demo runs of 2026-10-14 (`--fake-gpu`, the
  engine in a worker, headless Chrome 141, 240 s windows of the engine worker's CPU profile)
  compare the tree before the whole series (`92f18dcd`) with the later commits instead.
- **Machine.** The invalidated runs: not recorded. The Far Cry runs: a 4-core x86-64 Linux VM,
  Intel Xeon @ 2.10 GHz; power plan not recorded.
- **Decision.** The change stays.

### 2026-10-14 -- indirect call prediction (`callTargets`) in Far Cry in Chromium, measured again

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

### 2026-10-14 -- indirect call prediction (`callTargets`) on the benchmark, on by default

- **Idea.** Whether `callTargets`, on by default since `b73438e6` for Far Cry's 4-6%, costs the
  benchmark anything, and which part of it does.
- **Workload.** `modules/cork/bench` at ten times each workload's own length, tree `b73438e6`.
  Chromium: `suite.mjs '{"head":{},"off":{"bundle":"head","cork":{"callTargets":false}}}' --scale
  10 --reps 3`, the two arms alternated run by run. Node: `run.mjs --variant x87 --only spread
  --iterations 1000`, one run each, three arms started together each round as three processes:
  on; the same tree with the profile never switched on (`sampleCalls` leaving its flag 0); off.
  Eight rounds.
- **Values.** Chromium, best of three, on / off: geometric mean of the sixteen 1358 / 1361 MIPS
  (1.00). `spread` x87 291 / 321 (runs on 291 283 266, off 321 319 305: every run on below every
  run off), SSE 300 / 321 (on 290 300 279, off 311 321 281). The other fourteen between 0.92 and
  1.06 either way, inside the spread of their own three runs. Node, started together, on / off
  by round: 0.957 0.976 0.927 0.933 1.035 0.972 0.936 0.977 (median 0.965, 7 of 8 below 1); never
  on / off: 0.973 1.012 0.964 0.979 0.994 0.938 0.988 0.938 (median 0.976). With `reforms: 0` (no
  region formed again), run one after another, on's rate: 251 and 267 MIPS against on 267 and 246,
  off 313 and 288.
- **Noise.** In Node one after another, the rounds' on / off went from 0.87 to 1.15, and the
  machine's rate drifted by a quarter within the hour (290 MIPS, then 220, the same arm; steal
  time under 1%). Started together, within about 4%.
- **What costs.** Not the regions formed again. The profile: about two and a half per cent is its
  flag's load and branch on every indirect call with it switched off, about one more is the
  sampling while it is on (one reading in two).
- **Machine.** A 4-core x86-64 Linux VM, Intel Xeon @ 2.10 GHz; Chromium 141.0.7390.37 headless
  (V8 14.1); Node 22.22.0. Power plan not recorded.
- **Decision.** It stays on: Far Cry gained more than `spread` loses, and the benchmark as a whole
  is unchanged. Sampling less often while no call comes due would cut the part paid while it is
  on; the flag's load stays while regions carry the profile. Not tried.

### 2026-10-14 -- `callTargets` in Far Cry in Chromium, its regions formed again under the credit

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

### 2026-10-14 -- an indirect call with nothing to form in sampled no more (quiet calls)

- **Idea.** A call whose samples came due with no callee to form in (none took an eighth, or the
  ones that did cannot be formed in) keeps paying the profile's flag load on every call. Formed
  again without the profile at it (`d207d7e5`), it pays nothing.
- **Workload.** Far Cry as in the entries above, tree `d207d7e5` (quiet) against `b73438e6`
  (without), both with `callTargets` on, alternated: cold quiet, cold without, warm quiet, warm
  without, each arm on a profile of its own. And `spread` in Node, three arms started together as
  three processes for eight rounds (quiet, without, `callTargets` off).
- **Values.** Far Cry: cold 269.6 against 268.5 M/s (1.004), warm 276.2 against 270.6 (1.021), the
  noise floor about 6%. Calls quiet: 19 cold, 20 warm, every one of them for a
  callee not formed in (calls with no callee taking a share: none); due calls 49 and 45. The
  translator's holds of 16 ms or more: 2 against 9 cold, 1 and 1 warm. `spread` in Node: quiet /
  without by round 1.011 1.045 1.006 0.989 0.908 1.031 0.984 1.005 (median 1.005): there the
  profile is read too seldom for any call to come due (34 samples over 26 calls in a run of 4 s).
- **Machine.** A 4-core x86-64 Linux VM, Intel Xeon @ 2.10 GHz, headless Chromium 141.0.7390.37
  (V8 14.1), Node 22.22.0. Power plan not recorded.
- **Decision.** Kept: inside the noise in Far Cry, nothing measured against it, and a quiet call
  pays nothing for a profile it cannot use. What the Far Cry counts point at instead: 50 to 103
  times a run (91, 103, 50, 82) the callees a call was predicted to were found too large to form
  in, and those calls still go through the entry hash.

### 2026-10-15 -- the speed work of 2026-10-13 and 14 in Far Cry, all of it at once

- **Idea.** The changes of those two days that were measured in Far Cry (call prediction, quiet
  calls, the solo turn) were each measured against the tree just before them, one pair of runs a
  phase, and came out between 1.004 and 1.064. Their sum, measured against the tree before the
  first change of the work, should show at least the larger ones.
- **Workload.** The Far Cry demo bundle (`bundle.btl` sha256 `44530097b2a5a284…`),
  `tools/cdp_test/game.mjs farcry-demo --worker --coi --no-video --fake-gpu --run-seconds 240
  --cpu-profile 240`. Before: `98303907`, the last tree before the first runtime change of the
  work (`1e368204`), with the harness's `--fake-gpu` (`ca67027a`) applied on top and nothing else.
  After: `0ee30d80`. Ten runs, alternated: before cold, after cold, before warm, after warm; then
  after first: after cold, before cold (fresh profiles), and warm runs on all four profiles. Guest
  instructions over the whole run (257 to 271 s, the load included).
- **Values.** Before: 201.1, 222.9, 220.8, 213.4, 226.7 M/s (cold, warm, cold, warm, warm), median
  220.8. After: 219.3, 218.6, 220.9, 225.4, 222.5, median 220.9. Ratio of the medians 1.000. The
  lowest, 201.1, is the first browser started after the machine started. The instructions over
  the engine thread's time in translated code alone: before median 450 M/s (402 to 451), after
  440 (430 to 448). Translated code holds 49 to 53% of the engine thread in both; calls to the host
  37 to 42 s a run in both; the Direct3D command ring's replay 31.5 to 35.5 s before, 29.0 to
  29.8 s after. Scheduler turns 691 to 743 thousand before, 578 to 604 thousand after.
- **Machine.** A 4-core x86-64 Linux VM, Intel Xeon @ 2.80 GHz, headless Chromium 141.0.7390.37
  (V8 14.1), Node 22.22.0. Power plan not recorded. Not the VM of the entries above: `0ee30d80`'s
  tree ran 273 to 279 M/s there and 219 to 225 here, so no number here compares with theirs.
- **Correctness.** Every run ran to the end of its window; the game's log in each ends on the same
  line (its CPU speed test). Whether each reached the level was not checked.
- **Decision.** Nothing to revert: the work was taken for what it was measured on (the benchmark,
  Gothic 3's x87, the engine thread's holds). But the Far Cry gains each change was credited with, one pair a
  phase, do not show in their sum: they were inside the noise, as each entry said, and none of
  them is evidence for a default by itself. Half of the engine thread in this window is outside
  translated code, and that half did not move.

### 2026-10-15 -- three host-side costs off Far Cry's engine thread, measured in its rate

- **Idea.** The engine thread spends half of Far Cry's run outside translated code, 64 s of 240
  in host calls, 55 s of them Direct3D 9's. Three costs there were work for nothing: cork judged
  every host write into a page with no code against a copy of the page (`d9a43818`; 5.6 s of
  the thread, and a copy kept of every page the host ever wrote); `ringState` was sent to the
  graphics worker after every host entry (`a94451fc`; 222 thousand sends); and a dynamic
  buffer's bytes compared at its unlock were compared again by the draws of the same entry
  (`cdcee939`; 2.9 to 3.1 GB a run compared again).
- **Workload.** The Far Cry demo bundle (`bundle.btl` sha256 `44530097b2a5a284…`),
  `tools/cdp_test/game.mjs farcry-demo --worker --coi --no-video --fake-gpu --run-seconds 240
  --cpu-profile 240`, each tree from a worktree of its own, alternated. First `ddbcdfc4` against
  `a94451fc`: cold, cold, then warm in the order base, new, new, base, base, new. Then
  `a94451fc` against `cdcee939`: base warm, new cold, new warm, base warm.
- **Values.** Guest instructions over the whole run, M/s. `ddbcdfc4`: 230.8 cold; 224.9, 224.0,
  232.9 warm. `a94451fc`: 215.0 cold (run while the disk was full, its profile writes failing:
  left out); 226.2, 228.9, 232.2 warm. Warm medians 224.9 against 228.9 (1.018). Second pair:
  `a94451fc` 236.3 and 225.1 warm; `cdcee939` 234.8 cold, 228.4 warm. The noise floor on this
  machine about 4% between runs of one tree.
- **The engine thread** (inclusive, from its profile, a warm run of each): host calls 63.5 s
  (`ddbcdfc4`), 61.3 s (`a94451fc`), 58.4 s (`cdcee939`); cork's store judge 5.6 s, then none;
  the ring's take phase 29.3 s, then 26.3, then 23.0; bytes the draws compared 2.87-3.14 GB,
  then 0, with the bytes the unlocks sent unchanged (1.56-1.71 GB a run in both).
- **Machine.** A 4-core x86-64 Linux VM, Intel Xeon @ 2.80 GHz, headless Chromium 141.0.7390.37
  (V8 14.1), Node 22.22.0. Power plan not recorded.
- **Correctness.** Cork's unit and integration tests, the graphics layer's remote, seam, Direct3D
  8 and 9 tests and gates (1016) pass; every run ran to the end of its window.
- **Decision.** Kept: each takes work away that bought nothing, and the profile shows it gone.
  The rate does not show it past the noise: 5 to 9 s of a 260 s thread is 2-3.5%, inside the
  4% two runs of one tree differ by. The thread's time freed went to translated code, whose own
  rate over its time did not rise with it (443-468 M/s before, 434-446 after).

### 2026-10-15 -- the process's executor looking for the others' words between its regions

- **Idea.** With other executors running threads, the process's own executor answers their calls
  into the host and takes their slices' ends only at its own crossings and between its turns, so
  its turns stay one quantum (100 000 instructions) long; 7-Zip's benchmark with one thread on two
  executors ran a fifth slower than on one in such turns. Turns as long as a lone thread's, ended
  between regions as soon as the executors' bell rang -- the kernel's `yieldCheck`, which runs
  translated code in budgets of `yieldChunk` (10 000) and asks between them -- would answer them
  as soon and lose nothing to the turn.
- **Workload.** 7-Zip 26.04 x86 `7zr.exe b -md22` (sha256 `256feca8e274e5da…`) through
  `createApp` with `cpu: { cores: 1 }`, the kernel's `preemption` on (the same chunked budget and
  a check between regions) against off; `cork2` at `a6925e9b` with `89ab808d`'s scheduler changes
  under way (the check is the kernel's own, which they do not touch).
- **Values.** One run each, MIPS (compressing / decompressing / total): off 809 / 1413 / 1111,
  on 525 / 667 / 596.
- **Machine.** Node 22.22.0, a 4-core x86-64 Linux VM (KVM, Intel Xeon @ 2.80 GHz). No browser.
  Power plan: not recorded.
- **Why it did not pay.** A budget of 10 000 instructions brings the slice back to the host
  every 10 microseconds or so, and the round trip and the check cost as much as the code: half the
  rate gone before any bell is looked at.
- **Correctness.** Not judged: measured once for speed.
- **Decision.** Not used for the executors' bell. The process's executor takes a lone thread's
  long turn only while no other executor runs a thread (nobody's calls to answer), and a thread
  made ready during it that a free executor could take ends it (`noteReady` in `threads.js`).

### 2026-10-16 -- the program's cores chosen from the host's by default (roadmap/v2 C1)

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

### 2026-10-16 -- a host call's device steps run as the device's methods in the host

- **Idea.** `ID3DXEffect::CommitChanges` on the host drives the device's setters as guest calls,
  each a turn into the guest and back. The guess was that answering those steps where they stand
  (`InterfaceMethod.inPlace`), by running the setter's own host method, would make a commit
  cheaper than entering the guest for each.
- **Workload.** The Need for Speed Carbon demo bundle (`bundle.btl` sha256 `f5aec769a16ce7d8…`),
  started from the launcher and driven into its first race, 640x480; host calls counted by
  function over 10 s on the running page. The scenes of two runs are not the same.
- **Values.** Host time per `CommitChanges` call: before, not recorded; with the steps run as the
  device's methods, about 48 us; with the steps answered by writing the setter's command into the
  ring as the guest routine would (`appendCommand`, the change that was kept), 34 then 18-24 us.
  One run of each; spread and noise floor not recorded.
- **Machine.** Chrome in a Parallels Windows 11 VM on its virtual GPU; version, driver and power
  plan not recorded.
- **Why it did not pay.** A setter's host method does the device's whole work at once (its state
  checks, its shadow, its seam), where the guest routine only appends a command record.
- **Correctness.** The bridge's tests of steps answered in place; the gate holding the host's
  command records to the guest routine's byte for byte (`seam/commands-host.itest.js`).
- **Decision.** Removed: steps are answered in place only by appending the command.

### 2026-10-16 -- a host answer let in at once, and the renderer kept by its rate of calls, each alone (roadmap/v2 C1)

- **Idea.** Two cores drew fewer of Far Cry's frames than one (the entry of the same date above).
  Two steps were measured alone before the change that was kept: (a) the process's turn with
  nothing of its own to run leaves at once while a call into the host is still to be answered
  through the event loop -- a graphics worker's answer -- rather than waiting up to 4 ms on the
  other executors' bell, a wait in which that answer cannot come in; (b) with (a), of two threads
  the process's executor may run, the one calling into the host twice as often an instruction
  keeps it and the other goes to the other executor.
- **Workload.** Far Cry demo (bundle sha256 `ec81f9c260efb780…`) settled 40 s and watched 40 s in
  `tools/cdp_test/frames.mjs --coi --worker --cores N --threads`; `cork2` at `20eb483b` with the
  step. Three runs an arm for (a), one for (b).
- **Values.** Frames a second. (a) 1 core 13.4 13.8 13.6, 2 cores 5.7 11.1 10.5 (2822 to 3026
  slices on the other executor, 5.5 to 6.0% of the instructions retired while it ran). (b) 2
  cores 10.4 (3040 slices there). Before either (the entry above, at `f72be67b`), 2 cores 10.1 11.3 8.5.
- **Machine.** Headless Chromium 141 (`chromium-1194`), SwiftShader, a 4-core x86-64 KVM VM
  (Intel Xeon @ 2.80 GHz). Power plan: not recorded.
- **What was found.** Both left threads that call into the host often running on the other
  executor, where each call is a round trip to the process's: of the last 16 placements there, in
  (a) 13 to 15 a run were a priority-15 thread that sleeps 10 ms between runs, at 0.4 to 1.6 calls
  a hundred instructions, and 1 to 3 the renderer (the main thread); in (b) 15 and 1. (b) decides
  only between two threads that want the process's executor at the same moment; a thread placed
  elsewhere because that executor was busy was placed by the old rule.
- **Correctness.** Every run drew its frames to the end of its window.
- **Decision.** Neither kept alone: (a) is part of the change that was kept, with a thread kept on
  the process's executor by its rate of calls into the host or by how its runs elsewhere end
  (roadmap/v2/README, 2026-10-16); (b) was replaced by it.

### 2026-10-16 -- invalidated: the host calls of `tools/executor-sweep.mjs` (2026-10-08 to 2026-10-16)

- **What was wrong.** The sweep's host call, every H-th turn of each thread, was GetTickCount,
  which kernel32 answers as guest code -- a read of the clock word in the process block -- since
  before the tool was written: the call never left its executor, and no point with H measured a
  call into the host. Its figures stand for what ran: a guest routine every H-th turn and a test
  and branch on every turn, beside the locks and the computing.
- **Cited as host calls in.** "2026-10-08 -- more threads than other executors, or one other
  executor" above (its host-call combinations), and roadmap/v2/README's measurements of
  2026-10-08 ("the more locks and host calls, the larger the gain"), of the interrupt word ("four
  on two with host calls") and of more ready threads than executors (the sweep's host-call points).
- **Measured again with a call the host answers** (GetACP; node 22.22.0, a 4-core x86-64 KVM VM,
  Intel Xeon @ 2.80 GHz, power plan not recorded; `cork2` at `9791153d`; 200 M turns over T
  threads, five runs a point, the mean of the fastest three, two rounds): against one executor, a
  call every 256 turns (about one in 2 300 instructions) x0.58 to x0.74 on two and four executors
  for two and four threads; every 1024 turns x0.91 to x1.18; every 4096 turns x1.04 to x1.28 --
  where the computing alone gave x1.24 to x1.45 on two (400 M turns, the same day). The other executors retired 10 to 63% of the
  instructions.
- **Since.** The sweep calls GetACP, says how many calls the other executors made and what share
  of the instructions they retired, and stops with an error at a point whose workers' calls never
  reached the host.

### 2026-10-16 -- a translation store without relinked modules

- **Idea.** Keep only the batch modules regions were emitted in, never a relink's module (named by
  its bytes, a new record every run), so a store holds each region's code once.
- **Conditions.** Far Cry demo (`farcry-demo`), `tools/cdp_test/game.mjs --worker --coi --no-video
  --fake-gpu --args "map fort" --run-seconds 200 --executors 1 --store local`, a fresh browser
  profile, one cold run and two warm ones; headless Chromium 141, the 4-core KVM VM, power plan
  not recorded; one run each (single runs: a frame varies by a quarter between runs).
- **Measured.** The cold run stored 404 MB against about 1.1 GB. Every warm run relinked its
  regions again: the translation worker's time 56 and 58 s against 23 and 20 s with the relinked
  modules stored, the map reached at 128 and 132 s against 121 and 122, the first minute on it at
  18.7 and 17.3 frames a second against 20.5 and 19.6.
- **Decision.** Not taken. A relink's module is stored, each relinked region's record names it,
  and a batch module no region names any more is dead at the next opening -- the store holds each
  region's code once without a later run relinking what an earlier one did.

### 2026-10-16 -- an effect's constants handed to the setter where the parameter lies

- **Idea.** The guest `Walk` (`d3dx9/effect-commit.js`) copies each constant word by word into a
  scratch block before calling the device's setter. For a constant whose registers are the
  parameter's words in order (a float parameter into float registers, an identity layout), the
  setter could read the parameter in place and the copy loop go. The performance overlay's
  "guest code, last second" put `Walk` at 26-37% of the guest's code.
- **Workload.** The Need for Speed Carbon demo bundle (`bundle.btl` sha256 `f5aec769a16ce7d8…`)
  at the start of its first race, 640x480, the renderer set to normal priority by hand.
- **Values.** The overlay's share of the buckets holding `Walk`: 28% before, 30% after (21 + 9).
  The engine worker's CPU profile (V8, 8 s) put `Walk`'s translated region at 2.0% of the
  worker's time -- about 4% of the guest's. One run of each; the race scenes differed (520 and
  770-1700 draws a frame), so no frame rate is compared.
- **Machine.** Chrome in a Parallels Windows 11 VM (4 vCPUs, Apple Silicon host) on its virtual
  GPU; versions and power plan not recorded.
- **Why it did not pay.** D3DX lays a matrix into registers transposed unless it is declared
  row-major, so few of the title's constants have an identity layout; and the overlay's share was
  not `Walk`'s time. The guest sampler (`cpu/internal/samples.js`) credits a whole slice to the
  64-byte bucket where it ended, and slices end where translated code exits -- around calls and
  short loops such as `Walk`'s -- so a routine full of calls is overstated there by several times.
- **Correctness.** The equivalence test of `Walk` with an in-place entry, and the effect's
  guest-against-host commit gates, which caught a wrong pointer on the in-place path.
- **Decision.** Removed. A routine's cost is read from the worker's CPU profile, not the overlay.

### 2026-10-16 -- less garbage on the Direct3D path, against a frame rate that floats

- **Idea.** Frames of the measured title floated (p90 twice the median, p99 four times), and a CPU
  profile of the engine worker put the garbage collector at 7.3% of it. The Direct3D path made a
  new array or closure for most commands: a copy of every constant and matrix out of the ring, a
  closure per SetConstant, arrays per draw for the streams read, entries per state-block apply.
  Reusing views and buffers there would cut what the collector has to sweep.
- **Workload.** The Need for Speed Carbon demo bundle (`bundle.btl` sha256 `f5aec769a16ce7d8…`)
  in its first race, 640x480.
- **Values.** The engine worker's allocation (`tools/cdp_test/live/worker-allocations.mjs`, 8 s,
  one run each): 152-182 MiB/s before, 88 MiB/s after (1.7 MiB a frame); the scenes differed, the
  sources removed made about a third of the first figure. The collector's share stayed 7.3%.
  Then the page was found hidden and its renderer at Windows' Idle priority class; with the tab
  visible and the renderer at normal priority (one 10 s trace of V8's GC categories): the busier
  dedicated worker spent 88.7 ms in 55 scavenges (largest 4.2 ms), 26.7 ms in 3 mark-compacts
  (largest 11.9 ms) and 34 ms in incremental marking -- 1.5% of its time; the worker's CPU profile
  (10 s, 14 087 samples) put the collector at 0.5%. Frames meanwhile: p10 17.3, p50 21.5, p90
  34.0, max 104.6 ms (239 frames).
- **Where the spread is.** Not the work: a frame's instructions stay at 15-16 million across its
  quantiles. A steady loop in an unrelated process, sampled beside the frames, ran at 67-68% of
  its median speed in the slowest tenth of frames and 106-113% in the fastest quarter (r = -0.53
  to -0.59 against ms per million instructions, two runs of 12 s). The VM was not saturated: 68%
  of its 4 processors busy, the renderer 1.4 of them. The vCPUs slow down together, from outside
  the guest.
- **Machine.** Chrome in a Parallels Windows 11 VM (4 vCPUs, Apple Silicon host) on its virtual
  GPU; versions and power plan not recorded.
- **Why it did not pay.** The 7.3% was the Idle priority's: the collector's background marking
  and sweeping run on threads of the same process, and starved, they leave the work to the
  worker's own thread. At normal priority the collector was a small share before the change could
  matter.
- **Correctness.** The Direct3D 8 and 9 tests and the device gates (3508 passing).
- **Decision.** Kept, as less garbage at no cost; no frame rate is claimed for it. A frame spread
  on this machine is measured with the tab visible, and set against an unrelated loop before it
  is read as the engine's.

### 2026-10-17 -- a dynamic buffer's DISCARD made in the guest by trading two storages

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

### 2026-10-17 -- invalidated: the streaked road in "a dynamic buffer's DISCARD made in the guest by trading two storages" (2026-10-17)

- **What was wrong.** That entry's **Picture** read the road drawn streaked, its lane line gone,
  as the trade's doing. The same streaks were seen later the same night in a build without the
  trade (07162c7e + 02f5ea86), right after the level loaded, and gone 25 s later in the same run:
  the road as it first appears, whatever the build. The entry's screenshot was one, taken at
  that moment.
- **What stands.** Its frame rates and host calls: 15.1 fps before, 5.7 after, one run each.
  The picture is not evidence against the trade, and the gates' silence is not a gap they have.

### 2026-10-17 -- invalidated: the scene of "d3dx9: a state's preshader expression is worked out in the guest" (10321baf)

- **What was wrong.** The commit says its numbers (frames 18 463 to 21 276, host time 55.9 to
  31.1 s, crossings 3.61 to 0.84 million, 220 s each) were taken in the Most Wanted demo's Quick
  Race by its route. Both runs stood at the "CLICK to continue" card: the route clicks the card at
  60 s, and the demo passes it on Space only, so no step after it was taken.
- **What stands.** The two numbers compare the same scene, the card, one run each; they say
  nothing about a race. The race was measured once, by the user in the launcher: about 66 to 81.7
  fps, conditions not recorded.

### 2026-10-17 -- a region stopping at every block another region has an entry for

- **Idea.** Far Cry's cold run stored 842 MB for 3.1 MB of x86 it ran, each byte in 6.9 regions.
  A region that stops at a block another region (published, or formed and on its way) has an
  entry for, and leaves to that region there, translates a function's code once (`regionStops`,
  `0b6289c7`, on by default there).
- **Workload.** The Far Cry demo bundle, `tools/cdp_test/game.mjs farcry-demo --worker --coi
  --no-video --fake-gpu --args "map fort" --run-seconds 200 --executors 1 --store local`, a fresh
  profile, one cold run a mode, on `6328903b` with the mode set by `cork.config`; and the transfers
  between regions (`countTransfers`) of xz 5.8.4 (`-3 -T1` on 16 MiB), Stockfish 8 (`bench 16 1
  12`) and 7-Zip (`7zr b -md22`), one executor, one run a mode -- the guest instructions retired
  are the same in every mode (xz 9.976 billion to within 3 000), so the transfers are counts, not
  timings.
- **Values.** Stopping at any such block / at another region's own entry only / never:
  Far Cry stored 246 / 336 / 345 MB (modules emitted 229 / 316 / 324 MB, 13 481 / 13 709 /
  13 608 regions); xz 179.3 / 116.2 / 103.0 million transfers (`f74d60e9`, before both:
  103.0 million); Stockfish 137.5 / 101.8 / 100.9 million; 7-Zip 74.4 / 68.3 / 68.3 million. The
  CPU suite on `0b6289c7` with the parked scheduler change (6 of 10 rounds, the machine loaded by
  two full check runs in some of them) had xz 10 to 17% and Stockfish 3 to 5% slower than
  `9a8f577e` on one core.
- **Machine.** The 4-core KVM VM after a container restart (Intel Xeon @ 2.80 GHz, slower than
  the one before it: xz 16 to 19 s here against 10 to 11 s there), node 22.22.0, headless
  Chromium 141. Power plan not recorded. Far Cry runs single, the figures in MB of one run.
- **Decision.** Off by default (`regionStops: false`). A third of Far Cry's store is the price of
  the cut it makes in hot code: a block another region holds is often inside the loop or the path
  this region runs, and every pass through it is a transfer, its registers stored and loaded
  again. Stopping only at other regions' entries keeps little of the saving (336 MB) and still
  costs xz 13%. The covering of regions on their way to being published, which kept candidates
  from being formed over them, stays on: it cost no transfer (xz 103.0 million) and took Far Cry
  from 842 to 345 MB. A stop that keeps out of hot code -- stopping only in code that runs rarely,
  or forming a region again without its stops once a transfer at one turns hot -- is still open.

### 2026-10-21 -- the process's executor makes a Direct3D ring ahead while it has nothing to run

- **Idea.** With the free host (the program's threads on other executors), the render thread's
  Present took the frame's whole command ring on the process's executor while the thread waited
  (735 us of host time a Present in a Call of Duty 4 firefight). The process's executor is idle
  about 30% of the time there; the guess was that it could make the ring between calls, when it
  has nothing to run (the kernel's shared turn calling the graphics layer before it waits for the
  other executors), so that a Present finds little left. The device's lock is taken only when free
  at once; a routine that finds it taken leaves for the host.
- **Workload.** Call of Duty 4 demo, `bog_a`, the firefight (W held once play starts), scratchpad
  `cod4/ingame3.sh` (`tools/cdp_test/game.mjs cod4-demo --worker --coi --no-video --fake-gpu --gpu
  sm3 --memory 2048 --screen 1024x768 --executors 3 --run-seconds 420 --series 100`, the profile
  `cod4data-e3` warm, its bundle 2 667-2 883 of 5 443 blocks cached), window 240-420 s. Bundle:
  `bundles/cod4-demo`, manifest sha256 `ead9cfb87a8147ce...`. Tree: `d2ddaf75` with the drain
  switched by `graphics.drainIdle`; the quiet variant is `d2ddaf75` plus a check that the ring's
  head has stood still for 0.5 ms.
- **Values** (ms a frame by the frame series, host / guest, guest instructions in 420 s, the
  routines that found the device's lock taken, presents' gaps p95 and over 100 ms):
  without: 64.0 (34.9 / 29.1) 200.5 G, 2 011, 95.9, 117; 60.3 (34.0 / 26.2) 204.4 G, 2 261,
  83.7, 62; 70.2 (36.6 / 33.5) 197.0 G, 1 670, 101.3, 137. Made ahead whenever idle: 65.8 (30.7 /
  35.1) 198.7 G, 43 228, 100.5, 139, made 77 673 times (15.6 s); 64.3 (30.5 / 33.8) 201.9 G,
  44 770, 94.3, 111, 77 980 times (16.3 s). Made ahead once the head stood still: 59.8 (33.0 /
  26.8) 206.6 G, 2 733, 82.8, 58, made 2 441 times (0.9 s); 66.0 (34.8 / 31.1) 194.2 G, 2 614,
  102.0, 154, 2 826 times (1.2 s). One run per line, alternated; the same arm varies by +-5 ms.
  A first made-ahead run (73.2 ms, 40 900) is left out: the tree it loaded was edited during it.
- **Machine.** The 4-core KVM VM (Intel Xeon @ 2.10 GHz), headless Chromium 141.0.7390.37, the
  fake GPU, node 22.22.0. Power plan not recorded.
- **Correctness.** A gate played the frames and streaming gates' seeded programs with the ring
  made ahead at random points and without, every answer and GPU read the same; it caught the ring
  made without the buffers the guest let go of settled first.
- **Decision.** Removed. Made whenever the executor was idle, the ring was taken while the render
  thread was writing it: its routines found the lock taken twenty times as often and left for the
  host, and the host time a frame saved (~4 ms) went back as guest time. Made only once the
  thread had stopped writing, it ran rarely (the thread ends its frame with the Present that
  takes the ring anyway) and moved nothing. Frame times stayed within the noise either way. A
  ring taken without the device's lock (records copied out under it, played after) is still open.

### 2026-10-22 -- an executor's look for its next slice counted among the cores taken

- **Idea.** The wait rule (`lookFor`, `executor-channel.js`) looks 1 ms before it sleeps while
  the executors' slices out and the two threads always beside them leave one of the host's
  processors free, and 0.05 ms otherwise. An executor between slices looks the same way without
  being counted, so on a host with no core to spare it might hold one the rule thinks free;
  counting its look among the slices out (`Bell.RUNNING`, given back when the look ends or the
  wait sleeps) was to keep the long look off such a host.
- **Workload.** The Direct3D stand (scratchpad `d3dstand/run-wake.mjs 200 30 20 1000000 2 C
  '{"program":{"vbBytes":65536,"pin":true,"renderWork":1000000}}'`: main computes 1 M rounds a
  frame and waits on a render thread that computes 1 M rounds and draws 30 batches of 20 quads,
  the graphics worker over the fake GPU), C = 2 and 3 executors, 200 frames; ms a frame over the
  run. Arms: a fixed 0.05 ms look (`fdc588b2`), the rule (`d4bc2788`), the rule with the look
  counted (`53f1cc0b`); snapshot worktrees, alternated, 4 runs an arm and core count, nothing
  else running.
- **Values** (ms a frame; best three, median): two executors: fixed 5.797 6.156 6.721 6.938
  (6.225, 6.438); rule 5.472 5.932 6.266 7.066 (5.890, 6.099); counted 5.957 6.111 6.323 6.477
  (6.130, 6.217). Three executors: fixed 6.993 7.103 7.462 7.976 (7.186, 7.282); rule 7.057 7.084
  7.251 7.391 (7.131, 7.168); counted 7.168 7.462 7.818 8.473 (7.483, 7.640). An earlier set of
  the rule against the fixed look (4 runs each): two executors 5.98 / 6.22, three 7.33 / 7.10.
- **Machine.** The 4-core KVM VM (Intel Xeon @ 2.80 GHz), node 22.22.0. Power plan not recorded.
- **Decision.** Reverted. Counted looks made the other executors' waits for answers short, so
  they slept and were woken more, while the looking executor kept its long look (it decides
  before it counts itself): worse than the rule on both core counts. The rule stays; on three
  executors it is level with the fixed look within the runs' spread.

### 2026-10-22 -- the shared layout's state and table bases held in locals

- **Idea.** Under the process's shared layout (several executors) a region reads its state
  block and tables at an offset from two imported immutable globals (`bases.js`), one
  `global.get` an access. The two-executor layout measured 7-12 % slower than one executor's
  on some cork-bench workloads in Chrome; reading the globals once a function into two locals
  (`stateBase`, `tablesBase` after the x87 ones) and taking every access from them was to
  recover that.
- **Workload.** cork-bench in headless Chromium (`tools/cork-bench/browser.mjs --paired`, 40
  rounds, warm 100): fmath-x87, vm-x87, fmath-pc24, game-x87, lua-x87; arms base and head on
  one executor's layout and on two executors' (`executors: 2`, atomic), the base a snapshot of
  `0e803748`. Ratios to the base on one executor, median with quartiles.
- **Values.** fmath-x87: two executors base 1.091 [1.040 1.131], head 1.068 [1.020 1.149];
  vm-x87: base 1.107 [1.074 1.154], head 1.098 [1.076 1.177]; game-x87: base 1.034, head 1.030;
  fmath-pc24: base 1.022, head 1.016; lua-x87: base 0.998, head 1.003 (quartiles 0.88-1.13).
  The same tree's one-executor arm: 0.992-1.030.
- **Machine.** The 4-core KVM VM (Intel Xeon @ 2.80 GHz), Chromium 141.0.7390.37 (V8
  14.1.146.11). Power plan not recorded.
- **Decision.** Reverted: within the quartiles on every workload. V8 reads an immutable
  imported global about as cheaply as a local; the two-executor layout's cost is elsewhere.

### 2026-10-22 -- the interrupt word looked at every 64th back edge

- **Idea.** Where other executors run beside it, the process's executor compares its budget at
  every back edge with an interrupt word loaded atomically from its state block
  (`spentTest`), which cost loops 3-12 % against one executor's layout in Chrome. A counter
  in a local, the atomic load only every 64th back edge, the budget against 0 between.
- **Workload.** cork-bench in headless Chromium (`tools/cork-bench/browser.mjs --paired`, 40
  rounds, warm 100), the two-executor layout (`executors: 2`, atomic) against the base's one-
  and two-executor layouts, base a snapshot of `0e803748`.
- **Values** (ratio to the base on one executor, median [quartiles]): crc-x87 base 0.987, counter
  1.097 [1.037 1.193]; fmath-x87 base 1.049, counter 1.096; sort-x87 base 1.099, counter 1.387
  [1.334 1.449]; vm-x87 base 1.091, counter 1.257; fmath-pc24 1.043 / 1.035; game-x87 0.990 /
  0.997.
- **Machine.** The 4-core KVM VM (Intel Xeon @ 2.80 GHz), Chromium 141.0.7390.37 (V8
  14.1.146.11). Power plan not recorded.
- **Decision.** Not taken: the counter's decrement and branch at every back edge cost more than
  the load. A plain load of the word took instead (0-3 %), the same contract kept: V8 12 and
  14 do not take it out of a loop that stores nothing.

### 2026-10-22 -- invalidated: "the shared layout's state and table bases held in locals"

- The entry above measured nothing of the shared layout: the cork host's executor 0, which
  every arm ran on, keeps its own layout (constant addresses) with any number of executors,
  and only the others translate for the shared one, so the change was not in the arms' code.
  Its conclusion about imported globals is not shown and is not to be cited.

### 2026-10-22 -- a block's budget charge carried into the one block it enters

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

### 2026-10-23 -- a call's register reloads left out where the value lives on in a local

- **Idea.** After a guest `call` returns through a wasm call, the caller reloads every guest
  register from the state block. A register the caller still holds in a local and the callee
  cannot have changed (a callee-saved register by the calling convention the call site
  shows) need not be reloaded: up to 37 machine instructions of the about 115 a call site
  costs in Crysis's main-thread code.
- **Workload.** The machine code V8 makes of the Crysis CPU benchmark's main-thread regions,
  weighed by the timedemo's block profile (`tools/cork-asm.mjs --blocks --classes`, a node
  stand's profile from 350 s on, the 400 heaviest blocks: 15.79 G guest instructions), the
  macOS arm64 model (`--no-wasm-bounds-checks`), atomic variant, RAM at 0.
- **Values** (machine instructions an executed guest instruction): base 7.553; reloads left out
  7.579 (+0.3 %): loads and stores of the state block fell 2.457 -> 2.285, stack spills rose
  0.284 -> 0.498. A wasm call keeps nothing in registers across it, so a value kept live in a
  local is spilled and refilled by V8 instead of reloaded from the state block: the same
  memory traffic, at another address.
- **Machine.** Counted instructions, not timed: the 4-core KVM VM, qemu-aarch64 8.2.2, node
  26.12.1 (V8 14.6.202.34).
- **Decision.** Not taken.

### 2026-10-23 -- the callee's flag record taken back only where code after the call reads a flag

- **Idea.** After a call the caller takes back the callee's lazy flag record (five loads)
  before going on. Code after a call almost always sets the flags before it reads one, so the
  record is needed only where the block after the call reads a flag first (`flagsLiveIn`).
- **Workload.** As the entry above.
- **Values.** Base 7.553; the record left out and its locals kept stale 7.613 (+0.8 %: V8
  kept the stale locals live across the call); left out and the locals zeroed 7.538 (-0.2 %).
- **Machine.** As the entry above.
- **Decision.** Not taken now: 0.2 % of the executed instructions does not pay for a cache
  version of its own (every store cold once). The patch waits for a translator change that
  needs a new cache version anyway.

### 2026-10-23 -- callees formed into their callers one level deeper (`formDepth` 2)

- **Idea.** A small callee formed into its caller may make direct calls of its own; with
  `formDepth` 1 those leave as wasm calls. Formed one level deeper, a small callee's own small
  callees join the region too: fewer wasm calls, each about 110 machine instructions at the
  caller in Crysis's main-thread code.
- **Workload.** Crysis demo, `benchmark_gpu` (the island flythrough, High, every setting before
  `+map`), on the node stand (`tools/launch-probe.mjs`, one executor, atomic variant, 2048 MB,
  a translation store of its own for each arm, 700 s a run): timedemo Run 0, which streams the
  level, as Game.log gives it. The arms alternated: cold, then two warm runs each. Statically:
  `tools/cork-asm.mjs --form-depth` on the timedemo's 400 heaviest main-thread blocks
  (block profile from 350 s on, macOS arm64 model, atomic variant, RAM at 0).
- **Values.** Run 0 fps, `formDepth` 1 / 2: cold 7.57 / 6.58; warm 8.50 and 8.37 / 8.15 and
  8.64 (the 8.15 run had a stray `find /` beside its last 40 s). Run 1 (no streaming): 9.43,
  9.69, 9.05 / 9.18. Static: 7.553 -> 7.681 machine instructions an executed guest
  instruction (+1.7 %): 3.6 % fewer calls (447 -> 431 M in these blocks), and the blocks
  without a call grew from 3.87 to 4.30 a guest instruction.
- **Machine.** The 4-core KVM VM (Xeon 2.80 GHz), node 22.22.0 (V8 12.4); the static counts
  by qemu-aarch64 8.2.2 running node 26.12.1 (V8 14.6.202.34). Noise between warm runs of
  one arm: about 3 %.
- **Decision.** Not taken: no warm gain past the noise, the code itself counted 1.7 % worse,
  and a cold run 13 % slower for the extra forming. `formDepth` stays 1; the tools keep the
  switch (`--form-depth`) for the next measurement of forming.

### 2026-10-23 -- hot direct callees formed into their callers past the caps

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

### 2026-10-23 -- the backward edges given as the cause in the entry above, invalidated

- **Idea.** Before laying a formed callee out between its call and the call's return (the entry
  above's decision), how the emitter itself takes those edges, and where the lua-x87 time went.
- **Workload.** Statically: the same 21 main-thread regions of the Crysis demo timedemo, formed
  and emitted as the translator does, every jump the emitter makes classed as a branch forward,
  a branch back to the head of a loop around it, a trip through the function's dispatch or a way
  out, weighed by the same block profile. Run: lua-x87 in node with the block profile and its
  counts of jumps back (`JUMP_LOOP`, `JUMP_DISPATCH`, `JUMP_OUT`), a33c9493 against a33c9493
  with the hot-callee patch; 100 iterations from the start, and 200 measured after 400 warm.
- **Values.** Static: of the 89.5 M formed calls, all forward; none through the dispatch or to a
  loop's head; their returns all forward too. The 43.3 M calls and 33.7 M returns backward of the
  entry above were counted in address order, which a structured region is not emitted in: its
  blocks follow the control flow (`planStructure`), and a callee formed in falls between its call
  and the call's return. lua-x87, the measured 200 iterations, per 1000 guest instructions (base,
  patch): through the dispatch 6.73, 6.89; to a loop's head 13.15, 12.87; calls formed in 5.18,
  10.80; direct wasm calls 8.55, 2.78; rets that left the region 0.31, 1.10; wasm calls come back
  by a way out 0.03, 0.45; transfers 2.20, 3.95; calls that left 0.007, 0.16. An iteration once
  warm: 7564 and 7716 us without the profile, 9188 and 8894 us with it. From the start, 100
  iterations with the profile: 4.3 and 9.6 s; regions formed again 21 and 187; module bytes 10.7
  and 29.2 MB.
- **Why.** The cause given above is wrong: the edges of a callee formed in run forward already.
  Once warm, in node, the patch runs at the base's speed: the wasm calls it saves are paid back
  by the new ways out of the regions (rets that leave, wasm calls left by an exit, transfers).
  The loss of the short runs is the forming again and the compiling of the larger modules. Why
  lua-x87 in Chromium stayed 1.38 times as long at warm 800 is not measured.
- **Machine.** The 4-core KVM VM (Xeon 2.80 GHz); node 22.22.0 (V8 12.4); one run of each arm,
  noise not measured.
- **Decision.** Laying formed callees out between call and return is dropped: the emitter does it.
  Hot callees formed in, if taken up again, start from the new ways out and the forming again.

### 2026-10-23: what a shader draw's samplers read, kept by the words it is made from

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

### 2026-10-24: a smaller start in WebKit through cork's region and module sizes, and through JavaScriptCore's tiers

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

### 2026-10-25: the translation worker nudged into collecting sooner, as the engine's thread is

- **Idea.** With the engine's thread nudged (`cpu.gcNudge`: an untouched 64 MB buffer made and
  dropped every 50 ms where JavaScriptCore runs), the web process still held about 200 MB more
  with translation than without, in small anonymous mappings, and the translation worker's heap
  stood at 120-200 MB before each collection against 50-130 MB after: the same nudge in that
  worker would collect its garbage sooner and give the difference back.
- **Workload.** The engine's test page (`test/page/game`, fake GPU in a graphics worker, engine in
  a worker) on 66fd44b5, the Quake III Arena demo's bundle `baf676901226a7e870606221`, 512 MB of
  guest memory, one core, 60 s from the start; the web process's RSS read from `/proc` once a
  second; the median from 15 s on, MB. Arms alternated, three runs each. The nudge reached the
  worker through cork's `gcNudge` setting, sent with `ready`; the GC log (`JSC_logGC`) showed it
  working: 201 collections of the translation worker's heap in 30 s instead of 26.
- **Values.** Head 941, 1028, 1001 (peak 1249, 1317, 1196); translation worker nudged 948, 1055,
  944 (peak 1259, 1191, 1311). Frames 4817-5014 and 4824-4955. For comparison, the graphics
  worker nudged instead: 934, 981, 947 against 1085, 1015, 956 in the next three pairs.
- **Why.** Not established. Collected sooner, the worker's garbage did not leave the process any
  sooner; the libpas pages its heap frees may be returned to the system on a schedule of their own.
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz), 15 GB, Ubuntu 24.04, no GPU; Playwright 1.63.0
  (WebKit 26.6, WPE, headless). Spread between runs of one arm: about 100 MB after the start.
- **Decision.** The translation worker is not nudged; the graphics worker is (`nudgeWhenAsked`).
  The change itself is 20 lines (a `gcNudge` runtime setting passed to the worker with `ready`,
  an interval started on it) and was not kept.

### 2026-10-25: a DXT level's blocks let go in the graphics worker once uploaded

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

### 2026-10-25: a smaller translation arena, and no relinks, for the page's memory

- **Idea.** Translation costs the Doom 3 demo's web process about 250 MB at equal progress (no
  translation, 130 s: 930 MB against about 1190 at 60 s with it). The arena keeps 48 MB of emitted
  functions for relinks, and each relink emits every live region again into one module, two copies
  of the code until the old one dies: an 8 MB arena, or no relinks, would give some of it back.
- **Workload.** The engine's test page built as the package is (minified, diagnostics off), fake
  GPU in a graphics worker, the Doom 3 demo's bundle `3f84befac918afe335547b36`, 2 GB of guest
  memory, one executor; the web process's RSS once a second. Its menu, 60 s, median from 15 s and
  highest, alternated: head (95438a8f) against `cork.config.arenaBytes` 8 MB, three runs each.
  Its first level (`+map game/demo_mars_city1`), 130 s, mean 80-125 s and highest by 125 s, two
  pairs alternated: head (632a0aa5) against `relinkAfter: 0`.
- **Values.** Menu, arena 8 MB: median 1231, 1189, 1195 against 1205, 1208, 1205; highest 1328,
  1379, 1314 against 1460, 1417, 1344. Level, no relinks: mean 1879, 1891 against 1920, 1929;
  highest 2322, 2308 against 2055, 2542; module bytes emitted 100, 103 MB against 195, 202 MB;
  instructions 51.9, 54.6 G against 52.5, 51.6 G.
- **Why.** The arena's pages are not what the process keeps, and an old module dies once its
  regions are relinked, so the second copy does not stay.
- **Machine.** The 4-core KVM VM (Xeon 2.10 GHz), 15 GB, Ubuntu 24.04, no GPU; Playwright 1.63.0
  (WebKit 26.6, WPE, headless). Spread between runs of one arm: about 10 MB in the menu's median,
  300 MB in the level's highest.
- **Decision.** Neither default changed.

### 2026-10-25: a context that keeps no texels reads a program's pixels without converting them

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

### 2026-10-26: a guest page written out and zeroed gives the tab no memory back on an iPhone

- **Idea.** A page file for guest memory: past a ceiling, write a cold page's bytes to a file,
  zero the page, fault it back on its next access. A browser cannot hand a WebAssembly memory's
  page back to the system, so the page file frees memory only if the system takes a zeroed page
  for free (a memory compressor's single-value pages).
- **Workload.** A test page: one `WebAssembly.Memory` of 2048 MiB (not shared), written in 64 MiB
  chunks of xorshift output with 200 ms between chunks. Mode A keeps what it wrote; mode B zeroes
  each chunk right after writing it, three passes over the memory. Progress kept in
  `localStorage` after each chunk, so a tab the system ends says how far it got.
- **Values.** Mode A ended by the system at 1856 and 1664 MB written; mode B at 1728 and
  1728 MB written, holding no random data at either point. Two runs a mode, in the order A, B,
  B, A.
- **Why.** The tab is charged for every page it ever touched, whatever the page holds now.
- **Machine.** The user's iPhone, the page opened in the Claude app's viewer; model and iOS
  version not recorded.
- **Decision.** No page file over guest memory. What can give memory back is the engine's own
  (JavaScript heaps, compiled modules); the guest's zone counts the heap up to the highest
  address it ever handed out.

### 2026-10-26: a long-mode doubleword register read left unmasked after a doubleword write

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

### 2026-10-26: long-mode regions laid out with wasm loops instead of the dispatch loop

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

### 2026-10-26: a long-mode store's page test as one load of two pages' flags

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

### 2026-10-26: no flag record for a long-mode write whose flags no one reads

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

## 2026-10-26: a long-mode region of more or fewer blocks than 256 (16 KiB)

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

### 2026-10-26: long-mode indirect-call prediction on real programs

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

### 2026-10-26: long-mode packs merged by levels

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

### 2026-10-26: the 32-bit translator's store into code, its slow path cut or moved out

- **Idea.** In long mode the granule test of a store's page (`codeHit` per granule) on the slow
  path of every store cost x264 a fifth of its speed while never run, and a store leaving on a
  flagged page, tested to the granule only after it kept leaving, won that back (35bbf05d). The
  32-bit translator's stores carry the same slow path inline (`noteCodeStore`, the group
  checks' `windowHit`/`spanHit`). Arms: the stores' slow path a plain leave before the
  instruction (min), the same with the group checks' slow path a leave too (min2), and the slow
  path whole but in one shared helper, a call, an `if` and the stale flag left inline (outl).
- **Workload.** cork-bench, every 32-bit workload; Chromium (`browser.mjs --paired --runs 1
  --rounds 40`, Chrome for Testing 153.0.8010.12, V8 15.3.76.4, headless), two runs; node 22.22
  (`modules/cork/bench/run.mjs --reps 3`), three rounds an arm, alternated. Base a8bc8c90.
  Checksums equal everywhere.
- **Values.** min and min2 are invalid as a measure of the slow path's weight: a leave before
  a block's first instruction makes the block no way in (`leaving`), so regions split (sort: 5
  regions, 19 403 module bytes -> 44 regions, 159 618 bytes, 37 relinks) and sort and str ran
  4.2-5.4 times slower with no leave taken. outl against base, Chromium, median ratio of two
  runs: every workload within 0.95-1.05 and none past the noise in the same direction in both;
  node geomean 1619 / 1607 / 1662 against 1677 / 1677 / 1625 MIPS (base spread 3.4 %). Module
  bytes base against outl over the 22 images: within -2.9 to +1.3 %, regions the same.
- **Why.** The 32-bit translator's stores fall mostly in group checks, whose slow path already
  sits in a guard; the inline `noteCodeStore` paths are about 1 % of the module bytes, where the
  long-mode ones were on every store of large regions.
- **Machine.** A cloud container (Xeon 2.30 GHz, 4 vCPU), node 22.22; GPU, driver, power plan
  and bundle hash not recorded.
- **Decision.** Not taken; the long-mode scheme is not ported to the 32-bit translator.

### 2026-10-27: long mode's window test folded into the page test

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

### 2026-10-27: long mode's push and pop without the 4 GiB test under loose stacks

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

### 2026-10-27: callee-saved registers kept across a guest call

- **Idea.** After a guest call made as a wasm call returns, read back only eax, ecx, edx and esp
  from the state block; ebx, ebp, esi and edi keep the caller's locals, as the i386 calling
  conventions promise.
- **Workload.** cork-bench vcall, game, tree, sort, str and lua (x87 images), `pair.mjs` in one
  node 26.12 process (V8 14.6, `--no-liftoff`), arms off, on, off again, warm 200, 40 rounds of 10.
- **Values.** Ratio to the first arm, median [quartiles]: vcall on 0.993 [0.975 1.025], game 0.989
  [0.945 1.032] (off again 0.988), tree 0.999, sort 1.025 [1.003 1.053], str 0.999, lua 1.015
  [0.967 1.089] (off again 1.048). Static machine code of vcall's call blocks (`cork-asm --calls`,
  x64 V8 14.6): 20.30 against 19.76 a guest instruction, -2.7 %.
- **Why.** The reads back are loads of a line the callee just wrote, off the critical path; the
  call's cost is the return stack, the entry hash's probe and the indirect call.
- **Noted on the way.** In one process the third and fourth host of the same configuration ran
  vcall at 196-205 us an iteration against 102-109 for the first two, with six times the
  untranslated exits; hosts made but not run first did not do it. Not explained yet.
- **Machine.** A cloud container (Xeon @ 2.10 GHz, 4 vCPU).
- **Decision.** Not taken.

### 2026-10-27: a byte copy loop done at once

- **Idea.** A block that is the whole of `movs` (or `stos`) of one element, `cmp` of the pointer
  with a register the loop does not write, and `jne` back to itself (gcc's freestanding memcpy
  and memset) does every element but the last at once before the loop runs: a page at a time,
  `memory.copy` or `memory.fill` for a run over 256 bytes and eight-byte moves in wasm for a
  shorter one, the loop running the last element so its flags and count come out of its own code.
  Gated against the interpreter on seeded programs (copies and fills, either compare order,
  overlaps both ways, the code's own page, the direction flag, small budgets); both mutations
  tried (budget charge, overlap test) failed the gate.
- **Workload.** cork-bench sort (its record swaps copy 12 bytes a call through such a loop, 37 %
  of its guest instructions by the block profile); valgrind callgrind, node 26.12 (V8 14.6) x64,
  `--no-liftoff`, 300 + 100 iterations less 300, divided by 100.
- **Values.** base 5.140 M machine instructions an iteration; with `memory.copy` alone 5.161 M;
  with the short runs in wasm 5.138 M. Native wasm: 1.368 M.
- **Why.** Twelve bytes are eleven turns of the loop saved, and the test before them (each
  pointer's page, its flags, the overlap, the budget) costs about as much. MSVC, which the
  games are built with, copies with `rep movs`, which already has a run path.
- **Machine.** A cloud container (Xeon @ 2.10 GHz, 4 vCPU), valgrind 3.22.
- **Decision.** Not taken; the patch and its gate are kept outside the tree.

### 2026-10-28: the flag record not read back after a guest call where the code after it writes the flags first

- **Idea.** After a guest call made as a wasm call returns, the region loads the record (its five
  fields) back from the state block with the registers. Where the flags are dead at the return
  address (its code writes the six before it reads one, and every way out before that write leaves
  for code that does the same), the record could be taken as empty instead of loaded.
- **Workload.** cork-bench tree and vcall (x87 images), valgrind callgrind with per-instruction
  counts and V8's printed code (`--print-wasm-code`), node 26.12.1 (V8 14.6) x64, `--no-liftoff
  --no-wasm-dynamic-tiering --predictable`, warm 300, 300 iterations; machine instructions run in
  the regions' own code, one run each (the count is exact to 0.01 % on these: two builds that emit
  the same code differed by 0.004 %).
- **Values.** On top of the empty record at the ways out (the change that went in the same day):
  tree 1 795 465 068 against 1 795 362 891 (-0.006 %), vcall 1 098 913 802 against 1 098 953 287
  (+0.004 %). Native and the rest: not measured.
- **Why.** The loads read a line the callee just wrote and are off the critical path, as the
  registers' are (the entry of 2026-10-27 on callee-saved registers).
- **Machine.** A cloud container (4 vCPU), valgrind 3.22.
- **Decision.** Not taken.

### 2026-10-28: a scalar SSE load that owes its vector on an x64 host

- **Idea.** With the scalar SSE forms holding their low lane in a local on x64 too, a `movss` or
  `movsd` load leaves the value in that local alone and owes the zeroed vector, as on arm64,
  rather than loading the vector (`owesLoads` in emit/simd.js): the load's offset folds into the
  scalar load, and no copy of the lane is taken out of a vector still live.
- **Workload.** cork-bench fmath-sse and game-sse; valgrind callgrind over node 26.12.1 (V8 14.6)
  x64, `ir.sh`'s flags, 1000 warm-up iterations, then 1000 counted less 0, divided by 1000, the
  run's clock its own (`CLOCK=0.001`). Two runs of the vector loads, one of the owed ones; two
  runs of one tree agreed within 0.23 % on every cork-bench workload.
- **Values.** Machine instructions an iteration, vector loads against owed ones: fmath-sse
  809,730 and 808,950 against 795,922 (-1.7 %); game-sse 1,135,728 and 1,135,993 against
  1,152,080 (+1.4 %). Native wasm: 265,201 and 434,481.
- **Why.** An owed zeroed vector is put back as a zeroing and an insert at the block's end;
  game's blocks are short and load more than they compute, fmath's chain arithmetic on what they
  load.
- **Checked.** The low-lanes gate on both hosts' features (emit/low-lanes.itest.js).
- **Machine.** A cloud container (Xeon @ 2.80 GHz, 4 vCPU), valgrind 3.22.
- **Decision.** Not taken: x64 loads the vector.

### 2026-10-28: long mode's push and pop without the 4 GiB test under loose stacks, measured again

- **Idea.** As the 2026-10-27 entry: under `looseStacks` a push, pop, call or return through rsp
  takes rsp's low half as its address, without the 4 GiB window test (`push`, `stackAccess`).
  That entry measured sort-x64 alone, whose hot loops neither call nor push.
- **Workload.** cork-bench sort-x64 and tree-x64 (images64, committed), `tools/cork-bench/ir.sh`
  as it was at 73ed219 (callgrind, WARM 1000, 100 iterations, the run's clock the real one),
  each of its two processes counted twice and a third time where two differed past 0.1 %, the
  median taken; node 26.12.1 (V8 14.6.202.34). Arms: the tree at 73ed219, and the same with
  this change alone.
- **Values.** Machine instructions an iteration, base then without the test: sort 6 026 075 ->
  5 989 352 (-0.6 %); tree 4 016 095 -> 3 696 743 (-8.0 %), one call, one return, a push and a
  pop every 33 guest instructions. Noise floor: on code emitted byte for byte the same, medians of
  this measure moved by 0.1-0.7 % between invocations (switch at 32 bits, 1.9 %).
- **Machine.** A cloud container (Xeon @ 2.80 GHz, 4 vCPU), valgrind 3.22; power plan not
  recorded.
- **Decision.** Taken, with the 4 GiB test of a return moved past its compares (`returnLong`).
  The earlier entry's sort result stands; its decision does not.

### 2026-10-28: long mode's field reads off one wrapped sum, grouped by register name

- **Idea.** The 32-bit emitter's `wrappedFirst` (a block's reads of several fields off the same
  registers share their sum wrapped into RAM, each field's displacement added after) for long
  mode too, grouping reads by register name as the 32-bit emitter does.
- **Workload.** cork-bench x64 images, measured as in the entry above. Arms: this change's tree
  on 73ed219 with long-mode `wrappedFirst` grouped by register name, and the same without it.
- **Values.** Without, then with: fmath 817 357 -> 779 192 (-4.7 %); game 1 303 648 -> 1 305 015
  (+0.1 %); vm 2 819 381 -> 2 842 234 (+0.8 %); sort 5 588 781 -> 5 599 661 (+0.2 %). All but
  fmath's within or just past the noise floor of the entry above.
- **Why.** vm's dispatch reads `[rdx + 4]`, moves rdx by 8 and reads `[rdx]`: one register name,
  two values, so no sum is shared and each read pays an add more than its address wrapped whole.
- **Machine.** As the entry above.
- **Decision.** Grouped by register name, not taken. Grouped by the values the registers hold
  (`operandValues`, the access planner's model), taken: vm 2 800 365 (-0.7 % against without),
  sort 5 573 581 (-0.3 %); fmath and game emit the same wasm as by name. All on 73ed219's
  `wrappedFirst`, before its spreads of 64 KiB (cbe09368).

### 2026-10-29: a plain self-loop run two turns a wasm turn

- **Idea.** A self-looping block that `planLoop` does not hoist (no stream: a pointer the data
  moves, registers alone, x87) emitted twice in its wasm loop: the first turn's back edge goes on
  into the second with no charge and no look at the budget, its count owed into the second's ways
  out, and the second charges both and looks once -- the budget's subtraction, compare and branch
  and V8's stack check at the loop's head paid every other turn. With x87, the tracker reset
  between the turns to the state the back edge leaves (`x87BlockStart`'s, after `x87BlockEnd`).
- **Workload.** cork-bench crc, vm, switch, sort, fmath, tree, str, game, vcall (x87 images);
  `tools/cork-bench/ir.sh` with WASM=1, node 26.12.1 (V8 14.6) x64, CLOCK=0.001, 1000 warm-up
  and 1000 counted iterations; machine instructions an iteration in wasm code. One run an arm:
  two runs of the arm without it gave the same in-wasm count on every workload.
- **Values.** Against the tree without it (the loop-edge changes of the same day, before the
  paired unchecked copy): crc 1,707,993 against 1,706,399 (-0.09 %), sort 3,966,623 against
  3,964,870 (-0.04 %); vm 2,190,307, switch 501,974, fmath 748,116, tree 2,896,777, str 3,301,943,
  game 1,163,971 and vcall 1,740,686 unchanged. With x87 as well: fmath 748,116, unchanged (its
  frustum loop leaves mid-body and is no self-loop). Native: not measured for this arm.
- **Why.** The hot self-loops of these workloads have streams and are hoisted; their unchecked
  copy running two turns a wasm turn did pay (crc -3.0 %, str -10.2 %), and went in.
- **Checked.** emit/loop-edges.test.js with loops of a data-moved pointer, registers alone and
  x87: every count mutation failed it; the x87 ones (no reset of the tracker between the turns,
  no `x87BlockEnd` after either) did not, as what they change is rewritten the same at the turn's
  end in these loops.
- **Machine.** A cloud container (Intel Xeon @ 2.80 GHz, 4 vCPU), valgrind 3.22.
- **Decision.** Not taken.

### 2026-10-29: long mode's window test of a single access folded into its page-flag test

- **Idea.** At 64 bits an access checked on its own (`checkAccess` after `windowAddress`) tested
  the 4 GiB window with a branch of its own (the address and its last byte or'ed, shifted by 32)
  before the page-flag test; folded into that test as the window checks of a group already were
  (the high half or'ed into the flags, a test under the one branch), it saves the add, the or
  and a branch an access. Gated: the far and crossing accesses of `runtime64-programs.itest.js`
  fail with the high half left out of the test or with the test under it removed.
- **Workload.** cork-bench tree, x86-64 image; valgrind callgrind, node 26.12.1 (V8 14.6) x64,
  `--no-liftoff --no-wasm-dynamic-tiering --predictable`, `tools/cork-bench/ir.sh` with `WASM=1`
  (machine instructions in V8's printed wasm code, 1100 iterations less 1000, over 100), one run
  an arm (the column repeats to the instruction run to run on this workload).
- **Values.** On cork2-x64 at cc16b41 with this change's stack, return, call and address
  changes in place: without the fold 3 445 305 an iteration, with it 3 445 783 (+0.01 %). 32-bit
  arm, unchanged: 3 085 465.
- **Why.** tree's hot accesses are a group's (`emitGroupChecks`), whose window test was folded
  already, or reads left untested; a single checked access is off its hot path.
- **Machine.** A cloud container (Xeon @ 2.10 GHz, 4 vCPU), valgrind 3.22; power plan not
  recorded.
- **Decision.** Left in: it is fewer instructions on every path that has such an access, and
  no workload measured here runs one hot; not measured apart on the others.

### 2026-10-29: the flag record not taken back after a guest call, measured again on the arm64 model

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

### 2026-10-29: a guest call's depth and budget tests as one condition

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

### 2026-10-29: every planned access off a lone register takes its displacement as its offset

- **Idea.** cfd605d0 gives a planned access off esp alone esp as its address and the
  displacement (0 to 64 KiB) as the load's or store's own offset, so V8 makes one address of esp
  for all of them. The same for any lone base register (ebp frames, struct pointers).
- **Workload.** As the entries above.
- **Values.** At the same tree with the esp form: 5.385 -> 5.384 (-0.02 %).
- **Why.** The hot planned accesses off other registers are few here; reads are mostly wrapped
  (`wrappedFirst` already shares a wrapped sum among a block's fields).
- **Machine.** As above.
- **Decision.** Not taken: off a pointer in the top 64 KiB the sum, not wrapped at 4 GiB, would
  trap where a wrapped sum reads the null page, for 0.02 %.

### 2026-10-29: a cmovcc from a register as a select

- **Idea.** Every 32-bit cmovcc as a `select` of the source and the destination under the
  condition, where it was a branch over the write: V8 makes a conditional move of a select,
  and the branch left two paths whose register merges a loop paid on both.
- **Workload.** cork-bench, x87 images; `tools/cork-bench/ir.sh` with WASM=1, CLOCK=0.001,
  ITERS=300, node 26.12.1 (V8 14.6) x64, `--predictable --no-liftoff
  --no-wasm-dynamic-tiering`; machine instructions an iteration in V8's printed wasm code, one
  run an arm (the base ran twice: the same count on every workload but vcall, 1,701,852 and
  1,710,564). Base 3078203.
- **Values.** Base, then every cmovcc a select: tree 2,848,928 -> 2,800,184 (-1.7 %), game
  1,091,219 -> 1,138,179 (+4.3 %); vm, sort, fmath, str, crc, switch unchanged; vcall 1,699,241.
- **Why.** game's clamp (`cmp eax, ecx; cmovg eax, ecx`, ecx 31) as a select had V8 hold the
  constant in a register of its own across its loop and spill others for it: in the main
  region's executed code (tools/wasm-grind.mjs listing, warm 1000 + 300 iterations) stack-slot
  loads and stores rose from 129 M to 154 M and register moves from 109 M to 128 M. tree's
  gain is a cmov from memory (`cmovae edi, [eax+4]`), whose read happens anyway.
- **Machine.** A cloud container (Intel Xeon @ 2.10 GHz, 4 vCPU), valgrind 3.22; power plan not
  recorded.
- **Decision.** Taken from memory only (4f54a94: tree -1.71 %, game unchanged); a cmovcc from a
  register stays a branch.

### 2026-10-29: an x87 integer store through the quadword saturating conversion

- **Idea.** fist/fistp of a dword or a word without `precise`: the rounded value through
  `i64.trunc_sat_f64_s`, its low half stored and its range tested as one unsigned compare of the
  quadword, where `i32.trunc_sat_f64_s` and two compares of the double were.
- **Workload.** The machine code V8 14.6 (node 26.12.1, x64) makes of `fldcw; fistp dword;
  fldcw` (`tools/cork-asm.mjs --hex`), counted by hand. Not measured under valgrind.
- **Values.** The quadword conversion is 8 instructions (a rounding, cvttsd2siq, its
  conversion back, a compare into a mask, a move out of it, an and, a test, a branch) where the
  dword one is 6; with the integer range test and the NaN's own compare, 19 for the store
  against 17.
- **Why.** V8 tests a quadword conversion for saturation by converting back, as it does the
  dword one, and adds a mask's move out of the vector register.
- **Machine.** A cloud container (Intel Xeon @ 2.10 GHz, 4 vCPU).
- **Decision.** Not taken: the value plus 1.5 * 2^52 went in instead (1a635af, 11 instructions,
  no branch; game -2.64 %).

### 2026-10-29: a self-loop that only reads, hoisted as a loop with stores is

- **Idea.** A self-loop whose streams only read, where reads go untested, hoisted as
  `emitHoistedLoop` hoists one with a store stream: the window tested, a copy whose reads go
  unwrapped for the turns it cleared, back to the test when they are spent, the checked copy
  when it fails. Left unhoisted since bcd3a03a, before the unchecked copy counted its turns on
  the budget (3441019).
- **Workload.** As the entry above (`ir.sh`, one run an arm). Arms: on 4f54a94's cmov change
  (unpublished then) with and without the hoisting; and on 1a635af with read streams tested
  against RAM alone (ab41509's window, then still over a movs copy's source too), with and
  without it.
- **Values.** With the pages' flags as the window: crc 1,721,137 -> 1,659,826 (-3.6 %), str
  2,959,943 -> 2,751,410 (-7.0 %), sort 2,639,133 -> 2,759,666 (+4.6 %). With the window a
  compare against RAM: crc 1,716,203 -> 1,654,826 (-3.6 %), str 2,952,739 -> 2,708,935
  (-8.3 %), sort 2,606,244 -> 2,679,031 (+2.8 %). The other workloads unchanged.
- **Why.** sort's partition scans (`while (v[i] < p) i++`) run a few turns an entry, and an
  entry paid the window, the turns' setup and two wasm loop heads, each V8's stack check and
  the alignment padding before it, which the counts include (nops run 2.5 M times in qs).
- **Machine.** A cloud container (Intel Xeon @ 2.10 GHz, 4 vCPU), valgrind 3.22; power plan not
  recorded.
- **Decision.** Not taken in this shape; a loop that only reads is hoisted as one, with no
  loop around the test (`emitReadLoop`, the change after this entry's).

### 2026-10-29: a single read off a register through the register's wrapped sum

- **Idea.** `wrappedFirst` shares the sum of a read's registers, wrapped into RAM, among the
  block's reads of fields off them, each displacement the load's offset; a read alone in its
  spread had its whole address wrapped. Taking a lone read with a small displacement (0 up to
  64 KiB) through the wrapped sum too costs the same where it stands (an `and` of the register,
  the displacement in the load, against a `lea` and an `and`), and the host may share that sum
  with another block's reads off the register -- tree's lookup reads `[eax+8]` in one block
  and `[eax]`, `[eax+4]` in the next.
- **Workload.** cork-bench, x87 images, `tools/cork-bench/ir.sh` with WASM=1, CLOCK=0.001,
  ITERS=300, node 26.12.1 (V8 14.6) x64; one run an arm. Arms: on the read-stream window (then
  unpublished, a stream of string reads still under it) every small displacement; and on
  8513591 with the copy run's peel and the read loops in place, any displacement but 0.
- **Values.** Every small displacement: crc 1,716,203 -> 1,744,169 (+1.6 %), str 2,952,739 ->
  2,958,363 (+0.2 %), tree 2,800,184 -> 2,747,558 (-1.9 %), switch 471,331 -> 468,593
  (-0.6 %), vcall 1,701,852 -> 1,714,252 (+0.7 %), game +0.1 %; vm, sort, fmath unchanged.
  Any but 0: crc 1,630,190 -> 1,658,177 (+1.7 %), str 2,630,056 -> 2,658,590 (+1.1 %), tree
  -1.9 %, switch -0.6 %, vcall +0.7 %, game +0.1 %.
- **Why.** Where the sum is shared the host has one more value live across the code between,
  and its register allocation moved and spilled others for it (crc's literal loop: the same
  instructions, other registers, a spill more a turn).
- **Machine.** A cloud container (Intel Xeon @ 2.10 GHz, 4 vCPU), valgrind 3.22; power plan not
  recorded.
- **Decision.** Not taken: a lone read keeps its address wrapped whole.

### 2026-10-29: a loop of several blocks paired up to 64 instructions

- **Idea.** A small loop of several blocks runs two turns a wasm turn (`emitPairedRange`)
  when its blocks hold at most `PAIRED_MAX` (32) instructions; twice that takes in more loops.
- **Workload.** cork-bench, x87 images, `tools/cork-bench/ir.sh` with WASM=1, CLOCK=0.001,
  ITERS=300, node 26.12.1 (V8 14.6) x64; one run an arm, on 30c1205.
- **Values.** The loops it adds: one in switch, one in vcall, none in the others. switch
  447,918 -> 447,918, fmath 623,156 -> 623,156, tree 2,756,671 -> 2,756,671, vcall 1,701,852
  -> 1,713,971 (+0.7 %).
- **Why.** Not measured; the larger body did not take V8's turn test off enough turns to pay
  for its size.
- **Machine.** A cloud container (Intel Xeon @ 2.10 GHz, 4 vCPU), valgrind 3.22; power plan not
  recorded.
- **Decision.** Not taken: the limit stays 32.

### 2026-10-29: entry-test locals for jumps forward, and locals cleared in shallower loops

- **Idea.** The local that lets a jump pass a block's entry test it passed before
  (`planTestedOnce`) given also (a) to blocks only a jump forward reaches past their test, and
  (b) to blocks whose way back to such a jump runs through a block that changes the test's
  registers or reaches the host, that block clearing it, where every such block lay in fewer
  of the program's loops (jumps to an address no higher, calls and returns aside) than the
  block itself.
- **Workload.** cork-bench, x87 images, `tools/cork-bench/ir.sh` with WASM=1, CLOCK=0.001,
  ITERS=300, node 26.12.1 (V8 14.6) x64; one run an arm, on 30c1205.
- **Values.** Taken (jumps back, nothing cleared): game 1,062,421 -> 1,030,109, the others
  unchanged. With (a): game the same, sort 2,605,293 -> 2,661,731 (+2.2 %), crc 1,630,190 ->
  1,628,053 (-0.1 %). With (a) and (b): crc 1,550,288 (-4.9 %), game 1,021,043 (-3.9 %), sort
  2,724,988 (+4.6 %); with every clearing block allowed, sort +5.2 %. Other workloads
  unchanged in every arm.
- **Why.** Sort: one more local live across a large function, and V8 spilled and moved others
  for it, the jumps forward rarely passing a test; with (b) the locals of its partition's
  blocks cleared by the recursive call's pushes and pops. Not measured which of crc's locals
  gave its 4.9 %; its one cleared local sits on a cold path, so it may be the same
  allocation's luck the other way.
- **Machine.** A cloud container (Intel Xeon @ 2.10 GHz, 4 vCPU), valgrind 3.22; power plan not
  recorded.
- **Decision.** Neither taken: a jump back only, nothing on its way clearing the local.

### 2026-10-29: long mode's owed compare result answered for je/jne by an i64 compare

- **Idea.** With a `cmp` whose result its block's final branch leaves unmade at 64 bits too
  (`oweResult`, `owesTo`), a `je` or `jne` compares the record's two operands: as i64, the
  record holding a narrower compare's operands zero-extended, so one compare serves every width.
- **Workload.** cork-bench x86-64 images, `tools/cork-bench/ir.sh` with `WASM=1 CLOCK=0.001
  ITERS=1000`, node 26.13.0 (V8 14.6) x64, machine instructions an iteration in V8's printed wasm
  code; one run an arm (the column repeats to the instruction run to run). Arms: the tree at
  8740b9eb with the float-compare fusion over instructions between (this branch's first change),
  without and with the owed result at 64 bits.
- **Values.** Without, then with the i64 compare: tree 3,117,594 -> 3,160,406 (+1.4 %); sort
  4,029,716 -> 3,793,562 (-5.9 %); crc 1,991,978 -> 1,991,020; vm 2,434,503 -> 2,434,503.
- **Why.** tree's hot `cmp r32, r32; je`: V8 extends the dword operand into a register of its own
  before a 64-bit compare (`movl r12, r11; cmpq rsi, r12`) where the made result's
  `i32.eqz` had been one `cmpl`.
- **Machine.** A cloud container (Intel Xeon @ 2.10 GHz, 4 vCPU), valgrind 3.22; power plan not
  recorded.
- **Decision.** Not taken as such: a narrower compare's operands are wrapped and compared as i32,
  a quadword's as i64 (tree 3,117,594, its base; sort 3,791,850).

### 2026-10-29: a linked call's slot read in one quadword load on an x64 host

- **Idea.** fe40382e read a linked call's slot (the index, the label and the top-and-empty
  halfword) in one i64 load, taking each field out with shifts and masks, where it had been
  three loads: on arm64 a constant address past a load's offset costs two instructions a load
  (4da46ec1 kept the one load on both hosts when it took the one condition back to arm64).
- **Workload.** cork-bench, both widths, `tools/cork-bench/ir.sh` with `WASM=1 CLOCK=0.001
  ITERS=1000`, node 26.13.0 (V8 14.6) x64, machine instructions an iteration in V8's printed wasm
  code, two runs an arm (identical to the instruction; load and lua one). Arms: cork2-x64-speed
  at 35c25a0 (the one load on both hosts), and the same with three loads on an x64 host.
- **Values.** One load, then three: calls512-order 5,242,588 -> 5,128,910 (x32), 5,998,645 ->
  5,843,891 (x64); calls512-scatter 5,251,383 -> 5,139,761, 4,989,406 -> 4,825,586; load
  2,501,119 -> 2,478,182, 2,974,678 -> 2,949,159; lua 33,891,535 -> 33,757,597, 36,667,831 ->
  36,366,200; the other workloads within 0.1 %, none higher. Per commit of the base's history
  (x64): fe40382e calls512-scatter +3.18 %, calls512-order +3.00 % (x32 +3.50 %); 4da46ec1 -1.80,
  -1.99 (x32 -3.10 %).
- **Why.** An x64 load takes the constant address as its offset for nothing; the fields out of one
  quadword are shifts and masks the separate loads did not need.
- **Machine.** A cloud container (Intel Xeon @ 2.10 GHz, 4 vCPU), valgrind 3.22; power plan not
  recorded. arm64: not measured here (the one load stays there).
- **Decision.** On an x64 host three loads again; arm64 keeps the one load.
