# Cork — the integration plan

**Status:** in progress since 2026-09-20. Landed: 1.0 (the package and the executor contract), 1.1 (`engine` configuration, the hybrid host with no translator), 1.3 (the machine snapshot and its compare; the emulator host's SSE/x87 record accessors), 1.5 (the wasm encoder and the feature probe), 1.2 (the corpus: 15 608 cases published by the fork's CI since build-1460531, all run on the emulator through the harness in under two seconds; 24 diverge from the hardware recording as the pinned emulator is known to -- the sign of the NaN a square root of a negative leaves, and `fild m64` past 53 bits -- and are listed as such in the itest), 1.4 (the differential driver, proved by replaying every corpus case on the emulator against itself: 2.3 million instructions, zero divergences, a tampered word reported alone). Milestone 1 is complete. 2.1 (the opcode tables and the decoder: a linear decode of every corpus image reaches its halt, 2.19 million instructions over 376 operations, 862 invalid encodings named at the address the hardware raised #UD, zero refusals; the corpus taught the table nine undocumented x87 aliases, arpl, popcnt and the register-form prefetch no-ops), 2.2 (the pure evaluator of the integer instructions with the eager flag algebra, and the region former: blocks along fall-through and direct branches, splits at jump targets, caps, refusals and the exit kinds), 2.3 (the region emitter: one wasm function per region with a block dispatcher, registers in locals, lazy flags with a per-block dead-flag pass and a materialising helper proven against the model on 27 000 random records, the integer set; every instruction test agrees with the model, and the 26 corpus cases the emitter translates in full leave the state the hardware left -- the rest wait on MMX/SSE moves and the rarer forms), 2.5 (SSE and MMX: xmm registers as v128 locals and mm registers as i64 locals loaded in the prologue and stored in the epilogue, the moves, packed and scalar float arithmetic, min/max by compare and bitselect, the cmpps predicates, comiss into the flag word, shuffles and unpacks, the conversions with the indefinite integer, the SSE2 integer set with saturation, the masked stores, MMX resetting the x87 stack; a probe finds whether the host's default NaN carries the sign x86's does and, where it does not, invalid float operations are fixed up to the processor's 0xffc00000 -- the development VM is arm64 and needs it; with the moves in, 11 225 corpus cases translate in full and every one leaves the state the hardware left, the 4 383 left out being x87 (6 690 generated cases start with finit) and the integer forms still to come: shifts by cl and by one at byte and word width, shld/shrd, rcl/rcr, byte and word mul/div, popcnt; three defects the corpus found on the way were the segment-register operand deciding the instruction's size, the carry a pending add left being folded after inc had overwritten its operand, and pusha reusing the push helper's scratch for the esp it pushes), 2.3b (the integer forms the corpus still left out: rotates at every width, rcl/rcr as a rotation one bit wider in i64, shld/shrd with the pair as one value for the word form's counts past the width, byte and word mul/imul/div/idiv, popcnt; with them the 42 long random arithmetic programs of the corpus are judged for the first time and found three lazy-flag defects no single-instruction case could: a shift by cl clobbering a pending record's operand and leaving the record's kind unknown, the dead-flag pass counting a shift by zero or by cl as killing flags it may not write, and inc/dec with dead flags overwriting the operand of a record a later reader folds; each fixed with a test, and 11 807 corpus cases now translate in full with zero divergences, the 3 801 left out being x87 and the SSE3/rare forms), 2.4 (the page-flag table at `layout.tables`, pages beyond RAM inaccessible from the start; every load and store, the stack's and the string instructions' included, tests the flags of its first and last byte and leaves with a precise #GP before the instruction -- a push checks before esp moves, pusha/popa check their whole span, a rep faults with its progress in the registers; a store into a page holding translated code leaves `stale` right after the instruction with the address recorded, or folds into a call's own exit; int3/int n leave as traps with EIP past the instruction; the undo ring for differential builds, `prepareModule(..., { undoLog })`, with its reader and the span folding -- its wiring into the differential driver waits for 2.6, when the translator is an executor there; a counting defect found on the way: a conditional exit reset the block's owed count for the path that fell through), 2.6 (the runtime: candidates from the sampler's buckets at the exact address their last slice ended on, regions formed and emitted into one module per batch, instantiated asynchronously between frames, every block start an entry; a region stamped with its pages' generation at formation and dropped at publication if a page moved; `stale` drops the page's regions and clears the flag, a page dropped too often is volatile; the hybrid host's slice loop runs the translator while it has an entry and gives the emulator one turn with the rest; the emulator host reads its own layout off its typed views and the translator's tables take the top 2 MiB of RAM, which the layer reports as not the guest's; the frame feed and the `cork` diagnostics; proven on the real emulator: a hot loop found by the sampler, translated between frames, three of four slices in the translator, the registers and the instruction count identical to the emulator-only run. Deferred from this step: the `differential` engine, which needs the translator's undo log read by a host that can replay the emulator for the same count -- built as its own step once the seam here has run a title; and the emulator's own code pages are not protected from translated stores, named in `docs/core/cpu.md` for the fork change of 2.7), 3.1 (x87: the stack tracker gives every block its top and the permutation `fxch` left, an exchange costs no code, an edge or an exit whose expectation differs moves the locals, a block met with two tops is cut and leaves for the other executor; eight f64 locals loaded for the held registers at entry (the emulator's tagged doubles directly, a true 80-bit register converted inline) and the dirty ones stored at exit with the top, the empty mask and the status word; loads, stores, exchanges, the arithmetic in every form, the compares into the condition bits or the flags, fcmov, fxam, fnstsw, fninit, the constants, the integer forms with the indefinite, the 80-bit memory forms through two helper functions; the stack faults (an empty source, a push onto a held register) raise IE and SF and produce the indefinite as the processor does, a signalling NaN read from memory raises IE and goes on quiet, a zero-divide ZE, an invalid result IE, an underflowing single store UE; entries keyed by address and top, the runtime queueing a top it misses at a specialised address; 14 529 corpus cases translate in full with zero divergences and one named `x87.precision` case, a product past the double's range stored as a tword; left to 3.2 and 3.3: `fldcw`, the transcendentals, `fprem`, `fscale`, `frndint`, `fxtract`, the environment forms), 3.2 (the control word at run time: `fldcw` loads it, a rounding helper rounds `fist*` and `frndint` by RC, precision control at single rounds every arithmetic result's mantissa to 24 bits in the double's own bits so the exponent range stays extended -- a demote overflowed where the processor did not, which the corpus's single-precision case showed; `fscale` through the clamped two-step power, `fxtract` from the double's fields with the zero-divide of zero, `fprem`/`fprem1` with the quotient's bits in C0 C3 C1 and C2 for a partial reduction, `ficom`/`ficomp`; the truncation idiom of the era stays in one region; 14 571 corpus cases, zero divergences, two named `x87.precision` cases (a product and a scaling past the double's range stored as twords); exception masks are not honoured, documented), 3.3 (the transcendentals through the host's `Math` imported by every module -- `fsin`, `fcos`, `fsincos`, `fptan` with the push of one and C2 past the reduction range, `fpatan`, `f2xm1` as `expm1(x ln 2)`, `fyl2x` and `fyl2xp1` with the zero-divide and the invalid argument; precision control found to apply only to the arithmetic and the square root, as the processor has it, by the corpus's single-precision `fprem` case; 14 578 corpus cases, zero divergences, the two named precision cases), 2.7 (the handoff: the fork's `bottlify_handoff_page` bit per page, at which `run_slice` returns once it has retired something; the runtime flags the pages of every published region and clears them when none is left; the hybrid loop goes round -- translator, emulator, translator -- within one slice while the budget lasts, a fault or a trap always handed to the emulator; `handoffMisses` counts the slices an emulator without the export ended inside a page the translator holds (`Runtime.holdsPage`); the prebuilt re-pinned to build-7ef282d; on the itest program started at an untranslated address the translated share is above 0.95 with zero misses, and the count identical to the run without the export), 3.4 (the thread contexts under hybrid: `context-hybrid.itest.js` runs the x87-across-MMX and the pending-flags programs with their code translated and finds the same x87 block and flag word the emulator's own run leaves, because every exit writes them back; the environment forms already end a region), 4.4 in its first part (a host write -- `writePhysical`, `writeData`, `fillData` -- invalidates the translator's regions on every page it touches; a translated store into a page the emulator compiled is seen through the fork's `bottlify_page_has_code_ptr` table beside the translator's own flags, leaves `stale` with the width, and dirties the emulator's cache through `jit_dirty_cache`; the volatile-page rule and the self-writing program's rerun were 2.4's and 2.6's -- left for 4.4 proper: the unpacker-shaped itest against the emulator), 4.1 (calls, returns and indirect branches through the entry hash: every region function in one funcref table imported by every module, every entry mirrored into an open-addressing hash in the tables (65 536 slots of address, table index, label and x87 top, a removed slot a tombstone, rebuilt past a quarter of them, the map alone past three quarters full), and the epilogue of an untranslated exit with budget left probing it and tail-calling the region found with the label and the budget that remains -- one path for `ret`, `jmp r/m`, `call r/m` and a direct `call` or `jmp` out of the region; the former makes the return address after a call a block, the runtime forms a hot region's direct callees in the same batch; a block that leaves before retiring anything is no entry, which the first run of the suite found by spinning forever on one; the emulator is given the hash too (the fork's `bottlify_handoff_hash`, build-fcf72f9) so its slice returns at the translator's entries and not at every instruction of a page half translated; `emit/control.test.js` proves a call and its return, an indirect jump through a table, `ret imm` and the registers and flags across a transfer with two region-function calls where the slice loop made four; the encoder now refuses an unknown opcode name, which encoded as `unreachable` before; 14 578 corpus cases through the hash, zero divergences; on the hybrid itest with a call in the hot loop the translated share is above 0.95 and the instruction count identical to the emulator's; found on the way by running the program fixtures under hybrid: a page became volatile after the loader's own writes to it, before any region existed -- only a write that drops a region counts now), 4.2 in part (`hybrid-programs.itest.js`: whole programs under hybrid through `createApp` -- a built executable whose hot loop calls a kernel32 import on every iteration, and the shipped fixtures -- end with the emulator's exit code and output; what they found: an indirect call's target was parked in the local the push then used for the value, so every `call r/m` "returned" to the instruction after itself without calling (the corpus's case did not catch it; `control.test.js` now does, in the register, memory and stack-relative forms); the promise form of compilation never resolved during a run in a process whose yield is a message port, so a batch is compiled with the synchronous constructors at the feed point; `cork.feed: 'slice'` feeds the translator after every slice for a run without frames; an emitter exception is named in `refused` instead of vanishing in a rejected promise; and the emulator's compiler took the translated page's loop as its own and ran it without returning to the slice loop, so the fork now drops what it compiled for a flagged page, does not compile it again while flagged, and its interpreter's own loop -- which runs a page's worth of instructions per dispatch -- returns at an entry too; `int3`/`int n`/`into` are left to the emulator before the instruction, since a trap exit past it would be skipped by the host that re-executes to raise. Found last: `fetch-v86.mjs --update` re-pinned the lock without downloading, so every handoff test since 2.7 had been skipping politely on a build without the exports -- it downloads now, and on the real build (build-f93d90a) the emulator returns at the translator's entries, a page it compiled before the flag is dropped, and the import-calling loop runs at a translated share of 0.50 with one crossing per call into the stub. Then the call channel: `out dx, eax` to the trap port leaves with a `trap` exit past the instruction and the state block complete, the hybrid host raises the emulator's own handler (`raiseTrap`, the same handler and count the port write reaches) and resumes at whatever EIP it left, the instruction after a trap being a block -- an exit rather than the design's import call, since the import would need the state written back and reloaded around it and the exit gets the same crossing count with none of that; and the translator's own candidates: the slice sampler sees only where budgets run out, so the stub reached through untranslated exits alone was never noted -- the runtime now counts untranslated exits by target (`missThreshold` 64) and queues the hot ones itself, the feed hands a hot bucket over at every new address rather than once, an address that formed nothing is left alone until its page moves, and the feed calls `translatePending` every time; on the import-calling loop the translated share went from 0.50 to 0.99, one trap exit per call. Still open in 4.2: `cpuid`, `rdtsc` (the emulator's today, a crossing each), `int n` delivered by this engine rather than the emulator's), 4.2c (the forms the corpus still left out, each a region split and a crossing on a real title: the bit strings (`bts`/`btr`/`btc` with a register offset reaching past the operand, the word form's offset signed), `cmpxchg8b`, `arpl`, the decimal and ASCII adjustments with the processor's own carry rule, `movnti`/`movntq` as the stores they are, `movddup`/`movsldup`/`movshdup`, the horizontal adds and subtracts, `cvtpd2pi`/`cvttpd2pi`, `stmxcsr`/`ldmxcsr`, `fnclex`; with the control word translated the corpus judged the rounding modes for the first time, so every rounding conversion now reads the MXCSR rounding control at run time, and it showed x87 arithmetic handing out the host's positive NaN where the processor gives the negative indefinite, fixed as the SSE path was; 14 744 corpus cases judged, zero divergences, 864 left out at three opcodes -- `fbstp` and the x87 environment forms), 3.4b (the environment forms: `fnstenv` and `fnsave` write the protected-mode environment as the emulator does, the tag word derived from the empty mask and the values, the pointers zero; `fldenv` and `frstor` load the words and the eight registers into the locals -- physical register k from stack slot (k - top) & 7, an address computed at run time -- set the top local and leave for the next block, since the top is known only then and the entry hash enters the code compiled for it; `fnsave` resets the tracker's top as `fninit` does; 14 746 corpus cases judged, zero divergences, `fbstp` the one opcode still named; the 862 cases not run are the invalid encodings the hardware raised #UD at, which the decoder refuses at the entry and the emulator raises under hybrid -- the itest now names them as such), 4.3 in hybrid (a fault raised from translated code -- an undefined instruction after a hot loop -- is reported as the emulator reports it, at the same address with the same message, since the translator leaves before the instruction and the emulator raises it through the existing path; `hybrid-programs.itest.js`; delivery by this engine itself is Milestone 5's), 4.4 (the unpacker-shaped program under `createApp`: a routine copied into a buffer with `rep movsb`, a constant in it patched, called two hundred thousand times, patched again and called again, gives the emulator's exit code with the patch seen as a stale exit or an invalidation and the share above half), and a first synthetic measurement in node (`bench.mjs` in the session's scratchpad, three built programs under `createApp`: a tight loop, a loop storing into its own page, a loop calling an import): translated code runs the tight loop at 0.7 ns per instruction on its own; through the app it first showed 4.5 against the emulator's 7-8, because the region former had walked from the padding after `ExitProcess` into eight kilobytes of zero fill (four thousand `add [eax], al`, 700 KB of module, 200 ms to assemble) -- a run of two all-zero instructions now ends a region as data, and the encoder assembles a module by one concatenation instead of spreading the body through JavaScript arrays -- after which the loop runs at 1.6 against 7-8; the loop storing into its own page was never kept, every store being a store into "a page holding code", so the page table now keeps per page the first and last 32-byte granule of translated code and a store outside them is no store into code (the tables reserve grows to 4 MiB; the loop then runs three times faster than the emulator's); the import-calling loop is still slower under hybrid than on the emulator (the trap exit's JavaScript path: the view per region run and the x87 top read through a proxy every turn are fixed, a profile on an idle machine is next); the translator reports the milliseconds it spent translating and the module bytes it built. On a quiet machine -- a corpus test process of an earlier run had survived its timeout and spun for hours in a transfer loop under every measurement until found -- the tight loop runs at 1.5 ns per instruction against the emulator's 7-8 and the store loop at 4.4 against 18-19, four to five times faster; the import-calling loop stays 15-40 % slower under hybrid, the profile putting the bridge's own dispatch at about 1.4 µs per call on both engines and the hybrid's exit and re-entry at about 0.6 µs more (the region run's exit record is reused now; the design's trap import inside translated code, which saves the two transitions, is the named follow-up if a title's call rate makes it matter), 2.8 (the per-bundle translation cache: each region its own module, the unit the store keeps -- a deviation from the design's one module per batch, recorded in decisions.md -- keyed by the emitter version and features, the layout, the bundle, the entry and the region's hash with its x87 top; the region is still formed each run for the hash, the emitting and encoding are what the store saves; `cork/runtime/cache.js` packs and unpacks a record, the cpu layer's `translation-store.js` keeps one file per record under a directory per bundle in the origin's private file system, resolved in the engine's thread from `'local'` as the block store is; `hybrid-host.itest.js` boots the program twice against one store and the second run takes every region from it), 4.5 in its diagnostics half (the frame counters carry the frame's own translator figures beside the cumulative ones: the share of the frame's instructions the translator ran, the milliseconds it spent translating in the frame, the times translated code came back to the host in it -- what a heavy frame on a title is read against; thread switches under hybrid were 3.4's), and one shape of the emitted code: a block whose conditional branch comes back to its own start -- most inner loops -- is a wasm loop with the back edge a direct branch instead of the dispatcher's round trip, with x87 in play only when the block ends in the state it starts in; the budget is looked at on the taken edge and only there, as the dispatcher's jump does, which the first form got wrong (a leave before the branch decision had the next run repeat the body past a fall-through it never took, a loop counting past zero -- the corpus, with its two-million budgets, could not see it; the region test now spends budgets on the very round a loop ends). Measured on the region alone in node's optimising tier it gains nothing (0.68 against 0.72 ns per instruction, the dispatcher's br_table being as cheap there); it is kept for the baseline tier a browser runs first, where it is to be measured. Then the call channel as the design had it: `out dx, eax` to the trap port calls the `trap` import from inside the region with the state block written back (EIP past the instruction, the count charged) and reads it back after, going on past the write or leaving untranslated where the handler put EIP; the prologue and epilogue are split into the load and store halves this reuses; a region with x87 registers in its locals keeps the exit form; the cpu layer's import runs the emulator's handler and answers whether EIP moved or the machine stopped; the import-calling loop measured after it on the quiet machine at 178-220 ns per instruction under hybrid against 147-163 on the emulator, the same picture as the trap exit gave: the call itself is not the cost, the bridge dispatch behind it is, which the call channel cannot shorten; kept for the host of milestone 5, where the region calls its own bridge without the emulator between. First run on a real program through the browser harness (the ceiling demo route, 1920x1080, worker, warm store; emulator 192 ms per frame over the window): under hybrid the program stopped itself at the start of the demo with its own check that the x87 stack is empty at the end of a frame (stack fault, C1 set) -- every block start in a region with x87 was published as an entry under the region's top, so a block compiled for the stack after a push, entered from outside with the machine's stack as the entry's, pushed onto the wrong slot and wrote the wrong top back; and a block the tracking does not reach with a known shape wrote top 0 back. Blocks compiled for another shape than the entry's get no entry, the prologue loads the machine's top, the cache version bumped, a region test spends both; that alone did not clear the check, the direct cause being `emms`: it wrote every register empty and the same run's epilogue, seeing MMX used, held every register again right after, so every MMX copy left the stack held -- `emms` now clears the run's MMX mark, a SIMD test spends it. The launcher gained an engine setting (Machine group, next run) and the harness an `--engine` flag with the translator served beside core. The design this plan carries out A sequence corpus (`emit/sequences.itest.js`, 20 000 seeded chains of two to eight x87, MMX and SSE forms entered at several tops, judged live against the emulator with `replaySlice`, divergences minimised to the shortest pair) found what the single-instruction corpus could not: 1635 divergences from three causes -- an MMX form that only read an mm register (a store to memory, a move into an xmm or a general register) did not put the stack in the MMX state; `emms` released the top with the hold, so the exit wrote neither; `emms` in a region holding the x87 registers in locals wrote the state block's mask under the exit's. All three closed with SIMD tests, 0 divergences over 80 000 sequences on four seeds; four classes are the emulator's own (the indefinite's sign, what a faulting `fxch` leaves, `fnstenv`'s pointer fields, `fnclex` and the condition codes) and are named, not matched. Open: a region with both x87 and mm operands is still cut at its first x87 instruction, so that crossover is never translated. With the store version bumped for the changed exits, the real program through the browser harness passes its own end-of-frame check with every class translated (nothing left out) and plays its playback route: 135 frames in 80 s, no stop; the frame-time and coverage figures wait for the x87/MMX crossover inside one region. Then the crossover itself: x87 and MMX translate together in one region as two views of the eight physical registers -- an f64 local the x87 side computes in, an i64 local holding the mantissa the MMX side reads and writes, and a form bit saying which wrote last, reconciled at every write and swapped whole by an exchange; at the exit each register goes back in the form that wrote it, so the emulator reads it as the processor would leave it. With the cut gone the sequence corpus, its preamble widened to every entry top, translates 20 000 of 20 000 sequences at a 0.92 share (was 12 202 at 0.25), and found one older defect the shallow stack had hidden: a push onto a full stack raised IE and SF but not C1; fixed with a pure-x87 test; 80 000 sequences on four seeds, zero divergences; the store version bumped for the changed exits. Measured on the playback route in the browser with every class translated (the first comparison the coverage allows): the emulator alone reaches the window in 58 s at 15 ms per frame, hybrid in 94 s at 39 -- the translator runs 0.49 of the instructions with 19 million untranslated exits, the x87 memory forms in blocks the stack tracker reaches with no known state being what it leaves, and 68 of the 94 s are the translator's own (forming, emitting, storing and instantiating 51 000 modules, 50 197 of them store hits); both named as the next step. Then three tracker and runtime defects the real code showed (the tracker seeded the region's first block in address order rather than the entry's, a batched callee was queued at the entry's top rather than its call site's, a candidate was judged barren on the wrong block) and the translator's milliseconds split by part; measured again on the playback route: the window at 15-17 ms per frame against the emulator's 15 (was 39), 4 450 regions instead of 51 000 (the churn was the re-forming of regions whose entry was never published), 18 s of translator time instead of 68, of which 12 are the store's lookups at 2.7 ms each; the share still 0.53 with 10.6 million untranslated exits and the x87 memory forms still refused on shapes the itest does not have -- both named as the next step. 5.0 (a zstd decoder of this project's own in `modules/core/src/zstd.js`: frames, the three block kinds, every literal encoding, the FSE table kinds pinned by the format's own worked example, the sequences with the repeat offsets, the window; no dictionaries, the checksum read and not verified; a written bundle's every block decodes byte for byte to the emulator's decoder, at 1.5x the native decoder's time on match-heavy data and 7x on Huffman-heavy, which a guest file read can bear; `mountBundle` decodes through it and the cpu api's `decompressZstd` waits for 5.5 to leave). 5.1 (the cork host: `engine: 'cork'` boots with nothing of the emulator fetched or instantiated -- its own memory with the state block and the tables beside the guest's RAM, the registers the boot ROM would have left, eip from the entry vector at the first slice, contexts as the whole block plus the thread base, the fault record from a fault exit; the interpreter tier a stub that refuses, so a program under it fails loudly with `cpu: cork has no tier for 0x…` rather than running silently). 5.2 in its main part (the interpreter tier: the decoder and the evaluator over the state block one instruction at a time, the evaluator given x87 as `ir-x87.js` with every rule of the emitter's -- the indefinite, the stack faults and C1, precision control, the condition bits, the transcendentals, the environment forms -- and MMX/SSE as `ir-simd.js` in the emitter's order; `interp.itest.js` runs the single-instruction corpus on the interpreter alone: 14 678 judged, zero divergences, the two named precision cases; eight evaluator defects the corpus found on the way, fcomi on an empty register, the fcmov condition order, the 16-bit leave, unsigned mul/div, a dword store of a double, fxtract of zero, fnsave's high half; the cork host's slice loop runs the tier, so a program under `cork` executes with nothing of the emulator loaded; left of 5.2: the page-fault model for interpreted writes and the translate-off flag). 5.2 finished (the interpreter's page-fault model and the test-only translate-off flag) and 5.3 (hotness counted by the interpreter per instruction start, a start reaching the threshold queued once with its x87 top, the interpreted instructions in the block's own count so the share is over the whole run; `cork-programs.itest.js`: the shipped fixtures and an import-calling loop end under `engine: 'cork'` with the emulator's exit code and output, the machine absent, the loop at a 0.99 share; on the threads fixture the share is 0.49, its cold half never a region, the same coverage gap the real route shows and the next step's). Then the refusal reasons in the diagnostics, a block the tracker cannot reach left to a specialised entry instead of a partial one that shadowed it, and the store's per-bundle index; measured on the route: the share unchanged at 0.53 -- the reasons now say the dominant refusal is a join block (reached by fall-through and as a branch target) the tracker leaves with no state, the call-return shape being a minority; the store hit 399 of 3 900 on a warm run where it hit 2 342 before, and the miss counter's cap of 4 096 addresses leaves 9.9 million untranslated exits at addresses that can never become candidates -- all three the next step. Then bound as the emulator's no-op, the interpreter as a first pass (a start hot on its second visit, the slice run in one call), the tracker at a fixed point so a join takes its predecessors' state, the store index written whole and the miss count evicting instead of capping; measured on the route: hybrid unchanged at a 0.53 share and 10.3 million untranslated exits with the join class smaller but present, the store hitting again (2 734 of 3 914) and its reads still 8.7 of the 13.2 s on the frame thread; under cork alone the program ran 71 s to the same 77 085 112-instruction count it stopped at before, this time at ret imm16 unmodelled in the interpreter -- the identical count says the first-pass path no longer counts, and the four are the next step. Then the emitting and encoding of a batch off the frame thread (a translator worker; the engine thread instantiates and publishes between frames and never waits) and the five helper functions in one shared module every region imports; measured on the route: emit time on the frame thread 0, module bytes 53 MB where the route had 952, the window at 14.6-16.1 ms per frame against the emulator's 15.3; the share 0.51 and the 10.5 million untranslated exits unchanged, and the store's reads still 10.5 of the translator's 15.5 s on the frame thread -- the coverage and the store reads stay the next step. Then the no-tier answer naming the instruction met, the memory-form SSE conversions the interpreter missed, the loading-phase itests with the translator's split, and fourteen hardening forms in the sequence pool (all already correct); measured: hybrid at a 0.51 share, the refusal map now small but the 10.6 million untranslated exits unchanged -- exits into code that never became a region, to be named by target -- the store's reads still 10.8 s on the frame thread; under cork alone the program stops at the same count and address in every run, 77 085 112 instructions then eip 0x7000: a new thread is started at the entry vector's address, where the ROM's jump through the vector is under the emulator and nothing is under cork -- the next step. Then bound's register form decoded as the emulator's no-op, the untranslated exits named by target and reason in the diagnostics, a batch's store reads off the slice path (lookupMs 7.9 ms where it was 10.8 s), and the page-fault fixture; measured: every top untranslated-exit target on the route is an address with an entry compiled for another x87 top -- the runtime treats an entry at any top as done and never forms the second -- eleven million exits under hybrid, and under cork alone the same address livelocks the turn (a few dozen instructions per turn); that key, address and top together, is the next step.
is [`cork-x86-translator.md`](./cork-x86-translator.md) (and the first entry of
[`decisions.md`](./decisions.md) §B); read that first. This document says *in which order, in
which files, behind which contracts, checked by which tests and accepted by which number* the
design is turned into code, one step of at most a day at a time.

The owner's direction, stated 2026-09-20 and binding over any relayed brief: **the explicit
dependency on the vendored emulator is removed, and the emulator becomes one selectable
execution layer among two.** The idea is that the layer is chosen when a bundle is launched:
cork is the engine the product needs and runs on by itself, the emulator is an option the
person or the bundle may pick — loaded only when picked, never required, and still the
fallback tier of `hybrid` mode and the differential oracle. The emulator is the reason
processor-bound titles are weak; the replacement has to be several times faster — tens of
times where that is reachable — with 64-bit programs possible later (§7).
`engine: 'emulator'` keeps working unchanged through every step, as the regression gate of
each and as a product mode afterwards.

**The target in numbers.** The design's 0.5–1 ns per instruction is 2–4× on the plain view
(2 ns today) and up to 10× on the x87- and GUI-heavy view (3 ns today), and the milestones
below are accepted on those figures. Where the arithmetic caps a translator: a well-formed
region (registers in locals, lazy flags, one wasm load per guest load) is 3–6 wasm operations
per x86 instruction against the emulator's ~30, and the browser's compiled wasm runs at
roughly 1.5–3× the cost of native code, so 0.3–0.6 ns is the floor of this approach on a
machine of this class — 4–7× on integer code, 6–10× on x87/SSE code. "Tens of times" on a
whole frame does not come from instructions alone: the same 2004 title makes 25–30 thousand
host calls a frame at about 1 µs each (the design's §1), which is 25–30 ms of a 92 ms frame
that no translator touches. That lever — batching host calls, the design's §5.7 "later,
separate change" — is named here so the owner sees where the second factor lives; it is not
in this plan's scope, and its absence is the reason the plan promises "several", not "tens".

## 0. What a reader needs to know first

The `cpu` layer (`modules/core/src/layers/cpu/`, contract in
[`docs/core/cpu.md`](../docs/core/cpu.md)) is the only code that knows an emulator is
underneath. Today it wraps the vendored emulator (`vendor/prebuilt/libv86.mjs` + `v86.wasm`,
pinned by `modules/core/vendor-lock.json`) through `internal/v86-host.js`, and everything above
it — the kernel's scheduler, the bridge's traps, the loader's image writes — speaks only in the
layer's own terms: `runSlice(maxInstructions)`, `readReg32`/`writeReg32`, `readPhysical`/
`writePhysical`/`writeData`, `registerTrap`, `captureContext`/`restoreContext`,
`instructionCount`, `fault`. Facts that shape everything below:

- **The guest is flat 32-bit protected mode with no paging**, entered by the layer's own 64 KiB
  ROM at `0xF0000`. A guest linear address is a RAM offset.
- **A trap is `out dx, eax` to port `0xb077`** carrying a call number; the bridge's dispatcher
  runs inside that port write and may edit registers, EIP and ESP before the guest resumes, or
  stop the machine. Fault vectors 0..255 arrive as trap ids `0xf000 + vector` from the ROM's
  own interrupt stubs, which halt after reporting.
- **A slice is bounded by retired instructions** (the scheduler's quantum is 100 000), runs to a
  basic-block boundary, and the sampler credits the slice's instructions to the 64-byte bucket
  of the EIP it ended at (`internal/samples.js`). The instruction counter is the emulator's
  32-bit word folded into a JavaScript number after every slice.
- **A thread's context is a copy of the emulator's own fields** (`internal/context.js`): the
  eight registers, EIP, the five lazy-flag words together, the x87 registers with the stack
  top and the empty mask, XMM with MXCSR, FS's base for the thread block. The x87 registers
  are kept by the emulator in a fork-specific form: a "tagged double" whose exponent word is
  `0x7ffe` and whose mantissa word holds the `f64` bits, canonicalised by its readers
  (`internal/fpu.js`).
- **The emulator's registers and RAM live inside one `WebAssembly.Memory` the emulator's wasm
  exports** (`cpu.wasm_memory`); the layer takes typed views on it once and re-takes them when
  the buffer detaches (the memory grew). Any other wasm module may import that same memory.
- **The emulator's fork carries an instruction corpus**, `tests/nasm/`: 127 hand-written cases
  (the brief said 135; 127 `.asm` files are in the fork at the pinned commit, plus the cases
  `create_tests.js` generates at build time — five per instruction form and a hundred random
  arithmetic sequences). Each case is assembled with `nasm -felf32` and linked with `.text` at
  `0x80000`, `.bss` at `0x100000`, then run on real hardware under gdb to produce a *fixture*:
  the eight registers, EIP, ST0..7, MM0..7, XMM0..7, the 8 KiB at `0x100000`, EFLAGS, the tag
  and status words — or the signal the case died with. Neither `nasm` nor `gdb` is on the
  development machine; the fork's CI has both (`ci.yml` installs them and runs `make nasmtests`).

Standing rules that bind every step: branch `cork` only; vanilla ES modules with JSDoc, no
TypeScript, zero runtime dependencies; tests are `node:test`, colocated as `*.test.js` (unit,
no emulator) and `*.itest.js` (need `npm run fetch:v86`); gates before any commit are
`npm run typecheck && npm run lint && npm test && npm run check:boundaries`; one-line commit
messages; every change ships its test and its `docs/core/*.md` sentence in the same commit;
`vendor/` is importable only from `src/layers/cpu/` (`check:boundaries`); no per-title code in
the engine; no title names in shipped docs.

## 1. Where the code goes

Cork is **its own workspace package, `modules/cork` (`@bottlify/cork`)**, beside
`@bottlify/core`, `@bottlify/networking` and `@bottlify/installer` — not a directory inside the
core's cpu layer. The reason is the product model: a launch that selects the emulator must run
with cork absent, so core cannot depend on it; and x86-64 is expected to arrive as a separate
package (`cork-x64`) on the same seam, reusing what this package exports rather than living
inside it. Core keeps its zero-runtime-dependency rule: it never imports `@bottlify/cork`. The
cpu layer *defines* the executor contract (§2.2, §2.3) and loads an engine the way it loads the
emulator today — a dynamic `import()` of a module URL given at `boot()` — so a launch that
selects cork never loads the emulator and a launch that selects the emulator never loads cork.

What stays in core is the layer's own: the hosts that compose an executor with the layer's
contract (contexts, traps, faults, the slice loop), and the emulator adapter:

```
modules/core/src/layers/cpu/
  module.js                       picks the host by `engine`; the api is unchanged
  engine.js                       the executor contract: EngineFactory, Runtime, StateLayout
                                  (JSDoc typedefs only, exported for both packages' checks)
  internal/v86-host.js            the emulator host (unchanged except three accessors, 1.3)
  internal/hybrid-host.js         one register file, one memory, two executors (1.1)
  internal/cork-host.js           an executor alone: it owns the memory (5.1)
```

Everything that translates, runs, caches or interprets x86 is cork's:

```
modules/cork/
  package.json                    @bottlify/cork, zero dependencies, exports "." and the
                                  building blocks ("./wasm", "./runtime") for cork-x64
  jsconfig.json                   the same checkJs/strict settings as core's
  corpus-lock.json                the pinned corpus asset and its hash (1.2)
  scripts/fetch-corpus.mjs        downloads it into vendor/ (gitignored)
  src/
    index.js                      createEngine(env): the EngineFactory core loads
    wasm/encoder.js               the binary encoder: sections, LEB128, function bodies
    wasm/features.js              what this engine's WebAssembly validates (simd, tail calls)
    decode/table.js               the opcode tables: operands, flags, fault class, IR builder
    decode/decoder.js             bytes → Instruction, or a Refusal naming the opcode
    ir.js                         the instruction-level IR and its pure evaluator
    region.js                     entry → Region: blocks, edges, back-edges, exits
    emit/region.js                prologue, locals, epilogue, exits, budget, counting
    emit/integer.js               general-purpose instructions on i32 locals
    emit/flags.js                 lazy flags: recording and materialisation
    emit/memory.js                loads and stores, the page-flag test, fault exits
    emit/x87.js                   the stack tracker, fldcw modes, f64 arithmetic
    emit/simd.js                  xmm as v128 and mm as i64 aliasing the x87 registers
    wasm/simd.js                  the SIMD opcode numbers the emitter uses
    emit/control.js               jumps, calls, returns, the entry hash, traps, hlt
    runtime/layout.js             OWN_LAYOUT, and the layout read off an emulator's views
    runtime/pages.js              the page-flag table and invalidation
    runtime/entries.js            eip → function: the JS map and the in-memory hash
    runtime/runtime.js            batches, instantiation, dispatch, hotness, diagnostics
    runtime/cache.js              per-bundle translation cache over an injected store
    interp.js                     the interpreter tier (5.2)
    testing/snapshot.js           MachineState capture/restore/compare
    testing/differential.js       replay one slice on two executors and diff
    testing/corpus.js             the nasm corpus: ELF32 load, fixture parse, run, diff
```

In the steps below a path written `cork/…` means `modules/cork/src/…`, and `internal/…` means
`modules/core/src/layers/cpu/internal/…`. `testing/` is not exported by the package and is
imported only by tests; cork's `*.itest.js` reach the emulator oracle in core by a relative
path (`../../core/src/layers/cpu/internal/v86-host.js`), which is allowed for tests and for
nothing else. Root scripts (`typecheck`, `test`) gain `-w @bottlify/cork`; `lint` already
covers every workspace; core's `check:boundaries` gains one rule: nothing under core's `src/`
imports `@bottlify/cork`.

**Naming across the seam.** The contract core defines has one set of names, and every
executor implements exactly those: `createEngine`, `Runtime.entryOf/run/noteHot/
translatePending/invalidatePage/diagnostics`, `ExitRecord`, `StateLayout`. `@bottlify/cork`
implements it for 32-bit; `cork-x64` will implement the same names for 64-bit; the emulator
does not implement it — core's own `v86-host.js` adapts the emulator to the layer, as today.
Inside a package the names are the package's own business.

## 2. Contracts shared by every step

These are fixed here so that a step's implementer sees the names its neighbours use. A step
may add to them; a rename is a plan change.

### 2.1 The engine configuration

```js
/**
 * @typedef {'emulator' | 'hybrid' | 'cork' | 'differential'} EngineName
 *   emulator      the vendored emulator alone, exactly as today (the default until 5.4;
 *                 a selectable, optional layer afterwards)
 *   hybrid        the emulator runs everything cork has not translated; the migration mode,
 *                 kept afterwards as a selectable layer for a title cork refuses part of
 *   cork          cork alone: the product's engine, nothing of the emulator loaded or needed
 *   differential  hybrid, plus every region replayed on the emulator and compared;
 *                 test builds and the harness only, refused by the packaged build
 *
 * The engine is chosen per launch: `AppOptions.engine`, set by the launcher from the
 * person's choice for that bundle, with the bundle's `manifest.json` allowed to suggest one
 * (`engine` field) and the launcher's default used otherwise. A launch that names `emulator`
 * or `hybrid` fetches the emulator's artifacts then; a launch that names `cork` never does.
 *
 * cpu configuration gains:
 * @property {EngineName} [engine='emulator']
 * @property {CorkConfig} [cork]
 *
 * @typedef {Object} CorkConfig
 * @property {number} [hotThreshold=2000]  instructions a 64-byte bucket must have been
 *                                         credited before its address is a region candidate
 * @property {number} [maxRegionBlocks=64]
 * @property {number} [maxRegionBytes=8192]
 * @property {number} [batchRegions=32]    regions per wasm module
 * @property {TranslationStore} [store]    the per-bundle cache; none = translate every run
 * @property {string} [bundleId]           the cache's namespace
 *
 * @typedef {Object} TranslationStore
 * @property {(key: string) => Promise<Uint8Array | null>} get
 * @property {(key: string, bytes: Uint8Array) => Promise<void>} put
 */
```

`createApp`'s `AppOptions` gains `engine` and `cork` and threads them to the cpu layer exactly
as `jit` and `sampling` are threaded today (`app.js`, the `cpu:` line of the layer
configuration; `docs/core/host.md`'s option table).

### 2.2 The state layout

Cork's translated code addresses registers by constant offsets from a base held in a wasm
global. Which offsets is data, so the same emitter serves both modes:

```js
/**
 * @typedef {Object} StateLayout
 * @property {number} ramBase        wasm address of guest address 0
 * @property {number} ramSize
 * @property {32 | 64} bits         the register width; 32 in every step of this plan (§7)
 * @property {number} reg32          8 × i32: eax ecx edx ebx esp ebp esi edi
 *                                    (`bits: 64`: 16 × i64 at the same field, named `regs`)
 * @property {number} eip
 * @property {number} previousIp
 * @property {number} eflags         the eager word (hybrid: the emulator's `flags`)
 * @property {number} flagsChanged   hybrid only: written 0 at every exit; -1 when absent
 * @property {number} x87            8 × 16 bytes
 * @property {'f64' | 'tagged80'} x87Format   cork's own f64, or the emulator's tagged form
 * @property {number} x87Top         u8
 * @property {number} x87Empty       u8 bitmask, bit i set = register i empty
 * @property {number} x87Control     u16
 * @property {number} x87Status      u16
 * @property {number} xmm            8 × 16 bytes
 * @property {number} mxcsr
 * @property {number} fsBase         the thread block's linear address
 * @property {number} counter        u32 retired-instruction word (hybrid: the emulator's)
 * @property {number} tables         wasm address of cork's own tables (page flags, entry hash)
 * @property {string} id             a hash of every field above; part of every cache key
 */
```

In hybrid mode every offset but `tables` is read off the emulator's own typed views
(`cpu.reg32.byteOffset` and so on) at boot, the way `internal/fpu.js` already fixes `ST`,
`STACK_PTR`, `STACK_EMPTY` and `CONTROL_WORD`; the state block *is* the emulator's register
file, and a switch between the two executors copies nothing. In cork-alone mode the layout is
cork's own (`runtime/layout.js`, `OWN_LAYOUT`), a 512-byte block at the start of the memory.

### 2.3 The executor interface a host composes

Defined in core (`layers/cpu/engine.js`, typedefs only) and implemented by the engine package;
core reaches the implementation through the URL in its configuration, never through an import:

```js
/**
 * cpu configuration, in addition to §2.1:
 * @property {string} [engineUrl]   the module `boot()` imports for `cork` and `hybrid`;
 *                                  it must export `createEngine`. Absent, those engines
 *                                  refuse: `cpu: engine "cork" needs engineUrl`.
 *
 * @typedef {(env: EngineEnv) => Runtime} EngineFactory      the module's `createEngine`
 * @typedef {Object} EngineEnv
 * @property {WebAssembly.Memory} memory    the layer's memory (the emulator's in hybrid)
 * @property {StateLayout} layout
 * @property {CorkConfig} config
 * @property {(address: number) => number} read      one byte of guest memory
 * @property {{ trap: (id: number) => 0 | 1, getEflags: () => number,
 *              x87Read: (i: number) => number, rdtsc: () => bigint }} imports
 */
```

`createApp` resolves `engineUrl` the way it resolves the emulator's `moduleUrl`: from
`AppOptions.cork.moduleUrl` when given, else from the `@bottlify/cork` package the consumer
installed beside core (the launcher passes its URL). The runtime the factory returns:

```js
/**
 * @typedef {Object} Runtime            (called CorkRuntime below where the text predates this)
 * @property {(eip: number) => number} entryOf         function index or -1
 * @property {(entry: number, budget: number) => ExitRecord} run
 * @property {(eip: number) => void} noteHot            a candidate from the sampler
 * @property {() => Promise<number>} translatePending  regions published; resolves when the
 *                                                      batch is instantiated
 * @property {(page: number) => void} invalidatePage   a host or guest write into code
 * @property {() => CorkDiagnostics} diagnostics
 *
 * @typedef {Object} ExitRecord
 * @property {number} retired   instructions retired in this run (already added to `counter`)
 * @property {ExitKind} kind
 * @property {number} vector    for `fault`: 0 (#DE), 6 (#UD), 3 (int 3), 13 (page flag)
 *
 * @typedef {'untranslated' | 'budget' | 'trap' | 'halt' | 'fault' | 'stale'} ExitKind
 *   untranslated  eip in the state block has no translated entry
 *   budget        a back-edge found the slice's budget spent; eip is the loop header
 *   trap          a trap handler edited eip or asked to stop; eip is what it set
 *   halt          the region executed `hlt`
 *   fault         a precise exception; eip is the faulting instruction, registers as before it
 *   stale         the region was invalidated while running; eip is the next instruction
 */
```

Every exit leaves the state block complete: all eight registers, EIP, an eager EFLAGS, the x87
block with top and empty mask, XMM. There is no state cork holds outside the block between
`run` calls, which is what makes a thread switch, a context capture and a fallback to the
emulator the same operation: nothing.

### 2.4 Diagnostics

`diagnostics()` gains `engine` and, when cork is present, `cork`:

```js
/**
 * @typedef {Object} CorkDiagnostics
 * @property {number} regions          translated and live
 * @property {number} entries          entry points in the hash
 * @property {number} modules          wasm modules instantiated
 * @property {number} translatedShare  instructions retired in cork / instructions retired, 0..1
 * @property {number} cacheHits        regions taken from the store
 * @property {number} cacheMisses
 * @property {number} invalidations    regions discarded by a write
 * @property {number} volatilePages    pages written so often they are no longer translated
 * @property {Record<ExitKind, number>} exits
 * @property {Record<string, number>} refused   opcode (as "0f 2e" or "f3 0f 10") → times met
 * @property {number} handoffMisses    hybrid: slices the emulator ran through translated code
 */
```

The numeric fields join `CPU_COUNTERS` (`cpu/counters` table) as `cork.<name>`; `refused` is
a string and stays in `diagnostics()`.

## 3. The gates every step passes

- **Gate U** — `npm run typecheck && npm run lint && npm test && npm run check:boundaries`.
  Unit tests need no emulator. Runs both packages: core's suites and `@bottlify/cork`'s.
- **Gate I** — `npm run test:integration` with the prebuilt emulator: the cpu layer's existing
  itests (`v86-host`, `quantum`, `module`, `context`, `zstd`) and the top-level ones
  (`hello`, `threads`, `callbacks`, `imports`, …) unchanged and green. **This is the
  `engine: 'emulator'` regression gate**: none of these tests names an engine, so they run
  the default, which stays the emulator until step 5.4 flips it to `cork`.
- **Gate E** — one demo of the 2004 OpenGL title through `tools/cdp_test/game.mjs` under
  `engine: 'emulator'`, run to completion with `--exact`; the retired instruction count and
  the frame count must equal the run before the step (a deterministic demo route on the warm
  store, the same window the design's table was measured on). Run once per step that touches
  `module.js`, `v86-host.js`, `app.js` or the fork; not for a step confined to `cork/`.
- **Gate D** — the differential suites of the step (named in each step).
- **Gate P** — a paired measurement on one of the design's three held windows (plain corridor,
  GUI-heavy room, lit scene), emulator-only versus the engine under test in the same browser
  session on the host machine, reporting guest instructions per frame, ns per instruction and
  guest ms per frame. Only where a step names an acceptance number.

A step is committed when its named gates are green; a commit is one plain line; a failing gate
is reported as failing, never worked around.

## Milestone 1 — the differential harness and hybrid plumbing

Goal of the milestone: the program runs exactly as today under `engine: 'hybrid'` with zero
translated regions; the corpus runs on the emulator through a harness of this project's own;
a slice can be replayed on two executors from one state and diffed. Nothing of cork's
translator exists yet.

### Step 1.0 — the `@bottlify/cork` package and the executor contract

**Goal.** The seam exists before anything crosses it: a workspace package with the project's
conventions, and the contract in core that it will implement, so that from here on core and
cork can be checked and tested apart.

**Files.** Create `modules/cork/package.json` (`@bottlify/cork`, `private` until it ships,
`type: module`, MPL-2.0, `exports: { ".": "./src/index.js", "./wasm": "./src/wasm/encoder.js",
"./runtime": "./src/runtime/runtime.js" }`, scripts `test` and `typecheck` as the sibling
packages have), `modules/cork/jsconfig.json` (core's settings), `modules/cork/README.md` (what
the package is, how core loads it, that it needs nothing of the emulator), `modules/cork/src/index.js`
(`createEngine` that throws `cork: not built yet` and the `Runtime` shape as JSDoc),
`modules/cork/src/index.test.js`; in core: `src/layers/cpu/engine.js` (the typedefs of §2.2 and
§2.3), `scripts/check-boundaries.mjs` (the "core never imports `@bottlify/cork`" rule and its
fixture test), root `package.json` (`typecheck` and `test` include the package), `docs/core/cpu.md`
(a first "Engines" paragraph naming the contract and the package), `docs/core/README.md` (the
package in the layer map's neighbourhood).

**Tests.** `index.test.js`: `createEngine` is exported and throws the message; the package's
`exports` resolve (`import('@bottlify/cork/wasm')` from the test). `check-boundaries` fixture:
a core file importing `@bottlify/cork` fails the checker with `imports @bottlify/cork: core
must not depend on an engine package`.

**Accept.** Gate U green with the new package in every root script; `npm ls --workspaces`
lists it with no dependencies.

**Out of scope.** Any behaviour.

### Step 1.1 — `engine` configuration and the hybrid host with nothing to run

**Goal.** `module.js` picks a host by `engine`; `internal/hybrid-host.js` wraps the emulator
host and answers every call of the host interface by forwarding, so `hybrid` is
`emulator` with a different label.

**Files.** Create `internal/hybrid-host.js`, `internal/hybrid-host.test.js`; modify
`module.js` (config validation, host selection, `diagnostics().engine`), `app.js` (thread
`engine`, `cork`), `docs/core/cpu.md` (Configuration table, a new "Engines" section),
`docs/core/host.md` (option rows).

**Contract.**

```js
/**
 * @param {Object} parts
 * @param {import('./v86-host.js').V86Host} parts.emulator
 * @param {import('../cork/runtime/runtime.js').CorkRuntime | null} parts.cork  null in 1.1
 * @returns {V86Host & { engine: () => EngineName, corkDiagnostics: () => CorkDiagnostics | null }}
 */
export function createHybridHost({ emulator, cork })
```

`runSlice(n)` in 1.1 is `emulator.runSlice(n)` verbatim. An unknown `engine` value throws
from `create()`: `cpu: unknown engine "x" (emulator, hybrid, cork, differential)`; `cork`
and `differential` throw `cpu: engine "cork" is not built yet` until their steps land.

**Tests.** `module.test.js`: `create({ engine: 'x' })` rejects with that message;
`diagnostics().engine` reads `'emulator'` by default and `'hybrid'` when asked.
`hybrid-host.test.js`: every host method forwards (a fake emulator records calls; each of
`runSlice`, `readReg32`, `writePhysical`, `onTrap`, `halt` arrives once with its arguments).
`module.itest.js` gains: the `hello` program (`src/hello.itest.js`'s image) booted with
`engine: 'hybrid'` retires the same instruction count as with `engine: 'emulator'`, to the
instruction.

**Accept.** Gate U, I, E. Instruction counts identical.

**Could go wrong.** A forwarded method missing from the hybrid host surfaces as
`undefined is not a function` inside the scheduler; the forwarding test enumerates
`Object.keys(emulatorHost)` and fails on any key the hybrid host lacks.

**Out of scope.** Any translation; `cork`/`differential` modes.

### Step 1.2 — the corpus as test data

**Goal.** The fork's corpus, assembled and fixtured by the fork's CI, is fetched and verified
like the emulator's binaries, loaded into our machine through the ROM, run to its `hlt`, and
compared against the hardware fixture with the same masks the fork's runner uses.

**Files.** Fork (one commit on `mrwayer/v86`, its own CI): a release asset
`nasm-corpus.json.gz` — `{ cases: [{ name, image (base64 ELF32), fixture (the gdb text) }] }`,
built by the existing `nasmtests` job. This repo: `modules/cork/corpus-lock.json` (the asset
and its hash), `modules/cork/scripts/fetch-corpus.mjs` (fetches it into `modules/cork/vendor/`,
gitignored, verifying the hash the way core's `fetch-v86.mjs` does), `THIRD-PARTY-NOTICES.md`
(the corpus as BSD-2 test data, in this commit), create `cork/testing/corpus.js`,
`cork/testing/corpus.test.js`, `cork/testing/corpus.itest.js`.

**Contract.**

```js
/** @typedef {{ name: string, segments: { address: number, bytes: Uint8Array }[],
 *              entry: number, expected: Fixture }} CorpusCase */
/** @typedef {{ signal: null | 'SIGFPE' | 'SIGILL' | 'SIGSEGV' | 'SIGBUS',
 *              reg32: number[], eip: number, st: (number | 'invalid')[], mm: number[],
 *              xmm: number[], memory: Int32Array, eflags: number, ftag: number,
 *              fstat: number }} Fixture */
export function loadCorpus(gunzippedJson): CorpusCase[]      // parses ELF32 program headers
export function parseFixture(text): Fixture                   // the ---BEGIN JSON--- block
export const ARITH_MASK = 0x8d5;                              // CF PF AF ZF SF OF, as the runner
export const FPU_STATUS_MASK = 0xfdd5;                       // the runner: every bit but 1, 3, 5, 9
export function runCase(host, testCase): Promise<Fixture>     // write, set entry, run to hlt
export function diffFixture(expected, actual): Divergence[]   // [] when equal under the masks
```

`runCase` writes the segments, sets the entry vector, runs until `in_hlt` or a fault; a fault
maps to the fixture's signal (0 → SIGFPE, 6 → SIGILL, 13/14 → SIGSEGV).

**Tests.** `corpus.test.js` (no emulator): an ELF32 with two program headers hand-built as
bytes loads to two segments at the right addresses; a fixture text with `"invalid"` in ST3
parses; `diffFixture` on two equal fixtures is `[]`, on fixtures differing in `ecx` is
`[{ name: 'ecx', expected: 5, actual: 6 }]`, and on fixtures differing only in a masked
flag bit is `[]`. `corpus.itest.js`: every case runs on the emulator through our ROM and
matches its fixture (the same result the fork's own CI gets for the pinned build).

**Accept.** Gate U; corpus green on the emulator: 127 hand-written cases plus the generated
ones. The number of cases in the asset is printed and recorded in the commit message.

**Could go wrong.** The fork's CI may fixture with a different gdb than the runner expects;
a case that fails on the emulator here but passes in the fork's CI is a loader bug (segment
placement, `esp` from the header's own `mov esp, stack_top`) and the test names the first
divergent field. `hlt` in our machine halts only with `IF` clear; the corpus's `push 0; popf`
clears it, and a case that ends without halting is caught by the slice bound.

**Out of scope.** Cork running anything.

### Step 1.3 — the machine snapshot and its compare

**Goal.** One record that holds everything a program can observe of the processor, taken
from any host through the layer's accessors, restorable, and diffable with per-instruction
undefined-flag masks.

**Files.** Create `cork/testing/snapshot.js`, `cork/testing/snapshot.test.js`; modify `internal/v86-host.js`
(three accessors: `readXmm(i) → Uint32Array(4)`, `writeXmm(i, words)`, `x87State() →
{ top, empty, control, status, registers: Float64Array(8), raw: Uint8Array(128) }` — built on
`internal/fpu.js`'s decode); `docs/core/cpu.md` (the accessors are internal to the layer;
one sentence in "What of vendor/v86 is used").

**Contract.**

```js
/** @typedef {Object} MachineState
 *  @property {Uint32Array} reg32 @property {number} eip @property {number} eflags
 *  @property {Float64Array} st (physical order) @property {number} top @property {number} empty
 *  @property {number} control @property {number} status
 *  @property {Uint32Array} xmm (32 words) @property {number} mxcsr
 *  @property {{ address: number, bytes: Uint8Array }[]} memory  the spans captured */
export function snapshot(host, spans: { address: number, length: number }[]): MachineState
export function restore(host, state): void
/** @typedef {{ name: string, expected: number | string, actual: number | string }} Divergence */
export function compare(a, b, { flagsMask = ARITH_MASK, x87Ulps = 0 }): Divergence[]
```

`compare` reports x87 registers by physical index, `'empty'` against a value, and memory by
address (`'mem[0x100010]'`). `x87Ulps` is 0: bit-exact in f64 is the default; a step that
needs a tolerance says so and names it.

**Tests.** `snapshot.test.js` against a fake host (a plain object with the accessors backed by
arrays): a snapshot restored into a second fake compares equal; a changed `ebx` is the single
divergence `ebx`; a flag outside the mask is not; a memory word inside a span is
`mem[0x…]`; an x87 register empty on one side and held on the other is `'st3.empty'`.

**Accept.** Gate U, I (the three new emulator accessors have itests: XMM round-trip through a
`movaps` case, the x87 block read after `fld1` shows `top = 7`, `registers[7] = 1`).

**Out of scope.** Comparing across engines (1.4).

### Step 1.4 — the differential driver, proved on the emulator against itself

**Goal.** Replay one slice on two executors from one state and diff. Built before cork
exists so the driver is trusted on its own: the emulator against itself must diff to nothing,
and a deliberately perturbed replay must report exactly the perturbation.

**Files.** Create `cork/testing/differential.js`, `cork/testing/differential.test.js`,
`cork/testing/differential.itest.js`.

**Contract.**

```js
/**
 * @param {Object} run
 * @param {{ host: V86Host }} run.oracle
 * @param {{ run: (instructions: number) => number }} run.subject   retires up to that many
 * @param {MachineState} run.state            the common start
 * @param {number} run.instructions           exactly how many to retire on both
 * @param {(eip: number) => number} run.undefinedFlags   mask of flags the last instruction
 *                                                         leaves undefined (from decode/table
 *                                                         in M2; the identity mask in M1)
 * @returns {{ divergences: Divergence[], retiredOracle: number, retiredSubject: number }}
 */
export function replaySlice(run)
```

The order is: `restore(oracle, state)`, run the oracle for `instructions`, snapshot A;
`restore(oracle, state)` again (the subject shares the machine in hybrid, so the oracle's
own run is undone by the restore, memory spans included), run the subject, snapshot B;
`compare(A, B)`. Memory spans are the state's own — in M1 the corpus's data area and stack;
from M2 the subject's *undo log* (2.5) names every address it wrote, and the spans are those.

**Tests.** `differential.test.js` with fake hosts: two identical fakes diff to nothing; a
subject that adds one to `ecx` reports `[{ name: 'ecx' }]`; a subject that retires one fewer
instruction reports `retiredSubject` and a divergence on `eip`. `differential.itest.js`: every
corpus case replayed with `subject = oracle` (the emulator runs it twice) diffs to nothing;
one case replayed with a subject that writes `0x1234` into `[0x100000]` after the emulator's
run reports `mem[0x100000]` and nothing else.

**Accept.** Gate U, I, D (the two itests above).

**Could go wrong.** A restore that misses a field shows up here, before any cork code, as a
self-differential divergence — which is the reason this step precedes the translator.

**Out of scope.** The undo log (2.5), running cork.

### Step 1.5 — the wasm binary encoder and the feature probe

**Goal.** Cork writes wasm bytes itself: sections, LEB128, types, imports (memory, functions,
globals), a function table, function bodies with locals, `br_table`, SIMD opcodes, tail
calls. Nothing else in the project emits wasm; the emulator's generator is a Rust program and
is not consulted for this.

**Files.** Create `cork/wasm/encoder.js`, `cork/wasm/encoder.test.js`, `cork/wasm/features.js`,
`cork/wasm/features.test.js`.

**Contract.**

```js
export class ModuleBuilder {
    /** @param {{ params: ValType[], results: ValType[] }} sig @returns {number} type index */
    type(sig)
    importMemory(module, name, { min, max, shared }): void
    importFunction(module, name, typeIndex): number       // function index
    importGlobal(module, name, valType, mutable): number
    global(valType, mutable, initI32): number
    table(min): number                                     // one funcref table
    /** @returns {number} function index */
    function(typeIndex, locals: ValType[], body: Uint8Array, { exportAs, tableSlot }?)
    element(offset, functionIndices): void
    toBytes(): Uint8Array
}
export class Body {                    // an instruction stream with the block structure checked
    op(byte), simd(opcode), i32const(v), i64const(v), localGet(i), localSet(i), localTee(i),
    globalGet(i), globalSet(i), load(kind, { offset, align }), store(kind, { offset, align }),
    block(type), loop(type), if(type), else(), end(), br(depth), brIf(depth),
    brTable(depths, default), call(fn), callIndirect(type, table), returnCall(fn),
    returnCallIndirect(type, table), select(), unreachable(), return()
    toBytes(): Uint8Array               // throws if a block is left open
}
export const ValType = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, funcref: 0x70 };
/** @returns {{ simd: boolean, tailCalls: boolean, sharedMemory: boolean }} */
export function features()
```

**Tests.** `encoder.test.js`: each of these modules passes `WebAssembly.validate` and, where
instantiated, runs: (1) `(func (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)`
exported, `add(2, 3) === 5`; (2) an imported memory `{ min: 1 }` written at offset 8 from
JS, a function `i32.load offset=8` returns the value `0x11223344`; (3) a global set from a
function and read back from JS; (4) `br_table` over 3 cases returns 10/20/30/default 99;
(5) a v128 `f32x4.add` of `[1,2,3,4] + [10,20,30,40]` stored to memory reads `[11,22,33,44]`
(skipped when `features().simd` is false, and the skip is printed); (6) a `return_call` to a
sibling (skipped without tail calls); (7) a body with an unclosed block throws
`encoder: block left open`; (8) LEB128 of `0`, `127`, `128`, `-1`, `2**32 - 1` matches the
byte sequences from the spec. `features.test.js`: the probe answers booleans and never throws.

**Accept.** Gate U. On Node 22 (the engine floor) SIMD and tail calls are expected true;
the test prints the probe's answer so the record shows what the machine had.

**Could go wrong.** A wrong LEB128 for negative i32 constants validates and misbehaves;
case (8) pins it. A section written in the wrong order fails validation with a message
that names the section; the tests assert `validate` is true, and on false print
`new WebAssembly.Module(bytes)`'s error.

**Out of scope.** Emitting anything x86-derived.

## Milestone 2 — integer and SSE regions

Goal of the milestone: hot integer and SSE loops of a real program translate, run inside
`hybrid`, agree with the emulator bit for bit on the corpus and on generated inputs, are
cached per bundle, and the lit-scene window's guest ms drops by the share those loops held.

### Step 2.1 — the opcode table and the decoder, checked against the corpus

**Goal.** A table-driven decoder that turns bytes at a guest address into an `Instruction`
(operands resolved, length known, flags read/written/undefined known, fault class known) or a
`Refusal` naming the opcode; refusals are counted, never guessed around.

**Files.** Create `cork/decode/table.js`, `cork/decode/decoder.js`,
`cork/decode/decoder.test.js`, `cork/decode/table.test.js`, `cork/decode/corpus.itest.js`.

**Contract.**

```js
/** @typedef {Object} Instruction
 *  @property {number} eip @property {number} length
 *  @property {string} op            'add' 'mov' 'jcc' 'fld' 'addps' …
 *  @property {Operand[]} operands   {kind:'reg'|'mem'|'imm'|'rel', size:1|2|4|8|10|16, …}
 *  @property {number} size          operand size in bytes after prefixes (1, 2, 4; 8 is a
 *                                    value the type admits and no 32-bit table entry produces)
 *  @property {number} flagsRead @property {number} flagsWritten @property {number} flagsUndefined
 *  @property {'none'|'divide'|'invalid'|'memory'|'trap'|'privileged'} faults
 *  @property {number} prefixes      LOCK REP REPNE segment override bits
 *  @property {number} cond          for jcc/setcc/cmovcc: the condition code 0..15 */
/** @typedef {{ refused: true, eip: number, opcode: string, reason: string }} Refusal */
export function decode(read: (address: number) => number, eip: number,
                       mode: { bits: 32 | 64 } = { bits: 32 }): Instruction | Refusal
```

The table (`table.js`) has one entry per opcode of the one-byte map, the `0F` map, `0F 38`,
`0F 3A`, the group tables by `/r`, and the x87 maps by second byte — each entry
`{ op, forms: 'Ev,Gv' | 'Gv,Ev' | 'Eb,Ib' | …, flags: { r, w, u }, faults, sse: 'ps'|'pd'|'ss'|'sd' }`.
It is written by hand from the architecture (the operand-form letters are the manual's own),
not generated. The set is the design's §2: general integer, x87, MMX, SSE, SSE2, the SSE3
subset met (`movddup`, `addsubps`, `lddqu`, `haddps`), string instructions, `cpuid`, `rdtsc`,
`fs:` reads, `in/out/cli/sti/hlt`, `int n`, `int 3`, `into`, `bound`. Everything else is a
`Refusal` with `reason: 'not in table'`; a 16-bit code segment, `far` forms, `lgdt`-class
system instructions are `reason: 'not user mode'`.

**Tests.** `decoder.test.js` (concrete bytes): `03 c3` → `add eax, ebx` length 2 size 4;
`66 03 c3` → size 2; `8b 44 24 08` → `mov eax, [esp+8]` with the SIB decoded to base `esp`,
disp 8; `8d 04 8d 00 00 00 00` → `lea eax, [ecx*4 + 0]`; `64 8b 0d 18 00 00 00` →
`mov ecx, fs:[0x18]`; `f3 0f 10 05 …` → `movss xmm0, [imm32]`; `d9 c9` → `fxch st1`;
`dd d8` → `fstp st0`; `0f a2` → `cpuid`; `0f 0b` → `ud2` with `faults: 'invalid'`;
`ff /7` → refused `'not in table'`; `ea …` → refused `'not user mode'`. `table.test.js`:
every table entry's `forms` string is one the operand resolver knows; every entry with
`flags.w` non-zero has `flags.u ⊆ flags.w`; the group tables have eight rows. The modrm/SIB
resolver is enumerated: all 256 modrm bytes × all 256 SIB bytes for `lea`, and the address
formula each decodes to is compared against a 20-line JavaScript model of the manual's table
(`[base + index*scale + disp]`, the `esp`-means-SIB and `ebp`-means-disp32 special cases).
`corpus.itest.js` (no emulator run, only the ELF bytes): for each corpus case, a linear
decode from `_start` must land exactly on the footer's `hlt` byte, with no `Refusal` on the
way — a wrong length anywhere derails the walk and the test names the case and the eip.

**Accept.** Gate U; the corpus walk decodes every case; the refusal list from the walk is empty.

**Could go wrong.** An operand-size or address-size prefix mishandled in one form
(`66 0f 6f` movdqa versus `0f 6f` movq) decodes to the wrong length and the corpus walk
catches it; the `cvt*` and `maskmov*` cases have those forms.

**Out of scope.** Emitting; x86-64; 16-bit code.

### Step 2.2 — the IR, its evaluator, and the region former

**Goal.** Instructions become IR operations a pure JavaScript evaluator can run (used by the
tests here, by constant folding, and by the interpreter in M5), and a region is formed from an
entry: blocks along fall-through and direct branches, back-edges identified, cut at an
indirect jump, a `ret`, a refused instruction, a trap, or the caps.

**Files.** Create `cork/ir.js`, `cork/ir.test.js`, `cork/region.js`, `cork/region.test.js`.

**Contract.**

```js
/** @typedef {Object} Region
 *  @property {number} entry
 *  @property {Block[]} blocks           in address order; blocks[0].start === entry
 *  @property {number[]} entries         eips a later region may be entered at: every block start
 *  @property {number} bytes @property {Set<number>} pages   4 KiB pages the code spans
 *  @property {string} hash              of the decoded bytes, for the cache */
/** @typedef {Object} Block
 *  @property {number} start @property {number} end   [start, end)
 *  @property {Instruction[]} instructions
 *  @property {{ kind: 'fallthrough'|'jump'|'jcc'|'loop'|'ret'|'indirect'|'call'|'trap'|
 *               'hlt'|'refused'|'fault', targets: number[], backEdge: boolean }} exit */
export function formRegion(read, entry, { maxBlocks, maxBytes, translatable: (eip) => boolean }): Region
export function evaluate(instruction, state: EvalState): void   // the pure model, in ir.js
```

`translatable(eip)` answers whether a page may be translated (the runtime's volatile-page
list, 4.4). A `call` to a direct target inside the region's own range is a block exit of
kind `call` with the target as an entry; a `call` outside ends the region (M4 turns it into
a direct call to another region).

**Tests.** `region.test.js` with hand-assembled bytes: a countdown loop
`mov ecx, 10; L: dec ecx; jnz L; ret` forms 3 blocks with one back-edge into `L`; a diamond
(`test eax,eax; jz A; mov ebx,1; jmp B; A: mov ebx,2; B: ret`) forms 4 blocks and no
back-edge; a region is cut at `jmp eax` with exit kind `indirect`; at a `ud2` with `fault`;
at `out dx, eax` with `trap`; at a byte the table refuses with `refused` and the refusal's
eip; `maxBlocks: 2` cuts the diamond after two blocks with the third's start as a pending
entry. `ir.test.js`: the evaluator on `add eax, ebx` with `eax = 0x7fffffff, ebx = 1` gives
`eax = 0x80000000`, `OF = 1, SF = 1, ZF = 0, CF = 0, AF = 1, PF = 0`; `sub` of equal values
gives `ZF = 1, CF = 0`; `shl eax, 0` leaves flags untouched; `imul` two-operand sets `CF = OF`
on overflow only; `bsf` on zero leaves the destination and sets `ZF`; `sar` of `-8` by 1 is
`-4`; `rol` by 32 bits leaves the value.

**Accept.** Gate U.

**Could go wrong.** Overlapping blocks (a jump into the middle of an already-decoded block)
must split the block, or the same bytes get two translations with different instruction
boundaries; the test "a jump into the middle of a block splits it at the target" pins the
split.

**Out of scope.** Emitting; calls across regions.

### Step 2.3 — the region emitter: integer instructions on locals, lazy flags

**Goal.** A region becomes one wasm function: a prologue that loads the registers it reads
into i32 locals, straight-line bodies, structured control flow rebuilt from the block graph
(a `loop` per back-edge target, `block`/`br_if` for forward edges, `br_table` where a block
has several predecessors), and an epilogue per exit that writes back the dirty locals, an
eager EFLAGS, EIP and the exit kind. Arithmetic flags are lazy: an instruction that writes
flags records `(op, size, result, op1, op2)` in four locals; a flag is computed only where a
later instruction reads it; a `cmp`/`test` immediately followed by `jcc` (or with only
flag-neutral instructions between) becomes one i32 compare and branch; flags written and
dead by the region's exit are not materialised except into the epilogue's EFLAGS.

**Files.** Create `cork/emit/region.js`, `cork/emit/integer.js`, `cork/emit/flags.js`,
`cork/emit/flags.test.js`, `cork/emit/integer.test.js`, `cork/emit/region.test.js`.

**Contract.**

```js
/** @typedef {Object} Translation
 *  @property {Uint8Array} body @property {ValType[]} locals @property {number} typeIndex
 *  @property {{ eip: number, label: number }[]} entries   block starts and their br_table labels
 *  @property {number} instructions                          in blocks[0], for the count */
export function translateRegion(region: Region, layout: StateLayout, features): Translation
```

The function signature is `(entryLabel: i32, budget: i32) → i32` (the exit kind); the
region's blocks are reached by `br_table` on `entryLabel` at the top, so one function serves
every block-start entry. Register conventions inside the function: locals 0..1 are the
parameters; 2..9 mirror `reg32`; then the four flag locals; then temporaries. A local not
read by the region is not loaded; a local not written is not stored.

The lazy-flag algebra (`flags.js`) is a pure module: `record(op, size)` says what the four
locals hold after an instruction, `materialise(flag, record)` emits the wasm that computes
one flag from them, and `condition(cc, record)` emits the branch condition for a `jcc` —
the `cmp`+`jcc` fusion is `condition` given a `cmp` record. Parity is a lookup in a 256-byte
table in cork's tables area; AF is `((op1 ^ op2 ^ result) & 0x10)`.

**Tests.** `flags.test.js`: a JavaScript mirror of every `materialise` path (the same
formulas executed by `evaluate`) against a vector table of 40 concrete cases — for each of
`add sub adc sbb and or xor inc dec neg cmp test shl shr sar rol ror imul mul` at sizes 1, 2,
4: inputs and the six flags, taken from the architecture's definition (e.g. `add8 0xff + 0x01`
→ `CF=1 ZF=1 AF=1 PF=1 SF=0 OF=0`; `sub32 0x80000000 - 1` → `OF=1 SF=0`; `shl32 1 by 31`
→ `CF=0 OF=1`; `shr32 0x80000000 by 1` → `OF=1`; `sar8 0x80 by 1` → `0xc0 CF=0`). Emitted
wasm for each case is run and compared to the same vectors. `integer.test.js`: single-block
regions run through the encoder with a 64 KiB memory and `OWN_LAYOUT`: `mov eax, 5; add eax,
7` leaves `eax = 12` in the state block and `EFLAGS` with `PF=1`; `xchg`, `movzx`, `movsx`,
`cdq`, `idiv` with a positive quotient, `imul` three-operand, `lea` with every SIB shape,
`setcc` after `cmp`, `cmovcc`, `bt/bts`, `bswap`, `xadd`, `cmpxchg` (both outcomes),
`push/pop` (memory in the state's RAM), `pushf/popf` (the eager word round-trips),
`std/cld`+`rep movsd` of 16 dwords, `rep stosb`, `repne scasb` finding a byte at index 7,
`loop`/`jecxz`. `region.test.js`: the countdown loop of 2.2 with a budget of 1000 retires
exactly 22 instructions (one `mov`, ten `dec`/`jnz` pairs, one `ret`) and
exits `untranslated` at `ret`'s successor; with a budget of 7 it exits `budget` at `L` after
retiring the last full iteration that fit, and `ecx` matches the iteration count.

**Differential (Gate D).** `cork/testing/differential.itest.js` gains: every integer corpus case
(arith-optimisations, btc/btr/bts ×3, cmp16-setbe, cmpxchg, cmpxchg8b, cmpxchg-setbe,
double-segment-prefix, idiv8/16/32-overflow, jcxz, jump, lea-nop, leave16/32, loop,
loopnz/loopz, mov16, pop_esp, pop_esp2, push, pushf, ret-imm, store-widths, shift and
arithmetic generated cases) is formed into regions from `_start` and replayed: the emulator
runs the case from the header's state, cork runs the same regions; `compare` under the
case's own undefined-flag mask must be `[]`, and the fixture (hardware) must match too. An
instruction the region former cuts at (a `Refusal`) makes the case *skipped with the opcode
printed*, never passed silently; the skip count is part of the step's report.

**Accept.** Gate U, D: every listed corpus case agrees with both the emulator and the
hardware fixture; zero refusals among the integer cases.

**Could go wrong.** A fused `cmp`/`jcc` that ignores a `mov` between them is fine; one that
ignores an `inc` is a wrong branch — the fusion's "flag-neutral" list is the table's
`flagsWritten === 0`, and the test "a cmp separated from its jcc by an add is not fused" pins
it. Undefined flags (`AF` after `shl`, `OF` after a multi-bit shift) differ between the
emulator and hardware and between hardware generations; the masks say which comparisons
are meaningful, and a mask too wide hides a real bug — the mask is per instruction from the
table, never global.

**Out of scope.** Memory faults (2.4), SSE (2.5), calls between regions (M4).

### Step 2.4 — memory access, the page-flag table, precise faults, the undo log

**Goal.** Every load and store compiles to a plain wasm access preceded by one page-flag test;
the table covers the whole 4 GiB address space so an address beyond RAM, in the null page, in a
range the host marked inaccessible, or in a page holding translated code takes the slow path;
the slow path is a precise exit with every register as before the instruction.

This is a deliberate deviation from the design's §5.1 ("the browser's wasm bounds check is the
only check"): a wasm trap unwinds the function and the registers held in locals are lost with
it, so precision after a trap would need every dirty local written back before every access —
more stores than the check costs. The test is three wasm operations per access
(`i32.shr_u 12`, `i32.load8_u` at the table, `br_if`), and it is what also delivers
self-modifying-code detection, the null page, and (later) the memory layer's protections to
the guest, which the emulator never did. It stays measured: 2.9 reports the share the check
holds, and elision for a base register already checked in the same block is the named
follow-up if the share is material. Recorded in `decisions.md` §B when the step lands.

**Files.** Create `cork/emit/memory.js`, `cork/emit/memory.test.js`, `cork/runtime/pages.js`,
`cork/runtime/pages.test.js`; modify `cork/emit/region.js` (fault exits, undo log).

**Contract.**

```js
/** Page flag bits, one byte per 4 KiB page, 1 MiB at layout.tables */
export const PageFlag = { INACCESSIBLE: 1, HAS_CODE: 2, VOLATILE: 4 };
export function createPageTable(memory: WebAssembly.Memory, layout): {
    set(page: number, flag: number): void, clear(page, flag): void, get(page): number,
    markRange(address, length, flag): void, clearRange(address, length, flag): void,
}
```

Loads test `flag & INACCESSIBLE`; stores test `flag & (INACCESSIBLE | HAS_CODE)`. A store's
slow path writes the value (the store itself still happens — it is code being written, not an
error), then exits `stale` with EIP at the next instruction, so the runtime can invalidate
the page's regions and continue; a load's or store's slow path on `INACCESSIBLE` exits
`fault` with vector 13 and EIP at the instruction. A fault exit block per site writes back
every dirty local and the site's EIP; nothing per instruction is stored on the fast path.

Pages beyond RAM are `INACCESSIBLE` from boot. The null page is not: today the emulator lets
a guest read address 0, and hybrid parity requires cork to as well; marking it (and the memory
layer's `rx`/`r` regions) is a one-line policy change left to the owner, named in
`docs/core/cpu.md` as the switch it is.

**The undo log** (differential builds only): a `Translation` made with `{ undoLog: true }`
records before every store `(address, size, oldValue)` into a ring at `layout.tables +
UNDO_RING`; `differential.js` reads it after the subject's run to name the memory spans to
compare and to restore them before the oracle's run. Production translations carry none of
it; the flag is part of the cache key so the two never mix.

**Tests.** `pages.test.js`: `markRange(0x40000000, 0x1000, INACCESSIBLE)` sets exactly page
`0x40000`; pages beyond `ramSize` read `INACCESSIBLE` after `createPageTable`; `clearRange`
across a partial page clears the whole page (the granularity is the page and the test says
so). `memory.test.js`: `mov eax, [0x2000]` with the word set from JS reads it; `mov [0x2000],
eax` writes it and leaves `HAS_CODE` pages untouched; a load from a page marked
`INACCESSIBLE` exits `fault` vector 13 with `eip` the load's and `ecx` as set *before* the
instruction that follows it in the block (proving the epilogue wrote the pre-fault state); a
store into a page marked `HAS_CODE` exits `stale` with `eip` the next instruction and the
byte actually written; `idiv` by zero exits `fault` vector 0; `ud2` exits `fault` vector 6;
`int 3` exits `fault` vector 3 with `eip` past the instruction (a trap, as the frame reader
expects). With `undoLog: true`, three stores to `0x3000`, `0x3004`, `0x3000` leave three ring
entries in order with the old values, and `differential.js`'s span reader folds them to one
span `[0x3000, 8)`.

**Differential (Gate D).** The corpus cases with memory operands rerun with `undoLog: true`
and the spans from the log; the result must equal the fixed-span run of 2.3.

**Accept.** Gate U, D.

**Could go wrong.** An unaligned store spanning two pages tests only its first page; the
emitter tests the page of the *last* byte too when `size > 1` and the address is not
provably aligned (`memory.test.js`: a dword store at `0x2ffe` into a page whose neighbour is
`HAS_CODE` exits `stale`).

**Out of scope.** Elision of checks; the memory layer projecting its map (named for M4).

### Step 2.5 — SSE as v128, MMX as i64

**Goal.** XMM registers are `v128` locals; `movaps/movups/movss/movsd/movlps/movhps`,
`addps/subps/mulps/divps/sqrtps/minps/maxps/rsqrtps/rcpps`, the `ss`/`sd`/`pd` forms,
`cmpps` predicates, `shufps/unpck*`, `cvt*` between float and integer, `comiss/ucomiss` into
the flag record, the integer SSE2 set (`padd*/psub*/pmul*/pcmp*/pand/pandn/por/pxor/
psll*/psrl*/psra*/punpck*/pack*/pshufd/pshuflw/pshufhw/pmovmskb/pinsrw/pextrw/movd/movq`),
`movnt*` as plain stores, `maskmov*` as a masked loop. MMX registers are `i64` locals over the
x87 registers' mantissa words: an MMX instruction in a region marks the x87 block "not f64"
until `emms`; a region that mixes the two classes materialises through the state block at the
crossover (a store of the i64 and a reload as f64 or the reverse), which the differential
suite proves rather than the design assuming it rare.

**Files.** Create `cork/emit/simd.js`, `cork/emit/simd.test.js` (one file: the two register
classes share the read/write helpers and most lowerings), `cork/wasm/simd.js`,
`cork/wasm/simd.test.js` (every opcode number validated by the engine).

**Contract.** Additions to the emitter's per-instruction dispatch; no new public names. The
one policy decision: `minps`/`maxps`/`minss`/`maxss` are emitted as `f32x4.lt` +
`v128.bitselect` (three ops), not `f32x4.min`, because wasm's min propagates NaN and returns
the negative zero, while the architecture returns the *second* operand when either is NaN or
both are zero. `rsqrtps` is `f32x4.div(splat 1, f32x4.sqrt x)` and `rcpps` is `f32x4.div`,
exact, as the emulator computes them, so results are bit-identical to what the library's
programs already run against.

**Tests.** `sse.test.js` (concrete lanes): `addps [1,2,3,4]+[0.5,…]`; `minps` with a NaN in
lane 2 returns the second operand's lane 2, `minps [+0,…],[-0,…]` returns `-0` (second
operand); `cmpps` predicate 1 (`lt`) produces `0xffffffff`/`0` masks; `shufps xmm0, xmm1,
0x1b` reverses; `cvttps2dq [1.7, -1.7, 3e9, NaN]` → `[1, -1, 0x80000000, 0x80000000]`;
`cvtsi2ss` of `2**24 + 1` rounds to `2**24`; `pmaddwd`, `pmulhw`, `packuswb` saturation
(`0x1234` → `0xff`, `-1` → `0`); `psrad` by 32 gives the sign; `pmovmskb` of alternating sign
bytes gives `0xaaaa`; `movntps` writes the lanes; `maskmovdqu` writes only masked bytes.
`mmx.test.js`: `movq mm0, [m]; paddb mm0, mm1; movq [m], mm0` round-trips; after an MMX
write the x87 tag reads all-valid and top 0 (`emms.asm`'s behaviour); a region with
`fld1; movq mm0, [m]; emms; fld1` leaves the second `fld1` at top 7 with ST0 = 1.

**Differential (Gate D).** The corpus's SSE/MMX cases: comiss, ucomiss, cvtpi2ps,
cvtps2pi, cvttps2pi, emms, maskmovdqu, maskmovq, movaps, movd, movntpd, movntps, movq,
pack*, padd*, pand, pandn, pcmp*, pmaddwd, pmulhw, pmullw, pmuludq, por, pshufw, psll*,
psra*, psrl*, psub*, punpck*, pxor, shufps-edgecase — each against the emulator and the
hardware fixture. Then generated inputs: for each SSE arithmetic op, 200 random lane sets
including NaN, ±0, denormals and ±inf, run on cork and the emulator through
`replaySlice`; zero divergences.

**Accept.** Gate U, D. SIMD absent (`features().simd === false`) makes the SSE emitter
refuse every SSE instruction with `reason: 'no simd'` so the program still runs on the
fallback; the differential suite is skipped and says so.

**Could go wrong.** Denormal handling: wasm keeps denormals, SSE with `FTZ`/`DAZ` clear does
too; a program that sets `FTZ` in MXCSR would see denormals cork does not flush. MXCSR is
read at region entry only for `cvt*` rounding; `FTZ`/`DAZ` are reported by the diagnostics'
`refused` list as `mxcsr.ftz` the first time a `ldmxcsr` sets them, and the region is not
translated — the program then runs those regions on the emulator, which is the same picture
it has today.

**Out of scope.** SSE3 beyond the four named forms; `fxsave/fxrstor` (M3).

### Step 2.6 — the runtime: batches, instantiation, dispatch, counting, hotness

**Goal.** Regions are compiled into modules of up to `batchRegions` functions sharing one
type, one imported memory, one function table and the `trap`/`getEflags`/`x87Read` imports;
instantiation is asynchronous and the emulator keeps running meanwhile; `runSlice` in
hybrid enters cork whenever the current EIP has a translated entry; instruction counting
adds each block's constant to the counter word at back-edges and exits so
`instructionCount()` and the sampler need no change; hotness comes from the sampler's own
buckets.

**Files.** Create `cork/runtime/runtime.js`, `cork/runtime/runtime.test.js`,
`cork/runtime/entries.js`, `cork/runtime/entries.test.js`; modify `internal/hybrid-host.js`
(the slice loop), `internal/hybrid-host.test.js`, `module.js` (candidate feed from the sample
table, cork counters), `docs/core/cpu.md` ("Engines": hybrid's slice loop, counting at loop
edges, what the sampler now attributes to), `docs/core/log.md` (the `cork.*` counter columns).

**Contract.**

```js
export function createCorkRuntime({ memory, layout, features, config, read, imports }): CorkRuntime
// imports: { trap: (id) => 0 | 1, getEflags: () => number, x87Read: (i) => number, rdtsc: () => bigint }
```

The hybrid slice loop:

```
runSlice(n):
  remaining = n
  while remaining > 0:
    entry = cork.entryOf(eip)
    if entry >= 0:  exit = cork.run(entry, remaining); remaining -= exit.retired
                    if exit.kind is fault/halt/trap-with-stop: break
                    continue
    ran = emulator.runSlice(remaining); remaining -= ran
    break           // the emulator runs to a block/page boundary; one turn per slice in 2.6
  credit the sampler with eip and n - remaining, as today
```

In 2.6 the emulator gets one turn per slice (it decides when it stops); the handoff that
returns control to cork at a translated entry mid-slice is 2.7. Hotness: `module.js` feeds
`cork.noteHot(address)` with each bucket whose `instructions` crosses `hotThreshold` (read
off `state.samples` once per frame in the `onFrame` sampler already there; no new per-slice
cost); the runtime forms a region at that address, queues it, and `translatePending()` is
called from `onFrame` too, so translation is paced by frames and never inside a slice.

Counting: each block's instruction count is a constant; at a back-edge the emitter adds the
count of the blocks since the last edge to a local `retired`, subtracts from `budget`, and
on `budget <= 0` writes `retired` into `layout.counter` and exits `budget`; every exit
flushes `retired` the same way. The count is exact per block, so a slice that ends in cork
ends on a block boundary as one that ends in the emulator does.

**Tests.** `entries.test.js`: `add(eip, fn)`, `entryOf(eip)`, `removePage(page)` drops every
entry in the page and no other. `runtime.test.js` (a `WebAssembly.Memory` of 4 MiB, `OWN_LAYOUT`,
no emulator): a region for the countdown loop of 2.2 with `ecx = 1000` and a budget of 100
exits `budget` after retiring a count divisible by the loop body's length, `layout.counter`
increased by exactly that, and repeated `run` calls finish the loop with the sum of `retired`
equal to the evaluator's count for the whole program; two regions in one batch are both
callable after one `translatePending()`; `translatePending()` with nothing queued resolves 0;
a batch whose module fails validation is reported as `refused` under `'batch'` and the
regions stay untranslated (the program is unaffected). `hybrid-host.test.js`: with a fake
emulator and a fake cork whose `entryOf` answers for one eip, a slice of 10 that cork
answers with `retired: 4, kind: 'untranslated'` then hands 6 to the emulator.

**Differential and integration (Gate D, I).** `hybrid-host.itest.js`: a guest program of two
functions (a hot integer loop and a cold trap to the host) booted under `hybrid`: after the
loop's bucket crosses the threshold and a frame passes, `diagnostics().cork.regions === 1`,
the final registers and memory equal the emulator-only run, and `instructionCount()` is
identical to the instruction. Under `differential`, the same program replays every region
and reports zero divergences.

**Accept.** Gate U, I, E, D; `translatedShare` on the itest program > 0.5 (the loop is most
of it and the emulator still takes the slices it starts).

**Could go wrong.** A module instantiated after the page it translates was written (a race
between the loader's write and the batch) publishes stale code; the runtime stamps each
region with the page table's generation at formation and drops a batch member whose page
generation moved (`runtime.test.js`: an `invalidatePage` between `noteHot` and
`translatePending` yields `regions === 0`).

**Out of scope.** Mid-slice handoff (2.7), the cache (2.8).

### Step 2.7 — handoff: the emulator returns at a translated entry

**Goal.** A slice the emulator starts returns to the hybrid loop the moment it reaches an EIP
that has a translated entry, instead of running through cork's region on its own until a
block boundary happens to coincide with the slice end. Without this the translated share is
bounded by how often a slice *starts* inside a hot loop.

**Files.** Fork (`mrwayer/v86`, one commit, its own test under the fork's `tests/`): an
exported `bottlify_handoff_page(page: u32, on: u32)` and a per-page bit the dispatcher checks
before entering a block at a new page: when set and the EIP is in the page, `run_slice`
returns with the instructions retired so far. Then this repo: `vendor-lock.json` re-pinned to
the fork's new release, `internal/v86-host.js` (`handoffPage(page, on)`, a no-op with a
counter when the export is absent), `internal/hybrid-host.js` (the loop no longer breaks
after the emulator's turn; it loops while `remaining > 0`), `internal/v86-host.itest.js`
(the export stops a slice at the page), `cork/runtime/runtime.js` (a published region
flags its pages; an invalidated page clears the flag when it holds no regions),
`docs/core/cpu.md` ("What of vendor/v86 is used").

**Contract.** `V86Host.handoffPage(page: number, on: boolean): void`;
`CorkDiagnostics.handoffMisses` counts slices in which the emulator's slice ended inside a
page that holds a region (the sampler's EIP tells), i.e. handoffs that did not happen — zero
with the export present, the whole count without it.

**Tests.** Fork: a loop over two pages with the second flagged stops at its first byte.
`v86-host.itest.js`: the same through the host. `hybrid-host.itest.js` (2.6's program):
`translatedShare > 0.95` and `handoffMisses === 0`; without the export (a test that stubs it
out) the program still completes with identical results and `handoffMisses > 0`.

**Accept.** Gate U, I, E, D; `translatedShare > 0.95` on the itest program.

**Could go wrong.** The check costs the emulator a bit-test per block entry; Gate E's
instruction count is unchanged by construction, and the ms per frame under `emulator` must
not move by more than the run-to-run noise on the plain-corridor window (Gate P, one paired
run). If it does, the check moves to the page-change path only.

**Out of scope.** Anything but the one export.

### Step 2.8 — the per-bundle translation cache

**Goal.** A region's wasm is a pure function of its bytes and the layout; the second start of
a program translates nothing it ran the first time.

**Files.** Create `cork/runtime/cache.js`, `cork/runtime/cache.test.js`; modify
`cork/runtime/runtime.js` (lookup before forming, put after publishing), `app.js` (a
`TranslationStore` over the same OPFS-backed store the bundle blocks use, namespaced by
`bundleId`; none when the bundle store is off), `docs/core/cpu.md`, `docs/core/host.md`.

**Contract.**

```js
/** key = `cork/${version}/${layout.id}/${imageStamp}/${entry.toString(16)}/${hash}` */
export function cacheKey({ version, layout, imageStamp, entry, hash, undoLog }): string
/** a batch's record: the module bytes and, per region, its entries and instruction counts */
export function packBatch(batch: PublishedBatch): Uint8Array
export function unpackBatch(bytes: Uint8Array): PublishedBatch
```

`imageStamp` is the loader's identity for the image the entry falls in (the PE
`TimeDateStamp` and `SizeOfImage`, already read by the loader; the cpu layer receives it
through a new optional `imageIdentity(address) → string` callback the app passes in the cpu
config, the same way `lastError` is passed to the bridge). Without one the stamp is
`'unknown'` and the hash of the bytes alone still guards correctness.

**Tests.** `cache.test.js`: `packBatch`/`unpackBatch` round-trip a batch of two regions;
a key changes with any of its inputs; with an in-memory store, the runtime's second
`translatePending()` for the same regions reports `cacheHits === 2, cacheMisses === 0` and
instantiates from the stored bytes; a changed byte in the region's code changes the hash and
misses; a stored batch whose `version` is older is ignored. `hybrid-host.itest.js`: two boots
of 2.6's program with one store: the second reports `cacheHits === regions`.

**Accept.** Gate U, I, D.

**Could go wrong.** A stored module compiled with tail calls loaded on an engine without
them fails validation; `features()` is part of `version`.

**Out of scope.** Ahead-of-time sidecar content (the mechanism is the same store; a bundle
carrying `cork/` entries is a bundle-format change, its own decision).

### Step 2.9 — the first measured window

**Goal.** The hottest SIMD and integer loops of the 2004 OpenGL title — the ones its sidecar
kernels replaced by hand — translate, and the lit-scene window's guest ms drops by the share
those loops held.

**Files.** None in the engine beyond fixes the run demands (each its own commit with its
test); `tools/cdp_test/game.mjs` and `frames.mjs` gain `--engine NAME` threaded to
`createApp` (`tools/cdp_test/README.md`).

**Tests.** Gate P: the lit-scene window, the demo's deterministic route on the warm store,
with the sidecar kernels *off*, `engine: 'emulator'` versus `engine: 'hybrid'`, in one host
browser session, three runs each; reported: guest instructions per frame (must be equal
within 0.1 %), `translatedShare`, `refused` (which opcodes the loops need that the table
lacks — each becomes a table entry with its differential test, in this step), guest ms per
frame, ns per instruction.

**Accept.** Guest ms per frame on the window drops by at least the share the sidecar
kernels were measured to buy when they were installed (that title's sidecar report holds
the paired before/after figure; the number is copied into this step's commit message when
the run is made). `refused` on the window empty after the step. Gate U, I, D, E.

**Could go wrong.** The loops call into other functions (`call` ends a region in M2); a
window whose hot code is call-heavy shows a low `translatedShare` and the gain waits for
M4.1. That is a finding, reported as such, not worked around by a per-title change.

**Out of scope.** x87 (M3), calls (M4).

## Milestone 3 — x87

Goal of the milestone: x87-heavy code translates with a static stack tracker on `f64`
locals; `fldcw` rounding and precision control are honoured; the GUI-heavy window's ns per
instruction halves; every demo in the library still runs to completion in `hybrid`.

### Step 3.1 — the stack tracker: loads, stores, exchange, arithmetic

**Goal.** Inside a region the top of stack is a compile-time value; ST(i) is a physical f64
local; a region is entered with a known top because the *entry is specialised on it*: the
entry key is `(eip, top)`, and a function is compiled per top actually met (in practice one:
the ABI leaves the stack empty at calls, or holding one return value). Exit writes back the
dirty registers, top and the empty mask; in the emulator's layout the write is the tagged
double form, which its readers canonicalise, and a register read at entry that is not in that
form (a true 80-bit value the emulator produced) is converted through the `x87Read` import.

**Files.** Create `cork/emit/x87.js`, `cork/emit/x87.test.js`; modify `cork/runtime/entries.js`
(the key), `cork/runtime/runtime.js`, `internal/hybrid-host.js` (entry lookup passes the
current top), `docs/core/cpu.md`.

**Contract.** `entryOf(eip, top)`; `translateRegion(region, layout, features, { entryTop })`.
The tracker is a pure module inside `x87.js`: `track(instructions, entryTop) → per-instruction
{ top, physical: (i) => index, empty: bitmask }`, exported for its test. `fld m32/m64/m80`,
`fild m16/m32/m64`, `fst/fstp m32/m64/m80`, `fist/fistp/fisttp`, `fld st(i)`, `fst/fstp
st(i)`, `fxch`, `fadd/fsub/fsubr/fmul/fdiv/fdivr` in every form, `faddp`-class, `fiadd`-class,
`fchs/fabs/fsqrt`, `fld1/fldz/fldpi/fldl2e/fldln2/fldlg2/fldl2t`, `fcom/fcomp/fcompp/fucom*/
fcomi/fucomi` (into the flag record or the status word), `fcmovcc`, `ftst/fxam`, `fnstsw
ax/m16`, `fnstcw/fldcw` (3.2), `fincstp/fdecstp`, `ffree`, `fwait/fnop`, `fninit`. `fnsave/
frstor/fnstenv/fldenv/fxsave/fxrstor` end a region (they run on the fallback tier).

**Tests.** `x87.test.js`: the tracker on `fld1; fld1; faddp; fstp m64` gives tops
`7, 6, 7, 0` and the store reads physical 7; on `fld st0; fxch st2` the physical map swaps.
Emitted regions: `fld m64 (2.5); fmul m64 (4); fstp m64` writes `10`; `fld1; fld1; fsubp`
leaves `0` with the empty mask `0x7f` after `fstp`; `fstp m32` of `1.1` writes `0x3f8ccccd`
(round-to-nearest of the f64); `fxch st1` then `fstp` stores the lower; `fcomi` sets
`ZF/CF` as `cmp` would (`1 < 2` → `CF = 1`); a region entered with `entryTop = 6` and the
emulator's tagged-double bytes for ST0 in the state block reads them as f64 without the
import; the same with a true 80-bit register calls `x87Read(7)` once.

**Differential (Gate D).** The corpus's arithmetic x87 cases (fdiv, fdivr, fdiv-zero,
fchs, fdecstp, fincstp, fsqrt, fst-st-empty-tag, fstsw, fpu_m80, fstm80, x87-tagged,
x87-kept-tag, x87-interp-inline) against the emulator bit for bit in f64, and against the
hardware fixture with the comparison the fork's runner uses (`float_equal`, seven significant digits).
Where the emulator's own 80-bit result and cork's f64 differ (the "kept tag" case's value no
double holds), the divergence is reported under a named class `x87.precision` and *counted*,
not failed: the design accepts f64; the acceptance is the count staying at the cases the
step names and the demos' pictures being unchanged (3.5).

**Accept.** Gate U, D with `x87.precision` at the named cases only.

**Could go wrong.** An entry reached with a top the region was not compiled for: the lookup
misses and the fallback runs it, correctly; `diagnostics().cork.exits.untranslated` rising
with a constant region count names the pattern, and a second specialisation is compiled at
the next `noteHot`. A region that leaves the stack in an unknown shape at exit does not exist:
every exit writes top and the mask.

**Out of scope.** Rounding modes (3.2), transcendentals (3.3).

### Step 3.2 — `fldcw`: rounding control, precision control, the truncation idiom

**Goal.** The control word's RC and PC bits are honoured at run time from a local loaded at
region entry and updated by `fldcw`, so the compiler idiom of the era — `fnstcw [t]; or word
[t], 0xc00; fldcw [t]; fistp [x]; fldcw [saved]` around every float-to-int conversion — stays
inside one region and truncates. `fist*` and `frndint` round by RC through a four-way
`br_table` over `f64.nearest/floor/ceil/trunc`; arithmetic results are demoted to f32 when
PC = 24 (a `select` of `f64.promote(f32.demote r)` against `r`), and PC = 64 is treated as
53 (documented: 80-bit results are not reproduced).

**Files.** Modify `cork/emit/x87.js`, `cork/emit/x87.test.js`, `docs/core/cpu.md`.

**Tests.** Concrete: `fistp m32` of `2.5` → `2` under nearest, `2` under trunc, `3` under
up, `2` under down; `-2.5` → `-2 / -2 / -2 / -3`; `1e19` → `0x80000000` (the integer
indefinite) and the invalid-operation bit set in the status word; `fistp m16` of `40000`
→ `0x8000`; `fisttp` truncates regardless of RC; the idiom above as bytes (`d9 7d fe 66 81
4d fe 00 0c d9 6d fe db 5d f8 d9 6d fe`) forms one block and stores `3` for `3.9` and `-3`
for `-3.9`; `fld m64 (1/3); fadd st0, st0` under PC = 24 stores the f64 whose low 29 mantissa
bits are zero; under PC = 53 the exact double.

**Differential (Gate D).** `frndint`, `fprem`, `fprem1`, `fprem-distinct`, `fscale`,
`fxtract`, `fxtract-zero` corpus cases; generated: 200 random doubles × 4 rounding modes
through `fistp m32/m64` on cork and the emulator, zero divergences.

**Accept.** Gate U, D.

**Could go wrong.** A program that sets PC = 24 for the whole run (some Direct3D-era
runtimes do at start-up) pays the `select` on every x87 op; the cost is measured in 3.5's
window and, if material, PC becomes a second specialisation key like top.

**Out of scope.** Exception masks and the x87 exception (`#MF`) — unmasked exceptions are
reported by `refused` as `x87.unmasked` at the `fldcw` that unmasks and the region is not
translated.

### Step 3.3 — transcendentals and the remaining forms

**Goal.** `fsin/fcos/fsincos/fptan/fpatan/f2xm1/fyl2x/fyl2xp1/fscale/fprem/fprem1/fxtract`
computed in f64 through imports into JavaScript's `Math` where wasm has no operation (sin,
cos, atan2, exp2, log2) and inline where it has one (`f64.sqrt`, `f64.nearest`). The
emulator computes the same way in f64, so the reference is the emulator's own result,
bit for bit; the hardware fixture is consulted with the runner's tolerance.

**Files.** Modify `cork/emit/x87.js`, `cork/emit/x87.test.js`, `cork/runtime/runtime.js` (the
`Math` imports).

**Tests.** Concrete: `fldpi; fsin` → `1.2246467991473532e-16` (the f64 sin of the f64 pi);
`fld1; fld1; fyl2x` → `0`; `fldz; fyl2x` sets the zero-divide bit and stores `-inf` with the
mask set (`fyl2x-zero.asm`'s expected state); `fptan` of `0` pushes `1` then `0`;
`fsincos` leaves `top` two lower; `fprem` of `10 mod 3` is `1` with `C2` clear.

**Differential (Gate D).** The corpus's f2xm1, fptan, fsincos, fyl2x, fyl2xp1, fyl2x-zero
cases; generated: 200 random arguments per operation in the operation's domain, cork
against the emulator, zero divergences.

**Accept.** Gate U, D.

**Could go wrong.** `Math.sin` differs between JavaScript engines by an ulp on some
arguments; the emulator runs in the same engine, so the differential comparison holds on
any one machine and the cached translation carries no numeric result. A program's picture
does not depend on the last ulp of a sine (3.5 checks the pictures anyway).

**Out of scope.** 80-bit results.

### Step 3.4 — `fnsave/frstor/fxsave/fxrstor/fldenv/fstenv` and the thread's x87 across a switch

**Goal.** The environment-saving instructions run on the fallback tier (they end a region
in 3.1) and the state block they read is always current; `captureContext`/`restoreContext`
under hybrid see the same x87 block the emulator's own would, because every cork exit wrote
it back.

**Files.** `internal/context.itest.js` gains the hybrid variants; `cork/emit/x87.js` (region
ends at those instructions with `exit.kind = 'untranslated'` and the eip of the instruction).

**Tests.** `context.itest.js` under `hybrid`: the existing "an x87 thread survives
interruption by MMX" and "pending arithmetic flags survive a switch" run with the thread's
loop translated (`regions > 0` asserted); `fsave_frstor.asm` and `fstenv.asm` corpus cases
in the differential suite (the save runs on the emulator, the arithmetic around it in cork).

**Accept.** Gate U, I, D.

**Out of scope.** Translating the environment instructions themselves.

### Step 3.5 — the GUI-heavy window and the whole library in hybrid

**Goal.** The design's milestone-3 acceptance.

**Tests.** Gate P on the GUI-heavy room window: ns per instruction, guest ms per frame,
`translatedShare`, `refused`, the `x87.precision` divergence count in a `differential` run
of the same window (short: the mode is slow). Every demo in the library run to completion
under `hybrid` through `game.mjs --engine hybrid` (the same routes the emulator's own
library check uses), pictures compared by the harness's existing frame capture against the
`emulator` run of the same demo: byte-identical where the demo is deterministic, and where
it is not (a timing-dependent particle), the same comparison the library check already
tolerates.

**Accept.** GUI-heavy ns per instruction at or below half the emulator's on the same
session; every demo completes; no picture differs beyond what the emulator's own run-to-run
differs.

**Could go wrong.** A demo that completes on the emulator and not in hybrid is a cork bug
found by bisecting `refused`/`exits` per region (the diagnostics name the region's entry
and the `differential` mode names the instruction). Never a per-title switch.

## Milestone 4 — whole programs

Goal of the milestone: calls, returns and indirect branches stay inside cork through the
entry hash; traps, `hlt`, `fs:`, `cpuid`, `rdtsc` and the string instructions translate;
precise exceptions reach the existing fault path unchanged; self-modifying code invalidates
through the page table; thread switches need nothing; three titles of different engines run
their demos in hybrid with ≥ 95 % of retired instructions translated.

### Step 4.1 — calls, returns, indirect branches: the entry hash

**Goal.** A direct `call` to a translated region is a wasm `call` (or `return_call` for a
`jmp`) to its function when both are in the same batch, and a hash lookup otherwise; `ret`
and `jmp/call r/m32` look the target up in an open-addressing table in cork's tables area
(`(eip * 0x9e3779b1) >>> (32 - 16)`, 65 536 slots of `{ eip, functionIndex }`, linear
probing, 8 bytes each) and `return_call_indirect` through the function table on a hit, or
exit `untranslated` on a miss. The stack is guest memory, as it must be (the program reads
its own return addresses).

**Files.** Create `cork/emit/control.js`, `cork/emit/control.test.js`; modify
`cork/runtime/entries.js` (the in-memory hash mirrors the JS map), `cork/region.js` (a
`call` inside the range is a block exit that continues at the return address),
`cork/runtime/runtime.js` (batches gather callees of a hot region's direct calls before
compiling, so a function and what it calls land in one module).

**Tests.** `control.test.js`: `call F; …; F: ret` inside one region returns to the
instruction after the call with `esp` restored; `jmp [table + eax*4]` with the target
translated dispatches through the hash (the test fills the hash from JS); a target not in
the hash exits `untranslated` with `eip = target`; the hash with 65 536 slots and 60 000
entries still finds every one (a probe-length test, max probe < 64); `ret 8` pops the
argument bytes. `entries.test.js`: `add` writes the slot the emitter's formula reads.

**Differential (Gate D).** `indirect-call.asm`, `indirect-jump.asm`, `ret-imm.asm`,
`jump.asm`; a generated call tree of 50 functions with random `call`/`ret` shape, cork
against the emulator.

**Accept.** Gate U, D; on 2.6's itest program with a call in the hot loop,
`exits.untranslated` per slice ≤ 1.

**Could go wrong.** A `call` whose return address the program rewrites (a trampoline)
returns somewhere with no entry; that is a miss and a fallback, never a wrong jump, because
the hash compares the full eip.

**Out of scope.** Inlining callees.

### Step 4.2 — traps, `hlt`, `fs:`, `cpuid`, `rdtsc`, the string instructions, `int n`

**Goal.** `out dx, eax` to the trap port is a call to the `trap` import with the state block
written back before and reloaded after; the import answers 1 when the handler changed EIP
(a hook's `holdEip`, a park redirect) or asked the machine to stop, and the region exits
`trap` with the handler's EIP. `hlt` exits `halt` (the hybrid host sets the emulator's
`in_hlt`, the park loop's contract). `fs:[disp]` loads `fsBase + disp`. `cpuid` writes the
constants the emulator answers (read once from it at boot so both engines agree). `rdtsc`
calls the import and splits the bigint. `rep movs/stos/cmps/scas/lods` are loops with
budget accounting per iteration group (16 elements per count) so a megabyte `rep movsd` does
not overrun the quantum. `int n` with `n ≠ 3` exits `fault` with vector `n` (the ROM's stub
reports `int 0x21 with no handler` today; the hybrid host makes the emulator raise it, 4.3).
`in`, `cli`, `sti`, `out` to any other port, `bound`, `into` are refused (`reason: 'trap
port only'` / `'not user mode'`).

**Files.** Modify `cork/emit/control.js`, `cork/emit/integer.js`, `cork/emit/memory.js`,
`cork/runtime/runtime.js`, `internal/hybrid-host.js` (the `trap` import: forwards to the
host's `onTrap` handler exactly as the port write does, then compares EIP and the stop
flag), tests beside each; `docs/core/cpu.md` ("Traps" under Engines), `docs/core/bridge.md`
(one sentence: a hook's `holdEip` is honoured by cork through the same handler).

**Tests.** `control.test.js`: a region `mov dx, port; mov eax, 7; out dx, eax; inc ebx`
with a `trap` import that records `7` and returns 0 continues to `inc ebx`; with an import
that sets `eip = 0x9000` and returns 1 exits `trap` with `eip = 0x9000` and `ebx`
unchanged; the import sees `ebx` as set by the instruction *before* the `out` (the writeback
happened); `hlt` exits `halt`. `mov eax, fs:[0x18]` with `fsBase = 0x7ffde000` reads
`[0x7ffde018]`. `rep movsd` of 100 000 dwords with a budget of 50 000 exits `budget` with
`ecx`, `esi`, `edi` mid-way and the copy correct on resumption. `cpuid` leaf 1 returns the
emulator's four words.

**Integration (Gate I).** `hello.itest.js`, `imports.itest.js`, `callbacks.itest.js`,
`threads.itest.js` run under `hybrid` with `regions > 0` asserted (a variant of each,
selected by an environment variable `BOTTLIFY_ENGINE=hybrid` the itests read, so the
emulator variants are unchanged files).

**Accept.** Gate U, I, D, E.

**Could go wrong.** The bridge's dispatcher may call back into guest code from inside a trap
(a callback: it restores a context and runs slices *from within the handler*). In hybrid that
re-enters `runSlice` while cork's region is on the wasm stack — re-entrancy the emulator's
port write already allows and cork's region must too: the import is a plain function call,
the nested slices run on the same memory, and the region resumes with the state block
reloaded. `callbacks.itest.js` under hybrid is the test; a nested slice that enters *the same
wasm function* recursively is legal wasm.

**Out of scope.** Batched host calls (a later, separate change, as the design says).

### Step 4.3 — precise exceptions reach the existing fault path

**Goal.** A `fault` exit (vector 0, 6, 3, `n`, or 13 from the page flags) is delivered the
way every fault is delivered today: the hybrid host, holding the state block exactly as at the
faulting instruction, lets the *emulator* execute that instruction, which raises the vector
through the ROM's interrupt stub, pushes the frame, traps `0xf000 + vector`, and lands in
`module.js`'s existing `readFault` — so a report, a `CONTEXT` for structured exception
handling, and `describeFault` are byte-identical between engines. For vector 13 from the
page flags (an access the emulator would not fault on, by design of 2.4's parity) the hybrid
host records the fault itself with `hostFault({ vector: 13, eip, … })` and halts, since the
emulator has no view to raise. In cork-alone mode (M5) cork's host records every fault
itself the same way.

**Files.** Modify `internal/hybrid-host.js`, `internal/hybrid-host.test.js`,
`module.itest.js` (the fault cases under hybrid), `docs/core/cpu.md`.

**Tests.** `module.itest.js` under hybrid: a translated loop that ends in `idiv` by zero
reports `divide error at 0x…` with the same `eip`, `calledFrom` and `errorCode: null` as
under the emulator; `ud2` reports `invalid opcode`; `int 3` reports `breakpoint` with the
frame's EIP one past the byte; the double-fault test unchanged; `corpus.itest.js`'s
signal-carrying cases (idiv overflow, `mov_sreg_ud1/2`) under hybrid map to the same vectors.

**Accept.** Gate U, I, D, E. Fault records equal field for field.

**Could go wrong.** The emulator re-executing the faulting instruction must not have side
effects before the fault: a faulting `idiv` has none; a faulting load has none; a store into
an inaccessible page is *not* performed by cork's slow path for `INACCESSIBLE` (only for
`HAS_CODE`); the test "a store into an inaccessible page leaves the target unchanged" pins it.

**Out of scope.** Delivering exceptions to a guest handler (that is the layer above's,
unchanged).

### Step 4.4 — self-modifying code and host writes

**Goal.** A store into a page with `HAS_CODE` exits `stale`; the runtime removes every
region that spans the page from the entry maps and the hash, clears the page's flag if
nothing else holds it, and the program continues on the fallback tier until the page is
hot again. A page invalidated more than `volatileLimit` (8) times becomes `VOLATILE`: no
region is formed on it again this run (an unpacker's target is written once; a page that
mixes code with a counter is written forever, and translating it again is what the emulator's
`modulesLostToWrites` counter shows it doing). The host's `writePhysical` calls
`cork.invalidatePage` for each page touched, beside the emulator's own invalidation;
`writeData` does not (its contract is that the target is never executed).

**Files.** Modify `cork/runtime/runtime.js`, `cork/runtime/pages.js`,
`internal/hybrid-host.js`, tests beside each, `docs/core/cpu.md` ("Self-modifying code").

**Tests.** `runtime.test.js`: a region whose code is overwritten from JS via
`invalidatePage` is gone from `entryOf` and the hash, `invalidations === 1`; a region that
writes into its own page (`mov byte [L], 0x90` then the loop) exits `stale`, the write is
in memory, and a rerun after re-forming executes the new byte (a `nop` where a `dec` was:
the loop count changes accordingly); the ninth invalidation of one page marks it `VOLATILE`
and `noteHot` on it forms nothing. `hybrid-host.itest.js`: an unpacker-shaped program
(copy a routine into a buffer, patch a constant, call it, patch again, call again) gives the
same results as the emulator and `regions` settles.

**Accept.** Gate U, I, D.

**Could go wrong.** A region running in cork while its page is being written *by the host*
(a loader write from inside a trap): the trap import returns 1 when `invalidatePage` was
called during the handler (a generation counter compared before and after), so the region
exits `trap` at the next instruction and is not resumed after it was discarded.

**Out of scope.** Translating code that the same region writes (it runs on the fallback).

### Step 4.5 — thread switches and diagnostics

**Goal.** Nothing to build for switches (every exit leaves the block complete, and a slice
ends outside cork); the step is the proof, plus the diagnostics of §2.4 in the counters table
and in the launcher's overlay row that already shows the cpu's figures.

**Files.** `internal/context.itest.js` (hybrid variants with `regions > 0`), `module.js`
(the `cork.*` counters), `docs/core/cpu.md`, `docs/core/log.md`, the launcher's overlay
reader (one row: engine, translated share, regions, cache hits).

**Tests.** `threads.itest.js` under hybrid: two threads in translated loops interleave under
the scheduler with the same final memory as the emulator run; `context.itest.js`'s x87 and
flags cases under hybrid; `module.test.js`: `CPU_COUNTERS` includes `cork.translatedShare`
and the frame sampler writes it.

**Accept.** Gate U, I, E.

### Step 4.6 — three titles in hybrid at ≥ 95 % translated

**Goal.** The design's milestone-4 acceptance, on three titles of different engines from the
library's demos.

**Tests.** Gate P per title on its held window: `translatedShare ≥ 0.95`, the `refused`
list, the frame budget against the master plan's thresholds, pictures against the emulator
run as in 3.5. Each refused opcode met is a table entry with its differential test, its own
commit; each divergence found by a `differential` run of the window is a fix with its test.

**Accept.** Three titles at `translatedShare ≥ 0.95`; frame budget within thresholds; no
picture divergence beyond run-to-run; Gate E still identical.

## Milestone 5 — cork alone

Goal of the milestone: cork runs the library's demos with `engine: 'cork'`, where nothing of
the emulator is loaded — not its machine, not its wasm; the one thing the product still took
from that wasm, the zstd decoder, is replaced by a decoder of this project's own; the default
engine becomes `cork`; and the emulator becomes *optional*: selectable per bundle launch, its
artifacts fetched only for a launch that selects it, absent from a build that leaves it out,
with its vendoring, build pipeline and pinning kept for those who select it.

### Step 5.0 — a zstd decoder of this project's own

**Goal.** `decompressZstd` on the cpu api exists only because the emulator's wasm happened to
carry one; a bundle block is decoded synchronously inside a guest file read. A decode-only
zstd implementation in JavaScript (frames, blocks, the three Huffman/FSE table kinds,
sequences, the window; no dictionaries, no checksum verification beyond reading it) replaces
it, placed beside the bundle code rather than in the cpu layer, since it has nothing to do
with the processor.

**Files.** Create `modules/core/src/zstd.js`, `zstd.test.js`, `zstd.itest.js`; modify
`app.js` (`mountBundle` decodes through it instead of `cpu.decompressZstd`), `docs/core/host.md`,
`docs/core/cpu.md` (`decompressZstd` marked as leaving the api in 5.5, its one caller now served here).

**Contract.** `export function decompressZstd(packed: Uint8Array, expectedLength: number): Uint8Array`
— the same signature the cpu api had; throws `zstd: frame ended before it was supposed to`
and `zstd: unsupported <feature>` (a dictionary id, a window larger than 128 MiB).

**Tests.** `zstd.test.js`: frames produced by Node's own `zlib.zstdCompressSync` (Node ≥ 22.15)
for: an empty input, 1 byte, 4 KiB of one byte (RLE block), 64 KiB of text (compressed
blocks with all three literal encodings, forced by different compression levels), 1 MiB of
random bytes (raw blocks), a 3 MiB input spanning several blocks with matches across block
boundaries, a frame with a content checksum; each decodes byte for byte; a truncated frame
throws the first message; a frame naming a dictionary throws the second. `zstd.itest.js`:
every block of the harness's test bundle decodes identically through the new decoder and the
emulator's, and the decode time per megabyte is printed (a JavaScript decoder is expected
within 2–3× of the wasm one; a guest file read is not on a hot path).

**Accept.** Gate U, I; the itest's byte-identical result on every block.

**Could go wrong.** FSE table construction has three off-by-one traps (the `-1` symbol
counts, the baseline/number-of-bits accumulation, the state update order); each is a
concrete test vector taken from the format's own worked example in the RFC.

### Step 5.1 — the cork host: its own memory, layout and contexts

**Goal.** `internal/cork-host.js` implements the host interface over cork's own memory: a
`WebAssembly.Memory` of `memorySize + tables + state` pages, `OWN_LAYOUT`, no ROM (boot
sets the registers the ROM would have: flat segments are implicit, `esp = initialStack`,
`eip` = the entry vector's target read at the first slice), the thunk table unchanged (the
stubs are guest code cork translates like any other), `captureContext`/`restoreContext` as a
copy of the 512-byte block plus `fsBase`, `readReg32('eflags')` from the eager word, the
fault record built by the host from a `fault` exit. Nothing of the emulator is imported,
fetched or instantiated on this path.

**Files.** Create `internal/cork-host.js`, `internal/cork-host.test.js`,
`internal/cork-host.itest.js`, `cork/runtime/layout.js` (`OWN_LAYOUT`), modify `module.js`
(`engine: 'cork'` accepted; `boot()` under `cork` takes no `moduleUrl`/`wasmBytes`),
`internal/context.js` (a second capture/restore over the block; the emulator's stays until
5.5), `docs/core/cpu.md` ("Engines": cork alone).

**Tests.** `cork-host.test.js`: contexts round-trip every field of the block (a filled block
captured, zeroed, restored, compared byte for byte); `newContext` positions eip and esp;
`readReg32('eflags')` is the word. `cork-host.itest.js`: `hello` under `engine: 'cork'`
with the interpreter of 5.2 stubbed to "refuse everything" fails loudly with
`cpu: cork has no tier for 0x… (…)`, proving nothing runs silently.

**Accept.** Gate U, I, E (the emulator path untouched).

**Out of scope.** Running a program (5.2).

### Step 5.2 — the interpreter tier

**Goal.** Code cork has not translated — cold code, a refused instruction, a volatile page —
runs on cork's own interpreter: the decoder of 2.1 and the evaluator of 2.2 over the state
block, one instruction at a time, counting each. Small, table-driven, correct, slow; it is the
tier for the instruction met once, and the differential harness proves it against the
emulator on the whole corpus.

**Files.** Create `cork/interp.js`, `cork/interp.test.js`, `cork/interp.itest.js`; modify
`ir.js` (the evaluator gains the x87/SSE/MMX operations it lacked, since M2–M4 needed it only
for integer tests), `internal/cork-host.js` (the slice loop: translated entry → cork, else
interpret until one).

**Tests.** `interp.test.js`: the evaluator's vectors of 2.2 through the interpreter over a
memory; a `rep movsd` bounded by the budget; a trap through the import; `hlt` halts.
`interp.itest.js`: the whole corpus on the interpreter alone matches the hardware fixtures
and the emulator (the same `corpus.itest.js` cases, `engine: 'cork'` with translation
disabled by a test-only `cork.translate: false`).

**Accept.** Gate U, D: corpus green on the interpreter; `x87.precision` at the same named
cases as 3.1.

**Could go wrong.** The interpreter and the emitter disagreeing on an instruction is caught
twice: the corpus (interpreter versus fixture) and the differential suite (emitter versus
emulator). The evaluator is one function per operation shared by both, so the disagreement
can only be in the glue.

### Step 5.3 — translation policy in cork mode and the library's demos

**Goal.** In `cork` mode hotness is counted by the interpreter per block start (a counter in
the tables area), regions form at the threshold, and the demos run to completion with the
emulator's machine absent.

**Files.** Modify `internal/cork-host.js`, `cork/runtime/runtime.js`, tests, `docs/core/cpu.md`.

**Tests.** `cork-host.itest.js`: `hello`, `imports`, `callbacks`, `threads` under `cork`;
`diagnostics().engine === 'cork'`, `cork.translatedShare > 0.9` on `threads`. Gate P on the
three held windows under `cork` against `emulator` and `hybrid` in one session: ns per
instruction under `cork` equal to `hybrid`'s within noise (the same translations; the
fallback differs). Every demo in the library under `cork` completes with pictures as in 3.5.

**Accept.** The library's demos complete under `engine: 'cork'`; Gate E identical (the
emulator path is untouched by this step).

### Step 5.4 — `cork` becomes the default engine

**Goal.** The one-line change, its own commit, after 5.3's run: `engine` defaults to `cork`;
the launcher and `game.mjs` run it without a flag; `--engine emulator` still selects the
emulator for a paired measurement.

**Files.** `module.js`, `app.js`, `docs/core/cpu.md`, `docs/core/host.md`,
`tools/cdp_test/README.md`; every itest that asserted `regions > 0` under an environment
variable now does so by default, and the emulator variants become the ones selected by
`BOTTLIFY_ENGINE=emulator`.

**Tests.** Gate U, I under the new default; Gate P on the three windows with `--engine emulator`
as the control, recorded as the milestone's before/after table in `decisions.md` §B.

**Accept.** The paired table shows ns per instruction at or below the design's target on
each window (plain ≤ 1.0, GUI-heavy ≤ 1.5, lit ≤ 1.0) and no picture divergence.

### Step 5.5 — the emulator becomes an optional layer, chosen at launch

**Goal.** The explicit dependency is gone while the emulator stays selectable. Concretely:
`@bottlify/core` builds, tests and runs with `vendor/prebuilt/` empty and the `vendor/v86`
submodule not checked out (`engine: 'cork'` is the default and touches nothing of it); the
package's `./libv86.mjs` and `./v86.wasm` exports stay and are *optional* — `check-package`
accepts a `dist/` without them and `createApp` under `emulator`/`hybrid` reports
`cpu: the emulator is not available in this build (engine "emulator" needs it)` rather than
failing on a fetch; `AppOptions.v86` (its `moduleUrl`/`wasmUrl`) is read only for those
engines; the launcher shows the engine choice per bundle (cork, emulator, hybrid) with the
manifest's `engine` field as the preselection, remembers it per bundle, and fetches the
emulator's artifacts on demand for a launch that needs them; `cpu.decompressZstd` is gone from
the api (5.0 replaced its one caller); the `jit` option and the `jit.*` counters stay, valid
under the emulator engines and reported `-1` under `cork`. The differential oracle and the
corpus stay as they are; `THIRD-PARTY-NOTICES.md` says the emulator is an optional component.

**Files.** `module.js`, `app.js` (`engine` selection, the refusal message, the artifact fetch
only on demand), `scripts/check-package.mjs`, `scripts/build.mjs` (the emulator copied into
`dist/vendor/` when present, the build not failing when absent), the launcher's bundle card
and settings (outside `modules/core`; `ui/`), `docs/core/cpu.md` ("Engines": choosing one at
launch; "Limitations": what each engine lacks), `docs/core/host.md` (`engine`, the manifest
field, the refusal), `docs/core/README.md`, `roadmap/decisions.md` §B (the emulator as an
optional layer, with the milestone table).

**Tests.** `check-package.test.js` (new): a `dist/` without the emulator passes; `npm test` and
`npm run check:boundaries` green with `vendor/v86` absent and `vendor/prebuilt/` empty (the
boundary checker's `layerRequires` and the module tests never touch them); `module.test.js`:
`create({ engine: 'emulator' })` then `boot()` without artifacts rejects with the message
above; `npm run test:integration` green with the prebuilt fetched (the emulator engines and
the oracle); a manifest with `"engine": "hybrid"` reaches `createApp` as `engine: 'hybrid'`
(`app.test.js`); the launcher's choice overrides the manifest's.

**Accept.** A fresh clone without the submodule and without `fetch:v86` builds, tests and runs
the library's demos under `cork`; the same clone after `fetch:v86` runs them under `emulator`
and `hybrid` from the launcher's selector; Gate E under `emulator` still identical to its
baseline.

**Could go wrong.** Something outside the cpu layer still reaches an emulator export or
assumes its memory layout (the audio worklet's ring reads, the log keeper's mirror): running
the whole itest set with `vendor/prebuilt/` empty under `cork` is the net, and the grep for
`v86` across `src/` outside `layers/cpu/` is part of this step's commit message.

## 6. Acceptance summary

| step | number that decides |
|---|---|
| 1.1 | instruction count identical, hybrid vs emulator, on `hello` |
| 1.2 | corpus green on the emulator through our harness (count recorded) |
| 1.4 | emulator-vs-itself replay: zero divergences on every case |
| 2.3 | integer corpus: zero divergences vs emulator and vs hardware |
| 2.5 | SSE/MMX corpus + 200 random lane sets per op: zero divergences |
| 2.7 | `translatedShare > 0.95`, `handoffMisses = 0` on the itest program |
| 2.8 | second boot: `cacheHits = regions` |
| 2.9 | lit-scene guest ms drops by the sidecar kernels' measured share; `refused` empty |
| 3.2 | 800 `fistp` cases: zero divergences |
| 3.5 | GUI-heavy ns/instruction ≤ ½ the emulator's; every demo completes in hybrid |
| 4.3 | fault records equal field for field |
| 4.6 | three titles ≥ 95 % translated, frame budget within thresholds |
| 5.0 | every bundle block decodes byte-identically through the project's own zstd |
| 5.2 | corpus green on the interpreter |
| 5.3 | library demos complete under `cork` with nothing of the emulator loaded |
| 5.4 | paired table: plain ≤ 1.0, GUI-heavy ≤ 1.5, lit ≤ 1.0 ns per instruction |
| 5.5 | fresh clone without the submodule or the prebuilt runs the demos under `cork`; after `fetch:v86` the same demos run under `emulator`/`hybrid` from the launcher's selector |

## 7. Provisions for x86-64

The owner wants 64-bit programs supported in the future. None of the five milestones builds
it (the design's §9 says the same), but the seams below cost nothing now and would each be a
rewrite later, so every step that touches them respects them and a test pins each one:

- **The decoder takes a mode** (`decode(read, eip, { bits })`, 2.1). The table's operand-form
  letters are the manual's own and already distinguish `v` (operand-size dependent) from `d`
  (fixed 32), so a 64-bit table adds REX handling, the `q` forms and RIP-relative addressing to
  the resolver without renaming anything. In 32-bit mode a REX-range byte (`40`–`4f`) is
  `inc/dec r32`, and the test "REX bytes are inc/dec in 32-bit mode" keeps the two modes from
  being confused when the second arrives.
- **The IR and the evaluator are width-parametrised**: every arithmetic operation takes
  `size ∈ {1, 2, 4, 8}` and the lazy-flag algebra (`flags.js`) is written for a size, with
  `8` computed on `i64`; the flag vector table of 2.3 includes the size-8 rows even though no
  32-bit instruction produces them, so the algebra is proven before a decoder needs it.
- **The state layout has a width** (`bits`, §2.2): registers are addressed by index and width,
  never by the name `reg32` inside the emitter; 64-bit mode is 16 × i64 general registers, 16
  XMM, and `rip`. `fsBase` becomes `gsBase` in 64-bit Windows (the thread block moves to GS);
  the layout names both fields from the start, one of them unused.
- **The entry hash keys on a full address**, not a 32-bit truncation: entries are stored as
  two words (`lo`, `hi`) and compared as such; in 32-bit mode `hi` is always 0 and the probe
  compares it anyway (one extra `i32.load` per lookup, measured in 4.1 and folded away if it
  shows).
- **Guest addresses are `number`s below 2^53 everywhere on the JavaScript side**, never
  `| 0`'d into signed 32-bit; the page-flag table is indexed by `address >>> 12` today and by
  a two-level table in 64-bit mode; `pages.js` exposes `pageOf(address)` so the change is one
  function.
- **Memory.** A 64-bit guest needs an address space wider than 4 GiB. Two ways exist and the
  choice is deferred: wasm `memory64` (a 64-bit index space, shipping in current browsers)
  emitting `i64` addresses, or a 32-bit wasm memory with the guest's addresses laid out in a
  4 GiB window (Windows programs of the era rarely exceed it). The emitter takes the address
  type from `layout` (`addressType: 'i32' | 'i64'`) rather than hard-coding `i32`, and every
  load/store goes through `emit/memory.js`'s two helpers, so the decision touches one file.
- **What stays 32-bit-only by design**, and would be a separate plan: the ROM and the trap
  stubs (the thunk table is 32-bit code), the win32 layer's calling conventions and structure
  layouts, the loader's PE32 reading. Cork's translator is not the part of the engine that
  makes 64-bit hard; those are.

## 8. What this plan could not verify

- **The host's default NaN.** An invalid float operation (0/0, inf - inf, the square root of
  a negative) leaves x86's default NaN, 0xffc00000, sign set; an arm64 host's engine leaves
  0x7fc00000. `features().defaultNaNNegative` probes `0 / 0` once, and on a host whose
  answer is positive the SSE emitter follows every float operation with a fix-up (a NaN lane
  whose inputs were not NaN becomes the default NaN); an x86 host emits nothing extra. The
  corpus proves the fix-up on the arm64 development VM; that an x86 host indeed leaves the
  hardware bits without it is expected of the engine and is verified the first time the
  corpus runs there.

- **The corpus asset.** The fork's CI runs the corpus but does not publish it; step 1.2 adds
  that publication. The count of cases in the built corpus (hand-written 127 plus generated)
  is known only when the asset exists.
- **Importing the emulator's memory.** The prebuilt module exports its memory (`cpu.wasm_memory`)
  and creates it inside the wasm; a second module can import an exported `WebAssembly.Memory`
  when its declared limits fit, which step 2.6's runtime test on a plain `Memory` does not
  prove for *that* memory — `hybrid-host.itest.js` in 2.6 is the first proof, and its failure
  mode (a `LinkError` naming the limits) is loud.
- **SIMD and tail calls on the development machine's Node.** Expected on Node 22; step 1.5's
  probe records the answer.
- **The sidecar kernels' measured share** (2.9's acceptance) is in that title's sidecar
  report, not in this tree; the number is copied into the commit that reports the run.
- **The handoff export** (2.7) is a fork patch with a cost the emulator path pays; Gate P in
  that step decides whether it stays where it is placed.
