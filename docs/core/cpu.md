# `cpu` — guest execution

The layer that runs x86 code. It is the only part of `@bottlify/core` that knows an emulator is
underneath: everything above it speaks in terms of running, stopping, registers, physical memory
and traps. Module machinery is described in [`README.md`](./README.md) and
[`system.md`](./system.md); the process assembler that drives this layer is in
[`host.md`](./host.md).

## 1. Purpose

`cpu` owns the emulated processor: it boots the machine straight into 32-bit protected mode with a
64 KiB ROM of its own (no BIOS), runs guest code in slices bounded by retired instructions, hands
out guest-side call stubs that trap into the host, captures and restores a thread's complete CPU
state, reports processor exceptions by name, and exposes the zstd decoder the emulator carries
(a compatibility accessor, leaving the api in 5.5; the bundle path no longer uses it).

It deliberately does not know what a trap *means* (that table is the bridge's), when a thread
should be switched (the kernel's), or what is mapped where (the memory layer's). It emits
stubs and reports numbers; it captures contexts and restores them on request. Guest RAM is
reached through `readPhysical`/`writePhysical` with no validation — validation is what the memory
layer adds on top.

### Engines

The layer runs a program on one of two execution engines, chosen per launch. The vendored
emulator is the one everything below describes. The other is a translator package
(`@bottlify/cork`, `modules/cork`), which the layer loads at `boot()` by a module URL in its
configuration, the way it loads the emulator, and which implements the executor contract the
layer defines in `src/layers/cpu/engine.js`: an `EngineFactory` that takes the layer's memory,
a `StateLayout` naming where every register lives, and the host functions translated code may
call, and answers a `Runtime` (`entryOf`, `run`, `noteHot`, `translatePending`,
`invalidatePage`, `diagnostics`). The layer never imports an engine package — `check:boundaries`
refuses it — so a launch that selects the emulator runs with no translator installed, and a
launch that selects the translator loads nothing of the emulator. The `engine` configuration
field selects one per launch, and a launch that names none runs the translator (`engine: 'cork'`,
`DEFAULT_ENGINE`); the emulator is selected by name, and stays the reference the translator's
suites judge it against. There is no third engine: the hybrid that ran the translator over the
emulator's memory, and the differential that replayed it there, are gone. `diagnostics()` reports the selected engine as
`metrics.engine` and the translator's own report as `metrics.cork` (null when none is
attached).

Between regions, translated
code needs no slice loop at all where the engine has tail calls: every region function is
placed in one function table shared by every module, every entry (block start, x87 top) is
mirrored into an open-addressing hash in the translator's tables (262 144 slots of the
address, the table index, the label and the top), and an exit for an untranslated address
with budget left probes that hash in the epilogue and tail-calls the region found -- a
return, an indirect jump or a call into translated code costs no crossing, and a hot
region's direct callees are formed in the same batch so the call and the return both hit --
up to the batch's ceiling (`maxBatchRegions`), not its usual size (`batchRegions`), and taken
as in flight like the batch's own candidates: a loading phase's function calling dozens had
the first thirty-one formed with it and the rest run by the interpreter, their loops hot
before their starts and so regions of their own headed there, where now each callee is one
region from its start. cork-bench's loading workload's first iteration went from 2 062
regions in 214 modules and 6 relinks, 59 % of it translated, to 1 530 in 32 and one relink,
94 % translated: its first host 1 825 -> 1 438 ms and a later host's first iteration 573 ->
390 (a process a sample, 7 each); no other cork-bench workload forms a batch that deep, and
their regions and modules are the same. A
switch's jump costs no transfer at all: `jmp [table + r*4]` whose index the branch into its
block bounds -- the last flag writer before it `cmp r, n` (or `cmp` of the memory a `mov r` at
the block's start loads the index from, with only register writes that leave it alone between),
then `ja`/`jae` falling through or `jbe`/`jb` taken -- is formed with the table's entries as its
targets (`switchTable` in `region.js`; the table's bytes are hashed with the code and its pages
are the region's), and the jump picks its case by a `br_table` on the index and branches there
when the entry it loaded still names the case it was formed with; an index past the table, an
entry written since or a case the caps left out leaves as any indirect jump does. A bytecode
interpreter's dispatch loop went 800 -> 385 us an iteration, a message pump and a tokenizer
250 -> 162. A switch on an index masked to its low bits (`x & 15`, or `x % 16` unsigned), whose
table has every case and so no bound test, is bounded by the `and r, m` in the jump's own block
(only register writes that leave r alone after it) and formed with its m + 1 entries: its cases
were each a region of their own, formed the second time the machine met one, so a loading phase
that meets a new case now and then translated one more small module every few iterations long
after its code was warm -- cork-bench's loading workload, whose switches on `x % 16` and the
like are 29 of 178, formed 73 regions in its iterations 10 to 39 and now forms one in its
iterations 3 to 39, and its steady state went 1.62 -> 0.88 ms an iteration. A batch does not form a candidate that a region it formed before already holds
as a block (one with no x87, whose blocks are entries at any top): a loop's head and its cases
are hot together, and each formed the whole loop again -- the bytecode interpreter's first
iteration made fourteen regions of it and now one, and a program of 1 500 small functions its
first iteration in 633-696 ms where it took 947-1 061. A transfer is the caller's store of the state block and the callee's load of it, so each region moves only what it names: its registers and x87 registers are loaded if the body uses their locals at all and stored only if it writes them (a register written on one path is still loaded, so the other path stores what came in), placed once the body is written; and the lazy flags are folded at an exit only when the record is not already whole. A call-and-return of a small function (two transfers) went 19 -> 16 ns, and with an x87 body 25 -> 17 ns. Under cork's own layout a transfer carries the rest in its call: a region function takes seventeen parameters -- the label and the budget, the eight registers, the five words of the flag record, the flags word and the budget the run started with at the host (`STATE_PARAMS`, locals 0..16) -- and a transfer passes its locals, so the registers, the record, the flags, EIP, the previous IP and the counter word are written only when the run leaves for the host, and a callee loads none of them. A block charges its instructions to the budget alone: what the run retired is what it took off the budget it started with, added to the counter word when it leaves (and before a region calls the host's trap handler, after which it counts from the budget left), where every block also added to a count of its own that each loop carried and each transfer passed -- the count stays exact, and a loop of four blocks a turn went 1.89 -> 1.77 ns a turn, one of seven 3.59 -> 2.88, one with a call formed in 3.37 -> 3.01; on the benchmark, each workload in paired rounds of one process, 6.2 % less over the eleven that are not dominated by translation or transfers with branch hints and 4.3 % without (the float math 7-11 %, strings and sorting 6-10 %), calls4096 14-18 %, and calls512 and the rest within their noise. Its exit then writes all eight registers, since the ones it never named came in as parameters and are not in the block, and a reload after a trap's handler takes all eight back. The host enters through `enterRegion`, which reads the same state from the block; the vector registers and the x87 block still go through it. A call of a function kept out of its caller (two transfers) went 12.3 -> 11.4 ns, with an x87 body 15.3 -> 13.7. A region over the emulator's layout takes the parameters and loads its state from the block as before. Under cork's own layout the lazy flags are not folded at an exit at all: the layout's `flagRecord` (five words after `eflags`: the kind with its width, the result, the two operands, the carry in) takes the record as the region holds it, and the next region loads it back as a record of unknown kind -- it mostly writes the flags before it reads them. Whoever reads the word outside translated code folds it first, through `eflagsOf` (the host's `readReg32('eflags')`, the interpreter's `syncIn`, the test machine), with the same helper function the regions call, in its own small module; `setEflags` writes the word and clears the record. Inside a region a read at a block's start, where the record's kind is not known, checks it against the kind the block before left (the second `jcc` of `cmp; je; jl`) -- or, for a loop's head, the kind its latch will leave, its last flag writer's (a tree search's `cmovae` at the head reading the CF of the `cmp` at the bottom called the helper every turn: 6.1 -> 2.5 ns a turn, the tree workload 780 -> 571 us an iteration) -- and reads the record inline when it matches, the helper otherwise; and an `inc`/`dec` -- which keeps only CF of the record before it -- computes that CF inline (known kind) or branch-free from the record (unknown kind) rather than folding all six: a `dec ecx; jnz` after an `add` or a `xor` called the helper every turn. A counting loop 0.7 -> 0.3 ns an instruction, a call-heavy loop 3.0 -> 1.8-2.0, a load/add/store loop 3.3 -> 2.4-2.6. A record is left out wherever no reader follows it before another write, over the region's blocks and not only within one (`liveFlagsOut`, whatever `structure` says, each block's kills and early reads taken once and iterated to a fixed point): a block's end is live for what its successors in the region read -- all of it where a way out leaves the region, and at a jump back whose budget is spent what the target reads, since the host resumes there -- and an instruction that writes flags and nothing else (`clc`, `stc`, `cmc`, `sahf`, `bt`, the ZF of `bsf`/`bsr`, `cmpxchg8b`) emits nothing when they are dead, where its partial write folded the record first; a shift or `shld`/`shrd` by cl, which may write no flag at all, folded the record before it every time so that a count of zero left it whole, and with its own flags dead now keeps its value apart from the record and leaves it alone (a `sar eax, cl; test al, 1` in a decoder's loop: the CRC workload 325 -> 224 us an iteration). By default (`precise: false`) an instruction's undefined flags count as written too (see section 4): an `imul` in a hash loop kept the `xor` before it alive through the `test` after it, whose AF is undefined, and folded it every turn to leave SF, ZF, AF and PF as the emulator does. An FNV-1a loop 4.0 -> 1.5 ns a turn; on the benchmark, each workload in paired rounds of one process, the string workload 427 -> 297 us an iteration and the bytecode interpreter 348 -> 275, 5.4 % less over all thirteen. The hybrid layout keeps no record (its flags are the emulator's word), so a region over it folds at the exit as before. Cheaper still is no transfer: a direct call to a small callee -- at most sixteen blocks and 512 bytes reached by direct branches alone, every way out a `ret` (`isLeaf` in `region.js`) -- forms the callee into the calling region. A callee of the entry's own function may make direct calls of its own (they leave through the hash as any call does, and come back to the block after the call, which `inlineReturns` walks on to); one formed in that way takes in leaves only, so the forming goes one level deep. The entry's own function is formed first and the callees take only what the caps leave, so formed-in callees never cut the caller's own loops: a two-level call chain in a loop went 14.3 -> 8.7 ns a turn with no transfer, and the caps are 128 blocks (`maxRegionBlocks`) and 8192 bytes -- at 64 blocks seven of Doom 3's twelve hottest functions were cut short. The call pushes its return address and jumps to the callee's block; a `ret` the callee reaches compares the address it popped with the return addresses of the calls that formed it in (`inlineReturns`) and jumps there on a match, and leaves through the hash as before otherwise, so a callee that rewrites its return address or is entered from elsewhere stays exact. The `ret` charges its block once, at the block's depth, before those comparisons: charged inside a match it was charged again by the jump's own spent-budget or untranslated exit (`inc edx; ret` counted +2 at every budget exit). The x87 tracker takes those returns as edges, so a callee returning a value on the stack (`fld1; ret`) no longer leaves its return address unknown, and the callee's pages are the region's, so a write to them invalidates the caller. A push of the return address into code leaves `stale` at the callee. A loop calling such a function went 17 -> 7 ns a turn, with an x87 body 20 -> 10, and a `_ftol2`-shaped callee 40 -> 12. `leafCalls: false` in the translator's settings turns it off. A `call` to the instruction after it (`call $+5`, the way position-independent code finds its own address) is no call: the former takes it as the push of its return address (`exitOf`) and the block goes on past it. As a call, its callee and its return address were one block, which the tracker took as the target of the `ret` the callee was formed in with; x87 code whose stack is deeper or shallower at that `ret` than at the call -- a function that finds its constant by its own address and returns it in ST0 -- gave the block two tops, and the region cut it and left there on every call: a loop calling such a function went 129 -> 12 ns a turn on the cork host, what the same function reading its constant by an absolute address costs. The test machine keeps no entry at a cut block either, as the runtime does not, and forms a region there for the top the machine has (`runProgram` had entered the region that cut it again and stopped with kind -2). A direct call to one of the compiler runtime's helpers is not a call at all (`helpers.js`): a helper every program built with one compiler links in byte for byte -- MSVC's `_ftol2`, the conversion every `(int)f` compiles to, is the one listed -- is recognised at the call's target by the fingerprint of its exact bytes, never by an address, and the call is formed as the instructions it computes, `_ftol2` as `fisttp qword [esp-8]` and the two dwords into edx:eax. With the x87 registers held as doubles that is exactly what its twenty instructions leave -- truncation toward zero, NaN and anything out of range the integer indefinite -- and only EFLAGS differ, which a compiled caller does not read after a call; each of the formed instructions carries the call's address, so an exit before them runs the real call, and the helper's bytes are in the region's pages and its hash, so a program that rewrites them gets the real helper back. Doom 3's own `_ftol2` and the formed call answered alike over 4 031 values (halves, NaN, infinities, ±2^63 and their neighbours), 32.4 -> 7.7 ns a call in a loop under node; Doom 3 from a saved game in Chrome, four runs each way interleaved, presented 1 170-1 218 frames in 150 s without it and 1 866-2 489 with it, the canvas over the last 30 s 17.1-18.1 -> 19.5-21.3 fps; `runtimeHelpers: false` in the translator's settings turns it off. An indirect call whose callees are such functions has them formed in the same way once the runtime has seen where it goes: an indirect call in translated code notes its address and target in cork's own state block (`callProfile`: a flag, a count and the last sixteen pairs) while the runtime has the flag set, which it does for every other `translatePending`, reading the pairs at the next; a call sampled 48 times has the callees that took an eighth of the samples or more -- four at most -- formed into each region holding it (`callTargets` in `formRegion`, which hashes them with the region's bytes), and the new region takes the old one's entries when it comes back. A call is due for that when its 48th sample comes within 64 readings -- the samples of a call not due by then go, since a region formed again is built, compiled and run on the engine's baseline tier again, which a call hot only now and then does not pay back -- and every due call's regions are formed again in one batch of up to `batchRegions`, a region holding two of them once with both calls' callees -- where a pass over every call sampled found one call each `translatePending`, whose regions made a batch, a module and a round trip through the worker of their own (`churn.mjs`, both features on: 2 757 regions formed again for their calls -> 6, 13.7 -> 7.9 ms of the engine thread a million instructions, where both off read 7.2). The call pushes its return address, compares its target with each callee formed in and jumps to that callee's block on a match; any other target leaves through the hash as before, a push into code leaves `stale` at the target before any comparison, and the callee's `ret` comes back only to the address it pops (`inlineReturns`), so a wrong prediction costs a comparison and nothing else. cork-bench's vcall (three virtual calls a turn, each to one of two or three small methods) went 783 -> 287 us an iteration in Node and 805 -> 350-395 in Chrome 141, a loop of indirect calls to one small function 16.8 -> 5.4 ns a turn, to three in turn 21.6 -> 9.9; `callTargets: false` turns it off, and the profile's flag is one load an indirect call while it is off. The hybrid layout has no call profile. The former finds the block that holds an address by a binary search over the block starts while no two blocks share a byte, and by the scan in the order the blocks were made -- which answers the first of them -- once code overlaps; and a block adds each page it spans once, not once a byte: forming a region at every direct call's target of the thirteen `tools/cork-bench` images and at every start the loading workload notes (5 526 regions, 458 674 instructions) went 914 -> 775 ms, the regions the same block for block. Every `if` whose body is a slow path -- a spent budget, a page flagged in an access or window test, a store into code, a divide fault, the x87 stack's shape or precision control not what the region was compiled for, an exception the processor would raise -- and the shared exit of a block's window tests carry a branch hint, rarely taken, in the module's `metadata.code.branch_hint` section (`openGuard` in the region emitter, `Body.unlikely` in the encoder; a branch that data decides is an `openIf` and carries none): the engine lays the slow path out of line and keeps the registers for the path that goes on, where it spilled and reloaded them around the page tests' `codeHit` calls. Chromium 141's V8 reads the section by default; Node 22's only under `--experimental-wasm-branch-hinting`, and an engine that does not read it skips it and runs the same code. Under node with the flag, each workload in paired rounds of one process, the integer guards (a spent budget, a page, a store into code, a divide fault) took 4.5 % off all thirteen on top of the flags' liveness above (a sort 462 -> 408 us an iteration, the bytecode interpreter 277 -> 238), none slower; on a tree with the x87 relaxations and fused float compares, every hint against none, cork-bench with one host per tree in one process, iterations interleaved, median of 40, ran the bytecode interpreter 1.36x faster, the x87 and SSE float math 1.13x and 1.14x, the entity updates 1.10x and 1.09x, the CRC 1.08x, sorting 1.06x, strings 1.07x, the tree 1.05x, the switch and virtual calls within noise (0.94-1.08 and 0.95-1.02 over runs). Every region function carries its entry address in its module's `name` section (`r004ea329`), so the browser's own sampling profiler names it: `tools/cdp_test/game.mjs --cpu-profile N` samples the engine's workers and folds self time by region, interpreter, runtime and layer, which is how a slow phase is charged to translated code, to the interpreter tier or to the host rather than guessed. A block whose conditional branch comes back to its own start is a wasm loop with the back
edge a direct branch, the slice's budget looked at on that edge as on any jump. By default (`structure: true`) a region's larger loops are wasm loops too (`planStructure` in `region.js`), and they are the loops of its control flow, not of its layout: a jump to a block that dominates it -- every way into the region reaches the jumper through the target -- closes a natural loop, whose blocks are those that reach the jump without passing its head, and the blocks are emitted in a topological order of the jumps that close none, a loop's blocks together after its head (ties to the block the one before falls through to, then to the lowest address), so that every other jump is a branch forward out of its target's wasm block. A switch's cases laid after a loop's latch, a callee formed in below its caller and a loop entered at its test at the bottom are each a jump back in address order that closes no loop; taken for loops by their addresses, as the first structured form did, they widened the real loops into a nest the code does not have, whose every turn paid its heads' tests. The ways into a region are its entry and the return addresses of the calls that leave it (a direct call to a callee not formed in, an indirect call not predicted, a trap), so a loop that calls out of the region every turn is no natural loop and its jump back takes the dispatch as in a flat region; a region formed at a block in the middle of a loop is planned from a root with that block's successors, so it has the loop the code has with its entry inside it. A jump back to a loop's head branches to its wasm loop, the budget looked at there; the dispatch sends a label to a loop head that holds loops of its own through the head of the loop around it, which a test there sends on, and to every other head directly. A block inside a loop other than its head cannot be entered from the dispatch without leaving the loops around it, so the runtime enters it through a second function, the region's copies (`emitCopies`, named `r<entry>-copies` in the name section): those blocks once more as a flat dispatch, which go on among themselves and leave by the entry hash at the first jump to a loop's head or past the loops, where the region's own function takes over; the region's function sends a copy's label (twice its blocks and up) there before anything else runs. Kept apart, the cold copies leave the loops' registers alone: inside the region's function they made TurboFan keep less of a loop in registers. The function of the copies is written from the region function's own plans -- its order and loops, returns, x87 tracking and stack shapes, the flags' liveness and the access groups, a copy of the last since emitting marks it -- rather than planning the same region again: the bytes are the same, and emitting cork-bench's game-shaped x87 regions, whose predicted calls return inside their loops, took 19 % fewer instructions (a stretch of Doom 3's own regions, with the copies its closed blocks called for, 2.7 % fewer). The copies double a region's code, so a region is formed without them: its blocks inside loops have no entry (`closed`) and are no candidate of their own, and once translated code has left for one of them `missThreshold` times -- a jump back to it that is no loop's, another region's exit into the loop -- the region is formed once more with copies (`copied` in the diagnostics) and takes the old one's entries; an entry that is another region's copy gives way to one of a region that holds the block in its own loops. A region whose predicted indirect call returns inside a loop (a call to another target comes back there from outside) has its copies from the start; one formed in the middle of a loop has its entry among the closed blocks, and the machine comes into it at the loop's head. A closed block is looked up at that threshold alone, not at every miss: a miss is most of a crossing into a page left to the interpreter, which a call into one pays every call (with the lookup at every miss the patching workload ran 5-6 % slower). The interpreter, which finds the machine in the middle of a loop when the region for it comes, runs on through closed blocks to the loop's head, which has an entry; so a loop of one block onto itself inside another loop is a loop of the plan too, entered through the head around it, where as one of the outer loop's blocks it had no entry and the machine found in it ran it interpreted to its end. Stopping the interpreter at every closed block instead, with an entry that leaves at once, doubled the CRC workload's first iteration. Against the flat dispatch under node `--no-liftoff`, each workload in paired rounds of one process (median of the rounds' ratios, 10 rounds, a second copy of the flat tree as the noise floor at +1.3 to +2.0 % over all), cork-bench's twenty-one workloads ran 7.5 % faster with branch hints and 8.0 % without -- the bytecode interpreter 37 %, the switch 19 %, the tree 16 %, the x87 float math 15 %, the virtual calls 14 %, the strings 10 % -- and none slower past the noise floor (the calls workloads that read slower in one run or another -1 to -5 % over 20 rounds), where the loops by address were 4-5 % slower over all (the sort 25-33 %, the virtual calls 39-57 %); on the shapes that cost them, without hints, a return into nested loops 231 -> 128 us (by address 318), a return into a loop from a callee far below 244 -> 141, a state machine's switch in a loop 404 -> 323, a loop calling out of the region every turn 1 049 -> 897, a loop holding many values 418 -> 403. The first iteration costs more: a process's first host (the engine's own JavaScript cold, one process a sample) 3-4 % over all, the strings' 102 -> 128 ms the most, and a later host's first iteration 6-8 % (the flat tree against itself within 2.5 %) -- the planning and the copies formed while the program warms up. A region ends at a run of zero bytes
(two all-zero instructions in a row are a page's fill, not code: a region that walked past
a call that never returns once decoded eight kilobytes of it). Candidates come from two places: the
layer's sampler, which hands every hot bucket over at the address its last slice ended on
whenever that address is a new one, and the translator's own count of untranslated exits by
target address and x87 top (`cork.missThreshold`, default 64), which is what finds a stub reached only
through such exits -- the sampler sees only where budgets run out. The count is per top, so
misses at a top a region already exists for never withhold the region another top needs; it
is bounded, and the oldest key is evicted and the counts halved as it fills: a real program
leaves for millions of addresses, and a hard cap that dropped every new one once full is what
kept a loading run at a share of 0.5 -- no address reached after the fill could climb to the
threshold. An address a region formed
nothing at for a top (every block of it leaves at once) is not tried again at that top until
its page moves.
A block that would leave before retiring anything (nothing decoded, its first instruction
left out) has no entry, so a transfer never spins on it. The host's call channel is
translated too: `out dx, eax` to the trap port (`cork.trapPort`, the layer's own) writes the
state block back with EIP past the instruction and the count charged, calls the `trap`
import from inside the region -- the cpu layer's, which runs the handler the port write would
have reached (`raiseTrap` on the emulator's host, the same handler and the same count) and
answers whether it moved EIP or stopped the machine -- takes the state back into the locals
and goes on after the write, or leaves untranslated where the handler put EIP. A region
holding x87 registers in its locals first puts them back in their own locals (undoing its
exchanges) and writes them back with the rest, and after the handler leaves untranslated
wherever EIP is, past the write or where the handler put it, through the entry hash: the
handler may have popped the stack or pushed a result, and the code after the write is
compiled for the top the tracker followed, so the region cannot go on in it. That exit
finds the code for the top the machine has, where the region once left with a `trap` exit
for the host's loop to run the handler, a turn of `runSlice` every call: a loop calling an x87
function that jumps into a trap's stub, its handler popping two and pushing one, went 247-257
-> 91 ns a call on the cork host, beside 80-88 for the same through `jmp eax` (the stub a
region of its own, with no x87) and 73-76 for an integer function. A region where the x87
and MMX views of the registers meet still takes that older form, which the hybrid host and
the cork host answer the same way (the cork host once ignored it, and a hook stub reached
with the x87 stack live ran on into its `int3` padding); either way a call into the bridge
costs no emulator turn. `out` to any other port, `in`,
`cli`, `sti`, `int n`, `int3` and `into` are the emulator's, before the instruction. Under engine cork the interpreter runs
`in` and `out` to any other port against the ports Windows 9x left a program: the interval timer
(0x40-0x43), its channel 0 counting down at 1.193182 MHz on the guest's clock with the latch
command honoured, and every other port a floating bus (reads all ones, writes ignored);
`metrics.ports` lists each port a program touched and how often.
`bound` is translated as the no-op the emulator's own decoder makes of it — it consumes the
instruction, register form included (`62 d0`), and neither checks the pair nor raises `#BR`,
so a guest that returns into a page of data (the entry vector is the shape seen on a real
route, whose first byte is the entry point's low byte) runs the same bytes either way.
A fault
translated code detects (a divide by zero, an undefined instruction, an access the page
table refuses) leaves before the instruction with the registers as they were, and the
emulator re-executes it and raises it through the same vector and report a program on the
emulator alone gets. A `pop` into memory checks its destination before esp moves (the moved esp
that `pop [esp+x]` addresses with folded into the displacement), so a fault on the destination
leaves esp as it was -- both tiers had left it past the value. The same hash is given to the
emulator (`handoffHash`, the fork's `bottlify_handoff_hash`): its slice then returns only at
an address the hash holds, not anywhere in a flagged page, which would otherwise hand a page
half translated back one instruction at a time. A page flagged for handoff is one the
emulator's own compiler leaves alone: what it compiled there is dropped when the flag is set
and the page is not compiled again while flagged, since generated code runs a page's blocks
without returning to the slice loop where the handoff is checked -- the emulator interprets
it, and its interpreter's own loop returns at an entry as the slice loop does, until the
translator takes it. A region writes the x87 control word in place, where the emulator keeps
its rounding and precision decoded apart from the word (set by its own `fldcw` and the
`set_control_word` export), so the hybrid and differential loops compare the word around a
region and, when it changed, have the emulator decode it again (`syncX87Control`): a
`fistp` the emulator ran after a region's `fldcw` rounded by the word before it. Without tail calls the map
alone answers and the slice loop crosses between regions as before. The translator's layout is the emulator's
own register file, read off its typed views at boot (`stateLayout`), and its tables take the
top of the guest RAM (`engine.js`'s `TABLES_RESERVE`; the layer reports the RAM below it as
the memory's size), so a switch between the two copies nothing. Translated code adds what it
retired to the emulator's own counter word, so `instructionCount()` and the sampler are
unchanged. Candidates come from the sampler: once a frame, every 64-byte bucket credited past
`cork.hotThreshold` instructions is handed to the translator at the exact address its last
slice ended on, and the pending batch is formed and compiled, paced by frames
(`cork.feed: 'frame'`, the default) or, for a run without a presenter such as a test, after
every slice (`'slice'`), never inside one. Forming stays on the engine thread -- where the
memory is -- and a batch's store lookups are *requested* there but not awaited: the slice
goes on and the batch is published between frames when its bytes come back, so a region
whose bytes are not back is simply not published this frame (`lookupMs` is the engine
thread's own time to start the reads, not their wall time). The emitting and encoding of
what the store did not hold go to a translation worker (`translator.worker.js`, opened
where a
`Worker` exists or through Node's `worker_threads`; `cork.worker` forces or forbids it,
`cork.workerUrl` names the file), which takes the formed region out of the message and
answers the module bytes and the record, so the engine thread never waits: a batch not back
is simply published on a later frame, and `workerMs` reports the worker's share apart from
`translateMs`, which is the engine thread's own. A worker that cannot load (a browser makes it
and reports the failure later, as an error event) or dies is dropped (`refused` names why,
`worker: ...`), the batch it held is given up and emitting goes back inline; so is a batch the
worker has held past the in-flight limit (`inFlightMs`, ten seconds) on time the engine thread
was free to hear it -- past it by the clock, and the event loop come round twice since (a
timer the runtime arms once the clock is past it), in which an answer already waiting would
have been delivered. By the clock alone, a hold of the engine thread longer than the limit gave
up answers that were only waiting behind it and threw their work away: a Doom 3 run through
the launch probe in node, whose slices took 7-10 s once its frames were rasterized in software,
gave up 15 batches that way. Its candidates count as in flight on the same terms. Before, the failure was an uncaught
exception and the batch stayed outstanding, so nothing was translated for the rest of the run. The encoder writes a body's bytes straight
into a buffer that grows by doubling, each number LEB128-encoded in place (a signed constant
without a BigInt): building each instruction's bytes as an array of its own was half of
emitting, and a program of 1 500 small functions run a few times each emitted in 531 ms where
it took 1 168, with the same bytes out. A run with no frames (`feed: 'slice'`)
translates inline whatever `cork.worker` says, since it has no frame to hide the round trip
behind. A batch is one
module, a function per region (`emitBatch`): V8's tail call into a function of another module
costs more the more modules there are -- a chain of calls through 2000 regions ran at 219 ns a
call with a module each and at 6 with one module, and a title's 68 000 region modules made
its translated code slower per instruction than the emulator's. The translation cache keeps
a record per region naming its function in the batch's module and the key the module's bytes
are kept under (named by their hash); a region's function is a pure function of its bytes,
its entry, the x87 top it was compiled for, the layout and this emitter, so with a store
(`cork.store`, `cork.bundleId`; `createApp` resolves `'local'` to the origin's private file
system in the engine's own thread, a directory per bundle, as it does the block store) the
second run of a program takes every region it ran before from the store, each batch module
instantiated once for all its regions -- the region is still formed, a decode, which gives its
hash; what is saved is the emitting and the encoding, and the report says
`cacheHits`/`cacheMisses`. The keys carry what the emitter reads besides a region's bytes: the
host's features, the default NaN's sign among them (`n`), and the emitting settings (`structure`
`S`, `precise` `P`, `countTransfers` `T`, `dispatch` `D`, `callTargets` `C`, the trap port `p<port>`) -- a run with `structure` on a store a run
without it wrote took the other code; a batch module is named by 64 bits of its bytes' hash (two
FNV lanes), since every batch of a bundle shares one namespace, and so is a region's own hash, the
key's record of its code bytes and its tables' entries: with 32 bits a search of a second found two
`mov eax, imm32; hlt` whose bytes hash alike, and a store holding one answered at the same entry
for the other, which then returned the first one's immediate. `CACHE_VERSION` moves by hand
when the emitter's output does; `runtime/emitted.test.js` emits a fixed set of regions (the
benchmark's programs at their entries, under fixed features) and holds the digest to the one
recorded for the current version, so a change to the emitted code fails it until the version is
bumped -- a change the set's code does not reach still passes. A region dropped when its page is written leaves its batch's module
in place for the batch's other regions. Batches stay small while a title keeps finding code, so
once `relinkAfter` batch modules (16) have gathered the running regions not relinked yet go, in
chunks of `relinkRegions` (512: the engine thread instantiates each chunk's module whole, and 4096 of a real title's regions held it for 160 ms where 512 hold it for about 23), to the worker with a copy of their pages: each is formed there
again, kept only when its bytes hash as they did, emitted into one module per chunk, and
switched in place -- the entries it made take the new function and its index in the new
module's range of the table (below), the labels being the same. A title's regions then live in tens of modules rather than hundreds; the
store keeps the relinked records (`linked`), so the next launch starts from the big modules.
The emitter keeps what it emitted (`createEmitCache`, 48 MB, the least recently used out first;
the worker's own, and one a runtime emitting inline keeps): a region's function is a pure
function of the formed region, the top and shape test it is compiled for and a module prepared
with the same layout, features and options, whatever else the module holds, so a relink or a
merge takes each region that forms again to the same blocks and bytes from there and emits only
what is new -- the same bytes as emitting it again. The regions a batch or a relink forms share
their decoded instructions and callees' leaf tests (`formShared`): nothing writes their bytes
while they are formed, and a loading phase's regions call the same small functions. The messages
a Doom 3 run posted its worker in its first 35 s (8 596 regions, 17 243 emitted, merges
emitting a module of hundreds again for every few regions they gathered), replayed in node by
`tools/cork-bench/translate.mjs`, took the worker's work from 34.1 to 19.4 s.
A transfer between regions is one function a module, not code in every region: an untranslated
exit with budget left tail-calls its module's transfer function with its EIP in the label's
place and the state it carries, and that function probes the entry hash (the first slot before
any loop, since V8 checks the stack at every loop's head), and on a miss writes the carried
state back and leaves as the region would have. Every module is placed in a range of the
function table, one index per job of its batch or relink and job i's function at the range's
start plus i, so a slot naming an index of the module's own range is a direct tail call of that
function out of the transfer function's arms, and only another module's goes through the table:
V8's indirect tail call costs several times a direct one -- two functions tail-calling each other
took 4.5 ns a transfer through the table against 0.9 direct in Node's V8 and 7.7 against 0.35 in
Chrome 141's, the table's instance load chaining each transfer to the last -- and the probe in one
function makes every region smaller (a loading phase's modules 7.48 -> 7.33 MB, their eager
compile 8.0 -> 7.0 s). A transfer out of its module counts (`crossings`, with the index it went
to), and on the translation worker two modules one of which has crossed into the other
`mergeAfter` times (2^16) for every region the merge would build are gathered into one module,
both whole, or the region crossed into alone -- once only -- when the two would not fit
`relinkRegions` (`merges`, and `merged` the regions they built); a region is built again by two
merges at most. A merge builds every region of both modules again -- the worker emits them, the
engine thread instantiates the module and compiles each function at its first call, and the code
runs on the engine's baseline tier until its optimising compile catches up -- and with a fixed
count of crossings and no bound a program that kept bringing new code rebuilt its hottest
modules for as long as it ran (`churn.mjs`, both features on: 9 merges building 2 683 regions again -> none, 7.9 -> 7.8 ms of the engine thread a million instructions, where both off read 7.3). One merge in 2^23
translated instructions at most, and after one that built n regions one in n x 2^19, since its
module is instantiated on the engine thread whole -- with the worker taking the regions it
emitted before from what it keeps, the worker's time no longer spaced merges out, and a module
of hundreds gathering a few new regions at a time would be instantiated again every few million
instructions -- and the engine thread merges nothing without a worker, where a relink after the
warm-up is a slice's toll. A loop of indirect calls to one small function (two transfers a turn) went 17.9 -> 12.9 ns a
turn in Node; cork-bench's `calls` workloads (32 768 calls an iteration through a table of 8, 512
or 4096 small functions) 1.28-1.45x in Node and 1.10-1.70x in Chrome 141; and `vcall`, whose loop
and callees land in batches of their own until a merge gathers them, 850 -> 615 us an iteration in
Chrome (in Node, with no worker to merge on, as before). A module whose regions have all gone
gives its range back for the next module to take, its base set out of every index's reach so it
reaches none of it directly again (a region of it published again from the store takes an index
as an unplaced module's does); kept for good, the ranges grew the table by every batch, and V8
grows the dispatch table of every instance importing the table with it, which ran the 20 000
sequences out of memory. `diagnostics().tableSize` is the table's length. `dispatch: false`
sends every transfer through the table.
Under `cork` alone a miss need not leave either: the transfer function calls the interpreter tier
in wasm (below) through the table's first index (`TIER_SLOT`, which the runtime keeps for it),
the flag record folded into the word the tier reads, and the tier counts the target as a jump's
and runs from it with the budget left; where it stops at a start with an entry, the transfer
function tail-calls itself with the state the block holds, charged what the tier retired, and
probes for it, so a call from translated code into a page left to the interpreter -- a routine
that rewrites itself, code the translator refused -- goes there and back without the host. What
else the tier stops for (a hot start to note, a trap, a fault, a store into translated code, an
instruction it leaves, the budget, an entry for another x87 top) leaves as an `interpreted` exit
whose vector is the tier's own code, and the host answers it as it answers the tier's own runs.
Until the host installs the tier (`interpretWith`, at its first run of it, so the JavaScript
interpreter's stretch before the tier stands), the index holds a function answering 0, and a
miss leaves as before; so does a miss on a page holding a block closed in a translated loop
(`PageFlag.CLOSED`, set while the runtime keeps such a block there), which the host must count
for the region's copies to be formed (`missAt`, see the loops above). The tier's in-place runs
count in the counter word as its other runs do, and not in the translator's `translatedShare`.
A translated loop calling a routine on a page it rewrites
(the callee left to the interpreter, no leaf callee formed in) went from 183-199 ns a call to
39-42 in one process paired with the tree before; cork-bench's self-patching routine, whose
every call is such a crossing, 4.15 -> 1.17 ms an iteration (3.5x without branch hints, 3.6x
with); the other workloads' steady state within what a second copy of the tree before reads
(0.94-1.04x a workload), their first iterations too.
A region's record holds only the entries it made: an address another region's entry holds
already stays that region's, so neither a relink nor a drop of this one touches it. The five helper functions every
region module needs (`materialise`, the 80-bit conversions, the rounding and the code-hit
test) are defined once in a shared module instantiated with the same memory and imported by
each region, not copied into every module -- a saving of about 3 KB a region, which on a
route that builds tens of thousands of them is most of the module bytes. The directory holds one `records` file with every record appended back to back and one
`index` naming each record's place in it (a hashed name, an offset, a length), read once when
the store is opened -- as the translator is made (`prepare`), so it is open by the program's first
batch: a miss never asks the file system, whose answer to a miss is an
exception that costs milliseconds a record, and a hit is one read at an offset -- synchronous
through the records file's access handle inside a worker, where the engine runs, so a warm
load's tens of thousands of hits cost microseconds each rather than a file open apiece. The
translator asks that way first (`getNow`), and a batch the store answers so is published in the
call that formed it, as a batch is without a store. Opening the store removes the bundle's directories of other layout versions: nothing reads them again, and the block store mounts the origin's whole private file system and stats every file in it on every start, so a version that kept a file per record cost a minute of every launch until swept. The
index is a log the batch's lines are appended to (a name that appears twice means the later
place), one write in flight at a time and going round again when a put lands during it, the
records flushed before it; a place the file does not reach (a torn write) or a line cut short
is not a record. The store is kept to what recent runs used, since appending alone grew a
test profile to 29 GB (every re-put, every run's relinked modules, every translator version's
records stayed): each opening is a session, marked in the index (`# <n>`), and a record read
or written in it is named again in it, so each carries the last session that used it. On
opening, a records file past 64 MB of which half is not live -- superseded by a later write of
its name, or unused for four sessions, which is what an old translator version's records and a
module no region names any more become -- is copied, live records only, into the next
generation (`records.<g>`, `index.<g>`, named by a `current` file written last, so a page that
goes away mid-copy leaves the old generation current and whole), and live records past 1 GiB go,
the least recently used first (layout version 3). An index past 4 MB and four times what its live records need is rewritten the same way even with the records small: a warm run touches every record it reads, a line each, and the whole index is read at every open; `flush` before the run ends and `close` after
let go of the handle. A record of another emitter
version, feature set or layout is a miss. A store travels as a seed: `exportSeed()` packs the live
records -- each name's later place, used within the last four sessions -- into one blob (magic
`CORKSEED`, the seed format, the `STORE_VERSION` its names were made under, then each record's name
and length and the records back to back, in the order of their names, so the same records make the
same bytes), and `seed(bytes, identity)` appends the records a store lacks, names them in its index
as used in this session and keeps `identity` (`seededWith()`), all before any lookup of that
opening is answered, since every `get` waits for a seed on its way. A name the store holds already
stays as it is, so a second seed adds nothing; a seed of another format or layout version, or one
cut short, adds nothing. A seed is wasm the engine instantiates: its reach is the engine's wasm
memory and cork's imports (the trap, the flags and clock reads, the math and helper functions, the
shared function table) -- what the modules cork emits from the guest's own code reach -- and nothing
outside the engine's thread. Nothing in a seed is trusted to fit: a record is under the name of its
key, and the key carries the region's code bytes (their 64-bit hash), its entry, the bundle's id,
the emitter's version, the host's features, the layout and the emitting settings, so a record
another engine, another bundle or other code bytes made is one no lookup here names.
`translation-store.itest.js` seeds a fresh store from runs with the default NaN's sign flipped,
without tail calls (no entry hash, so no tier resumed from it), with another layout, with
`structure` off and with it unset against a run with it off, with `precise`, with `dispatch` and
with `callTargets` each against the other setting, with another trap port, under another precision
control (wide, narrow and mixed against each other, on one program's
code bytes), and from the program with one code byte changed: none answers a lookup, and each run's
checksum is the one a run without a seed computes. `seedRecords` (cork's `runtime/cache.js`) is the
`select` an export takes to keep only the region records of this emitter and the modules they name:
a batch's module whose regions a relink moved is named by none, and on the benchmark's load of
fifteen hundred functions that was nearly half the store (10.0 MB against 5.4).
A bundle carries its seed as an optional member (`docs/core/filesystem.md`; `node
tools/make-btl.mjs translations <bundle-id> <seed>` puts one into a packed bundle, where load-x87's
5.4 MB took 0.4 MB, its blocks compressed as a file's are), and `createApp` hands it to the
store under a translating engine -- the default, `cork`, or one named -- before the program's first
instruction, so the first run of a bundle on a machine takes the regions a run elsewhere made. The
seed is as trusted as the bundle's code, which it rides with: the index names its digest and the
manifest the index's. And it is never taken for code bytes it was not made from: the lookup's key is
made here, from the bytes the program holds when a region is formed, so a seed made from another
build of the program answers only the regions whose bytes did not change.
A launch hands its store out as such a seed through `app.exportTranslations()` (the cpu layer's
`exportTranslations`, with the translator's own `seedRecords` as the `select`; null without a
translating engine or a store), asked before `dispose`; `tools/cdp_test/game.mjs
--export-translations FILE` writes a browser run's to a file.
`tools/cork-bench/bench.mjs --capture DIR` writes a benchmark program's seed, `--seed DIR` starts
every rep from one and `--store fresh` from an empty store, each opened before the host starts, the event loop turning between slices
so the store's answers come back. A seeded first iteration against an empty store, the median of
seven processes a workload, each five hosts (the first host, the engine's own JavaScript cold as at
a launch, and `coldMs`, hosts three to five): over the thirteen original workloads the first host
159 -> 85 ms and `coldMs` 33 -> 21 by geometric mean, load-x87 1178 -> 401 and 454 -> 145, the
checksums the empty store's. A store that can answer at once (`getNow`, above) answers a batch's
lookups in the call that formed it; one that cannot -- a page's, with no synchronous handle, or one
with a seed on its way in -- is asked through `get`, and the batch is published a turn of the event
loop later, no batch formed meanwhile. That turn cost a first run more than the emitting it spared:
the program ran on in the interpreter tier and turned other starts hot, so crc-x87 formed and emitted two
regions in two modules where without a store it forms one. Answered at once, an empty store's run
forms what a run without one does (`translation-store.itest.js`); the same thirteen workloads, seven
processes each, the store open before the host starts as a launch leaves it: the first host with
an empty store 158 -> 89 ms by geometric mean (81-83 with none) and with a seed 86 -> 43, now half
of no store's, seeded `coldMs` 20.5 -> 21.6. The turn had also held translation back, which a first
iteration run mostly by the wasm tier gained from: with an empty store `coldMs` went 34.7 -> 40.1,
where a run without a store is (34.7-36.1), load-x87's 452 -> 778 ms (676 with none) -- held back it
formed 1 380 regions in 10 batches, and now forms 2 075 in 214, as it does without a store. How
eagerly a loading phase is translated is the translator's own policy, the same with a store or
without. A region with x87 instructions in it is compiled for the x87 stack top it is entered
with, and its entries are keyed by address and top (`entryOf(eip, x87Top)`, the top read off
the emulator's `fpu_stack_ptr` before every turn); a region without them is entered with any
top. A lookup that misses at an address compiled for another top queues that top for the
next batch, with a heat that grows each time the machine is found standing there, so a variant
it keeps arriving at climbs the queue rather than waiting in the bottom bucket behind a
loader's cold starts while its code runs interpreted. The miss histogram names such a target
`other-top` only while a top its exits were at still has no region; once every one has, it is
`translated since` -- those exits were the wait for the translation (a Doom 3 timedemo's 211 000
untranslated exits read as `other-top` were mostly this), not a gap still open. A block the tracker reached with no known state (a call's return address, whose
top the callee decides) or cut for a second top gets no entry of the caller's region: it is
noted as a candidate, so the miss at its address forms a region of its own compiled for the
top the machine has, instead of a partial entry that would shadow every later attempt. The
region's own entry block is the exception: it is always compiled for the top the region was
formed at, whatever other path reaches it, so a join two tops meet at still publishes an entry
for each -- the edge that arrives at the entry with the other top leaves, and the runtime forms
a region there for the top the machine has. The translator keeps every x87 value as a double, as the emulator does; the
emulator's tagged-double form is read and written directly, a true 80-bit register it left is
converted inline. The one exception is the quadword a `fild m64` loads: the processor's 64-bit
mantissa holds it whole and `fild m64; fistp m64` is a way programs copy eight bytes, so within a
block the translator keeps the loaded quadword in an i64 local beside the register's double, carried
by `fxch` and the register copies (`fld st(i)`, `fst st(i)`) and dropped by any other write, and a
`fistp`/`fisttp m64` of such a register stores the quadword (`0x0123456789abcdef` had come back
`...cdf0`, `INT64_MAX` the integer indefinite with IE); the interpreter keeps the same shadow per
physical register (`exactWrites` in `ir-x87.js`, one rule for both), dropped at every sync with the
state block. The stack-fault checks -- a register read that is empty, a push into one
that is held: IE and SF (and C1 for the push), and the indefinite for the value -- are decided
at translation wherever the empty mask is known there (`planStack` in `emit/x87.js`). A
region's function is entered from outside only through its head (the host, or another region
through the hash) and only at a block compiled for the entry's shape; from inside, only along
the region's edges, which the dispatch takes without the head. So what is known at a block's
start is what every predecessor in the region left of it -- a push or an `fst` into a register
leaves it held, a pop or `ffree` empty, and a read leaves it as it was, as a failing check does
-- met, where the block can be entered, with what the head tests there: the registers a path
from the block reads before setting them, held, and pushes into, empty. Compiled code keeps the
stack in one shape at each place, so what one path from a place needs every run through it
has, and the test -- a `br_table` on the label, then an xor and an and on the empty mask --
passes; the blocks run with no check and no indefinite to choose, and C1, which a push clears,
is cleared only where it is not known clear already. An entry whose test fails leaves before
the block with an untranslated exit of vector `SHAPE`, which goes to the host rather than the
hash, and the host's interpreter runs the block and raises the fault as before; a region whose
entries fail four times (`checkedAfter`) is dropped and formed again checked, under a store key
of its own (`-c`): its entries test nothing, and a block checks what no predecessor decides.
`x87Shapes: false` in the translator's settings compiles every x87 region so; a region with MMX
in it knows only what each instruction's own pushes and pops decide. The test machine
translates checked unless asked, and its `runProgram` translates everything checked from the
first `SHAPE` exit on, so the corpora run both. On gcc -O2 C built for x87 under the cork host
alone (the fastest of nine runs, three runs each), a transform, normalise and cull loop went
281-283 -> 217-238 µs an iteration and a game's entity update 264-273 -> 221-248 (232-269 and
236-256 checked, with only what the region's own edges carry), their hot regions 36.9 -> 33.5
and 35.3 -> 31.3 wasm operations an x86 instruction (32.5 and 30.8 with no check at all); the
SSE builds and the integer workloads emit the same code as before. The plain
forms (loads, stores, arithmetic, compares) leave the empty mask and the top in their locals
stale: they are written once, where something reads them -- a check on a register the block changed,
`fxam`, an MMX instruction or `emms`, every exit and edge, and the block's end -- rather than at
every push and pop; a register the block has marked dirty is not marked again. An arithmetic
result is tested for a NaN once: the host's NaN sign fixed and IE raised in that branch. The
control word is honoured at run time: rounding control rounds the
integer stores and `frndint` (to nearest inline, the other modes through a helper), precision control set to single rounds every arithmetic
result's mantissa to 24 bits (extended is treated as double). That test was a branch on every
arithmetic operation, a sixth to a fifth of an x87 loop, for a setting most programs never
change: x87 regions are compiled for the wide controls (double, extended) with no rounding at
all until the program is seen with single set (the runtime's `wideFirst`), and a block tests the
control word once, before its first rounding instruction and again after its own
`fldcw`/`fldenv`/`frstor`/`finit` -- an x87 region's host calls leave it, so nothing else changes
the word mid-block. Finding single, the block leaves before the instruction with an untranslated
exit of vector `PRECISION`, which goes to the host rather than the hash; the host interprets it,
and the runtime compiles x87 regions for single from then on and drops the wide ones (the
store keeps them under their own key, `-w`). A region compiled for single (`narrow`, key `-n`)
rounds every arithmetic result with no test of its own and leaves the same way when a block
finds another precision set, and the runtime then drops the single ones and compiles every x87
region with a test at each rounding operation for good (`precision` in the diagnostics:
`wide`, `narrow`, `mixed`; `precisionSwitches` at most 2) -- Direct3D sets single at
`CreateDevice` and keeps it, so a program under it moves once. A batch formed while the machine
has single set moves at once, rather than making wide regions that would only leave at their
first rounding block to be dropped: on cork-bench's single-precision builds, which set it before
anything is translated, the transform loop's first iteration took 54.2 -> 38.4 ms and the entity
update's 85.6 -> 63.0 (fresh hosts in one process, interleaved, median of 30), the transform's
translation 62.6 -> 50.9 KB of modules with nothing invalidated. The rounding in a module that is
not `precise` is Veltkamp's split -- c = x * (2^29 + 1), x rounded is c - (c - x), and a NaN
out of it (an infinity, a NaN, or a magnitude from 2^995 - 2^966 up, where c overflows) keeps
the value -- three floating operations where the double's bits took ten and a trip through the
integer registers; it gives the interpreter's double for every other value, ties to even
included (every pattern of the 23 kept bits at seven exponents from 2^-1022 to 2^994, and
millions of random ones), a double's denormal aside, and `precise` keeps the bits. On
cork-bench's x87 float workloads under single precision (`fmath-pc24`, `game-pc24`, built with a
start that sets PC = 00 once, as creating a Direct3D device does; one host per tree in one
process, iterations interleaved, median of 10), the transform loop 212.4 -> 152.0 us an
iteration and the entity update 126.7 -> 117.7, the double-precision builds the same code as
before. The test machine does the
same, so the corpora run the wide translation. An x87 dot
loop 8.1 -> 7.3 ns a turn, a cull (the dot and `fcomp`/`fnstsw`) 10.2 -> 8.3; Doom 3's x87
functions 60-63 -> 49-51 wasm operations an instruction; a signalling NaN read from memory
(IE, and the value goes on quiet) is no longer an integer load, a mask and a compare ahead of every
float load: `fld` loads the float -- the f32-to-f64 promotion quiets a signalling NaN keeping its
payload, as the processor's own conversion does -- and tests only a value that is a NaN at all, and
an arithmetic with a memory operand or an ordered compare loads it unchecked, a NaN operand making a
NaN result the arithmetic's one compare already catches (the unordered compare keeps the bit test,
it raises IE for a signalling NaN alone); the rare branch after that compare is one call to the
shared `x87Invalid` helper (IE for a NaN made from operands that were not NaNs, or for a signalling
memory operand, read again from its bits) where its body inline cost half again what the compare
did. A dot loop 6.3-7.0 -> 5.3-5.6 ns a turn, a cull 7.5-8.1 -> 6.7-6.9; the SSE conversions that round
read the MXCSR rounding control the same way; a NaN an operation makes carries the
processor's negative sign whatever the host's default NaN is; exception masks are not
honoured, an exception behaves as masked. Unless `precise`, the sticky exception flags are not
computed at all (see the limitations): the NaN test after every arithmetic, the signalling test
of every float load, the underflow test of every single store, the zero-divide test of `fdiv`, the
negative test of `fsqrt` and the IE of a compare or an out-of-range integer store go, and so does
C1's clearing by a push and `fcomi`; a compare's C0 C2 C3 are set with no branch, and an integer store picks
the indefinite with a `select`. Each was a test and a branch per operation, and a branch splits
the block TurboFan allocates registers over -- after the NaN test's call every live register was
reloaded from the stack -- so they cost more together than apart: on cork-bench, an x87 transform,
normalise and cull loop 185 -> 115 us an iteration and an entity update 195 -> 167 (the same
steady iterations, one host per tree in one process, interleaved), the SSE and integer workloads
unchanged. What stays exact is every value, C0 C2 C3, the stack and its faults, and precision
and rounding control; a precise module computes the rest as the processor does. The four rounding modes of an integer store and `frndint` are inline (nearest,
then toward zero, down and up): a C cast compiled for the x87 sets truncation with `fldcw` around
its `fistp`, and the helper it called spilled the registers around every conversion. A scalar
SSE form (`addss` .. `divsd`, `sqrtss`, `minss`, `cmpss`, `rcpss`, `movss` and `movsd` between
registers) merges its low lane into the destination with one shuffle, a blend, where a mask
constant and a bitselect were four operations with the constant built in registers every time;
the operation stays packed, since TurboFan swaps a scalar add's or multiply's operands and the
NaN kept when both are NaNs would be the source's, not the destination's: cork-bench's SSE
transform loop 145.5 -> 126.4 us an iteration (1.15x; 128.0 -> 109.9 in a second run), the SSE
entity update within noise. A float compare (`fcomi`, `fucomi`, `comiss`, `ucomiss`, `comisd`,
`ucomisd`, popping or not) whose flags only the block's final conditional branch reads makes no
flags at all: the branch compares the operands itself, kept aside in two locals
(`fusesCompare`, `floatCondition`). Only the branch reads them when nothing after it does over
the region's blocks (`liveFlagsOut`, the same liveness the dead-flag pass takes) and nothing
between the two touches them or can leave -- for `fcomi` a register move such as `fstp st(1)`,
for SSE nothing. The flags were a compare, a set and an or into the word per flag and the branch
a test of two bits, some twenty operations for what TurboFan makes one compare and a jump: on
cork-bench, one host per tree in one process, the x87 transform loop 137.8 -> 116.6 us an
iteration, the SSE one 122.1 -> 85.4, the x87 entity update 171.2 -> 162.1, the SSE one
156.4 -> 135.2, the integer workloads the same code as before. The transcendentals (`fsin`, `fcos`, `fsincos`,
`fptan`, `fpatan`, `f2xm1`, `fyl2x`, `fyl2xp1`) go through the host's `Math`, imported by every
translated module, as the emulator's do, so the two agree on one engine. Out of the reduction range
(|x| >= 2^63) they leave the operand as it was and set C2, as the processor does, and `fptan` and
`fsincos` push nothing there: the region leaves past the instruction with the stack as it was, where
it had moved the top for the push the tracker counts on and pushed no value. `fprem` and `fprem1` are
exact: the JavaScript interpreter's `remainder` (`ir-x87.js`) takes JS's `%`, the IEEE fmod, moves it
by the divisor where `fprem1`'s quotient rounds to nearest, and finds the quotient's low bits for C0,
C3 and C1 from the remainder of eight times the divisor; translated code (the shared helpers'
`remainder`, `addRemainderHelper`) and the wasm tier (`remainderOf`) compute the same in integers --
the significands' long division, eleven quotient bits a step so the partial remainder stays below
2^64, the low three carried along -- where they called the host twice an instruction, for the value
and for the bits (a loop of `fprem` until C2 clears, as `fmod` reduces, 109 -> 15 ns a turn in
`math-bench.mjs`). Every tier had once computed `a - trunc(a / c) * c` in doubles, so a quotient that
rounded up gave a remainder of the wrong sign and bits off by one, and one past 2^53 lost the
remainder. Past an exponent difference of 63 the reduction is partial, C2 set, by 32 plus the
difference mod 32 bits, so a loop of them ends at the exact remainder. `fxtract` splits a finite
value from the double's fields (a denormal normalised, a zero its own significand with an
exponent of -inf and ZE), and leaves an infinity as its own significand with an exponent of
+inf and a NaN in both, as the processor does; translated code had split those two by their
fields too, a significand of 1 or 1.5 and an exponent of 1024. `fnstenv` and
`fnsave` write the protected-mode environment as the emulator does (the instruction and data
pointers zero, which neither keeps); `fldenv` and `frstor` read it back into the locals and
leave for the next block, since the top they set is known only at run time and every block
is compiled for one -- the entry hash re-enters the code compiled for whatever the top then
is. Within a region, only the blocks compiled for the stack in the entry's shape (its top,
no registers exchanged) are entries; a block compiled for another shape is reached from
inside the region alone, where the edge brings the stack into it, since entered from outside
it would push, pop and write the top back for a stack the machine does not have. A block
whose shape the tracking does not know keeps the top the machine had. A region with both x87
and MMX in it translates the two together rather than cutting at the first instruction that has
both. On the processor mm<i> is the mantissa of the physical register R<i> (not relative to the
top), so the eight registers are one set with two views the region keeps consistent: the value
the x87 side computes in an f64 local and the mantissa the MMX side reads and writes in an i64
local, reconciled at every write -- an x87 write leaves the mantissa the double's bits, an MMX
write leaves the value its mantissa decodes to (the indefinite, or a zero mantissa the negative
infinity, since the write sets the exponent and sign all ones) -- and a per-register form mark
records which view wrote it last, so the exit puts each register back into the state block in
that form, the MMX one (the exponent and sign all ones, as the processor leaves them) or the
relaxed double. An MMX instruction
holds every x87 register with the top at zero, as the processor does, and `emms` empties them
again, whichever order the two come in within one run, and leaves the top at the zero the MMX
instruction set -- leaving the MMX state does not undo it. `fxsave`, `fxrstor` and `fbld` still end a region and run on the fallback -- under cork the interpreter, whose model writes and reads `fxsave`'s 512-byte image (control, status with the top, the abridged tag byte, MXCSR with a mask of 0xffbf since the SSE model has no DAZ, ST(0)..ST(7) and XMM0..XMM7; the pointers zero), the first thing Doom 3 runs once it finds CPUID; `fbstp` writes its packed BCD through the BCD helper the shared helpers module carries. The stubs cork answers itself -- `cpuid` (the pinned emulator's own leaves, `src/cpuid.js`, the subleaf in ECX read where a leaf has them -- 4's cache parameters, 7's extended features -- and every leaf the emulator answers listed, 4, 5, 7, 0x15 and 0x40000000 among them, which cork had answered with zeros; `v86-host.itest.js` holds the table to the emulator's answer leaf by leaf and subleaf by subleaf -- but for the clock leaves 0x15 and 0x16, which state the rate cork's counter runs at, `CORK_TSC_MHZ` (3000), where the emulator's run at 1000. The answer keeps the emulator's hypervisor bit and its VMware leaf so the two engines agree; dropping them is a change to the fork first. `rdrand`, which leaf 1 advertises, is decoded and interpreted -- the host's `crypto.getRandomValues`, CF set, a memory operand #UD -- where it had stopped a program under cork; `popf` lets a program flip EFLAGS' ID and AC bits, since a program finds CPUID by flipping ID -- one that could not saw no CPUID, and Doom 3 took its generic x87 SIMD over SSE, while `popfw` writes the low sixteen bits alone and leaves AC and ID as they were, which both tiers had cleared), `rdtsc` (the host's counter through the `rdtsc` import: the emulator's own `read_tsc` under hybrid; under cork the guest's clock at `CORK_TSC_MHZ` (3000) ticks a microsecond -- the clock QueryPerformanceCounter and GetTickCount read, which the kernel hands the cpu layer (`useGuestClock`) -- going on at the page's rate inside a slice by at most a credit (16 ms) and never backward, so a program calibrating the counter against QueryPerformanceCounter measures the 3000 MHz that CPUID's leaves 0x15 and 0x16 and the registry's `~MHz` state whatever the host did meanwhile, where the page's own clock ran on through every stall the guest's is not credited for; a program turns rdtsc into seconds with that figure and picks its settings for the machine it thinks it has, and the emulator's counter and its figures stay at 1000), `xlat`, `addsubps`/`addsubpd` -- are lowered in the emitter and modelled in the interpreter, as `int n`/`int3`/`into`, `bound`, `hlt`, `ud2` and the string forms are. A store translated code makes into a page the emulator's own compiler compiled is
seen too: the store checks the emulator's byte-per-page "has code" table beside the
translator's own flags (`layout.codePages`, the fork's `bottlify_page_has_code_ptr`) and
leaves `stale` with the address and width, and the runtime dirties the emulator's cache for
that range (`dirtyCode`, the fork's `jit_dirty_cache`) as the emulator's own stores do. A
host write into guest memory (`writePhysical`, `writeData`, `fillData`) invalidates the
translator's regions on every page it touches, as it already dirties the emulator's. Nearly every
such write is a call's answer into a stack or a buffer, where the translator has nothing: the
runtime keeps a byte a page of the address space, set while a published region spans the page (its
code, a switch table or a helper it was formed with) or a candidate or a barren address is filed
under it, and `invalidatePage` passes over a page with the byte clear on that byte alone, where it
looked in three maps and moved the page's generation (a host write of four bytes, in node, over a
runtime that had been written 100 000 pages: 41 -> 20 ns into one of 64 pages written in turn, 159
-> 67 ns into pages 20 000 apart). The generation is read only when a region formed over the page
is published after the guest ran on, and such a region is hashed again then, as for a guest store.

Translated code tests a page-flag table before every load and store (one byte per 4 KiB page
of the address space, kept in the memory after the guest RAM): a page beyond RAM is
inaccessible from boot and an access to it is a precise `#GP` with the registers as before
the instruction; a page that holds translated code makes a store into it leave translated
code with a `stale` exit right after the instruction, so the runtime can drop what it
translated there -- a store into the code's own bytes, that is: beside the flag the table
keeps, per page, the first and last 32-byte granule holding translated code, and a store
into the page's data next to its code (a small image keeps both in one page, and a loop
storing into its own page went volatile after eight such stores) is no store into code. The
range is kept as counts, per page, of the regions whose blocks there begin and end in each
granule, so a region that goes takes its own extent out: made again from every region left on
the page, a page of small functions formed into their callers -- where nearly every region lies
-- was a pass over all of them each time one went, the engine thread's largest cost (cork-bench's `churn.mjs` in node, the translation worker in lock step, `callTargets` and `dispatch` on: 38.2 -> 13.0 ms of the engine thread's time a million guest instructions, its 99.9th percentile turn 154 -> 30 ms). A
store is tested at its first byte, its last and one byte in every granule between, since a state
save spans several (`fnsave`'s 108 bytes over code that lay in neither end's granule went
unnoticed), and the emulator's "has code" table above is read for the store's last page as well as
its first. Those flags go up as a region is published, so a store into a page whose first region
is still in flight -- its batch on the translation worker, or its store lookups out -- meets none
of them: a region the guest ran past between its forming and its publishing is published only
while its bytes still hash as they did when it was formed (`hashRegion`), and is dropped otherwise,
to be formed again from what the page holds now. cork-bench's patch-x87, which rewrites an
immediate of the routine it calls, summed 13c09d36 where the interpreter sums 3bf0ccce whenever a
store answered its lookups a turn after the batch was formed (`translation-store.itest.js`).
The common case is one test per access: the flags of the access's page and of the next one,
read as one halfword (the last byte of an access lies in one of the two), against
inaccessible -- and, for an access that is only written (`mov` to memory, a push, `stos`, an SSE
or MMX store such as `movaps`/`movss`/`movq` to memory or `stmxcsr`),
against code too, so the store's code note needs no second test. Only when a flag is up are
the last byte's own flags read, so an access beside an unmapped page or beside code faults
or notes only when it reaches it. On a push/pop loop this took a third off (2.3 -> 1.5 ns an
instruction), on a load/store copy a quarter (1.14 -> 0.86), on a call-heavy loop a tenth.
Most accesses need not even that. Those off a register whose value the planner can follow -- a
frame through esp or ebp, a struct through one pointer, an array through a base and an index --
or off an address in the instruction form a group (`planRegion` in `emit/memory.js`, made from
the decoded operands before the region is emitted). The planner follows each register as a value
and an offset from it: a push, a pop, a call, a return and an add, sub, inc or dec by a constant
move a register by a known amount; a `mov` from another register, a `lea` off one and a `leave`
copy a value with its offset, and an `xchg` swaps two; any other write gives the register a
value of its own, and an operation not known there gives every register one. So a frame's
`push ebp; mov ebp, esp`, its reads through ebp and esp, its `leave` and its `ret` are one group.
A group's accesses lie in a window known from the registers at its first access, and one of at
most 4096 bytes spans at most two pages, each touched by one of the accesses: the group is
checked once, there, as one access is -- the flags of its first page and the next as one
halfword, against inaccessible and, for a group with a store, against code; only when a flag is
up are the window's own pages and the stores' granules (`codeHit`) looked at -- and its accesses
carry no test at all. Two accesses make a group, then, since its test costs what one access's
does. A window that would fault, or a store that would land in code, leaves the region
untranslated before the group's first access, and the interpreter runs the rest with a check on
every access, so the fault is raised at its instruction and the note made at its store as they
would be here. The emitter's own calls are held to the plan: an access it did not foresee, or a
store it took for a load, is an error in translating rather than a test left out. Groups within
a block took a copy loop through one base 188 -> 113 ms (the no-test ceiling 107), a push/pop
loop 245 -> 171 (at the ceiling), an indexed walk 161 -> 137 (ceiling 120).

A group reaches past its block. Each block takes the windows still open at the end of one block
that leads to it -- its one way in, where it has one; else, unless a jump back reaches it too
(a loop's head, whose every turn would pay the test), the block before it or the first block
before it that jumps there -- along a fall-through, a jump, a branch, a call into a callee formed
into the region and a return formed back to the block after its call. The way on past a trap
(whose host call may change what is accessible) and a switch's jump through its table carry
none; the region's entry, a structured region's loop heads and a block that loops onto itself
take none. Every other way into a block that takes windows -- the dispatch, another region, a
block of the region other than the one it takes from -- goes through the block's entry test:
windows over the accesses the block and the blocks taking from it rely on, placed from the
registers at the block's own start, found by following the code from that start alone rather
than from what the chosen way put in them, so the test holds however the block was entered; a
window not clean leaves at the block's start with nothing of it run. The chosen way branches
past the test, a jump back through an inner label of the dispatch's table (in a flat region,
where every jump back goes through the dispatch). An access no register at the block's start
leads to keeps its own test. Registers holding one value at the start of a block that takes
windows were made so before it, which an entry from elsewhere does not keep: a group begun in
the block or after it follows all but one of them as values of their own, while a group begun
before it still takes them all (its accesses there are the entry test's). The page tests an
iteration of `tools/cork-bench`'s programs makes, before -> with this planner's groups kept
within their block -> reaching past it: sort 440 263 -> 147 106 -> 102 418, the tree 286 308 -> 220 183 -> 135 136,
virtual calls 236 810 -> 202 756 -> 188 072, the game's entity update 44 165 -> 41 179 -> 35 703,
SSE float math 38 930 -> 30 736 -> 24 587, the switch 33 031 -> 27 582 -> 23 486, the loading
phase's fifteen hundred small functions 104 983 -> 102 526 -> 102 493. In time (the best of
five reps, the median of nine processes, `node --no-liftoff`) sort went 815 -> 474 us an
iteration, the strings 512 -> 421, SSE float math 150 -> 136; the rest moved within the five to
ten per cent a process's figure moves by. The first iteration, which pays for the planning, came
out 2 per cent slower in the geometric mean (the median of seven processes), and the loading
phase's, bound by translation, 1 per cent faster: the planner takes about half as long again as
the block-by-block one did, and the modules it gives are a few per cent smaller.

The leave for a window not clean, at a group's first access or at an entry test, is *held* (its
exit carries vector `HELD`): an untranslated exit with budget left goes through the epilogue's
hash probe, which found this very address's entry and tail-called it, whose check left again
with nothing retired -- a loop spinning for ever with the budget untouched the moment its window
met a page it could not use. Held, it returns to the host, which interprets the instruction.
All the windows tested at one place share one such exit. A held exit is counted by target but is
no candidate and asks for no copies (`missAt`): a region formed there, or formed again with
copies, tests the same and leaves the same way, and counted, a small function formed into many
callers inside their loops had every region holding it formed again once its count came up
(the same workload with `callTargets` alone, 300 M instructions: 490 regions formed again with copies and 10 188 held exits, 30 and 935 once held exits were counted apart).

That probe takes EIP 0 for a miss before it looks: an empty slot's key is 0, so a jump to address
0 -- a call through a null pointer -- took the first empty slot it met for an entry and ran some
region's code with its label, where the processor faults on the fetch.

A block that loops onto itself is taken further (`planLoop` and `emitStreamWindow` in
`emit/memory.js`, `emitHoistedLoop` in `emit/region.js`): when a register its accesses go off
holds at the end of a turn the value it held at the start moved by a constant (the planner's
values above), each access group moves by a fixed stride a turn -- a stream. The turns a stride
of at most 4096 bytes takes span at most three pages beyond the window, so before the turns the
pages every stream reaches in them are tested once -- against inaccessible, and against code at
the page for a stream with a store -- and those turns run a second copy of the body with no test
on the streams' accesses; the back edge counts the turns down and goes back to the test when
they are spent. A test that finds a page not clean runs the checked copy (the groups above) to
the loop's end. A string instruction with no repeat (`movs`, `stos`, `lods`, `cmps`, `scas`)
moves its pointers by its size a turn while DF is clear, and a loop of them whose body does not
write DF is planned so: the test before the turns reads DF with the pages, and DF set runs the
checked copy. That took the benchmark's sort, which moves its elements with a loop of `movsb`,
from 354 538 page tests an iteration to 102 418 and 722 -> 480 us, and its strings 134 990 ->
101 608 and 451 -> 377.
An access off a register the block changes otherwise keeps its own test in both copies. A
pointer walk of loads and a store (`mov`/`add`/`mov`, `add esi, 12`) 125 -> 79 ms, an SSE
dot over an array (`movups`, `mulps`, `add esi, 16`) 157 -> 110, CPU time, best of five
interleaved runs on a loaded machine; the no-test ceiling was about two thirds of the checked
figure.

A `rep movs` or `rep stos` moves, per turn of its loop, every element that lies wholly on the
current page of each pointer the way DF goes -- up to the page's end, down to its start -- as
far as ecx and the budget go, at once: one test of those pages (inaccessible, and code for the
destination), then one `memory.copy` or `memory.fill` over the bytes the run spans -- or a word
loop for a value that is not one byte repeated -- with ecx, the pointers, the count and the
budget moved by the whole run. An element across a page, a flagged page, and a copy whose
destination lies just ahead of its source the way it goes (above it going up, below it going
down, by less than the run: the processor reads there what it has just written, where a memmove
does not) take the per-element path. `rep movsd` 5.2 -> 0.7 ns an element, `rep stosd` 2.9 ->
0.6. Going down -- a copy whose destination lies above its source and inside it, as the guest
msvcrt's `memmove`, `memcpy` and `strcpy` make one (`copyDown`, see `win32.md`) -- had taken the
per-element path; under the engine, a loop of one `rep` a turn (as below) of `std; rep movsb`
moving a run 32 bytes up, 4 KiB 20 500 -> 70 ns a turn, 64 KiB 357 000 -> 1 610, `std; rep
movsd` of 64 KiB 75 300 -> 1 980, `std; rep stosb` of 64 KiB 332 000 -> 2 040. Both
interpreter tiers move them the same way (`Memory.repeat` in `ir.js`, which `blockState` answers
with a `copyWithin` or a `fill` of RAM; `repeatBulk` in `interp-wasm.c`, a `memory.copy` or
`memory.fill`, the module built with `-mbulk-memory`), under the same tests, each element they
leave going one at a time as before, and a bulk store into the JavaScript interpreter's own run
ending the run as a store does. They have to: a `rep` a slice's budget stops in translated code
leaves on the instruction, in the middle of its block, where no region has an entry, so the next
slice runs the rest of it on an interpreter tier -- as one instruction, whatever the count -- and
there it went an element at a time. Under the engine, a loop of one `rep` a turn timed between
two points of one run (node, pinned to a core, median of three, a run each): `rep stosb` of 4 KiB
1 100 -> 262 ns a turn, of 16 KiB 12 690 -> 914, of 256 KiB 985 000 -> 14 100; `rep movsb` of
16 KiB 14 700 -> 1 100, of 256 KiB 1 437 000 -> 10 400; `rep stosd` and `rep movsd` of 256 KiB
75 500 -> 7 190 and 101 000 -> 7 740, where cork's test machine runs the same loop's 16 KiB
`rep stosb` in 0.15-0.4 us and its 256 KiB in about 5. An
element of the per-element path counts against the slice's budget as an instruction does, and a
turn of the bulk path a unit for every sixteen bytes it moves, a begun one whole, where it had
counted each element too: a fill or a copy of sixteen bytes costs about what a translated
instruction does, and counted by the element a `rep` of bytes ended its slice sixteen times as
often as its time did -- each end a turn of the host's scheduler, and the rest of the `rep` on an
interpreter tier. The same loop, one thread: `rep stosb` of 4 KiB 262 -> 95 ns a turn, of
16 KiB 914 -> 399, of 256 KiB 14 100 -> 5 870; two threads each running it, 16 KiB 1 625 -> 230,
256 KiB 41 500 -> 7 820. The interpreter tiers count a `rep` as one instruction, as the emulator
does. A `rep cmps` or `rep scas` tests its stop condition before the budget: a slice that runs out on the iteration that stops it leaves the
instruction done, where it had left on it and the instruction run again scanned on past the match
(a `repne scasb` strlen of "abc" answered 9). A `cmps` sets its record's first operand only once
the destination's element is read: a fault there leaves the record of the compare before it
whole, where its AF, CF and OF had been folded with the source's next element in place of its
own. The source of `lods`, `movs` and `cmps` takes an `fs:` override as any memory operand does,
the thread block's base added to esi, where translated code had read linear esi; the destination
is es:[edi] whatever the prefix, and a `rep movs` with an `fs:` source takes the per-element
path.

A `repe` or `repne` `cmps` or `scas` passes over, per turn of its loop, the elements that do not
stop it among those that lie wholly on the pointers' current pages the way DF goes, all but the
last of them (`bulkScan`): a loop of a load, or two, and a compare alone, when those pages can
be read, with ecx and the pointers moved past the elements and the budget charged by their bytes
as a bulk move is. The element after them -- the one that stops the instruction, or the last on
the pages or of the count -- takes the per-element path, which sets the flags, tests the stop
and the budget and faults on its page, so however the instruction leaves -- done, out of budget,
at a fault on the next page -- it leaves the flags of the last element it compared, as the
processor does. Both interpreter tiers pass over the same elements (`Memory.pass`, `passBulk`).
The same loop: `repne scasb` to a zero at the end of 64 bytes 86 -> 34 ns a turn, of 4 KiB
6 130 -> 2 060, of 64 KiB 280 000 -> 37 000 (0.56 ns a byte); `repe cmpsb` of two equal runs of
64 KiB 331 000 -> 51 600, `repe cmpsd` 63 700 -> 15 600.

Under cork alone the addresses below `closedBelow` are marked no-access -- a fetch or a store
there faults, as an access violation a program's handler can catch; a translated read outside
`precise` is not tested (it wraps into RAM, above). A process passes 0 for now, leaving the null
page readable as the emulator's is: a title that runs reads through a null pointer our libraries
hand it where Windows would not, and it faults once the range is closed.

Under `engine: 'cork'` (milestone 5) nothing of the emulator is loaded. The engine module the
configuration names (`engineUrl`) is loaded by URL at `boot()` like the emulator is, and
`internal/cork-host.js` builds the translator's runtime over a `WebAssembly.Memory` of its own:
`memorySize` of guest RAM with cork's 512-byte state block and tables *beside* it, not carved
from the guest's RAM as hybrid carves the tables from the top of the emulator's. There is no
boot ROM, so `boot()` needs no `moduleUrl`/`wasmBytes` and `romBase` is `-1`; the host sets the
registers the ROM would have left (flat segments are implicit, `esp` at the initial stack,
`eflags = 2`, the x87 control word and MXCSR at their defaults, every x87 register empty) and
reads `eip` from the entry vector at the first slice, the way the ROM's indirect jump read it.
The whole register file lives in the block, so a context is a copy of the block plus the halted
flag and `fsBase` (`captureBlockContext`/`restoreBlockContext` in `internal/context.js`); a
`fault` exit builds the fault record from the vector and the state the faulting instruction
left, since there is no IDT and no frame to read. Either tier's fault is first offered through the
host's `onFault` -- with `stack`, `eax` and `edx` taken from the register file, what the ROM stub
would have saved -- so the layer's `onFault` handler sees the same record under every engine and
a program's exception handlers run under cork too; only one the handler declines is recorded and
stops the machine. Where the translator has no entry for an
address, the slice loop runs cork's own interpreter tier over the same state block
(`interpret`/`blockState` in the engine module) for the slice's whole budget in one call,
`syncIn`/`syncOut` bracketing the run rather than one per instruction; it stops at a halt, a
trap the host has to answer, or an address the translator has an entry for, where translated
code's own register file takes over. A fault it raises goes the same way; an instruction the evaluator has no model for is the engine's no-tier answer,
`cpu: cork has no tier for 0x0f (fxsave) (eip 0x00001003)`: the byte and address are the
instruction the interpreter actually met, not the address the slice started at.

The interpreter keeps decoded runs by their first address -- the instructions that fall through
from one to the next, up to a jump, a call, a return, a `hlt` or anything that traps, and through
a conditional branch, which a taken one leaves midway -- checked against RAM byte for byte on
every hit so code rewritten in place is decoded again. A run grows as execution first reaches its
end, so only what ran is decoded, and a store into the run being interpreted ends it after the
storing instruction (the memory's `watch`), so an instruction a program patches in a run
already decoded runs as written. The stop test, the hotness count and the ring of recent starts
are per run rather than per instruction, and a jump's target always starts one, so every start a
jump reaches is still counted; a fetch from an inaccessible page faults at the address fetched.
A cached run some of whose bytes cannot be fetched now (a page it spans freed or protected since)
is decoded afresh rather than failing its check: its leading instructions run and the fetch
faults at the one that reaches the page -- the check faulted at the run's start with the EIP of
the instruction before it, so a faulting `call` was re-executed and ran twice. The interpreter's
extended reader keeps an infinity and a NaN's sign as the translator's does (every infinity read
from a ten-byte value had become a NaN) and raises IE for a signalling NaN only (it had for a
quiet one with a payload), and `lea` with an `fs:` override computes the offset alone, as the
processor and the translator do (the interpreter had added the thread block's base).
`blockState` keeps eip and the flags word as fields of its own between `syncIn` and `syncOut`
(which write them back), and the width and sign tables the flag arithmetic reads per instruction
are arrays -- frozen objects with numeric keys are dictionaries to V8. Measured on compiled C
programs with translation off, each in a process of its own: a call-heavy program 42 -> 22 ms an
iteration, a CRC 53 -> 29, a tree walk 54 -> 31, a sort 98 -> 59, x87 math 66 -> 51, 1.55x
geomean over ten. Each instruction of a run has a step compiled for it once
(`fast.js`): the common integer instructions, shifts and two- and three-operand `imul` included,
become a function of the state with their operands resolved, and an x87 instruction goes
straight to the x87 model; the rest runs through `evaluate`. `blockState` keeps the fields a
step touches on the state object itself and its accessors on a prototype -- one literal holding
both put the object in V8's dictionary mode, and every `state.retired++` was a hash lookup (a
load/add/store loop 250 -> 20 ns an instruction, x87 370 -> 56). The state and its memory are
instances of two classes (`BlockState`, `BlockMemory` in `interp.js`), one shape of each for every
machine a process makes: made as an object over a prototype of accessors built per machine, each
machine's state had a shape of its own, and the steps -- one set of functions for every machine --
read it through as many shapes as there had been machines, polymorphic from the second and
megamorphic from the fifth: a loop of five instructions on the JavaScript interpreter alone in
six machines one after another in one process went 555, 514, 513, 547, 516, 537 -> 513, 452, 365,
387, 386, 389 ns a turn (median of five processes). An access within one page tests
that page's flag once, and a store to a page that is neither inaccessible nor translated code
does nothing more; an access that crosses a page is judged by both. An `xadd` into memory writes
its sum where the destination was before the source register changed (`xadd [ebx], bh` moves
ebx), as the processor computes the address once.

Under `cork` alone the interpreter tier's integer instructions run in wasm
(`interp-wasm.c`, built with `clang --target=wasm32` by `scripts/build-interp-wasm.mjs` into the
committed `interp-wasm.bytes.js`, whose recorded SHA-256 a unit test checks against the source,
so a checkout needs no C compiler). It decodes each instruction from guest memory as it executes
it -- no records and no closures, so a first visit costs what a later one does and code rewritten
in place needs nothing -- keeps the arithmetic flags lazy, tests the page flags as the JavaScript
interpreter does, and leaves MMX and the rare and system forms unexecuted at eip: the JavaScript
interpreter runs one run from there and the wasm tier goes on. It counts hotness at the
targets of the jumps it takes, in the same table the JavaScript interpreter counts in (moved into
the memory past the tables, with the ring of recent starts), and looks each target up in the
entry hash translated code probes, so a range still ends at a start with a region (a jump to
address 0, a call through a null pointer, finds none: the probe takes an empty slot, whose key is
0, for a miss before it compares the key with the target); a store into translated code
ends it after the store for the host to invalidate, and `out` to the trap port after the write.
Its data and stack sit in the page below guest RAM, past the state block, which
nothing else in cork's layout writes. `wasmInterpreter: false` runs the JavaScript interpreter
alone. The records, closures and garbage of the JavaScript interpreter's first visits were most
of what code met a handful of times cost (a loading phase's forty thousand decodes kept 42 MB,
and the collector took 40 % of its first pass): with translation off, on eight integer workloads,
9-13 ns an instruction on the tier against 37-56 on the JavaScript interpreter in a steady state,
and 11-17 against 180-370 on a fresh machine's first pass. On `tools/cork-bench`, each workload in its own processes, five
runs interleaved: the first iteration's geomean 48.9 -> 29.1 ms, the loading phase's 1 093 -> 773
ms, the self-patching routine's 94 -> 8.7 ms, the ten others 0.98-2.25x. The hardware corpus on
the tier, the JavaScript interpreter taking what it leaves: 14 751 cases judged, 0 diverged; and
generated integer programs run on both interpreters leave the same registers, flags and memory.

The tier runs x87 and the XMM forms of SSE too, each as its JavaScript model (`ir-x87.js`,
`ir-simd.js`) has it and in its order of effects. x87: the registers doubles in the block by
physical number, the stack faults, C1 on a push, single precision control's rounding, the extended
loads and stores, a quadword `fild`'s integer kept beside its double for a quadword `fistp` or
`fisttp` to store whole (dropped at every run's start, as the JavaScript interpreter drops its own
at every sync), the host's `Math` for the transcendentals (imported, as translated code imports
them) and the model's exact partial remainder for `fprem` and `fprem1` in integers, as translated
code's helper computes it; it leaves the environment and
save images (`fldenv`, `fnstenv`, `frstor`, `fnsave`) and packed BCD to the JavaScript interpreter.
SSE: the moves, the logic, the scalar and packed arithmetic, square roots, minimum and maximum, the
compares, the conversions (by MXCSR's rounding), the shuffles and unpacks, the packed integer family
and `ldmxcsr`/`stmxcsr`; a single lane is computed in double from its value and rounded back, and a
NaN result is the first NaN operand's, quieted, or the negative indefinite, as the model computes
them; the MMX forms (an `mm` operand puts the stack in the MMX state) and `maskmovdqu` stay the
JavaScript interpreter's. Each is a helper `run` calls with the instruction's address alone, the
helper decoding its prefixes again: passing the lazy flag record, the flags word, the prefixes or
the modrm's address as arguments, folding the record for the call, decoding the modrm in `run` or
testing for an SSE opcode ahead of the integer cases each made the integer paths two to ten per
cent slower in TurboFan, so the SSE helper is reached only where those cases leave; an `fcmov`, the
one reader of the flags, is left by `run` and run by the exported wrapper with the record folded on
the way out. Unless `precise`, the tier does not keep the sticky IE, ZE and UE, a signalling NaN
loaded, or C1's clearing by a push or `fcomi` (see the limitations): their tests were 6 % of an x87
transform loop's time on the tier; `interpretedRelaxedReads` in the diagnostics counts the `fnstsw`
it runs meanwhile. For the two interpreters to leave the same bits, the JavaScript one gives an
arithmetic of two NaN operands the x87's choice -- a quiet one over a signalling one, then the
larger significand, then the positive, quieted -- where the host's own operation returned whichever
its compiler put first, quiets a NaN the host's `Math` returns (its `log2` and `log1p` of a
negative NaN are signalling, which a call from wasm quiets), and takes a NaN operand's bits before
asking whether it is one, or from its bytes (the SSE lanes): once V8 optimizes the code and knows a
value is a NaN it may use the canonical NaN in its place, and the same instruction gave a
signalling NaN's quieted payload before its code was optimized and the canonical NaN after. An x87
or SSE instruction had cost one run of the JavaScript interpreter, some 500-600 ns with its
closures and decoding: with translation off, in one process paired
with the tree before it (eleven rounds), an x87 transform, normalise and cull loop 107.3 -> 6.4 ms
an iteration (16.7x), its SSE form 289.6 -> 6.4 (49x) and its single-precision form 107.4 -> 6.1
(17.5x), the entity updates 27.2 -> 2.6 (10.2x), 45.1 -> 2.3 (SSE, 19.7x) and 28.2 -> 2.7
(single, 10.2x); the integer workloads 0.94-1.01x, 0.975 by geomean, where a second copy of the
tree before reads 0.96-1.04x: the helpers' calls cost the integer loop a little in TurboFan, which
the entry hash's probe taking an empty slot first gives back (1.00 by geomean). A
later host's first iteration (`coldMs`), which starts on the tier, 1.10-1.89x on the six float
workloads (the SSE transform 59.0 -> 31.2 ms); a process's first host, whose float loops are
translated by the time the JavaScript interpreter's stretch ends, as before (0.89-1.17x a
workload, 1.00 by geomean, the second copy 0.91-1.10); translated code is the same, and so is the
steady state (0.96-1.04x a workload without branch hints, the copy 0.94-1.04). The hardware corpus on the tier, `precise`: 14 751 cases
judged, 0 diverged, the instructions it leaves to the JavaScript interpreter 289 341 -> 98 790, the MMX forms most of them;
generated x87 programs over stacks of every shape, operands on every edge and every precision and
rounding control, and generated SSE programs over every mandatory prefix, register and memory
form, MXCSR rounding and operands on the edges, leave bit for bit what the JavaScript interpreter
leaves, and without `precise` the x87 ones differ from it only in IE, ZE, UE and C1. The tier's own
optimising compile grows with it only where floats run: `run` is the integer loop alone (33 KB as
before), and the x87 and SSE helpers (10 and 20 KB) are compiled once they get hot -- with translation off and
the tier from the first instruction, V8's optimising compile took 50-72 ms over `run` where it took
55-85 over the one function before, and 15-23 ms for the x87 helper and 38-52 for the SSE helper
and its packed integer family on the float workloads; in a process's first host neither helper
got that far on any of seven workloads traced (the four float ones, vm, load, patch).

A process starts on the JavaScript interpreter all the same: its hosts hand over to the wasm tier
once they have run `wasmInterpreterAfter` of their instructions between them (default 8192), each
jump target new to a host counting as 128, and a host made after the tier started runs it from its
first instruction. The tier's module is decoded, compiled and instantiated at its first run, not
when a host is made. Node's V8 gives the tier's `run` (one function, 33 KB of wasm) its optimising
compile a few hundred instructions in, 62 ms of a core, once a process: on one core that time was
taken from the translator in the same first iteration, and a small program interprets only two to
four thousand instructions before its loops are translated. A loader, or a table of many small
functions, meets enough new targets to hand over within a few hundred instructions (at the 64th new
target where every run is new). On `tools/cork-bench`'s `firstMs` -- the first iteration of a
process's first host, every workload in processes of its own, pinned to one core, seven runs
interleaved -- the thirteen original workloads' geomean went from 0.78x of ca1daa7 (the tree before
the tier and the rest of that speed work) to 1.03-1.09x in two sessions, the loading phase 1 967 ->
1 903 ms, the self-patching routine 71 -> 57, calls4096 in order 1 618 -> 1 610; the steady state
is as it was (paired rounds against the tier started at once, geomean 1.00x with and without branch
hints, each workload 0.96-1.03x, the ones at the edges back within a copy of the old tree against
itself on a second run). The start moved rather than went: `coldMs` times reps three on of one
process, and where every rep is a small program the stretch is spent between the first few and the
start falls among the timed ones (the thirteen's `coldMs` 0.69x of before over five reps; over
fifteen the bytecode interpreter's is back to 7.8 ms against 7.7).

In `cork` mode the interpreter counts hotness itself, at the starts a jump reached -- a taken
branch, a call, a return, or the target a region's untranslated exit went to -- in a flat array over
the address space (not a map: a straight-line loader runs millions of instructions once and would
grow one entry each). Only those: an interpreted run stops wherever a feed or the slice's end falls,
mostly mid-block, and when every instruction counted, each such place became a region entered in
the middle of another's block -- twelve thousand of a Doom 3 warm run's seventeen thousand store
misses, and a different set each run, so the store never caught up. A start interpreted `hotThreshold` times becomes a candidate, the layer's
feed forms it, and once a region exists the host runs it rather than interpreting it -- cold code
stays on the interpreter, hot code moves to the translator. The default is two under `cork`, not the sampler's two thousand: there is no compiled second
executor to carry the code in the meantime. A title's loader runs millions of instructions each
met once or twice, so the candidates are many; the runtime drains its queue hottest first -- the
interpreter keeps counting a waiting candidate and hands it over again at every power of two with
the count as its heat -- so the loop met forty thousand times is formed before the code met twice,
and a long queue costs memory, not the hot loop's place. With no frame to feed the translator (a
loader's long stretch) the host feeds it inside the slice, at most once every 2 048 interpreted
instructions; a candidate noted sooner than that is fed at the first start the interpreter meets
once the spacing allows -- a tight loop's last note is on its 128th turn, and when all of them fell
within the spacing the loop ran interpreted to its end (eight million instructions of a
four-instruction loop in 81 slices: 259 ms interpreted, 17 ms now translated). A `hlt` under `cork` ends the slice and
not the machine: on the emulator a halt holds the processor until its timer interrupt, whose ROM
handler only returns, and this host has no timer, so the layer's next slice is the tick and the
guest goes on at the instruction after the `hlt` -- the idle loop a scheduler parks the processor
in (`hlt; jmp`) costs one slice per turn, as it does there.

A call from translated code into a page left to the interpreter (a volatile one, or code the
translator refuses) crosses twice, and the crossing is the host's own work: the region's exit, the
exit's count, a range of the interpreter, and the entry lookups on each side. The host keeps one
object of hooks for every range rather than new closures per range; the interpreter is told the
host has just looked for an entry at the range's start (`asked`), so its first run goes without
the question; the entry map remembers the last entry it found, which is the one the host asks for
next when the interpreter stops at it; `enterRegion` reads the state without helper closures;
the untranslated exits keep one record per target, its count and its tops (the tops were a second
map, and one never trimmed); and an arithmetic step of the interpreter has one closure per sum,
so the record the flags come back in is not allocated. `tools/cork-bench`'s `patch` workload is
this shape -- a loop calling a routine that writes its own immediate when its argument changes,
as the era's span drawers did -- and went 10.0 -> 8.9 ms an iteration; a loop doing nothing but
the crossing 500 -> 340 ns a turn. The two clock reads around each interpreted range, for a slow
slice's account of itself, were about 100 ns of what was left under node, and a shipped build
does not read them: they, the translator's milliseconds and its record of long holds are the
`timings` setting's, off by default and on in the harness (340 -> 230 ns a turn, the `patch`
workload 9.1 -> 8.0 ms an iteration). A routine that rewrites its own code on every call is decoded
and compiled again on every call, which costs more than the crossing.

## 2. Contract

| field      | value                    |
|------------|--------------------------|
| `name`     | `cpu`                    |
| `version`  | `0.1.0`                  |
| `requires` | `['log']`                |

Source: `src/layers/cpu/module.js`. The layer is the only one allowed to touch `vendor/`
(enforced by `scripts/check-boundaries.mjs`), and it does so by dynamic `import(moduleUrl)` at
`boot()` time rather than by a static import, so the several hundred kilobytes of emulator never
enter the type check or the bundle.

### Configuration

| option          | type                       | default             | meaning |
|-----------------|----------------------------|---------------------|---------|
| `memorySize`    | number (power of two)      | `1 GiB`             | Guest RAM. Reserved, not committed: the host pays for pages the guest touches. Must be a power of two; the emulator requires it. With an engine other than `emulator` the top `TABLES_RESERVE` (4 MiB) is the translator's tables, and `layout.memorySize` reports the rest. |
| `engineUrl`     | string                     | none                | The translator's entry module, imported at `boot()` under `cork`; `createApp` resolves it from `cork.moduleUrl` or the package beside core. |
| `cork`          | `EngineConfig`             | `{}`                | The translator's own settings (`engine.js`): `hotThreshold` (the interpreter's own count under `cork`; default 2, where the sampler's default is 2000; the queue is drained hottest first), `maxRegionBlocks`, `maxRegionBytes`, `batchRegions`, `maxQueued` (the candidates kept waiting, the coldest evicted past it; default 8192), `maxBatchRegions` (a deep queue takes a quarter of itself per batch, up to this, and a batch its regions' direct callees; default 256), `relinkAfter` and `relinkRegions` (see the relink above; 0 turns it off), `dispatch` (default false: true places each module in a range of the table so a transfer into its own module is a direct tail call, see the transfers after the relink; off by default because games run from their start to a menu on real hardware held 57 % of the canvas's frame rate with it alone on against neither, where the benchmarks gain at most a few per cent) and `mergeAfter` (default 2^16: the crossings between two modules, for each region a merge would build, before the worker gathers them into one; 0 never), `leafCalls` (default true: a small leaf callee is formed into its caller, see above), `runtimeHelpers` (default true: a direct call to a compiler runtime helper recognised by its bytes, MSVC's `_ftol2`, is formed as the instructions it computes, see above), `callTargets` (default false: true samples indirect calls and forms a region whose indirect call keeps going to a few small leaf callees again with them in it, see above -- the benchmarks' virtual and indirect calls run four to five times faster with it, but games run from their start to a menu on real hardware lost more than half the canvas's frame rate with it and `dispatch` on, froze frames past 250 ms and repeated their audio, and the cause is not found yet, so it is off until it is), `structure` (default true: a region's loops, those of its control flow, are wasm loops -- a jump forward is a branch out of its target's wasm block, a jump back to the head of a loop around it a branch to that loop, only other backward jumps take the dispatch, and a block inside a loop is entered through the region's copies, see the loops above; false: every backward jump goes through the dispatch, and the store keys lack the `S` a run with it on or left unset has; a flag no block after reads is not computed either way, see the lazy flags above; the first structured form, loops by address, doubled the guest's time a frame in Doom 3's menu, and this one has not been measured in a game yet), `wideFirst` (default true: x87 regions compiled for the precision control the program runs under -- the wide ones until single is seen, single until another is seen -- see the x87 section; false tests precision at every rounding operation from the start), `precise` (default false: what the translator and the interpreter tier in wasm relax for speed, listed under the limitations below -- the x87 exception bookkeeping, and the flags an instruction leaves undefined, which hold what the cheapest code leaves there -- is not kept; true keeps it as the processor does and the undefined flags as the emulator leaves them -- the corpora, the sequences and the emulator-judged tests run so, and its translations are stored under their own key, `P` among the emitting settings), `countTransfers` (a diagnostic: each transfer between regions through the hash counts into `transfers`), `blockProfile` (a diagnostic, cork's own layout only: every block counts its executions in a table past the tables -- a slot per hashed block start of its address, count and a shared-slot mark, in a memory the host sizes for it -- the diagnostics carry `blockCounts` and the forty `topBlocks` with their regions, the harness writes them beside its report for `tools/cork-mix.mjs`, and the run keeps no store), `blockProfileFrom` (with `blockProfile`: seconds after the runtime is made at which the counts start over, so the profile holds a steady state rather than the load), `timings` (a diagnostic, default false: the host clock read around the translator's phases and the host's slices, for the diagnostics' milliseconds and `stalls`, the record of long holds; off, those read 0 and nothing is recorded -- the harness turns it on), `traceStore` (a diagnostic: every store key put and missed, `entry:hash:top` with the blocks' spans, in the diagnostics' `storeTrace`; the harness writes it beside the report as `-store.json`, and `missNoRecord`/`missNoModule` split the misses always, as `lookedUpNow`/`lookedUpLater` count the batches the store answered in the call that formed them and a turn later), `feed`, `missThreshold`, `wasmInterpreter` (default true: under `cork` alone the interpreter tier's integer, x87 and SSE instructions run in wasm, see the interpreter above; false runs the JavaScript interpreter alone), `wasmInterpreterAfter` (default 8192: how far the JavaScript interpreter carries a process's hosts, between them, before the wasm tier takes over, a jump target new to a host counting as 128 instructions; 0 runs the tier from the first instruction), and `leaveOut`, the instruction classes (`x87`, `mmx`, `sse`) a run leaves to the emulator so a defect can be localised by class; such a run keeps no translation store. The diagnostics among them -- `timings`, `blockProfile`, `traceStore`, `countTransfers` -- are left out of a production bundle whatever is asked (`import.meta.BOTTLIFY_DIAGNOSTICS`, see `host.md`), the translator among it: `npm run build` bundles `@bottlify/cork` into `dist/cork/` under the same define, and the built package loads it from there. |
| `trapPort`      | number                     | `0xb077`            | The I/O port a stub writes its trap id to. |
| `entryVector`   | number                     | `0x7000`            | Linear address of the dword the ROM jumps through to enter guest code. |
| `initialStack`  | number                     | `0x300000`          | ESP the ROM sets before jumping into the guest. |
| `thunkBase`     | number                     | `0x100000`          | Where the stub table is placed. Low, so everything between it and `initialStack` can be the first thread's stack. |
| `thunkCapacity` | number (bytes)             | `16384 * 16`        | Room reserved for the stub table: 16 384 slots of 16 bytes. Every import and every COM method takes one; none is ever given back. |
| `jit`           | `Record<number, number>`   | `undefined`         | The emulator's compiler budgets by config index (1 = pages one module may span, 3 = extra basic blocks discovery may follow, 6 = chaining). For measurement, not production. |
| `sampling`      | `boolean`                  | `true`              | Whether `runSlice` credits an address bucket per slice (see "Sampling" below). Always on; `false` is the only way to turn it off, for a caller measuring the emulator itself. |
| `engine`        | `'emulator' \| 'cork'` | `'cork'` | Which execution engine runs the program (see "Engines" above). An unknown name is refused by `create()` with `cpu: unknown engine "x" (…)`. `cork` runs with nothing of the emulator loaded; `boot()` under it needs no emulator artifacts and throws `cpu: engine "cork" needs an engineUrl` without one. |

Chaining (index 6) is switched on automatically when the running engine validates a wasm tail
call and the caller has not set the knob (`tailCallsSupported()` in `internal/v86-host.js`).

### API

`create()` returns the API below; nothing that needs a running emulator works until `boot()` has
been called, and each such method throws `cpu: boot() must be called before the guest can run`
otherwise.

| member | signature | meaning |
|--------|-----------|---------|
| `layout` | `{ entryVector, initialStack, thunkBase, thunkCapacity, memorySize, romBase, romSize }` | The addresses the layer owns, for whoever lays out the address space. |
| `boot` | `({ moduleUrl, wasmBytes }) => Promise<void>` | Instantiates the emulator, drives the ROM to protected mode, registers the trap port. Throws if already booted. |
| `booted` | `() => boolean` | Whether `boot()` has completed. |
| `fault` | `() => GuestFault \| null` | The fault that stopped the machine, with a `text` description, or null: a processor exception read off its frame, or one the host raised. |
| `raiseFault` | `({ name, detail, eip, calledFrom? }) => void` | Records a fault of the host's own naming (`vector` -1, `detail` is the whole report), to be found by the same poll as an exception. Only the record: called from inside a trap, the caller sends the stub's return into the park loop, whose `hlt` is what ends the slice. |
| `onFault` | `(handler: ((fault) => boolean) \| null) => void` | Who is offered a processor exception before it stops the machine. Called inside the trap with the fault read off its frame (`eax`, `edx` and `stack` included) -- under `cork`, from the host's own fault exit with the same fields; answering `true` means the handler has claimed it and sent the thread elsewhere, and nothing is recorded. |
| `stopWithFault` | `(fault) => void` | Stops the machine on a fault that was offered and not taken, recorded exactly as one never offered. |
| `run` / `stop` | `() => void` | Free-running mode (the emulator's own loop). The scheduler does not use these; it uses `runSlice`. |
| `readPhysical` | `(address, length) => Uint8Array` | A **window** on guest RAM — a subarray of the emulator's memory, not a copy. |
| `writePhysical` | `(address, bytes) => void` | Writes through the emulator, which invalidates any compiled code on the pages touched. |
| `readU32` | `(address) => number` | One dword, with nothing allocated. |
| `readU32sInto` | `(address, count, into, at) => void` | `count` dwords, signed, into `into` from `at`, in one call and with no region check -- the memory layer's `readU32sInto` checks the span and then hands it here, where it made a call down through this api to the host per word. |
| `writeData` | `(address, bytes) => void` | Writes straight into RAM without the emulator's device checks. Meant for memory the guest does not execute; a page the compiler holds code for is still dirtied (see "Host writes and the compiler"). |
| `readReg32` / `writeReg32` | `(name[, value])` | `eax ecx edx ebx esp ebp esi edi`, plus `eip` and `eflags` (the latter read through the emulator's accessor so lazy arithmetic flags are folded in). Unknown names throw. |
| `registerFile` | `() => Int32Array \| null` | The eight general registers in place, `eax` to `edi` in the encoding's order, for a caller that reads and writes them on every crossing (the bridge: ESP read, EAX written); `null` when the engine keeps them nowhere a view reaches. Cork's view lives as long as the machine; the emulator's reads empty once it grows its memory, and the caller asks again. |
| `ramView` | `() => Uint8Array \| null` | The guest's RAM in place, byte 0 at guest address 0, for a caller that reads it on every crossing and checks its own spans (the memory layer's reader: a host call's stack words and its thread's last error); `null` when the engine keeps it nowhere a view reaches. Cork's view lives as long as the machine; the emulator's is detached once it grows its memory, and the caller asks again. |
| `registerTrap` | `(name, popBytes, { preserveResult?, forwardTo?, saveRegisters?, pushEdx?, holdEip? }) => { id, address }` | Takes a stub slot; written into guest memory immediately if the table has already been laid down. Throws when the table is full. `saveRegisters` (`pushad`) or `pushEdx` (just EDX) run before the trap even without `forwardTo`; `holdEip` emits neither `ret` nor a jump, for a caller that decides EIP itself while handling the trap (the bridge's `hook`, EDX alone, or its `siteHook`, every register, together with `saveRegisters`). |
| `thunkImage` | `() => Uint8Array` | The stub table so far, to be written at `layout.thunkBase`. Marks the table as written. |
| `parkAddress` | `() => number` | Slot 0 of the table: `hlt; jmp` — where a terminating or blocking call returns to. |
| `onTrap` | `(handler: (id) => void) => void` | Who gets non-fault trap ids. The bridge claims this. |
| `runSlice` | `(maxInstructions) => number` | Runs at most that many instructions (to the end of the basic block the bound falls in) and returns how many retired. The scheduler's unit of progress. |
| `captureContext` | `() => Context` | The running thread's complete CPU state as an opaque record. |
| `restoreContext` | `(context, threadBase) => void` | Restores a context, pointing FS at `threadBase` (the TEB). The TEB is a parameter so a restore that forgets it is not expressible. On the emulator the ROM's GDT holds FS's own descriptor (`SEL_THREAD`, 0x18, the selector cork answers too) and the restore writes the thread's TEB into its base (`THREAD_DESCRIPTOR`), so a program that reloads FS (`push fs; pop fs`) finds its TEB again -- it read address 0 there before; `src/fs-reload.itest.js` runs one on both engines. |
| `resumeContextAt` | `(context, { eip, returnValue, esp?, registers? }) => void` | Redirects a saved context: EIP, EAX, optionally ESP, and optionally any general register by name (`registers`) -- for code that reads a register before it sets one, such as an exception handler's block reading EBP -- and `eflags`, a whole word that replaces the context's flags and drops the lazy arithmetic state beside it (`setContextEflags`: cork's flag record cleared, the emulator's `flags_changed` zeroed): the flags an exception handler starts with, and the ones the context it continues from gives back. |
| `newContext` | `({ entry, stackTop }) => Context` | A context for a thread that has not run: the current machine state as a template, positioned at its entry and stack, with the floating-point environment Windows starts every thread with (`freshThreadFpu`: x87 control word 0x27F, status 0, every register empty, MXCSR 0x1F80, XMM zero) rather than its creator's -- a precision set with `_controlfp` or a flush-to-zero MXCSR stays with the thread that set it, and the first thread, made the same way, no longer starts at the processor's reset word 0x37F. `src/fpuenv.itest.js` runs `fpuenv.exe` on the emulator and on cork: the first thread reads 0x27F and 0x1F80, sets single precision and flush-to-zero, and the thread it creates still reads 0x27F and 0x1F80. |
| `instructionCount` | `() => number` | Instructions retired since boot, exact past the emulator's own 32-bit counter. |
| `compiledModules` / `interpretedSteps` / `hostWrittenBytes` | `() => number` | Compiler and host-write counters (see diagnostics). |
| `profile` | `{ available, start, stop, read, instructionStats }` | The emulator's address-weighted profile and event counters, present only in a profiler build of the emulator. |
| `inProtectedMode` | `() => boolean` | `CR0.PE`. |
| `eip` | `() => number` | Where the guest is right now. |
| `forwardSave` | `32` | Bytes a forwarding stub pushes (`pushad`) before it traps. |
| `fpu` | `{ setResult, get, pop, depth, controlWord }` | The x87 stack, for a handler that returns a `double` or takes one from ST(n). |

An instance owns its emulator. `create()` may run more than once in the same realm (a process
replacement runs it again; the plan for two machines in one worker needs two at once), so the
emulator, the stub table and the fault record live in the instance the api closes over, and a
second `create()` cannot take the first one's machine; `diagnostics()` answers for the most
recently created instance. **A second boot is a second instance's own first boot**, not a
continuation of another one's: `boot()`'s "already booted" refusal reads only this instance's own
state, so a process replacement's fresh cpu instance boots cleanly while the machine it is
replacing is still standing (or already disposed) — it never sees the other instance's emulator
and never throws on its account. After `dispose()`, this instance answers exactly as one that has
never booted: `booted()` is `false`, `diagnostics()` reports `status: 'created'`, `fault()` is
`null`, `raiseFault()` is a no-op, and every method that needs a running emulator throws the same
`cpu: boot() must be called before the guest can run` a never-booted instance already throws —
there is no separate "disposed" refusal, because a disposed machine and one that has not started
yet are the same state from a caller's perspective.

### Diagnostics

`diagnostics()` answers `status: 'created'` until `boot()`, `'ready'` after. Metrics:

| metric          | meaning | when it moves |
|-----------------|---------|---------------|
| `running`       | Whether `run()`/`runSlice()` has been called and `stop()` has not. | On `run`, `runSlice`, `stop`. |
| `instructions`  | Total retired instructions. | Every slice. |
| `protectedMode` | `CR0.PE`. | Set during `boot()`, never cleared. |
| `traps`         | Slots taken in the stub table, park loop included. | Every `registerTrap`. |
| `trapCapacity`  | Slots available in total. | Fixed at `boot()`. |
| `trapCrossings` | Times the guest has left its own code for ours — every import, COM method and fault comes through the one trap port. | Every crossing. |
| `jit`           | `{ disabled, maxPages, loopSafety, cache, tableFree, compiledSteps, interpretedSteps, entries, interpretedDispatches, f80Conversions, codePageWrites, modulesLostToWrites, hotnessLostToWrites, chaining, chained, chainMissed, chainRefused, flagsDead, slowWrites, codePageWritesKept, x87TagLost, x87Sites, dirtyPages, finalised, published, discarded, hostWrites, hostWrittenBytes, refused }` | Per slice / per host write. Counters the emulator build does not carry read `-1`. `refused` is the first error a compiled module failed to publish with — a compiler that silently fails leaves every instruction interpreted, which is correct and several times slower. `published` is the last 4096 `[slot, start]` pairs `codegen_finalize` was called with, oldest first — `start` is the guest linear address the compiled unit begins at, for naming a JIT unit by the guest function it compiles once joined against the arrival order of the debugger's own `wasm://` script-parsed events. |
| `eip`           | The guest's instruction pointer. | Continuously; sampling it names a loop no host call would reveal. |
| `cork`          | The translator's report (`EngineDiagnostics` in `engine.js`): regions, entries, modules, `translatedShare`, invalidations, volatile pages, exits by kind (`interpreted` the misses the interpreter tier ran in place and stopped short of an entry), refused opcodes, and, with the engine's `timings` on, the milliseconds of translating whole (`translateMs`) and by part (`formingMs` the region forming, `lookupMs` the store's lookups, `emitMs`, `encodeMs`, `storeMs`, `instantiateMs`, `publishMs` — their sum), which says where a heavy run's translation time goes (0 without `timings`, as in a shipped build); `workerMs` is the emitting and encoding a translation worker did, apart from `translateMs`, which is the engine thread's own. `refusedWhy` carries the same refusals split by cause and block shape — `opcode (reason; entry kinds; entry x87)`, where the reason is `no-known-state` (the x87 tracker did not reach the block), `cut-second-top` (the block was reached with two different x87 tops), `step-null` or `unhandled-form`. `exitsByTarget` is the top 32 untranslated-exit targets with their counts and why each has no entry — `refused` (the decoder refuses its first instruction), `volatile`, `inaccessible`, `barren` (a region formed nothing there), `queued` (a candidate not yet formed), `other-top` (an entry stands at another x87 top) or `unknown` — which is what says whether a loading phase is a translation-policy problem or a decoder one. `forcedSteps` is how many turns retired nothing and the host forced an interpreted instruction through, zero when every turn moves. `x87RelaxedReads` counts the x87 status-word reads translated without `precise` that may see what only `precise` keeps -- an `fnstsw` into memory or into AX not read as C0 C2 C3 alone (`sahf`, a `test` or `and` of AH that masks the other bits out), `fnstenv`, `fnsave` -- found at translation, at no cost to the code: a title that misbehaves with some is worth a run with `precise`. `interpretedRelaxedReads` counts the status words (`fnstsw`) the interpreter tier in wasm stored while not `precise`, reads that may see a bit only `precise` keeps. `relaxedFlagReads` counts by opcode the translated instructions that read a flag an instruction before them in their block left undefined -- what they see there is the fast default's, not the emulator's (`precise`) -- so a title that misbehaves only without `precise` is checked there first. `null` without a translator. This whole snapshot is for a report: it sorts the exit targets and names each one's reason across the candidate queue, and read every slice it was a third of a loading phase's engine time; the frame counters read the translator's `counters()` instead -- regions, modules, invalidations, share, retired, `translateMs` and the exits, nothing sorted. The frame counters carry `cork.regions`, `cork.invalidations` and `cork.share` (cumulative), and the frame's own `cork.frameShare` (the share of the frame's instructions the translator ran), `cork.frameTranslateMs` (0 without the engine's `timings`) and `cork.frameLeaves` (times translated code came back to the host in the frame). | Per slice, per frame. |
| `samples`       | `{ slices, overflow, top: [{ address, instructions, samples }] }` — where every slice since boot has gone, by 64-byte address bucket; `top` is the 64 heaviest by instructions, reported by each bucket's own address rather than by rank. | Every slice that retired at least one instruction (see "Sampling" below). |

`jit.cache` is the emulator's own cache-size counter, which a release build compiles out (it
reads zero always); `compiledSteps` versus `interpretedSteps` is the number that says whether the
compiler is alive.

`diagnostics()` is the cold path: it reads thirty emulator exports and builds an object, and is
for a one-off look. The same figures are published once a frame into the `cpu/counters` table of
the log layer (`CPU_COUNTERS` in `module.js`: `running`, `instructions`, `protectedMode`, `traps`,
`trapCapacity`, `eip`, `trapCrossings`, and every numeric `jit.*` field), sampled when the profiler's
frame closes; a reader elsewhere takes them from shared memory and never asks this thread.
`jit.dirtyPages`, `jit.x87Sites` and `jit.refused` are strings and stay in `diagnostics()` only.

Some of that row is copied into every frame's own row as well (`FRAME_DELTAS` in the log layer), so
that one slow frame can be told apart from one busy frame without a second run: an emulator that
refused to answer reports `-1` rather than a record, and the sampler checks for that, because reading
fields off a number would leave every counter — and every frame's figure subtracted from it — `NaN`.

## 3. How it works

### The boot ROM

`internal/boot-rom.js` builds a 64 KiB image that the emulator maps as its BIOS at
`0xF0000` (`ROM_BASE`). The reset vector `F000:FFF0` is a far jump into eighteen instructions:
`cli`, `lgdt`, `lidt`, set `CR0.PE`, far jump to a flat 32-bit code segment, load flat data
segments, set ESP to `initialStack`, and `jmp dword [entryVector]`. The mode switch is done by
real guest instructions rather than by poking emulator fields, so every descriptor cache inside
the emulator is consistent by construction.

The jump into guest code is *indirect through RAM* on purpose: the ROM is needed to construct
the emulator, but the entry point is only known after the loader has mapped an image, which
needs an emulator to write into. The entry vector breaks that cycle.

The ROM also installs an IDT with a gate for each of the first 32 vectors. Each gate points at a
sixteen-byte stub that pushes EAX and EDX, writes `FAULT_TRAP_BASE + vector` (`0xf000 + n`) to
the trap port and then halts. The two pushes (`FAULT_SAVED`, 8 bytes) keep the faulting code's
own EAX and EDX, which the report itself needs: a handler shown the fault's context, or
continuing from it, has to find them as the program left them. Without those gates the emulator
has nowhere to send a fault and stops the machine with the same message for a divide by zero, a
bad pointer and an illegal instruction.

### Bring-up before anyone sees the machine

`createV86Host()` (`internal/v86-host.js`) drives the ROM itself during `boot()`, with the entry
vector temporarily pointing at a two-byte spin (`BRING_UP_PARK`). It single-steps up to 64
slices until EIP lands on the spin, checks `CR0.PE`, then sets EIP back to `GUEST_JUMP` — the
`jmp dword [entryVector]` instruction — and leaves the machine there. The reason is that every
thread's context is a copy of the machine as it stood when the thread was created; a context
captured before the mode switch would carry real mode into every thread that ever runs.

The boot code is then retired: the real-mode init and the prologue up to `GUEST_JUMP`
(`DEAD_BOOT_CODE`) are overwritten with `int3`. A guest that strays into the ROM — a return
through a wrecked stack lands anywhere — would otherwise run `mov cr0, eax` with whatever EAX
holds and turn paging on, or reload the stack and start the program over; instead it faults at
its first byte there, and `describeFault` names it `guest jumped into the boot ROM at …`.

### Slices and the quantum

`runSlice(n)` calls the emulator's `run_slice(n)` and returns retired instructions. Granularity
is a basic block: the emulator runs whole blocks, so a slice runs to the end of the block the
bound falls in. The bound is in guest instructions rather than wall time, so the preemption
point does not move with host speed. After every slice the 32-bit instruction counter is folded
into a JavaScript number (`instructionCount()`), which is exact as long as reads are less than
2^32 instructions apart. Under `cork` the count is exact too, and translated code looks at the
budget at every jump back, every turn of a `rep` and every transfer to another region: code
without a jump back runs through a region at most once, so a slice goes past its bound by at
most one region's instructions (a region holds at most 8192 bytes of code).

The emulator has no double fault: an exception it cannot deliver — a page fault while pushing
the frame for a page fault, which paging over a bad directory produces — recurses until the
host's stack is exhausted and surfaces as a `RangeError`. `runSlice` catches that one error,
records a `double fault at <eip>: a page fault at <cr2> while delivering a fault` (vector 8,
`detail` set; EIP is still on the instruction that faulted first, and CR2 holds the last address
that would not translate) and halts the machine, so the run ends through `fault()` like any
other.

### Sampling

Every slice that ran its whole budget credits the address it ended at, weighted by what it
retired (`internal/samples.js`): it stopped wherever the guest happened to be. A slice that ended
early stopped where the guest asked to -- a wait it parked in, a halt -- so it is skipped: it
credited that place with everything the slice retired, which charged a frame's hot loop to the
call that ended the frame (an itest halts a loop inside one slice and finds the `hlt` charged
nothing). The translator is still fed after any slice that retired something. Addresses are bucketed to
64 bytes (`eip >>> 6`) in a `Map` capped at 16 384 distinct buckets; a bucket beyond the cap is
counted as overflow rather than grown into, so a long run's own memory here is bounded no matter
how much guest code it touches. The register read (`eip`, already needed for other bookkeeping
in `runSlice`) and the table update are the whole cost: nothing per instruction, nothing per
basic block, and no clock — a slice's wall time is not read, because two `performance.now()`
reads per slice (tens of thousands of times in a heavy window) were measured at ~23 % of a
frame on `ceiling3.demo`'s light window (`report-sampler.md`) before they were removed. A reader
wanting milliseconds per bucket takes the bucket's share of instructions against the `guest`
phase's own ms over the same interval. Always on (`sampling: false` turns it off, for a caller
measuring the emulator's own compiler rather than the guest's code).

What a bucket's address belongs to — which image, which function — is not this layer's
knowledge: `diagnostics().samples.top` reports raw addresses, and resolving one against the
loader's module layout (`image` + `base` → an RVA) is left to whoever reads it, the same way the
kernel's own page counts are resolved into modules by a reader rather than by the kernel
(`docs/core/loader.md`, `docs/core/log.md`'s `guestByModule`). Naming the *function* a resolved
address falls in needs a symbol table, which is per-title bundle content this layer never reads
(`docs/core/host.md`'s `sidecarHooks`, "Sidecar hooks" in `loader.md`).

### Traps and the stub table

`internal/thunks.js` emits the guest-side stubs. Each is sixteen bytes at
`thunkBase + id * 16`: `mov dx, port; mov eax, id; out dx, eax; ret popBytes` (or plain `ret`
for cdecl). Slot 0 is the park loop (`hlt; jmp $-1`) — a handler that ends or blocks the
calling thread cannot stop the emulator from inside the trap callback, so the return address is
redirected here and the machine is stopped from outside.

Two variants: a stub reached by a `ret` (`preserveResult`) first moves EAX to ECX so the trap id
can use EAX; a forwarding stub (`forwardTo`) does `pushad`, traps, then `jmp`s into the real
guest function — the host restores EAX and EDX from the saved block and drops it, so the callee
sees the registers exactly as its caller set them.

The trap port write handler in `v86-host.js` calls whatever `onTrap` installed. In
`module.js` that handler first checks for a fault id (`0xf000..0xf01f`): if so it reads the
exception frame (`internal/faults.js`) and offers it to the `onFault` handler. One that claims it
has already sent the thread somewhere to wait -- the application's handler hands it to the
program's structured exception handlers, see [`win32.md`](./win32.md) -- and the trap simply
returns. Otherwise the fault is recorded as `lastFault` and the machine stopped. Nothing here
throws, because an exception raised inside the emulator's port write is lost crossing back into
wasm. Every other id goes to the bridge's dispatcher.

### Contexts

`internal/context.js` lists every field that must move with a thread: the eight general
registers, EIP and `previous_ip`, all segment tables (selectors, offsets, null flags, limits,
access bytes), the *five* lazy-flag fields together (`flags`, `flags_changed`, `last_op1`,
`last_result`, `last_op_size` — the raw `flags` word is missing OF/SF/AF/PF while
`flags_changed` is non-zero), the x87 registers with `fpu_stack_ptr` and `fpu_stack_empty`
(the tag word — there is no other, and MMX zeroes both), control/status words and instruction
pointers, XMM registers with MXCSR, and `in_hlt`. `setThreadBase` writes the FS segment offset,
which is how a TEB travels with the thread.

### The x87 stack

`internal/fpu.js` reads and writes the emulator's FPU state directly in its linear memory, at
offsets taken from the emulator's global-pointer table (`STACK_EMPTY`, `STACK_PTR`,
`CONTROL_WORD`, `ST`). A `double` is converted to and from 80-bit extended precision by hand.
`setResult` pushes like the processor would, refusing to overwrite an occupied register (it
leaves an indefinite value, as a real overflow does). Inside a compiled block the pinned build
keeps the stack top and the empty-register mask in that module's own locals rather than these
globals, writing them back together with the general registers at every point JS can next run
(chaining to another module, the fault/exit exits, and the port-write trap the engine's context
switch goes through), so this file's reads always see the current thread's values; `emms` resets
the stack top to zero along with the tag word.

### Host writes and the compiler

Every `writePhysical` goes through the emulator's `write_memory`, which discards compiled code
for the pages written. That is the right price for mapping an image and the wrong one for a
handler writing a structure field, so `writeData` writes straight into RAM; the memory layer
decides between the two by asking its region map whether the target could ever be executed.
The map's answer is per region and the heap is one read-write region, yet a program may run code
it placed there (a routine it unpacked or generates), so `writeData` and `fillData` also read the
fork's has-code table (`bottlify_page_has_code_ptr`, a byte a page) and dirty the compiler's code
for the range when a page they wrote holds some (`jit_dirty_cache`) -- a call into a routine the
host had rewritten ran the old compiled code. One byte read a page otherwise.
`hostWrittenBytes` and `jit.discarded` say how much that costs in a run.

### zstd

A guest file read needs a decompressor that answers without a promise — the CPU is stopped
inside one instruction and cannot await. Two decoders can: the emulator's wasm one, reached
through the cpu api's `decompressZstd` while the emulator is loaded, and
`modules/core/src/zstd.js`, a decode-only zstd implementation of this project's own (frame,
block, literal, Huffman and FSE decoding; no dictionaries, the checksum read and not verified).
A first bundle load decodes the whole bundle, and a wasm decoder is several times faster than
the JavaScript one on Huffman-heavy blocks (measured by `zstd.itest.js` per MiB on the bundle's
own blocks), so the decoder is a third thing: the same algorithm as `zstd.js`, written once
more as freestanding C (`modules/core/scripts/zstd/zstd.c`, no libc, no dictionaries, one
`zstd_decompress` export) and compiled to `vendor/zstd.wasm` by `build-zstd.mjs` -- in the pinned
container of `Dockerfile.zstd` (the vendor workflow, or any machine with Docker) or natively
with a clang that targets wasm32 (`--native`). `src/zstd-wasm.js` instantiates it once and
answers `decompress(packed, expectedLength)` synchronously with `zstd.js`'s errors.
`mountBundle` chooses once, by `chooseZstdDecoder` (unit-tested in `app.test.js`): the wasm
build for every engine when the package carries it (`AppOptions.zstd`, or `vendor/zstd.wasm`
beside the module); without it, the emulator's decoder under `emulator` and
`zstd.js` under `cork`. The artifact is optional (`check-package`), fetched by
`npm run fetch:zstd` from the release the vendor workflow publishes and pinned in
`zstd-lock.json`. The three decoders are judged byte for byte against each other and against
the emulator's on a bundle's own blocks by `zstd.itest.js`, which also asserts the wasm build
is not slower than the emulator's decoder when both are present.

### What of `vendor/v86` is used

`libv86.mjs` (the `V86` class: `add_listener`, `run`, `stop`, `write_memory`,
`get_instruction_counter`, `io.register_write`, and the `cpu` object's typed views over its
state) and `v86.wasm` (or `v86-profiler.wasm`), via `wasm_fn`. Views over the emulator's
memory are taken once and again only when the memory has grown -- which detaches the buffer
they were on, so a view reading as empty is the signal -- rather than through its proxies, which
create a fresh typed array per property access, or through the buffer accessor on every read. The host also reads and writes the SSE and x87 state as records
(`readXmm`/`writeXmm`, `readMxcsr`/`writeMxcsr`, `x87State`/`restoreX87State` -- the eight x87
registers by physical index, decoded from whichever of the emulator's two forms each is in,
with the raw bytes beside them, and the status word with the top of stack folded into bits
11..13 as `fnstsw` would report it, since the emulator keeps the two apart) and whether the
processor stands in a `hlt` (`halted`/`wake`), for the translator package's differential harness, which
snapshots this machine, runs the same code on both engines and compares; cold paths, nothing a
slice pays for. Two emulator methods are wrapped for counting:
`codegen_finalize` (published modules, and the first refusal) and `jit_clear_func` (discarded
ones). For the translator, three exports of the fork's own: `bottlify_handoff_page(page, on)`
sets the per-page bit at which `run_slice` returns (absent in an older build, the host counts
the request in `handoffUnavailable()` and the slice runs to its own boundary),
`bottlify_page_has_code_ptr()` names the emulator's own code-page table for the translator's
stores to test, `bottlify_handoff_hash(physical)` names the translator's entry hash so the
slice returns at its entries rather than at its pages, and `jit_dirty_cache(address, length)`
takes a translated store into such a page. The hash's slot for an address is
`(eip * 0x9e3779b1) >>> hashShift`, the layout's field: 14 on cork's own layout, so the slots
cover all 2^18 of the hash, and 16 on the emulator's, the fork's own lookup. With 16 the slots
began in the hash's first quarter only, and a title's hundred thousand entries filled it into
one run of 82 000 slots that every miss -- an exit to untranslated code, an insertion -- probed
to its end: tens of microseconds each, which ran a title's scene at 240 ns an instruction.

## 4. Limitations and divergences

- **A fault the program does not handle halts the machine.** A fault stub does not `iret`; the
  layer offers the fault through `onFault` and otherwise stops. What `fault()` reports is for
  whoever drives the machine to act on.
- **Without paging, a stray pointer does not fault.** Every address in RAM is readable and
  writable, the null page included, so a program that probes a pointer or writes through null
  and expects an access violation carries on instead. Cork can close the range below
  `closedBelow` (above); a process does not yet.
- **Only the first 32 vectors** have gates. Hardware interrupts are not delivered; the guest
  runs with `IF` clear from the ROM's `cli`.
- **Ring 0, flat segments, no paging.** The guest runs at CPL 0 with two flat 4 GiB
  descriptors; there is no user/kernel split and `CR3` is never set. Frame reads in
  `faults.js` assume no stack switch for that reason.
- **Trap ids are 32-bit port writes**; ids `0xf000..0xf01f` are reserved for faults and the
  bridge allocates from zero upward.
- **The stub table is finite** (`thunkCapacity`) and slots are never freed. `registerTrap`
  throws when full; the one caller that can act on that (the COM publisher) turns it into an
  out-of-memory answer to the guest.
- **`readPhysical` is a window**, not a copy; a caller that keeps it keeps a value that
  changes under it.
- **`writeData` trusts its caller** that the target is not executable, except where the
  emulator's compiler holds code for a page it writes, which it dirties.
- **One machine per process.** State lives on the module object; a second concurrent build
  would need it hoisted into a per-instance record.
- **The FPU offsets are the emulator's**, not an architectural fact; a change in the vendored
  build could move them.
- **Profiler counters** (`profile.*`, `instructionStats`, most of `jit.*`) exist only in a
  build of the emulator that carries them; they answer `null` or `-1` otherwise.
- **The emulator's compiler takes what follows a call for code**, since the call may return
  there, and follows it on through the page and the pages after. A program whose last call runs
  into its data has the data and the zeros after it compiled with its code: a test program's
  loop, `call [ExitProcess]` followed by its strings and import tables, made one function of
  1.8 MB, 12 162 of its instructions `add [eax], al`, which V8 optimised once the loop made it
  hot in 32.5 s of a background thread (`--trace-wasm-compilation-times`). A page pays that in the
  background. Node waits for its background tasks whenever its event loop has nothing else to
  wait on -- an asynchronous compile with nothing else pending, the process's exit -- so there
  the next machine's `createApp` and the exit waited half a minute each. An `int3` after the call
  does not end the decoding; a `hlt` or a `jmp` does, and the looping test programs in
  `src/cork-programs.itest.js` puts a `hlt` after its last
  call for that reason.
- **Under `cork`, translated code relaxes what games do not observe** unless the engine's
  `precise` is set (`cork: { precise: true }`), which restores each of these exactly:
  - the x87 sticky exception flags: IE from an invalid operation, a NaN compared or an
    out-of-range integer store, ZE from `fdiv` and `fyl2x`, UE from a single store -- the
    status word keeps what was raised before or elsewhere (a stack fault's IE and SF, the
    interpreter's); DE, OE and PE are never raised, precise or not;
  - signalling NaNs: an m32 or m64 read raises no IE, and an m64 one is not quieted by `fld`
    (an m32 one is, by the conversion);
  - C1: a push and `fcomi` leave it as it was, where the processor clears it; a stack
    overflow still sets it;
  - single precision's rounding at the two ends of a double's range: a result of magnitude
    2^995 - 2^966 or more stays unrounded, and a result that is a double's denormal keeps 24
    significant bits where `precise` and the interpreter round it at the normal numbers' place
    (bit 29) -- nearer the processor, whose exponent would have kept it normal, but not theirs.
  - the flags an instruction leaves architecturally undefined (AF of the logic instructions,
    SF, ZF, AF and PF of a multiply, OF of a shift past one, all six of a divide, OF, SF, AF
    and PF of `bt`, all but ZF of `bsf`/`bsr`): they count as written, so an earlier
    instruction's result is no longer kept for them and they hold whatever an older record
    folds to; real processors differ among themselves on them.
  - an instruction that only reads memory is not tested against the page flags: its address
    is wrapped into guest RAM (whose size is a power of two) instead, one `and` where the test
    was a shift, a load and a branch. The only flag a read can find is INACCESSIBLE, which only
    the pages past RAM carry, so what goes is the #GP of a read past the end of guest memory --
    it reads RAM there instead. Stores, and every access under `precise`, are tested as before.
    Doom 3's GUI text measure, its own bytes under node with branch hints, went 2.6-2.7 ->
    2.1-2.3 ns a character.

  C0, C2 and C3, the stack, its faults, precision and rounding control, every value (but for
  single precision's rounding at the ends of the range), and every defined flag a branch,
  `adc`/`sbb`, `setcc`, `cmovcc`, `pushf` or `lahf` reads stay exact. `x87RelaxedReads` in the
  diagnostics counts the translated status-word reads that may see a relaxed bit, and
  `relaxedFlagReads`, by opcode, the translated instructions that read a flag an instruction
  before them in their block left undefined. The interpreter tier in wasm relaxes the same x87
  bookkeeping -- the sticky IE, ZE and UE, a signalling NaN loaded (an m80 one included), C1 on a
  push and `fcomi` -- and nothing else: its single precision rounds as the JavaScript
  interpreter's does, and it leaves the undefined flags as `ir.js` does; `interpretedRelaxedReads`
  counts the status words (`fnstsw`) it stores meanwhile.

## 5. Tests

Unit tests (no emulator; `npm test` runs `src/**/*.test.js`):

| file | covers |
|------|--------|
| `internal/boot-rom.test.js` | ROM size and placement, reset vector, GDT/IDT contents, the indirect jump, every fault stub keeping EAX and EDX, reporting its own vector and stopping, the retired boot code ending exactly at the guest jump. |
| `internal/faults.test.js` | A host-raised fault reads as its sentence, a stand-in for an undeliverable exception keeps its vector, a breakpoint in the retired boot code is an excursion, the live guest jump is not, processor exceptions read as before. |
| `module.test.js` | Counters registered with the log, creation without a registry, instance isolation, disposal, diagnostics; a resume carrying registers sets each one it names, with EAX and ESP by their own rules, and a flags word whole with nothing lazy left beside it. |
| `internal/thunks.test.js` | Stub encoding per convention, forwarding stubs and their register save, a hook stub's single `push edx` and its held EIP (no `ret`, no `jmp`), refusal when the table is full, the default capacity. |
| `internal/context.test.js` | Context round trips, lazy flags travelling together, x87 stack pointer/tag word, the TEB being part of the switch. |
| `internal/fpu.test.js` | Double to extended conversion (sign of zero, explicit leading bit), push/pop, overflow refusal, control word. |
| `internal/cork-host.test.js` | The translator's host over its own memory; among the rest, the register file lent to the bridge is the registers themselves in encoding order, one view for the machine's life, a span of dwords reads signed into an array at an offset exactly as the words read one by one, and code a trap handler rewrites between two calls of it runs as written, where the handler's writes into the stack's page leave it translated. |
| `internal/samples.test.js` | A slice at a known EIP credits that bucket; two addresses inside one 64-byte span fold together, two spans apart stay separate; `topSamples` ranks by instructions and reports each bucket's own address; ten thousand distinct addresses leave the table's own size bounded at the cap, with the rest counted as overflow. |

Integration tests (`npm run test:integration` runs `src/**/*.itest.js`; they need the prebuilt
emulator in `modules/core/vendor/prebuilt/` — `npm run fetch:v86`):

| file | covers |
|------|--------|
| `internal/v86-host.itest.js` | Booting to protected mode, the instruction count past 2^32, registers by name, slice bounds on loops, x87 arithmetic, flags, string instructions, compiled-code chaining, profiler builds. |
| `internal/quantum.itest.js` | A slice is bounded by retired instructions to a page, compiled or interpreted. |
| `module.itest.js` | The frame's account of the interpreter; an exception the processor cannot deliver ends as a named double fault rather than a host stack overflow; a guest straying into the retired boot code is reported as an excursion. |
| `internal/context.itest.js` | An x87 thread survives interruption by MMX; pending arithmetic flags survive a switch. |
| `internal/zstd.itest.js` | A frame decodes byte for byte, scratch is returned, a short frame is an error. |

Filter to one file with `node --test src/layers/cpu/internal/thunks.test.js` from
`modules/core/`.
