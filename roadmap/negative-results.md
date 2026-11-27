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
| 2026-10-11 | patched code sites formed apart; store-dropped regions formed again with copies | 39.0 / 39.2 vs 38.6 s, synthetic mixer | stale: compiling moved to workers | a patched loop runs interpreted again |
| 2026-10-12 | callees formed two and three levels deep (`formDepth`) | geomean 1.00x, cork-bench Chromium, noise 13 % | holds | callees stop being copied per caller |
| 2026-10-13 | larger regions for an interpreter: caps doubled, or room for return blocks | Lua -11 %, rest of the bench +8.9 % | holds | regions grow without recompiling |
| 2026-10-14 | x87 single precision on floats: other encodings of the range test | best 0.995-1.03x; no test 0.60x | holds | on arm64 |
| 2026-10-15 | the shared layout's bases as other kinds of global | mutable 1.166 vs immutable 1.054-1.070, node | stale: main threads now run shared layout | Chrome x64 and M4, paired |
| 2026-10-16 | a translation store without relinked modules | warm worker 56-58 vs 20-23 s, Far Cry, 1 run each | holds | relinks go away |
| 2026-10-17 | a region stopping at every block another region has an entry for (`regionStops`) | xz 179.3 vs 103.0 M transfers; store 246 vs 345 MB | holds | a stop kept out of hot code |
| 2026-10-22 | the interrupt word looked at every 64th back edge | sort 1.387 vs 1.099, Chromium paired | holds | V8 hoists the load |
| 2026-10-22 | a block's budget charge carried into the one block it enters | charges 2.5 % of arm64 instructions | invalidated: counted by cork-asm on arm64 before its fix (x27 block marks misread, ab02ac9) | the fixed cork-asm |
| 2026-10-23 | a call's register reloads left out where the value lives on in a local | +0.3 % instructions, arm64 model | holds (x64 timing agrees) | wasm keeps registers across calls |
| 2026-10-23 | the callee's flag record taken back only where code after the call reads a flag | -0.2 %, arm64 model | holds (x64 exact count agrees) | - |
| 2026-10-23 | callees formed into their callers one level deeper (`formDepth` 2) | Crysis warm 8.15-8.64 vs 8.37-8.50 fps; cold -13 % | holds | as `formDepth` above |
| 2026-10-26 | the 32-bit translator's store into code, its slow path cut or moved out | 0.95-1.05 every workload, Chromium | holds | `noteCodeStore` shows in a profile |
| 2026-10-27 | callee-saved registers kept across a guest call | 0.989-1.025, node paired | holds | on arm64 |
| 2026-10-27 | a byte copy loop done at once | 5.138 vs 5.140 M instructions, sort | holds | long gcc-style copies |
| 2026-10-28 | the flag record not read back after a call where the code after writes the flags first | -0.006 %, x64 exact count | holds | - |
| 2026-10-28 | a scalar SSE load that owes its vector on an x64 host | fmath -1.7 %, game +1.4 % | holds | - |
| 2026-10-28 | long mode's field reads off one wrapped sum, grouped by register name | vm +0.8 %, fmath -4.7 % | holds (by value taken) | - |
| 2026-10-29 | a plain self-loop run two turns a wasm turn | crc -0.09 % | holds | - |
| 2026-10-29 | long mode's window test of a single access folded into its page-flag test | +0.01 % (left in) | holds | - |
| 2026-10-29 | the flag record not taken back after a guest call, measured again on arm64 | -0.04 %, arm64 model | invalidated: counted by cork-asm on arm64 before its fix (x27 block marks misread, ab02ac9) | the fixed cork-asm |
| 2026-10-29 | a guest call's depth and budget tests as one condition | +0.07 %, arm64 model | invalidated: counted by cork-asm on arm64 before its fix (x27 block marks misread, ab02ac9) | the fixed cork-asm |
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
| 2026-11-05 | wasm compiled straight to TurboFan against 3DMark2001 SE's drops | 52-65 vs 112 fps | holds | - |
| 2026-11-14 | the transfer taken out of every region (kept from inlining) | 0 of 519 call sites inlined under real tiering, calls512, Node 26 | holds: the premise was cork-asm's compile without call counts | V8 inlines cold calls |
| 2026-11-14 | regions of a module as one: `dispatch` alone on V8, its merges (`mergeAfter`) with a worker | Chromium 153 cork-bench x10 MIPS on/off 0.995 x87, 0.999 sse, median of 5, 2 runs; first, 2026-10-12: geomean 0.99x, noise 5.3 % | holds; the iOS path runs it | V8 inlines a `return_call` into a placed function; on/off under the iOS settings |
| 2026-11-14 | `dispatch` keeping linked calls (it turns each into a transfer) | Chromium 153 cork-bench x10 MIPS 1.006 x87, 0.994 sse; micro 1.012 x86, 0.931 x64 inside ±15-25 % noise | holds | as above |
| 2026-11-14 | every register in wasm parameters (calls bench), x64 run again | first, 2026-10-13: params / state-direct 1.085 node, 0.959 Chromium; farcry params / state-direct 0.826 Node 22.23.4, 0.889 Chromium 153; TurboFan, depth 8, 9 runs | holds on x64, not built; arm64 not measured | the M4 |
| 2026-11-14 | a region takes three registers in parameters on an x86-64 host, where V8 passes five (2a464ac) | machine instructions -1 to -6 %; PE vm x87 1.060 ms in Node, 8 of 9 pairs slower; Chromium geomean 0.995 | holds | vm's loss explained; paired Chromium runs |
| 2026-11-14 | a `ret` answers its wasm call the address it took and the call compares it; no stack of return addresses | calls512-scatter machine instructions 32-bit -5.3 %, 64-bit +7.6 %; formed callees' returns 100 of 100 through the transfer | holds | a frame's count of formed calls; long mode's window test folded |
| 2026-11-15 | regions of 256 blocks against the default 128, long mode and 32-bit | 256/128 geomean x64 0.99 (vm 1.08), sse 1.06 (vm 1.50); earlier, 2026-10-26, long mode: 128 Stockfish -10 %, 512 Stockfish +7 %, 7-Zip -2.6 %; later, 2026-11-17, exact (node 26): spread-x87 0.951, calls8-order at 64 bits 0.859, vm-x87 1.025, containers-x87 1.079 (5 regions into 3, 15 into 12: V8's larger functions), lua at 64 bits 1.47 at warm 100 (1.009 at warm 400) | holds: 128 kept | a game's region profile, not the bench's; with a callee formed in once a call site, or a cap by what a loop needs |
| 2026-11-15 | a callee formed in at one call of its region, its other calls wasm calls: its `ret` no edge from one loop into another, so both stay loops | instructions an iteration (exact) str 2.93 -> 3.22 M, tree 3.28 -> 8.50 M, lua 37.8 -> 38.4 M, game and vcall equal; str's jumps out 462 k -> 0 | holds | the callee's blocks formed once a call site (copies of blocks by place, not address) |
| 2026-11-15 | an xmm register a region uses as a scalar alone (92 % of a game's hot SSE uses by the operand forms, 14 % once `rsqrtss`, packed copies and bitwise masks refuse it) kept as a scalar through the whole region, its other lanes in a vector local, or in the state block under a zeroed mask; and a scalar load writing the vector on arm64 too | machine instructions an executed guest instruction over Crysis's 30 hottest regions: x64 2.735 -> 2.755 (vector) / 2.800 (mask); arm64 2.476 -> 2.486 / 2.526; loads not owed on arm64 2.514 | holds | the lanes' traffic (8.7 % arm64, 6.8 % x64) cut without a second value live across the region: V8 spilled it, and a guest call made it whole each time |
| 2026-11-15 | a float compare's carry kept in the flags word beside its lazy record (`Kind.FCMP`), so an `inc` after it needs no test | entities x87 7.75 -> 7.56 machine instructions a guest one (the record alone: 7.26), Crysis 30 regions 2.696 -> 2.700 | holds: the record alone was taken (048848df) | never: the carry costs some ten instructions a compare |
| 2026-11-15 | the region's own entry (label 0, which every call takes) tested before its entry `br_table`: a test and a branch for the table's bounds check and jump through memory | exact machine instructions a guest one: entities SSE 6.862 -> 6.908, spread x87 4.289 -> 4.559 | holds; disputed 2026-11-16: its entities and spread figures were taken as the difference of two runs on the machine's clock, before `tools/translator/pe-count.mjs`, inside that stand's spread | the entry dispatch is redone (V8 lays the entry block as a join and moves more) |
| 2026-11-16 | the flag record left in the state block in every function, a store of it tested by its kind where a way may not have written it | pe-count, x64: spread 4.1934 -> 4.2411, entities 4.2458 -> 4.2770 (V8 made up and moved each field at every join: +10 moves an entry); run-count calls512 0.960 | holds | a store's ways are known to have written the record without a test |
| 2026-11-16 | a way out's stores of the record narrowed to the fields its block wrote | run-count warm 400, x64: crc 0.970, game 0.965, sort 0.987, vcall 1.031; arm64 (mac model): those three 1.000, vcall 1.013, lua 1.004 | holds | the ways out no longer share sets of stores |
| 2026-11-17 | the flag record left in the state block in more functions, by a flow over blocks of where its locals hold it (written on every way in by the blocks before, not only by the block's own code) | emit-digest corpus: 963 of 2538 functions with path stores in that mode, from 423. pe-count x87, 2800-2900 M (qemu, node 26.13.1, x64): with the record loaded in the prologue for an entry other than the region's own, spread 4.1284 -> 4.1454 (+0.41 %), entities 5.3045 -> 5.3051; with the blocks that rely on the flow no entries of the region instead, spread 4.3507 (+5.4 %, 566 regions for 453), entities 5.3205 (+0.3 %) | refuted: the load for another entry joins a way that has the fields with one that has not and V8 moves each at every entry; without it the blocks become regions of their own | the record no longer travels by the state block at a call (a protocol where the caller owes it) |
| 2026-11-17 | an indirect call's callees compared in the order of their samples, or the most sampled first past some margin | of two callees called 2:1 the rarer was five deviations above the other in one slicing of the run and below in another (vcall, slices of 100 000 and 37 003 instructions); a chain in address order from the lowest: calls8 +2.9 to +4.4 %, entities 4.594 for 4.242 | refuted: the samples are the last calls of a slice; landed as a search by address (1b0570c7) | - |
| 2026-11-16 | path-sensitive stores (`pathStores`, and with them the record left in the state block) at 64 bits as at 32 | run-count warm 400, 64-bit geomean 0.9998 (vm 1.012, crc 1.008, game 0.986, sort 0.985); pe-count x64: vm 0.956, spread 0.984, path 0.988, entities 1.021; emit-count on node 26: 520.9 -> 572.7 M a pass over both widths (+9.9 %, all of it in the 64-bit regions' emitting), wasm bytes +2.7 %; on node 22 (V8 12.4) the emitting ran 1.84x | not taken: translating a fifth dearer for executed code that did not move; the patch with its two fixes (a `rep` loop's ways out count the turns' writes; a long-mode `ret` branches past the ways out's blocks) is kept outside the tree | when a step of the call's protocol that needs a path's stores shows its gain at 32 bits, or `planPaths` and `fillDeferred` cost less |
| 2026-11-16 | a direct wasm call in place of the table's for a direct guest call whose callee is in the same module (the ceiling: no guard on the callee's liveness, label 0, every callee of a gathered module taken) | pe-count spread-sse 1200-1300 M: 4.3556 -> 4.3473 machine instructions a guest one (-0.2 %), 375 call sites made direct in the gathered modules (132, 269, 128 and 56 regions) | holds; not built: the relocation of bodies in the emit cache and a module's range in the table would buy under a per cent | when the calls a program makes apart are mostly direct ones inside one module (a block profile says: `CALL_LINKED` by site) |
| 2026-11-19 | long mode's store without the test of its address's high half (the quadword sum shifted by 32 and joined to the page flags): the ceiling of any cheaper form of it | run-count --bits 64, warm 400, f0f8d80a, node 26.13.1 x64 under qemu 8.2.2, with the test left out against with it: vm 0.979, game 0.980, tree 0.987, crc 0.991, vcall 0.994, str 0.995, sort 0.995, switch 0.997, fmath 0.997 | not built: two per cent at most with the fault itself gone, and a form that keeps it (a register known to hold a dword, a group tested once a base) reaches a part of that | a program whose stores go through registers 32-bit instructions wrote |
| 2026-11-19 | long mode's dword register as a record operand taken whole (the quadword local itself, its high half nobody's) in place of its low half zero-extended, which the host makes with a move | f0f8d80a, same stand: run-count --bits 64 vm 1.021, str 0.995, tree 0.996, game 1.004, sort 1.002, crc, switch, vcall, calls8 1.000; pe-count x64 1200-1300 M: lz 2.9522 -> 2.9522, path 2.9525 -> 2.9525, vm =, containers 2.8157 -> 2.8174, math 2.6238 -> 2.6269 | refuted: the PE counts did not move by an instruction where the moves were seen (lz), so the moves it was to remove are not these | - |
| 2026-11-19 | the budget kept in the state block, charged by a load, a subtract and a store, to free the register it holds in a loop that uses fifteen guest registers | cork-asm --bits 64 --atomic on 7-Zip 23.01 x64's fourteen hottest regions (`7za b -mmt1 -md20`, node 26.13.1 x64): with no charge at all 3.165 -> 2.958 machine instructions an executed guest one (frame traffic 0.699 -> 0.637, register moves 0.497 -> 0.419; x86 build 2.402 -> 2.275) - the ceiling; V8 14.6 makes the charge on memory three instructions (`movl r,[m]; subl r,n; movl [m],r`, hand-written wasm, --print-wasm-code), no `subl [m],n` | not built: two instructions more a block (about 0.2 a guest instruction) for 0.14 of frame traffic and moves | the engine selects a subtract on memory, or a host with more registers |

The two 2026-11-14 lines on regions of a module as one, conditions: cork 3f877946, a cloud machine (Intel Xeon @ 2.10GHz, 4 cores,
power plan not recorded), Chromium 153.0.8010.12 / V8 15.3.76.4 headless (`browser/suite.mjs --scale 10
--reps 5`, both arms in one run, 5 reps an arm, a first run's sse spread +18 % not repeated in the
second, 1.00); Node 22.23.4 `run.mjs` x10 with a worker, ms on/off 0.987 x87, 0.998 sse, spread 10-20 %;
merges fired 0-1 a run, module bytes -1 to -12 % only from the linked calls `dispatch` drops.

The 2026-11-15 lines on the float compare's carry and the entry test, conditions: cork fc755e19 with the change of
048848df, node 26.13.1 (V8 14.6) on an x86-64 host. The carry: `tools/translator/cork-asm.mjs` weighted by the PE
benchmark's entities block profile (x87 build, 2000 iterations) and by the Crysis CPU benchmark's 30 hottest regions.
The entry test: every machine instruction of the process counted under QEMU 8.2.2 between 100 and 200 iterations of
entities (SSE build) and between 1000 and 1100 of spread (x87 build), one run an arm (a count repeats to the
instruction); V8's optimising compiles apart.

The 2026-11-15 line on region size, conditions: cork ec2c1353 + e2167a7e, the 4-core cloud VM with nothing else running,
Node 22.22.0 `bench/run.mjs --iterations <10 x own> --reps 1 --cork '{"maxRegionBlocks":N}'`, 5 alternated pairs, both
widths' builds of the same source (x64, sse), median ms of the 5: x64 vm 1815 / 1967, entities 3768 / 3603, spread 5271 / 5044;
sse vm 1068 / 1605, path 777 / 890, spread 4696 / 4518; at own iterations (cold) 256 looked 4-16 % faster on x64.

The 2026-11-15 line on a callee formed in once, conditions: cork a2791c91, the micro images' iterations under qemu-x86_64
8.2.2 with emit-count's plugin, Node 22.22.0 --single-threaded --predictable, a clock of 1 us a reading, 60-100 warm-up
iterations awaiting their translations, 20-50 counted; two runs of one tree equal to the instruction. A wasm call each
inner turn costs more than the jump out to the region's copies and back (`rejoinAt`) each outer turn it replaced.

The 2026-11-15 line on scalars kept through a region, conditions: cork 686f31dd, Crysis SP demo's Benchmark_CPU in the node
stand (1 executor, block profile from 450 s, 281 G guest instructions), `tools/translator/cork-asm.mjs --blocks --classes
--atomic` on the 30 regions that ran most (173 G, 62 %), V8 14.6: node 26.13.1 x64, and its arm64 build under qemu-aarch64
8.2.2 with `--no-wasm-bounds-checks` (macOS's model). A static weighing by the profile: one tool version, arms compared,
not absolutes; no exact run was taken, the static weighing already said no.

The 2026-11-16 lines, conditions: cork 657107ac with the change, node 26.13.1 (V8 14.6), every machine instruction
counted under QEMU 8.2.2: `tools/translator/pe-count.mjs` (entities SSE between 2800 and 2900 million guest
instructions, spread x87 between 1200 and 1300 million, one run an arm, a tree twice the same to the fourth
decimal), `tools/translator/run-count.mjs --warm 400` (32-bit), and the same count on node's arm64 build under
qemu-aarch64 8.2.2 with `--no-wasm-bounds-checks` (macOS's model). What was kept of the change: the record left
in the block only in a function no store of whose record may follow a way that did not write it, and the stores
narrowed at a call and at a `ret` only (spread 4.1934 -> 4.1451, entities 4.2458 -> 4.2444, calls512 0.96, lua 0.977,
vcall 0.9995).

## Executors and scheduler

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-10-07 | several translation workers for one process, on four cores | Doom 3 load 18 vs 16 s, 3 runs | stale: pool reworked, no many-core run | the M4, 1 / 2 / 3 translators |
| 2026-10-08 | an executor waiting in place for its next slice, not through its event loop | 1.23 vs 1.23 s, sweep | holds | - |
| 2026-10-08 | more threads than other executors, or one other executor | E=2 x0.64-0.86 | stale: scheduler rewritten since | sweep T 1-4 x E 1-4 |
| 2026-10-15 | the process's executor looking for the others' words between its regions | 7-Zip 596 vs 1111 MIPS | holds (`spentTest` instead) | - |
| 2026-10-22 | an executor's look for its next slice counted among the cores taken | 6.130 vs 5.890 ms a frame, 4 runs | holds | a many-core host |
| 2026-10-31 | threads placed by trial and on reckoned gains, and the trade of a pinned processor | CoD4 trade 86.7 vs 77.4 ms a frame | holds | - |
| 2026-10-31 | a job thread's executor chosen by where the other threads will run | 8.66-8.78 vs 8.72-8.87 ms, 2 runs | holds | Deus Ex HR's job threads |
| 2026-11-14 | a thread elsewhere called back at once only for a hand-off it can end | recalls 1 501 vs 1 182 | holds | - |

## Graphics

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-10-09 | not waiting for a render-target copy that stays on the GPU | 10.81 vs 10.87 ms a frame, RC menu, 1 run | holds | GPU-only copies show waits |
| 2026-10-09 | client arrays read once a glLockArraysEXT rather than once a draw | 6.78 vs 6.64 ms a frame; bytes -35 % | holds | copies show in a profile |
| 2026-10-10 | reading a fence target back ahead, as each frame is presented | +3 ms a frame, RC level, 3 samples | holds | the device runs in step |
| 2026-10-11 | a draw's reads of a dynamic buffer lent to the graphics worker, not compared | 0.32 vs 0.31 s overhead per guest s, CoD4 | stale: written pages tracked since | CoD4 Bog, 2 runs |
| 2026-10-16 | a host call's device steps run as the device's methods in the host | 48 vs 18-24 us a CommitChanges | holds | - |
| 2026-10-16 | an effect's constants handed to the setter where the parameter lies | `Walk` 2 % of the worker | holds | - |
| 2026-10-21 | the process's executor makes a Direct3D ring ahead while it has nothing to run | 64-66 vs 60-70 ms a frame, CoD4 | holds | the ring taken without the lock |
| 2026-10-31 | a Direct3D 10 dynamic buffer given 32 MiB of storages instead of 4 MiB | 3.59 / 6.18 vs 4.10 / 4.97 fps, 1 run | disputed: one run, the two figures moving opposite ways | measured again, 5 runs an arm; the 32-storage count cap raised |
| 2026-11-23 | a draw's constants picked by `instance_index` from one storage binding a pass, not a dynamic offset a draw | 3000 draws: 10.1-10.2 vs 9.4-9.6 ms GPU a frame (6000: 18.7-19.1 vs 18.5-18.9), synthetic pass, 40 frames each, Parallels D3D12 adapter; neither 20-48 passes nor 3 MB of constants a frame moved it | holds: ~2.5 us a draw is the adapter's floor | a real GPU shows a per-draw bind cost |

## Storage and memory

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-10-25 | the translation worker nudged into collecting sooner | 944-1055 vs 941-1028 MB, 3 runs | holds | on the phone |
| 2026-10-26 | a guest page written out and zeroed gives the tab no memory back on an iPhone | ended at 1728 vs 1664-1856 MB | holds | wasm can give pages back |
| 2026-10-31 | the hottest regions gathered into one module (`gatherAfter`) | WebKit 3090 vs 1110 MB, 1 run | stale: modules let go since | WebKit and phone, 3 runs |
| 2026-11-12 | formed regions kept for the processes sharing a store (`sharedFormed`) | 32 768: 817.5 vs 691-731 s | holds (8 192 kept) | - |
| 2026-11-12 | more room for shared compiled modules (`sharedModuleBytes` 1 GiB) | 671.1 vs 655-691 s, 1 run | holds | let-go modules are asked for |
| 2026-11-14 | one machine memory with page tables (a software MMU) | paged +36.5 % x64, +47.1 % arm64 | holds | wasm gains mapping primitives |

## Win32 and core

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-11-14 | a .NET game's own assembly compiled to a native image (ngen) | clrjit 21.0 vs 17.2 % of block executions | holds | assemblies as files |

## Tooling and other

| Date | Idea | Result | Status | Revisit when |
| --- | --- | --- | --- | --- |
| 2026-10-31 | a CM Multi inflated in GameHub's worker without a Blob | 44.7 s vs 2.0-10.0 s idle | holds | where GameHub's work runs |
| 2026-11-18 | a protocol for the flag record across a wasm call (the caller told by the callee's entry that it kills the flags, the callee told at its `ret` that the caller reads none): what is left to save after the record stays in the state block until read (72b01a7c) | the ceiling, with every store of the record at a guest call and at a `ret` back to one left out (wrong where flags cross a call; the workloads' guest counts are the same): pe-count, node 26, f9baab5a, spread-x87 between 4500 and 4600 million guest instructions 4.1082 -> 3.9741 machine instructions a guest one (0.9675) with the call's stores out, 1.0000 with the `ret`'s out (it stores none already); entities-sse 2800-2900: 0.9966 and 1.0000. A check a call would take most of the 3 % back | holds | a workload whose callees write the flags before most of their calls |
| 2026-11-18 | every 64-bit process over a wide window of 8 GiB (cork's `wideLayout`, the RAM a `memory64` memory of its own) in place of the 4 GiB layout | exact, run-count --bits 64 (100 warm, 20 counted), node 26.13.1 x64 under qemu 8.2.2, cork 1db57930, one tree, `--window 8` against none: machine instructions an iteration 1.92x as many (geomean of 17 workloads, 1.27 load to 2.75 vm; vcall 2.68, crc 2.01, lua 1.71), patch 26.2x (no wasm interpreter tier over a wide window). arm64 not measured | holds | once the wide window's code is near the 4 GiB layout's (a split of what memory64's own bounds checks cost from what the wide path tests per access first), and the interpreter tier runs over it |
| 2026-11-18 | every 64-bit process over a wide window of 8 GiB, measured again once an access took its whole address, reads went untested and the stack loose, and the call profile's count ran on | exact, run-count --bits 64 (100 warm, 20 counted), node 26.13.1 x64 under qemu 8.2.2, one tree, `--window 8` against none: machine instructions an iteration 1.29x as many (geomean of 17 workloads without patch; calls 1.07-1.16, lua 1.13, switch 1.22, sort 1.29, vcall 1.29, load 1.33, str 1.34, crc 1.37, tree 1.37, vm 1.47, game 1.51, fmath 1.78), patch 26x (no wasm interpreter tier over a wide window). What is left is the engine's: each memory64 access compared against 16 GiB (a constant, a compare, a branch, with the trap handler too) and the second memory's base loaded at each access - a hand-written loop of two accesses in six instructions 1.20x; ours: the wrap of an untested read into the window (two instructions), a page's index (two more than 4 GiB's). arm64 with `--no-wasm-bounds-checks`: vm 1.07, crc 1.09, sort 1.16 (that flag drops the engine's compare, which a Mac keeps: its real ratio lies between) | holds | an interpreter tier over the wide window (interp-wasm.c with quadword addresses, the RAM reached through imports); the RAM as the module's first memory (its base then cached, the state's loaded instead: not tried, a call's two dozen state accesses pay it); fmath's 1.78 not looked at |
| 2026-11-18 | a window past 4 GiB as two `memory32` halves chosen by the address's bit 32, in place of one `memory64` | hand model of a region's loop (3 accesses a round, 100 M rounds, node 26 x64, best of 7): memory32 75.5-78.6 ms, memory64 79.6-81.2, two halves 195.5-203.1 - the branch at each access keeps V8 from unrolling the loop and hoisting its bases; arm64 not measured | not built | when V8 folds a select between two memories into an access |
| 2026-11-19 | a wide window (`memory64`) that grows as the program is given memory, in place of one made whole | node 26.13.1 x64 (V8 14.6) on the project's VM: a shared `memory64` memory of 8 GiB made whole, untouched: process RSS 40 MB before, 40 MB after; 64 MiB of it written: 104 MB. Growing itself works (a shared memory64 with a maximum of 8 or 16 GiB grown from 256 MiB to 1.25 GiB in node 26 and Chromium 153); arm64, Safari (no memory64) not measured | not built: V8 keeps an untouched page out of the process, so a grown window holds no less, and it would put a bound on every read, which goes untested there now | when an engine counts a memory64 memory by its length (as JavaScriptCore counts a memory32 one), or the machine's budget must count a window by what it was given |
| 2026-11-19 | a wide window's process: pages it asks for as executable (a JIT's) placed in its image's 4 GiB block, so the one code block holds them | `jit64.exe` at 0x140000000 with no relocations against the same file placed low, exact machine instructions of the whole run (qemu, node 26, start-up ~0.5 G in each): the copied loop 9962 M against 565 M, but `strlen` 100 000 times 13 259 M against 656 M and `HeapAlloc` + `HeapFree` 100 000 times 6555 M against 674 M - the system libraries' own code lies below 4 GiB by rule and is 85-98 % interpreted whatever is done with a JIT's pages | not built | never as stated: the measurement asks for code in two blocks in the translator (`roadmap/x64.md`), which serves both; and for blocks handed out past 4 GiB the handlers must take whole addresses first (`tools/checks/wide-addresses-high.json`) |
| 2026-11-20 | calls4096's time over a wide window (2.5x on an x86 Mac) laid to the engine's tiering, inlining, bounds checks, collections or the modules' size | headless Chrome 157 on the project's VM, calls4096-scatter-x64, 8 GiB against 4 GiB by time, 5 rounds a run: 1.10-1.46 over five runs (A's noise 2-19 %); `--no-liftoff` 1.07, `--liftoff-only` 1.24, `--no-wasm-inlining` 1.33, `--no-wasm-bounds-checks` 1.22, `--wasm-tiering-budget=10000` 1.38; node 24: 1.06, one mark-compact a run in each; 256 regions a module (`batchRegions`): 0.88-1.07 of 32's in both layouts, two runs each | holds: none moves it; cachegrind with a Mac's caches gives the window 1.20x the code misses (`roadmap/x64.md`) | on the Mac, with page walks counted |
