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

## Invalidated

None yet.
