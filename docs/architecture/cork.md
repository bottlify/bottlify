# cork, the execution core

cork, our x86-32 to WebAssembly translator with a runtime of its own (the [`cork/`](../../modules/cork/) package), runs all
of the program's code. What it is, how it translates and runs code, what it supports and how fast it
is: [`modules/cork/README.md`](../../modules/cork/README.md). This section is about how it sits in
Bottlify.

The engine does not import cork: the `cpu` layer loads it by URL (`/engine/cork/index.js`), and
`createEngine` implements the executor contract in
[`core/src/layers/cpu/engine.js`](../../modules/core/src/layers/cpu/engine.js); `@bottlify/core` adds
Win32, threads and the scheduler on top. Only user-mode code runs: nothing reaches a Windows
kernel, and where a system call would be, a trap into the bridge fires instead (section 6).

| Where | What it does |
| --- | --- |
| Engine thread | The interpreters, region forming, store lookups, publishing and running translated code, traps into the bridge |
| Translation threads | The emitter and the encoder: a batch of regions becomes a wasm module, and the module a compiled `WebAssembly.Module`. Several may work for one process, each with a batch of its own |
| OPFS | The translation store, `cork/<id>.v3/` |
| Server | The code of cork and its worker (`/engine/cork/`). A bundle may bring translations ready-made |

**Memory.** All of the program's memory is one `WebAssembly.Memory` of fixed size, shared in the
`isolated` mode: 1 GiB for the program by default, plus cork's tables. The layout (program address
`a` at offset `a`, the state block with the registers, 512 bytes, in the program's first 64 KiB,
which a Windows program never maps, on pages that fault the program's stores, and after the
program's memory cork's tables with one flag byte per 4 KiB page) is in
[cork's README](../cork/how-it-works.md). With several executors, each further one
has a state page and tables of its own (`executorLayout`), while the program's memory is
everyone's. The page flags are `INACCESSIBLE`, `HAS_CODE`, `VOLATILE`, `CLOSED`, `NO_EXECUTE`, and
`WATCH` or `WRITTEN` on a page watched for writes (section 7).

## Translation in Bottlify

- **Several translation threads, one arena.** A process can have several translation threads, each
  with a batch of its own out. A relink, a merge, and a region formed again take over running
  regions, so they go out alone. The functions already emitted, which a relink or merge takes again
  rather than emitting them anew, belong to the process, not to a thread: they are kept in its
  arena, 48 MB of shared memory that every translation thread of the process reads and adds to
  under one lock, the oldest segment going first. Without it a relink emits again what was
  emitted: a translation thread was busy 23.3 s instead of 14.6 s while a game loaded.
- **The pool's driver.** Every 500 ms it reads from shared memory how long each translation thread
  worked and how many regions it emitted (the threads write it there). One more joins a process
  when the median load of those already working for it reaches 80 %, at most `hardwareConcurrency`
  for a process. Each join is a trial: unless the process's regions a second rise by half of what
  one more thread adds at best, the joined thread leaves and the process keeps that count as its
  ceiling. That is what happens on four cores, where one translation thread already leaves no core
  free while a game loads, and a second made loading slower ([`roadmap/negative-results.md`](../../roadmap/negative-results.md), 2026-10-07).
  Joined threads leave at once when the process stops translating to wait, and after 3 s of a
  median under 40 % otherwise. Every decision is in the pool's journal (`translationPool()` on the
  run).
- **Regions do not repeat each other.** A candidate at a block of a region formed and not yet
  published (earlier in its batch, with a translator, or its module compiling) is not formed
  again beside it (for a region with x87 in it, at the top that region was formed for): it has an
  entry there once that region is published. A region runs on through a block another region has
  an entry for: stopping there translated a function's code once, but the hot code it cut crossed
  between regions. A small leaf callee
  is formed into each caller, for the call it saves.
- **The store.** A translation is keyed by the cache version, the browser's features, the memory
  layout, the bundle id, the entry address, the x87 stack top (any top for a region with no x87 in
  it) and the run's modes. Its record says what forming made of it: a 64-bit FNV hash of the
  region's bytes, the blocks it left to other regions, the callees formed into it, its x87
  precision. A run that forms the region otherwise (before its callees were known, or beside other
  regions) forms it again as the record says and takes it when the bytes hash the same. The store
  also keeps a map of where its regions have entries: a run that meets a block of a stored region
  before the region's entry forms that region rather than a new one
  ([cork's README](../cork/how-it-works.md)). Every process of a run adds its
  regions to that map when it flushes, to the map as the store holds it then, and writes it back
  only when it adds a 64th of it: a tool a game starts many times a run would otherwise write the
  whole map each time. A bundle may bring translations along (`CORKSEED`); they are seeded before
  the first instruction.

## Execution in Bottlify

- **Counting instructions.** Each block subtracts its instruction count from a budget on the way
  out, and the budget is checked on backward jumps. Translated code is given the turn's whole
  budget; another executor's call ends it early at a back edge. How long a turn is (the 100,000-instruction quantum,
  a quarter of a millisecond among ready threads, about 750,000 for fast translated code, and a
  solo turn of ten quanta) is in [`core/configuration.md`](../core/configuration.md#kernel). While
  other executors run threads, a solo turn comes only where their calls interrupt the process's
  slice.
- **Two interpreters.** The first 8192 units of a process's work (instructions, plus 128 for each new
  jump target) run on the JS interpreter, the rest on the wasm interpreter.
- **Memory and self-modifying code.** Outside precise mode reads are not checked until the program
  first touches a page it cannot reach: the address simply wraps into the program's memory. From
  that fault on, every region tests the pages it reads, and the regions that wrapped are translated
  again. Every write checks the page's flag byte (the accesses a block makes off one register once
  for all of them, as one window). A store through `esp` alone goes unchecked while no translated
  code lies on a thread's stack (`looseStacks`); once code is translated there, every region checks
  those too. In long mode such an access through rsp takes rsp's low half, without the test of
  the 4 GiB window.
  When the program writes where translated code lies on a page, the region exits. The first such
  write drops all of that page's translations. The regions formed there afterwards keep a copy of
  the bytes they were formed from, and a later write drops only those whose bytes it actually
  changed: a mixer that rewrites its voice patches with the bytes already there keeps its code,
  and the code it drops is queued for translation at once. A page keeps one range of the 32-byte
  granules its code covers, so data between two pieces of code is inside that range. A write there
  that touches no region's bytes is judged against a copy of the page. If it changed the value (a
  variable written every turn of a loop), the page loses its translations: kept as code, it would
  send every such write to the interpreter. If it wrote the bytes already there, the page stays.
  A page that loses its translations 8 times within 100 ms is marked volatile (`VOLATILE`) and
  interpreted for 2 s, twice as long each time it is marked again, then translated again. With
  several executors a page loses all its translations on every such write.
- **Several executors of a process.** How many a run gets, when they open, what the program is
  told of its processors and what an affinity mask means are in
  [`core/configuration.md`](../core/configuration.md#cpu) (`cpu.cores`, `cpu.eager`).
  - **An executor of its own.** Each thread has an executor of its own, where its translations
    are: the process's first thread runs on the process's own, each later one on the other
    executor fewest live threads call theirs. A turn gives every free executor the next ready
    thread whose executor it is; a thread whose executor is busy goes to one left free (the
    process's own first) and has its code translated there too, rather than leave a processor
    idle. A thread is never started while another executor still runs it: one that waited there is
    made ready by its wake before that slice is taken, and the scheduler refuses the second start.
  - **Threads that belong on the process's executor.** Two kinds of thread run there only, where
    they may. One calls into the host more often than once in 30 000 instructions over its last
    million or so instructions, since from another executor every such call is a round trip. The
    instructions are counted however many slices cut them: a thread that wakes, runs a few dozen
    instructions and waits again weighs as little as those. The other is a thread whose runs on
    another executor have mostly ended with the process's executor left nothing to run and calling
    it back, the run having done less than half of what the process's executor did meanwhile. It
    takes turns with the process's threads rather than running beside them; the share halves every
    second, so it tries again. A thread called back after doing at least half as much ran at once
    with them, as a render thread its main thread waits on each frame, and stays on its own
    executor. A thread of either kind waiting for the process's executor takes it from one that
    computes, which goes to another executor in its place.
  - **Spread.** All of the above is how threads are placed. For a debugging run, concentrated
    (`cpu.placement: 'concentrate'`) keeps every thread on the process's own executor where its
    mask allows, taking turns there as on one processor.
  - **A free host.** The process's own executor keeps itself for the answers: while a thread is
    pinned to its processor (a game's main thread, pinned to the first), another executor plays
    that processor and the process's own plays one no thread is pinned to. A game's main thread
    computed four tenths of the process's executor while its render thread, on another, waited
    half of its time for that executor's answers.
    GetCurrentProcessorNumber answers the processor played, so no thread is told of one its mask
    does not name.
  - **Answering calls.** The process's own thread runs its threads too, and answers the calls the
    others' threads make: at each of its own crossings into the host, between its turns, and inside
    them. An executor that needs its answer (a call, a fault, a slice's end) stores a word the
    process's translated code reads at every back edge as the floor of its budget, so its slice
    leaves there, the calls are answered and the slice goes on, each caller the current thread
    while it is answered. A back edge inside one of the host's unbroken routines puts the answer
    off to the next one past it: such a routine may hold a Direct3D device's lock, which the answer
    to another thread's call on that device takes.
  - **How long an executor keeps a thread.** While no ready thread waits for an executor and the
    process wants none back (suspended, ended by another), an executor keeps its thread slice after
    slice: its event loop turns in between, and the process hears of the thread at most every
    250 ms. While ready threads wait for an executor, it keeps its thread for a turn
    (1 ms) and gives it up at the first slice's end past that, as a processor keeps a
    thread to its quantum's end. The process's thread with nothing of its own to run waits for the
    others until its soonest deadline, 4 ms at most. An executor keeping a thread the process's
    executor may run lets it go at its slice's end and the thread comes to the process's executor,
    so a program whose one working thread was started while its first still ran runs it there.
    While a call into the host is still to answer through the event loop (a graphics worker's
    answer, a fetched block), the turn does not wait: the run loop waits for that answer and the
    others' bell together. The process's executor's own turns are as long while other executors
    run threads as while none does; such a turn ends when a thread a free executor could take is
    made ready, whoever made it ready, or when another executor's slice ends.
  - **Workers and translations.** An executor past the first is a cork host in a worker of its own
    over the process's memory ([`core/src/layers/cpu/internal/executor.worker.js`](../../modules/core/src/layers/cpu/internal/executor.worker.js)), with its own state
    page, entry hash and instances of translations. Their translations are shared: made for the
    process's shared layout (`sharedLayout`), which addresses the state block and the tables from
    two bases each instance is given, their bytes are the same on each of them, and one arena of
    emitted functions serves them all and their translators. The process's own executor translates
    for a layout of its own, the state and the tables at constant addresses, as with one executor:
    the shared layout's bases cost a sixth more machine code in a small function and 7 % of the
    benchmark, and the process's executor runs the first thread and any thread alone. So code run
    on both sides is translated twice, never once per executor. The process keeps the run's
    translation store, and the others' translators ask it through the process: a lookup is
    answered on its event loop and a record handed over unwaited, so a thread that ran on another
    executor in one run takes its regions from the store in the next.
  - **Writes into code, unfinished routines.** The page flags and the code bounds are the
    process's, so a write on any executor into code any of them translated is found: the finder
    drops its own translations and puts the range in a ring in shared memory, and every other
    executor drops its own at its next slice ([`cork/src/runtime/shared-code.js`](../../modules/cork/src/runtime/shared-code.js)). A
    run that ends inside one of the host's routines no slice ends inside (a command record
    reserved and not yet finished) goes on to the routine's end first, on any executor
    (`unbroken.js`): taken off there, the thread would hold back every record after it until it
    ran again.
- **Memory order between executors.** x86 shows one thread's stores to another in the order they
  were made, and a program relies on it with plain `mov`s: data, then a flag another thread waits
  on. On arm64 another core may see the flag first, or read the data before the flag. cork's
  ordered variant keeps x86's order there (the `ordered` setting,
  [cork's README](../cork/README.md#what-it-runs)): an integer operand's load and store are
  wasm atomics, ordered with every other access around them. The exceptions are an access through
  esp (a thread's own stack), one at an address not a multiple of its width (a wasm atomic traps
  there), and the x87's, MMX's, SSE's and the string instructions' operands: the data around a
  flag, which the flag's access orders. Code the interpreters run is not ordered. The variant is
  off unless a page sets `cork.config.ordered` to `true`: every integer access becoming an atomic
  one costs about an eighth more machine code on arm64, and a program that hands data between its
  threads through locked instructions and kernel objects does not need it. The cpu layer's
  diagnostics say which way a process runs (`ordered`). The engine's own routines lock and let go
  with locked instructions in either variant (`tools/check-lock-release.mjs`).
- **Exact exceptions.** A region exits right before the faulting instruction, with its EIP and
  registers. Division by zero gives #DE, an unknown instruction #UD, an access to a page the program cannot
  reach #PF with its address (translated code leaves, and the JavaScript interpreter runs the
  instruction once more to name the address), a jump below `0x10000` (a call through a null
  pointer, say) #PF. `int3` is finished by the
  interpreter. The exception then goes to the program's SEH, where #GP and #PF become
  `EXCEPTION_ACCESS_VIOLATION`.

### 64-bit programs

An x86-64 program (a PE32+ image) runs on the same translator and runtime at a 64-bit width: the
sixteen 64-bit registers live in the state block, and its memory is a 4 GiB window, every page
below 4 GiB and an image whose base is above it relocated down. A 64-bit process runs on one
executor. A run whose first program is 64-bit, or whose `memorySize` is past 2 GiB, is a 64-bit
Windows (`machine: 'amd64'`, [API](../core/api.md#what-runs)), where a 32-bit child runs under
WOW64. What the Windows layer has at 64 bits is in
[the limits](../core/limits/README.md#programs).

Where to look in the code: [`cork/src/decode/`](../../modules/cork/src/decode/), [`cork/src/region.js`](../../modules/cork/src/region.js), [`cork/src/emit/`](../../modules/cork/src/emit/),
[`cork/src/wasm/`](../../modules/cork/src/wasm/), [`cork/src/runtime/`](../../modules/cork/src/runtime/), [`cork/src/interp.js`](../../modules/cork/src/interp.js), [`cork/src/interp-wasm.c`](../../modules/cork/src/interp-wasm.c); the engine
glue is [`core/src/layers/cpu/internal/cork-host.js`](../../modules/core/src/layers/cpu/internal/cork-host.js). Where cork goes next is
[`roadmap/x64.md`](../../roadmap/x64.md).
