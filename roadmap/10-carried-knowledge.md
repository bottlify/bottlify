# 10 — Carried knowledge

A register of defects and mechanisms established by earlier work on this problem, kept so they are
not rediscovered. Each entry says what the mechanism is, how it shows itself, and what it costs to
find again.

Nothing here is a plan. Where an entry names something we have already built, it says so.
Process creation and its three defects are in `roadmap/09-process-creation.md` and are not repeated.

---

## The call bridge and thunking

**Every stub of a name must be patched, not the first.**
An export reached through the import table and the same export reached through `GetProcAddress` are
two different stubs. A registrar that patches only the first leaves the duplicate on the slow or
old path, so one function behaves differently depending on how the guest bound it.
*Symptom:* a fix that works when a program links normally and does nothing when it resolves at run
time, or the reverse. *Cost:* days, because the two paths look identical from the outside and the
difference is invisible in any log that records the call by name.

**Stdcall cleanup can be derived from a decorated name.**
An MSVC-mangled export carries its stack-cleanup byte count in the `@N` suffix. Where no descriptor
states the ABI, that suffix is a better source than a guess, and it is what makes a stub for an
unknown export possible at all.
*Symptom without it:* an unknown import cannot be given a correct `ret N`, so the guest stack is
corrupted at the first call and the failure lands somewhere else entirely.

**A repeating fault must stop printing its dump.**
An unbounded register/stack/ring dump on every fault lets a fault storm push the evidence for the
*first* fault out of the log. Cap it at a handful.
*Cost:* the whole diagnosis, because the first fault is the only one whose cause is still visible.

**Arguments are snapshotted at call time, never read from a closure at completion.**
Already recorded in this project's own register and already violated twice. Restated because it is
the single most expensive class here: a completion that re-reads a guest pointer reads whatever is
there *now*, which is a different frame.

---

## Kernel, threads and memory

**Preemption frequency is not throughput.**
A scheduler quantum that stretches — a long compiled block that is not interrupted at the
granularity the check assumes — starves a thread that must run often, even on a machine with ample
speed. Measured once: a far more capable machine took 4.2× fewer scheduler ticks and delivered only
1.7× less work per tick, so it accomplished ~2.5× more per quantum and still starved the audio
mixer. *Symptom:* a program feels stuttery on the fast machine and smooth on the slow one, and no
profile explains it, because the work is being done — just not often enough. *Cost:* weeks of
profiling that finds nothing, because faster quanta do not become more frequent quanta.

**File handles must be recycled, and a mapping must not store a handle number.**
Monotonic handles eventually walk off the end of their range and into another table's. Recycling
them makes a handle *number* ambiguous over time — and Win32 lets a program close its file the
moment a mapping exists, because the section holds the file object. A mapping that stored the
number then re-resolves it to whatever file has since been given that slot.
*Symptom:* a view populated from the wrong file, and an unmap writing that back over it. Silent
save-file corruption, arbitrarily far from the cause. *Cost:* very high — the "never reused"
property hides it completely until handles are recycled, so the two changes must land together.

**`VirtualQuery` must report an unallocated pool as free, in one region.**
A reserved-but-unallocated span reported as committed, page by page, makes a guest address-space
walker (`addr = BaseAddress + RegionSize`) step 4 KiB at a time across hundreds of megabytes.
*Symptom:* a program appears to hang for minutes at startup, usually a crash reporter or a heap
manager doing the walk. *Cost:* days, and it looks like an infinite loop in the guest.

**A module walk must report only what the process actually loaded.**
Eagerly materialising an image for every library the engine implements means an address-space walk
finds libraries no real process would contain — a 2001 title given a 2008 C runtime image it never
linked. *Symptom:* a heap manager concludes the program links a foreign runtime and refuses to
start. Track what was *asked for* — import binding and name→base handouts — not what exists.

**`MEM_RESERVE`, `MEM_RELEASE` and the free-space APIs have to answer honestly.**
A bare reserve that leaves pages committed lets a stale touch of decommitted memory read old
contents instead of faulting. A release that leaves the old protection makes a re-reserve inherit
it. `GlobalMemoryStatus` must report the architectural 0x7FFE0000 for total virtual, not the RAM
size, because titles divide it to size their own pools.

**Fibre-local storage is per thread and must move on a context switch.**
If it lives in one page shared by all threads it must be swapped in and out with the thread.

**Condition variables and slim locks have exact wake semantics.**
A wake with a contended lock re-parks the waiter *on the lock*, preserving its pending return value,
rather than resuming it lockless; releasing the lock then signals lock waiters. A sole-runnable
finite-timeout wait must not fall through past a parked wait. Getting the post-return stack pointer
wrong by one slot (a four-argument variant treated as three) corrupts the caller silently.

**`PEB->Ldr` has to be published.**
A guest that resolves exports by walking the loader data instead of calling `GetProcAddress` finds
an empty list and silently gets nothing.

---

## Structured exception handling

We have an IDT and fault reporting. This is what comes next, and every item was paid for once.

**A guest fault must become an exception the program can handle, not a halt.**
`#GP` and `#UD` dispatch to SEH, then to the unhandled-exception filter, then to per-thread
termination that releases the thread's critical sections and mutexes. Halting the machine instead
loses every program that faults on purpose.

**The unwind pass calls each frame's own registered handler with `EH_UNWINDING`.**
A runtime that is not MSVC — a JIT's frame teardown, for instance — depends on exactly that, and a
reading that only understands MSVC scope tables skips it.

**`EXCEPTION_RECORD` is 0x50 bytes on 32-bit** (five dwords plus `ExceptionInformation[15]`), and a
trampoline's return slot needs its own word after it. Reserving 32 bytes overlaps the trampoline and
puts the return slot inside `ExceptionInformation[2]` — invisible while `NumberParameters` is zero,
and lethal to any handler that copies the structure whole.

**A walk that stops because the chain is wrong must not write that frame back as the new head.**
Republishing a cycle, an out-of-bounds link or a frame past the target leaves the damage in place
for the next throw to walk again.

**The handler check can only be a bounds test.** Images are mapped readable, not
readable-executable, so demanding execute permission rejects the program's own handler.

**Dispatch calls *every* frame handler in chain order.** A walk that skips frames it cannot parse —
a cookie-XORed scope table, say — lands the exception in an outer catch. When a frame cannot be
parsed, defer the whole dispatch to the guest's own native walk rather than guessing.

**Build the exception record per dispatch, on the program's stack.** A fixed scratch address aliases
the record a rethrow still references, and the native handler then sees a null throw-info.

---

## The floating-point unit

**x87 precision control must be honoured.**
A relaxed FPU that ignores precision control keeps 64-bit mantissa bits where the program asked for
24. Any comparison the program makes against a value it stored as a 32-bit float then never matches.
*Symptom, observed:* a path-finding routine de-duplicated links by exactly that comparison, so every
candidate appended a new one, the array overran into neighbouring data, and starting a new game
dereferenced a null pointer. *Cost:* enormous — the failure is a null dereference in unrelated code,
and nothing points at arithmetic.

**A rounding-mode window must not be preemptible.**
Code that sets the x87 control word, does one operation and restores it hands its rounding mode to
another thread if a switch lands between the two loads.

---

## The loader

**Marking a real library "initialised" happens when its entry point is *scheduled*, not when it
returns.** Otherwise a library that calls back into the loader during its own initialisation is
seen as uninitialised and initialised twice.

**A synthesised system module must sit where a program can find it by hand.** Programs walk export
directories themselves and reject an address outside the module's image bounds — already the reason
this project synthesises real in-guest images. Restated because the same test appears in delay-load
helpers, in packers, and in copy-protection.

**One missing system export kills the load of a library the game ships.** Recorded already; the
practical consequence is that after each library loads, the unbound-import list must be re-read,
because its own imports are the next list.

---

## Graphics

Ours are contracts and state machines that have never drawn. These are the defects that were paid
for in a system that did.

**Lock flags are the whole performance and correctness story for dynamic buffers.**
A `Lock` whose flags are parsed and dropped renames the buffer on every re-lock within a batch,
which means re-sending the entire mirror to the device. `D3DLOCK_NOOVERWRITE` is the program's
promise not to touch bytes a pending draw reads — a real driver writes into the live buffer and
never renames there. `D3DLOCK_DISCARD` may rename, but because it declares the old contents
undefined, only bytes the program wrote need carrying over; a rename *without* discard must re-send
everything, since the old contents remain observable.
*Measured once:* ~60 uploads of a megabyte or more per frame, ~250 MB of invented traffic, 2.7 s of
every 10 s spent inside the upload call, a 275 ms frame. Fixing the flags and tracking the locked
byte ranges took uploads from 2725 ms to 133 ms per 10 s window and the frame rate from 3.6 to
23–34. *Cost to rediscover:* the whole of a performance investigation, and it presents as "the
backend is slow" rather than as a contract being ignored.

**Upload the range that was locked.** `Lock` already names it. Track the union of locked ranges
since the last upload, aligned outward to the API's alignment rule, and give the upload a
destination offset.

**`DISCARD` applies to the whole resource, not to the rectangle that was locked.**
A sub-rect lock carrying discard must not wipe the surface outside that rect. Discard is also
stripped under no-overwrite, and discard combined with read-only on the default pool is rejected
outright.

**A locked render target must return the pixels that were rendered.**
Reading device pixels into one storage and handing the caller a pointer to another, with nothing
copying between them, returns a buffer nobody ever wrote — all zeroes, and the canonical
render → copy → lock → read sequence silently produces nothing.

**A complex sublevel dies with its root, not at its own zero.**
A mip level or an implicit back buffer belongs to the root of the complex structure and is destroyed
with it; its own reference count reaching zero means nothing. Destroying it there returns the
address to the pool, and a program walking a mip chain then dispatches through a block that already
belongs to something else. *Symptom:* a descriptor query starts failing one iteration before a null
vtable call escapes into unmapped memory.

**Legacy interface delegation is a corruption class.**
Five defects of one shape were found together: a handler reporting success while writing the wrong
thing, or nothing, into the caller's memory. An older interface's `GetCaps` delegated to a newer
handler that writes sixteen bytes into a four-byte structure — twelve bytes of the caller's stack
frame smashed on every call, success returned. An out-parameter never written, with the two-phase
poll that reads it spinning forever on uninitialised memory: frozen frame, worker pegged, not one
log line. A count written four bytes past the caller's buffer. A declaration reporting an element
count one short of what it writes, so the universal query-then-fill idiom overflows an allocation
sized from a number we supplied. *Cost:* extreme — the caller is told it worked and cannot find out
otherwise, so the damage surfaces far from its cause and survives bisection.

**Every creatable COM interface needs a real `AddRef`/`Release`.** A stub that answers a constant
makes a program's lifetime bookkeeping meaningless, and the object dies or leaks unpredictably.

**A pixel shader may be bound while the vertex stage is fixed-function.**
Asking "is a vertex shader bound" to decide between the programmable and fixed-function paths drops
the pixel shader in exactly the standard shape of a full-screen post-process quad.
*Symptom, observed:* a black 3D background, because the substituted fixed-function combiner
multiplied the scene by a vertex diffuse whose RGB was zero. *Cost:* weeks — the picture is wrong in
a way that looks like a blending or alpha problem, and several plausible theories about blending
were pursued and refuted before the real one.

**The pipeline key must fold every stage the fragment formula depends on.**
A key built from stage 0 alone serves one image to every draw that shares its shape, because a
stage-1 cascade selects a different formula and a non-zero texture-coordinate index selects a
different coordinate set. The cascade is disabled unless a stage arms it.

**Ask a shader module whether it compiled.** Module creation does not throw; a rejected or silently
degraded module is otherwise invisible.

**A degenerate scissor rectangle must fall back to the full target**, and the default scissor *is*
the full render target. A zero-by-zero scissor taken literally renders nothing, which reads as "the
renderer is broken" rather than as one state value.

**Readback needs the channel order the storage format actually uses.** A red/blue swap on readback
makes every screenshot disagree with the screen, which then wastes an investigation into rendering
that was correct all along.

---

## Audio

**Completion is clocked by the consumer, not by the producer.**
A buffer's "done" flag follows the real play cursor. A buffer with a queued successor may complete
early once its unplayed bytes fit the device's lead — that absorbs delivery latency and is what the
system mixer does — while the *last* queued buffer completes only at true playback end.
*Symptom without it:* dropouts with small double-buffered queues, which is most titles.

**Buffer depth must derive from the device's reported latency.**
A device with half the latency calls its worklet twice as often with half the buffer. A ring depth
and premix lead that do not derive from that figure stop absorbing uneven delivery on exactly the
faster device. *Symptom:* audio sticks on the good machine and is clean on the poor one.

**Serve a streaming source from every entry point.** A streaming audio API is driven by whichever
call the program happens to make; servicing the stream only from a timer means a program that polls
instead never advances.

---

## Filesystem and I/O

**One speculator, and it must know what a file is.**
Three layers each reading ahead — an I/O worker guessing linearly from an archive offset, a block
cache, a path window — duplicate each other one step apart and fetch a neighbouring entry whenever a
file ends. *Symptom:* roughly four speculative fetches per real request and a cache thrashing
against its own guesses. The layer holding the file object derives the hint (an explicit sequential
flag, else whether this read starts where the last ended) and passes it down; exactly one layer
speculates, never past the end of the entry, and does nothing at all for a caller that is not
scanning. Keep the read-ahead position per entry.

**A stale cache keyed by something that changed must be evicted, not trusted.** A bundle cache that
survives a change to what it describes is worse than no cache.

---

## Diagnostics, and how to be wrong less

**A coverage census does not predict whether a program will run.**
A metric counting what a bundle imports against what is implemented was wrong twice — it counted
delay-load imports as load blockers, which they cannot be, and it guessed at two resolution steps
where the real resolver walks six. Tested against titles known to run, it fired on a third of them.
*Lesson:* a static metric about a dynamic system must be falsified against known-good cases before
it is believed, and the honest outcome is often to publish the falsification.

**A validator that emits three hundred warnings of one kind emits none.**
The single real finding in such a list is invisible. If a check cannot distinguish "unverifiable" from
"wrong", it must say so as a separate category rather than warning about both.

**A model of the system must import the system's own constants, not restate them.**
A coverage model that inferred which libraries the loader overrides — rather than importing the
list — answered *whose code runs* incorrectly, which points debugging at the wrong layer entirely.

**A heavy tool left running beside a measurement invalidates it.**
Two conclusions were once built on data polluted by an analysis process taking real cores from the
machine being measured, and both had to be withdrawn. Re-measure with the environment clean before
believing any number.

**A thing that exists is not a thing that works.**
A health check reporting a component present because it *exists*, rather than because it answers,
reports a green stack that nothing can drive.

**Delete the switch when the hypothesis is refuted.**
A toggle kept for a theory that measurement disproved is debt that later reads as a supported
option. Record the refutation; remove the mechanism.

---

## Code worth taking rather than knowledge

Each of these solved a problem we still have. They are the user's own prior work and may be reused —
but rewritten here against our contracts, never copied.

- **Stack-cleanup derivation from an MSVC-mangled name.** Small, self-contained, and the only way to
  give an unknown export a correct stub.
- **A dirty-range tracker for buffer uploads.** The union of locked ranges since the last upload,
  aligned outward. Small, and it is half of the lock-semantics fix above.
- **The x87 helper block emitted as real guest code.** `floor`, `ceil`, `fabs`, `sqrt` and the
  float-to-long conversion as x86 in guest memory rather than host traps: a title calling `floor`
  seventy thousand times in eight seconds pays for the boundary crossing, not the work. Requires the
  non-preemptible-window rule above.
- **An API coverage census over bundles.** Useful for "what does this need that we lack", provided
  its falsification above is carried with it.

---

## What could not be established

- Several commits state that something was fixed without saying how; where the message named no
  mechanism and the diff was large, it was left out rather than guessed at.
- Work touching a just-in-time compiler, ahead-of-time caching and a differential oracle was read
  only at the message level. It is a substantial body of work and may repay a second pass once
  anything here needs to be fast.
- The graphics entries come from a system whose backend differs from ours in ways not established
  here. The mechanisms are API-level and should carry; the measurements should not be quoted as
  predictions of ours.
