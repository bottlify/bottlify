# Defects this engine still has, found by reading an earlier attempt

`carried-knowledge.md` records mechanisms established by earlier work on this problem. This file
is narrower and more useful: each entry is a defect the earlier work paid for **that was then checked
against this tree's own source**, so every one of them is either a live bug here, a gap that will bite
when the surrounding work lands, or a rule already satisfied and worth not regressing.

Three sweeps produced it — the kernel and loader, the drawing layer, and the runtime libraries — each
reading commit messages rather than diffs, and each verifying its claims by reading our code.

**Status is stated per entry.** *Live* means read in our source and confirmed. *Gap* means the
surrounding work does not exist yet, so the rule is recorded rather than applied. *Satisfied* means
we already do it and the entry exists so nobody undoes it. *Unchecked* means the earlier work
asserted it and nothing here confirmed it.

---

## A. Live, and a program can fail on them today

### A1. A guest `pop fs` erases the thread block, and nothing faults — *live*

`cpu/internal/context.js` writes only the emulator's *cached* FS base. The boot ROM builds three
flat descriptors and loads a data selector whose descriptor base is zero, so the emulator re-derives
a base of zero on the **next** FS selector load — any `push fs … pop fs`, any `mov fs, ax`, any
exception epilogue that saves and restores it.

The address space is identity-mapped and low memory is a registered region, so `fs:[0]`, `fs:[0x18]`
and `fs:[0x2c]` then read linear 0, 0x18 and 0x2c. **No fault: just wrong data**, surfacing
arbitrarily far from the reload.

The fix is layout work rather than a line: a per-thread descriptor, or the selector's descriptor
rewritten on every switch. A per-thread segment base lives in two places — the cached descriptor and
the table it is re-derived from — and one function has to own both.

### A2. A throw during frame replay wedges every later frame — *fixed in this pass, recorded so it stays fixed*

One object owns the command encoder and one call releases it. That call was not in a `finally`, so a
throw anywhere in replay left the frame open; every later present then failed at `beginFrame` saying
a frame was already open, and each failure went into a ring nobody reads. One bad frame became every
frame after it, and the only symptom was a picture that stopped changing while the counters kept
climbing.

The general shape matters more than the instance: WebGPU validation never throws, so a real failure
reaches you only as a loop that stopped. Anything that re-arms a loop, and every submit/finish pair,
needs its own guard.

### A3. The compiler does not call `TlsGetValue` — *fixed in this pass*

`__declspec(thread) x` compiles to `mov eax, _tls_index / mov ecx, fs:[0x2c] / mov eax, [ecx+eax*4]`
— it reads the array in the thread block directly. Our `TlsSetValue` wrote a host-side map and never
touched that array, so every static thread-local read in a real binary returned zero and was
dereferenced.

Thread-local storage has two readers, the API and that instruction sequence, and they read the same
array. An implementation that serves only the API is invisible to every test and wrong in every real
program. Slots above the block's sixty-four are the API's alone, which is why Windows keeps the rest
elsewhere.

### A4. `PEB->Ldr` is a null pointer rather than an empty list — *live*

Nothing writes it. A program that resolves exports by walking the loader data instead of calling
`GetProcAddress` — packers, copy protection, delay-load helpers, crash reporters — reads a null and
faults or reads low memory. Publishing the three module lists is what the earlier work had to do.
`NumberOfProcessors` is likewise absent from the block.

### A5. A synthesised module cannot express a data export — *live as a structural gap*

Every export gets a jump trampoline. There is no notion of "this export is a variable", so a shipped
library importing `_iob`, `_pctype`, `__mb_cur_max`, `_HUGE` or the `_osver` family would take **the
address of executable bytes** as its `FILE*` table or `ctype` pointer. An export table is not all
code, and the "unknown argument count" diagnostic has to consult the data table first or it reports
a defect that is not there.

### A6. `VirtualQuery` answers a free page as one page — *live, reads as a hang*

A free address reports `RegionSize` of one page, so a guest walking the address space by
`address += RegionSize` takes four-kilobyte steps across everything unmapped. Crash reporters, heap
managers and pointer validators walk exactly like that; the earlier work measured it as minutes of
apparent hang at startup.

The same function has the opposite error for a *found* region: every heap pointer, virtual block and
thread stack reports the whole heap region as its allocation base. A stack-scanning collector or a
guard-page grower derives its bounds from those two fields. Three different answers are owed from one
function: a free gap coalesced to one region, a stack reporting its own reservation, a heap pointer
staying page-granular.

### A7. A stale `ERROR_ALREADY_EXISTS` breaks the single-instance idiom — *live*

Opening an existing file with `CREATE_ALWAYS`/`OPEN_ALWAYS` sets error 183 and leaves it there. The
canonical idiom is `CreateMutexA(NULL, TRUE, name)` followed by `GetLastError() == ERROR_ALREADY_EXISTS`
meaning another copy is running — and it reads the 183 an unrelated file open left behind. A create
path has to set `ERROR_SUCCESS`.

Named synchronisation objects also discard their name entirely, so nothing can be opened by name and
`ERROR_ALREADY_EXISTS` is never reported for the reason it exists.

### A8. Texture stages sample their own coordinate set, whatever the state says — *live, wrong picture*

The pipeline key records each stage's coordinate index correctly; the generated shader hardcodes
stage *N* sampling set *N*. Anything naming a different set — detail passes, environment maps, a UI
reusing set 0 across two stages — draws correct geometry with wrong texels, silently. Two
consequences of the same gap: the texture-generation bits share that field and fragment the pipeline
cache on a value nothing reads, and a draw with one coordinate set and two stages loses the second
stage entirely.

### A9. A stage argument the operation never reads still demands a texture — *live, wrong picture*

Stage state persists across draws, so an unread argument slot holds whatever an unrelated draw left
in it. A stage set to select argument one, with a stale `TEXTURE` in argument two and nothing bound,
is treated as needing a texture, resolves as unsampleable, and **truncates the cascade from there
upward** — an overlay or a fade vanishes with the rest of the picture correct. Which arguments count
is a function of the operation. We already apply that rule to the alpha arguments and not to the
colour ones.

### A10. Half a pixel, everywhere — *live*

Direct3D of this era names pixel centres; WebGPU names corners. Neither our pre-transformed path nor
our transformed one applies the correction. It belongs in the viewport mapping so it reaches
everything, and folding it into the transform as it is written into the uniform slot keeps it out of
every pipeline-cache key. Anything that expands that transform in host code takes the same shift or
becomes the one thing half a pixel off from everything else.

Reads as a font problem or a filtering problem: text baselines a pixel apart, hairline seams between
adjacent quads, a 1:1 blit sampling half a texel off.

### A11. A lost device is never observed and the guest is never told — *live*

The guest-facing half is built and correct — the three-state machine and the right refusals. The
other half does not exist: nothing reads the device's lost promise, and the function that would
inject the loss has no caller anywhere. So a lost device is a picture that freezes while every
counter stays healthy.

What the earlier work paid for, if this is ever wired: invalidation must fan out **synchronously**
before any await, holders must register rather than be tracked from one place, `Reset` must refuse
while no device exists, a resource with a host-side copy restores itself while a GPU-only target is
reported lost and restored cleared, and the state must be cleared when a new program loads.

---

## B. Answered, and answered wrongly

These are the shape that produces "the program failed and nothing points at it": a call that
succeeded, with an answer the program then acts on.

- **A window is created and never told.** `CreateWindowEx` sends no creation messages and `ShowWindow`
  sends none of the show, size or activate group. The call returns a valid handle, so from the
  program's side it worked — and everything its own procedure was going to build in those messages
  silently did not happen. They are synchronous, inside the creating call; posting them lets the
  caller's own code run first and stomp what the handler was about to build. **Live.**
- **Enumerations that succeed having enumerated nothing.** Device enumeration in the sound and input
  layers returns success with no callbacks, because calling guest code needed a route those tables
  did not have. That route now exists and is used elsewhere. The earlier work found this fatal: a
  title walked the enumerated names for one exact string, found none, and shut its own sound manager
  down. **The enumerated name is load-bearing — programs pick by string, not by position.** **Live.**
- **Version information says there is none, for every file.** The block walker is correct and has no
  source wired to it. Titles of this era discover the installed DirectX generation by asking the
  drawing libraries for their own version resource, and "no version information" is not a neutral
  answer to a version probe. Two gaps: no real file resource, and no way at all to synthesise one for
  a library we implement — reporting the level actually implemented is better than reporting past it.
  **Live.**
- **The registry has the four roots and nothing else.** No `Windows NT\CurrentVersion`, no
  `ProgramFilesDir`, no DirectX version, no processor description. The earlier work built a lazily
  materialised baseline that any stored value shadows. Only the ANSI half of the registry API exists.
  **Live.**
- **One processor described three ways.** The system info call, the emulator's own identification
  leaf, the environment block and the registry are four independent answers with nothing tying them
  together. Engines gate their vector paths and cache heuristics on whichever they read, and a
  disagreement makes them pick the older path or decide the machine is unsupported. **Live.**
- **A missing import's stub pops nothing for an undecorated stdcall name.** Deriving the count from
  the decoration is right for a C runtime and wrong for a system library, which exports stdcall
  functions undecorated. The stack then skews by four bytes per argument per call and the program
  walks off its own frame. **Live** — and the reason our stub emits an event at the call is so this
  is visible; the earlier work's rule is blunter: **cleanup comes from the descriptor, never from the
  name — the decoration lies even when present.**
- **Every implemented library exists in guest memory whether or not the process linked it.** A heap
  manager that walks the address space and asks each base its name finds runtimes the program never
  linked and can conclude it is running against a foreign one. Track what was asked for — import
  binding and name-to-base handouts — rather than what exists. **Live.**
- **`GetProcAddress` on the program's own module always answers zero.** How a program probes for its
  own optional symbols, and how a plugin resolves back into its host. **Live, small.**

---

## C. Rules for work not yet built

- **Process creation.** Five defects, each of which cost a commit there: the command line's first
  argument must be quoted or a launcher that strips it re-appends the tail on every restart and loops
  with the line growing; the image lookup must be case-insensitive, because a bundle index is
  case-sensitive and Win32 paths are not; `.` and `..` must be canonicalised before matching; named
  objects must survive the replacement, unowned, with one reference; and **a self-relaunch is not
  always a re-execution** — some engines launch their own image as a probe whose whole contract is a
  file it leaves behind, and treating that as a re-exec makes the probe become the game.
- **Suspension is orthogonal to waiting.** Flipping a waiting thread to suspended loses every signal
  that arrives meanwhile, and resuming then returns from a wait that never completed. A consuming
  signal must skip a suspended waiter. The maximum suspend count is 127 and exceeding it has its own
  error; a count real Windows never produces is a state no program was written against.
- **Completion ports must park on an empty queue.** Returning a timeout to an infinite wait spins an
  idle pool at full speed and starves the thread that would post the work. An alertable wait must
  drain its queue before reporting that it completed one, or the canonical loop spins forever. A
  guest callback invoked from host code must have a bounded pin, or an engine running its whole frame
  inside message dispatch deadlocks against a peer holding a lock.
- **Audio middleware run as real code.** It reads its data through the program's **own** file
  callbacks — the names are not files, they live inside the archive, so no filesystem lookup can
  serve them — and those callbacks must run as ordinary guest execution through a parking thunk,
  because the program's reader can hit a cold block. It also tops its streams up from a thread it
  starts itself, which we cannot run, so **every entry into the library has to be a service point**,
  with the export's own work first and one refill chain in flight at a time. Stream incrementally
  from one handle: reading whole files through those callbacks cost the earlier work hundreds of
  megabytes and seconds per frame. The refill must re-validate its stream after every yield, because
  the stream callback's canonical job is to close one source and open the next.
- **A play cursor that only advances when the guest calls in** works for a polling loop and hangs the
  double-buffered callback idiom, where the program queues two buffers and waits. Ours has that
  shape today; it matters when sound is wired to something that makes a noise.
- **Structured exception handling** needs the C++ frame handler and the cookie-checked scope tables a
  2003-era binary actually uses; the search phase must be separated from the mutating one; a catching
  frame goes back on the chain after the body; and on continue the stack pointer comes from the
  context too, so the resume address is written below it rather than at the dispatcher's own.
- **Interface identity.** Query must take a reference — an unreferenced query makes the balanced
  `query … release` pair in every engine net minus one. Guest interface blocks that are recycled must
  come from a pool partitioned by owning module and be handed back oldest-first, because the most
  recently freed block is precisely the one a stale pointer still names. We avoid the whole class by
  never recycling, at the cost of an unbounded leak; those are the rules if that is ever revisited.
- **A reversed depth range is legal in OpenGL and fatal in WebGPU**, which rejects it and invalidates
  the whole command buffer — an engine alternating the range instead of clearing loses every other
  frame entirely. Hand the sorted pair to the viewport and mirror the depth in the shader. Depth must
  also survive a buffer swap; only an explicit clear resets it.
- **A colour key is significant only in the format's colour bits**, and it is a modifier applied at
  consume time — applying it destructively on upload destroys the very colour the later comparison
  has to match.
- **Flat shading**, when it lands, needs the mode in the pipeline key, and a strip rewound to a
  triangle list must swap a triangle's **last two** vertices rather than its first two, or the
  provoking vertex changes. Ours swaps the first two: winding-correct and provoking-vertex-wrong,
  invisible only because nothing is flat-shaded yet.
- **The present interval is decoded and never honoured.** One decoder should serve both Direct3D
  versions so they cannot drift, with the DirectDraw flip flags mapping onto the same vocabulary.
  The wait for one interval must be the wait **verbatim**: one extra microtask before it costs a
  present that clears the refresh by a hair its whole slot, and locks to half rate with the worker
  idle. **And our pacer replaces a waiting frame rather than queueing it** — right for a presenter
  whose callback re-reads guest memory, wrong for a recorded frame whose work is already submitted.
- **A bind-group cache keyed per pass cannot span the recurrence that matters.** The earlier work
  measured the same pipeline at the same arena offset with a different texture as half of all misses,
  and the reuse distance as between 128 and 256 draws. Ours is per-pass by construction and
  deliberately so; this is the number to have in hand before the first "the backend is slow"
  investigation, not a defect to fix now.

---

## D. Already satisfied — recorded so nobody undoes them

- Synthesised exports sit **inside** the module's image bounds, with a sorted name table and
  trampolines placed before the export directory. This is the single most expensive thing the earlier
  work learned: a manual export walk that reads outside the image makes every delay-load slot fall to
  a failure stub and every archive open return failure.
- A module handle is its image base, and the address a name resolves to is the same trampoline the
  import table was bound to — so there is structurally one stub per name.
- Exception records are the right size, every frame's handler is called in chain order, a damaged
  chain is not republished, and the unhandled filter actually calls the program's own.
- File handles recycle through a queue **and** a file mapping stores the object rather than the
  handle number. Those two have to land together: the first hides the second completely.
- There is exactly one writer into guest memory, so the emulator's code-cache invalidation cannot be
  skipped. Any future fast path that writes the buffer directly inherits that obligation.
- An unimplemented import answers zero. The earlier work shipped a "not supported" status first and
  found it is a failure under no convention at all — as a result code it reads as success, as a
  boolean as true, as a handle as non-null.
- Fibre-local storage is per-thread; the input layer refuses an unacquired device from **both** the
  state and the buffered call, which is the asymmetry that makes hover work and clicks not; sockets
  capture their arguments at entry rather than at completion, keep a per-thread last error, propagate
  a close, keep the two protocols in separate namespaces, and cancel the losing waker.
- Capability words are derived from what the shader generator implements, so the advertised set
  cannot drift from the code.

---

## E. What the earlier work concluded was *not* worth doing

- **A static import-coverage metric does not predict whether a program boots.** Measured against
  thirty-seven titles known to run, it fired on twelve of them and scored a documented startup
  failure at zero — anti-correlated. Two mechanical causes: delay-load imports counted as blockers
  when the loader never read that directory, and a guess at two resolution steps where the real one
  walks six. Spend the effort on the dynamic half: what was asked for by name at run time and where
  the answer led. We already have that hook and do not use it.
- **A flag that turns a whole subsystem off never isolates which part mattered.** The inference drawn
  from one — "if clearing the code cache fixes it, some write site is missing its invalidation" —
  was unsound, because the flag also disabled a compilation tier, and the tier was doing the work.
- **A measurement taken while something else is using the machine is not a measurement.** Two
  conclusions built on data polluted that way were withdrawn as unfounded, and both had looked
  convincing.
