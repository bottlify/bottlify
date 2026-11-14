# Negative results

Ideas that were measured and did not pay, one line each, grouped by area: when, what it gave in one
number with its conditions, whether that still holds, and when it is worth trying again. A no
today is not a no for ever: "stale" means the code or conditions under it changed, "disputed" that
the result was inside its own noise; both are worth measuring again before they are cited. The full
text of every entry up to 2026-11-14 is `git show f6e23f6de:roadmap/negative-results.md` (the
original wording: `git show dc1a45dc8:roadmap/negative-results.md`). A new entry is one line here,
plus at most five lines below its table of conditions the line cannot carry.

## Translator (cork)

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-10-08 | a loop with a call out stays a loop under `callReturn` | 5.58 vs 3.98 ns an iteration, node, 3 pairs | disputed: a game ran beside it | paired + callgrind, current tree |
| 2026-10-11 | a store into code drops only the regions whose bytes it changed | Far Cry ~2 fps, 1 run | stale: re-landed as e7ae7813b | - |
| 2026-10-11 | patched code sites formed apart; store-dropped regions formed again with copies | 39.0 / 39.2 vs 38.6 s, synthetic mixer | stale: compiling moved to workers | a patched loop runs interpreted again |
| 2026-10-12 | callees formed two and three levels deep (`formDepth`) | geomean 1.00x, cork-bench Chromium, noise 13 % | holds | callees stop being copied per caller |
| 2026-10-12 | predicted virtual calls (`callTargets`) on cork-bench | geomean 1.01x, noise 7.6 % | stale: on by default since b73438e6 | - |
| 2026-10-12 | transfers inside a placed module as direct tail calls (`dispatch`) on cork-bench | geomean 0.99x, noise 5.3 % | holds: measured again 2026-11-14, below | - |
| 2026-10-13 | every register in wasm parameters across guest calls (calling convention, x64) | params / state-direct 1.085 node, 0.959 Chromium | disputed: arm64 never run | the M4; long mode's 16 registers |
| 2026-10-12 | transfers inside a placed module as direct tail calls (`dispatch`) on cork-bench | geomean 0.99x, noise 5.3 % | stale: the iOS path runs it | on/off under the iOS settings |
| 2026-10-13 | every register in wasm parameters across guest calls (calling convention, x64) | params / state-direct 1.085 node, 0.959 Chromium | disputed: arm64 never run; x64 run again 2026-11-14 | the M4; long mode's 16 registers |
| 2026-10-13 | loading only what is live after a call (step 2a/2b), its ceiling | 0.95-0.98 of a call, node, 15 pairs | stale: built as `planPaths` d4643f20b | - |
| 2026-10-13 | `callTargets` in Far Cry and its knobs, while the sampling took the last calls | on / off 0.971, node, 1 run | disputed: knobs ran on broken sampling | leaf limits with the sampling fixed |
| 2026-10-13 | `callTargets` in Far Cry at a 44 % share of its calls | 0.958 cold, 0.983 warm, node, 1 pair | stale: Chromium run turned it on | - |
| 2026-10-13 | a call out's cost in Far Cry: a smaller entry hash; the callee found from the call's site | hash alike; site: transfer 10.2 -> 7.4 % of thread, 1 pair | stale: site lookup is `linkedCalls` | - |
| 2026-10-13 | larger regions for an interpreter: caps doubled, or room for return blocks | Lua -11 %, rest of the bench +8.9 % | holds | regions grow without recompiling |
| 2026-10-13 | x87: code a wasm call returns to tests its stack shape whatever the entry top | -2.4 %, 10 processes an arm | invalidated: process spread hid 10 % | - |
| 2026-10-14 | invalidated: "x87: code a wasm call returns to tests its stack shape" | paired 0.897, node and Chrome | invalidated: the record; committed | - |
| 2026-10-14 | x87 single precision on floats: other encodings of the range test | best 0.995-1.03x; no test 0.60x | holds | on arm64 |
| 2026-10-14 | invalidated: the "before" of 3cc3e7c4 (store hits compiled off the engine thread) | - | invalidated: base was an intermediate build | - |
| 2026-10-14 | `callTargets` in Far Cry in Chromium, measured again | 1.041 cold, 1.064 warm, 1 pair, noise 6 % | disputed: one pair at the noise | 5 pairs a phase |
| 2026-10-14 | `callTargets` on the benchmark, on by default | geomean 1.00; spread -9 % | holds | the Far Cry gain is re-measured |
| 2026-10-14 | `callTargets` in Far Cry, its regions formed again under the credit | 1.018 cold, 1.028 warm, 1 pair, noise 6 % | disputed: one pair at the noise | with the line two above |
| 2026-10-14 | an indirect call with nothing to form in sampled no more (quiet calls) | 1.004 cold, 1.021 warm, noise 6 % | holds (kept) | too-large callees still go through the hash |
| 2026-10-15 | the speed work of 2026-10-13 and 14 in Far Cry, all of it at once | ratio of medians 1.000, 10 runs | holds | - |
| 2026-10-15 | the shared layout's bases as other kinds of global | mutable 1.166 vs immutable 1.054-1.070, node | stale: main threads now run shared layout | Chrome x64 and M4, paired |
| 2026-10-16 | a translation store without relinked modules | warm worker 56-58 vs 20-23 s, Far Cry, 1 run each | holds | relinks go away |
| 2026-10-17 | a region stopping at every block another region has an entry for (`regionStops`) | xz 179.3 vs 103.0 M transfers; store 246 vs 345 MB | holds | a stop kept out of hot code |
| 2026-10-22 | the shared layout's state and table bases held in locals | within quartiles | invalidated: arms never ran shared layout | - |
| 2026-10-22 | the interrupt word looked at every 64th back edge | sort 1.387 vs 1.099, Chromium paired | holds | V8 hoists the load |
| 2026-10-22 | invalidated: "the shared layout's state and table bases held in locals" | - | invalidated: the record | - |
| 2026-10-22 | a block's budget charge carried into the one block it enters | charges 2.5 % of arm64 instructions | disputed: pre-fix cork-asm arm64 counts | the fixed cork-asm |
| 2026-10-23 | a call's register reloads left out where the value lives on in a local | +0.3 % instructions, arm64 model | holds (x64 timing agrees) | wasm keeps registers across calls |
| 2026-10-23 | the callee's flag record taken back only where code after the call reads a flag | -0.2 %, arm64 model | holds (x64 exact count agrees) | - |
| 2026-10-23 | callees formed into their callers one level deeper (`formDepth` 2) | Crysis warm 8.15-8.64 vs 8.37-8.50 fps; cold -13 % | holds | as `formDepth` above |
| 2026-10-23 | hot direct callees formed into their callers past the caps | Crysis 435 / 735 vs 593 ms a frame; lua 1.38x | disputed: cause invalidated, noise 435-735 ms | on `planPaths`: callgrind, then Crysis 3 runs |
| 2026-10-23 | the backward edges given as the cause in the entry above, invalidated | all 89.5 M formed calls run forward | invalidated: emitter already lays them forward | - |
| 2026-10-26 | a long-mode doubleword register read left unmasked after a doubleword write | 7-Zip 1267-1270 vs 1255-1347, 2 runs | stale: long runner retired | callgrind on the shared emitter |
| 2026-10-26 | long-mode regions laid out with wasm loops instead of the dispatch loop | 7-Zip mean 1513 vs 1523, 5 runs | stale: shared emitter structures them | - |
| 2026-10-26 | a long-mode store's page test as one load of two pages' flags | 7-Zip 1542-1569 vs 1576-1616 | stale: shared `checkAccess` does it | - |
| 2026-10-26 | no flag record for a long-mode write whose flags no one reads | 24.36 vs 24.32 G host instructions | stale: shared emitter's pass does it | - |
| 2026-10-26 | a long-mode region of more or fewer blocks than 256 (16 KiB) | 128: Stockfish -10 %; 512: +7 % Stockfish, -2.6 % 7-Zip | stale: long mode now runs 128 | Stockfish and 7-Zip x64, 5 pairs |
| 2026-10-26 | long-mode indirect-call prediction on real programs | zstd 59.3 vs 66.8 MB/s; x264 alike | stale: on now, forming moved to worker | x264 and zstd, on / off |
| 2026-10-26 | long-mode packs merged by levels | patch-x64 +10-14 %, load-x64 +17-28 %, Chromium | stale: long runner retired | - |
| 2026-10-26 | the 32-bit translator's store into code, its slow path cut or moved out | 0.95-1.05 every workload, Chromium | holds | `noteCodeStore` shows in a profile |
| 2026-10-27 | long mode's window test folded into the page test | vm-x64 +3 % instructions | stale: the fold went in later | - |
| 2026-10-27 | long mode's push and pop without the 4 GiB test under loose stacks | sort-x64 +1.2 % instructions | stale: taken on 2026-10-28 | - |
| 2026-10-27 | callee-saved registers kept across a guest call | 0.989-1.025, node paired | holds | on arm64 |
| 2026-10-27 | a byte copy loop done at once | 5.138 vs 5.140 M instructions, sort | holds | long gcc-style copies |
| 2026-10-28 | the flag record not read back after a call where the code after writes the flags first | -0.006 %, x64 exact count | holds | - |
| 2026-10-28 | a scalar SSE load that owes its vector on an x64 host | fmath -1.7 %, game +1.4 % | holds | - |
| 2026-10-28 | long mode's push and pop without the 4 GiB test, measured again | tree-x64 -8.0 % (taken) | holds | - |
| 2026-10-28 | long mode's field reads off one wrapped sum, grouped by register name | vm +0.8 %, fmath -4.7 % | holds (by value taken) | - |
| 2026-10-29 | a plain self-loop run two turns a wasm turn | crc -0.09 % | holds | - |
| 2026-10-29 | long mode's window test of a single access folded into its page-flag test | +0.01 % (left in) | holds | - |
| 2026-10-29 | the flag record not taken back after a guest call, measured again on arm64 | -0.04 %, arm64 model | disputed: pre-fix cork-asm arm64 counts | the fixed cork-asm |
| 2026-10-29 | a guest call's depth and budget tests as one condition | +0.07 %, arm64 model | disputed: pre-fix cork-asm arm64 counts | the fixed cork-asm |
| 2026-10-29 | every planned access off a lone register takes its displacement as its offset | -0.02 % | holds (null-page trap) | - |
| 2026-10-29 | a cmovcc from a register as a select | game +4.3 %, tree -1.7 % | holds (from memory taken) | on arm64 |
| 2026-10-29 | an x87 integer store through the quadword saturating conversion | 19 vs 17 instructions | holds | - |
| 2026-10-29 | a self-loop that only reads, hoisted as a loop with stores is | sort +2.8-4.6 %, str -7-8 % | holds (`emitReadLoop` taken) | - |
| 2026-10-29 | a single read off a register through the register's wrapped sum | crc +1.6 %, tree -1.9 % | holds | - |
| 2026-10-29 | a loop of several blocks paired up to 64 instructions | vcall +0.7 % | holds | - |
| 2026-10-29 | entry-test locals for jumps forward, and locals cleared in shallower loops | sort +2.2-5.2 % | holds | V8's register allocation changes |
| 2026-10-29 | a guest call's ways out storing what a way to them wrote, through a chain of stores | str +1.95 %, lua -1.49 % | holds (`EXIT_KINDS` taken) | - |
| 2026-10-29 | callees of a few instructions formed in past the region's caps | no count moved | holds | Crysis's region-full calls sized |
| 2026-10-29 | a `ret` back to its call without the empty stack's test | lua -0.31 % | holds | the return stack changes form |
| 2026-10-29 | a predicted call to a callee not formed in made as a wasm call | vcall +21.1 %, calls8 -18.4 % | holds | sites with many targets |
| 2026-10-29 | long mode's owed compare result answered for je/jne by an i64 compare | tree +1.4 % | holds (width split taken) | - |
| 2026-10-29 | a linked call's slot read in one quadword load on an x64 host | three loads 2-3 % fewer instructions | holds (x64 three loads) | - |
| 2026-10-31 | a call to an empty function answered at its own site (`emptySites`) | ~1 ns more a call out; not recorded | holds | empty calls show hot |
| 2026-11-05 | eager WebAssembly compilation against 3DMark2001 SE's drops on new code | 150 vs 105-167 drops, 1 run | disputed: one run inside the spread | node bench or 5 runs an arm |
| 2026-11-05 | a smaller share of the engine thread for the translator (`holdShare` 0.15) | 115-118 vs 136-146 fps, 2 runs | disputed: declared inconclusive | with `holdMs` |
| 2026-11-05 | wasm compiled straight to TurboFan against 3DMark2001 SE's drops | 52-65 vs 112 fps | holds | - |
| 2026-11-05 | the translator's longest hold on the engine thread (`holdMs` 1 against 4) | one arm 79.6 and 141.7 fps | disputed: self-declared inconclusive | node bench of new code mid-frame |
| 2026-11-06 | a block held at its own start in a caller's region gets a region of its own | 102.2 vs 108.3 fps median, 5 runs, spread 84-112 | holds (kept, no fps claim) | - |
| 2026-11-06 | heavy frames inside 3DMark03's tests are not cold code waiting for translation | the wait at most 1/10 of a stall, 8 runs | holds | the stalls are open |
| 2026-11-12 | cork's interpreter and volatile-page levers do not speed up ngen's compile | 50.9 / 53.8 vs 52.9-55.5 s, 1 run | disputed: inside two-run noise | interpreted addresses known |
| 2026-11-14 | the transfer taken out of every region (kept from inlining) | 0 of 519 call sites inlined under real tiering, calls512, Node 26 | holds: the premise was cork-asm's compile without call counts | V8 inlines cold calls |
| 2026-11-14 | regions of a module as one: `dispatch` alone on V8, its merges (`mergeAfter`) with a worker | Chromium 153 cork-bench x10 MIPS on/off 0.995 x87, 0.999 sse, median of 5, 2 runs | holds | V8 inlines a `return_call` into a placed function |
| 2026-11-14 | `dispatch` keeping linked calls (it turns each into a transfer) | Chromium 153 cork-bench x10 MIPS 1.006 x87, 0.994 sse; micro 1.012 x86, 0.931 x64 inside ±15-25 % noise | holds | as above |
| 2026-11-14 | every register in wasm parameters (calls bench), x64 run again | farcry params / state-direct 0.826 Node 22.23.4, 0.889 Chromium 153; TurboFan, depth 8, 9 runs | between the rule's branches: not built; arm64 still not run | the M4 |
| 2026-11-14 | a region takes three registers in parameters on an x86-64 host, where V8 passes five (2a464ac) | machine instructions -1 to -6 %; PE vm x87 1.060 ms in Node, 8 of 9 pairs slower; Chromium geomean 0.995 | holds | vm's loss explained; paired Chromium runs |
| 2026-11-14 | a `ret` answers its wasm call the address it took and the call compares it; no stack of return addresses | calls512-scatter machine instructions 32-bit -5.3 %, 64-bit +7.6 %; formed callees' returns 100 of 100 through the transfer | holds | a frame's count of formed calls; long mode's window test folded |

The two 2026-11-14 lines on regions of a module as one, conditions: cork 3f877946, a cloud machine (Intel Xeon @ 2.10GHz, 4 cores,
power plan not recorded), Chromium 153.0.8010.12 / V8 15.3.76.4 headless (`browser/suite.mjs --scale 10
--reps 5`, both arms in one run, 5 reps an arm, a first run's sse spread +18 % not repeated in the
second, 1.00); Node 22.23.4 `run.mjs` x10 with a worker, ms on/off 0.987 x87, 0.998 sse, spread 10-20 %;
merges fired 0-1 a run, module bytes -1 to -12 % only from the linked calls `dispatch` drops.

## Executors and scheduler

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-10-05 | the system's side of a link waits blocking while calls are recent | median 196 vs 181 us, 1 run, node VM | disputed: one run; idea paid elsewhere | link round trip on the M4 |
| 2026-10-07 | a second executor for Doom 3 and Tron | 0-9 % of time with 2+ threads ready | stale: cores automatic since a527bd121 | - |
| 2026-10-07 | several translation workers for one process, on four cores | Doom 3 load 18 vs 16 s, 3 runs | stale: pool reworked, no many-core run | the M4, 1 / 2 / 3 translators |
| 2026-10-08 | an executor waiting in place for its next slice, not through its event loop | 1.23 vs 1.23 s, sweep | holds | - |
| 2026-10-08 | more threads than other executors, or one other executor | E=2 x0.64-0.86 | stale: scheduler rewritten since | sweep T 1-4 x E 1-4 |
| 2026-10-09 | Sleep(0) yielding to a ready thread of the caller's priority or higher | Gothic 3 world not shown in 2850 s, 1 run | stale: on again since aae122924 | Gothic 3 to its world |
| 2026-10-15 | the process's executor looking for the others' words between its regions | 7-Zip 596 vs 1111 MIPS | holds (`spentTest` instead) | - |
| 2026-10-16 | the program's cores chosen from the host's by default | 2 cores 10.1 vs 1 core 13.0 fps, SwiftShader | stale: reversed by a527bd121 | - |
| 2026-10-16 | a host answer let in at once, and the renderer kept by its rate of calls | 2 cores 5.7-11.1 vs 13.6 fps | holds (part of kept change) | - |
| 2026-10-22 | an executor's look for its next slice counted among the cores taken | 6.130 vs 5.890 ms a frame, 4 runs | holds | a many-core host |
| 2026-10-31 | a run loop in a worker that sleeps until something happens (`pacing: 'event'`) | 1.07 vs 1.95 G instructions; rest not recorded | disputed: no conditions recorded | menu and play, 5 runs |
| 2026-10-31 | threads placed by trial and on reckoned gains, and the trade of a pinned processor | CoD4 trade 86.7 vs 77.4 ms a frame | holds | - |
| 2026-10-31 | a job thread's executor chosen by where the other threads will run | 8.66-8.78 vs 8.72-8.87 ms, 2 runs | holds | Deus Ex HR's job threads |
| 2026-11-13 | a .NET game's loader with its commonest kernel32 calls in the guest | crossings 110 539 -> 33 025, start no faster | holds (kept) | - |
| 2026-11-14 | a thread elsewhere called back at once only for a hand-off it can end | recalls 1 501 vs 1 182 | holds | - |
| 2026-11-14 | invalidated - "to the menu" is no measure of a .NET game's start | - | invalidated: menu appears while still loading | - |

## Graphics

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-10-09 | not waiting for a render-target copy that stays on the GPU | 10.81 vs 10.87 ms a frame, RC menu, 1 run | holds | GPU-only copies show waits |
| 2026-10-09 | client arrays read once a glLockArraysEXT rather than once a draw | 6.78 vs 6.64 ms a frame; bytes -35 % | holds | copies show in a profile |
| 2026-10-10 | reading a fence target back ahead, as each frame is presented | +3 ms a frame, RC level, 3 samples | holds | the device runs in step |
| 2026-10-11 | a draw's reads of a dynamic buffer lent to the graphics worker, not compared | 0.32 vs 0.31 s overhead per guest s, CoD4 | stale: written pages tracked since | CoD4 Bog, 2 runs |
| 2026-10-11 | an unlock of a dynamic vertex buffer that sends and uploads nothing | quads flicker about once a second | holds (correctness) | a gate case fails on it |
| 2026-10-14 | an indexed draw's dynamic vertices compared over the range its indices name | 1.5 of 55 ms a frame | stale: superseded by `namedRange` | - |
| 2026-10-15 | three host-side costs off Far Cry's engine thread | +1.8 % warm, noise 4 % | holds (kept) | - |
| 2026-10-16 | a host call's device steps run as the device's methods in the host | 48 vs 18-24 us a CommitChanges | holds | - |
| 2026-10-16 | an effect's constants handed to the setter where the parameter lies | `Walk` 2 % of the worker | holds | - |
| 2026-10-16 | less garbage on the Direct3D path, against a frame rate that floats | 88 vs 152-182 MiB/s; GC share unchanged | holds (kept) | - |
| 2026-10-17 | a dynamic buffer's DISCARD made in the guest by trading two storages | 5.7 vs 15.1 fps, CoD4, 1 run | stale: re-landed as 6d0a42363 | CoD4 rate on the landed trade |
| 2026-10-17 | invalidated: the streaked road in the DISCARD trade entry | - | invalidated: streaks appear in every build | - |
| 2026-10-17 | invalidated: the scene of "d3dx9: a state's preshader expression" (10321baf) | - | invalidated: measured at the click card | - |
| 2026-10-21 | the process's executor makes a Direct3D ring ahead while it has nothing to run | 64-66 vs 60-70 ms a frame, CoD4 | holds | the ring taken without the lock |
| 2026-10-23 | what a shader draw's samplers read, kept by the words it is made from | 41.2-48.2 vs 42.9-45.8 ms, 4 runs | disputed: arms overlap, cause unmeasured | 10 runs and a profile |
| 2026-10-31 | a Direct3D 10 dynamic buffer given 32 MiB of storages instead of 4 MiB | 3.59 / 6.18 vs 4.10 / 4.97 fps, 1 run | holds | the 32-storage count cap raised |
| 2026-11-06 | less garbage a draw in the graphics worker (Direct3D 8/9 `render.js`) | 185.6 vs 196.6 fps, 1 run | holds | - |
| 2026-11-06 | a batch's buffer sent back and written on again | 259.0 vs 251.1 fps median, 5 runs, p 0.15 | holds (kept for memory) | - |

## Storage and memory

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-10-08 | bundle blocks decoded in the pool rather than on the reading thread | 0.5-1.2 % of the thread, node, loading | stale: browser reads differ now | `fetch` drops in a browser run |
| 2026-10-24 | a smaller start in WebKit through region and module sizes and JSC's tiers | no lever past a 500 MB peak spread | disputed: single runs, not the phone | the iPhone's jetsam report |
| 2026-10-25 | the translation worker nudged into collecting sooner | 944-1055 vs 941-1028 MB, 3 runs | holds | on the phone |
| 2026-10-25 | a DXT level's blocks let go in the graphics worker once uploaded | peak 2772-2787 vs 2324-2431 MB, 2 pairs | disputed: only 10 of 47 MB | the whole load, on the phone |
| 2026-10-25 | a smaller translation arena, and no relinks, for the page's memory | level mean -40 MB; highest in 300 MB spread | holds | on the phone |
| 2026-10-25 | a context that keeps no texels reads pixels without converting them | mean 1918-1979 vs 1897-1994 MB, 3 pairs | disputed: effect under the spread | heap high-water, 5 pairs |
| 2026-10-26 | a guest page written out and zeroed gives the tab no memory back on an iPhone | ended at 1728 vs 1664-1856 MB | holds | wasm can give pages back |
| 2026-10-31 | the hottest regions gathered into one module (`gatherAfter`) | WebKit 3090 vs 1110 MB, 1 run | stale: modules let go since | WebKit and phone, 3 runs |
| 2026-11-11 | a shared translation store does not speed up .NET 4 setup's ngen | ngen at 155 vs 114 s, 1 run | stale: superseded on 2026-11-12 | - |
| 2026-11-12 | the shared translation store, measured again, pays from ngen's second assembly | System.Drawing 16.4-17.9 vs 20.9-21.6 s | holds (positive) | - |
| 2026-11-12 | formed regions kept for the processes sharing a store (`sharedFormed`) | 32 768: 817.5 vs 691-731 s | holds (8 192 kept) | - |
| 2026-11-12 | a store-known target a candidate at its first exit (`storedThreshold`) | 729.9 vs 708-747 s, 1 run | disputed: one run inside the noise | later starts wait on 64 exits |
| 2026-11-12 | more room for shared compiled modules (`sharedModuleBytes` 1 GiB) | 671.1 vs 655-691 s, 1 run | holds | let-go modules are asked for |
| 2026-11-12 | the shared formed regions (`sharedFormed` 8192) cost ngen's short processes | median 618.7 vs 655.1 s, 5 runs | holds (kept) | a region kept in fewer objects |
| 2026-11-14 | one machine memory with page tables (a software MMU) | paged +36.5 % x64, +47.1 % arm64 | holds | wasm gains mapping primitives |

## Win32 and core

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-10-09 | the startup stub on a read-only page, for an IsBadWritePtr probe | error 8007 unchanged | holds | - |
| 2026-10-31 | the cpu layer's guest sampler switched off (`sampling: false`) | not recorded | disputed: no figures recorded | - |
| 2026-11-14 | a .NET game's own assembly compiled to a native image (ngen) | clrjit 21.0 vs 17.2 % of block executions | holds | assemblies as files |

## Tooling and other

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-10-16 | invalidated: the host calls of `tools/executor-sweep.mjs` | - | invalidated: GetTickCount never left the executor | - |
| 2026-10-29 | invalidated: arm64 executed counts of `tools/cork-asm.mjs` read before ab02ac9 | - | invalidated: x27 block marks misread | - |
| 2026-10-31 | a CM Multi inflated in GameHub's worker without a Blob | 44.7 s vs 2.0-10.0 s idle | holds | where GameHub's work runs |
