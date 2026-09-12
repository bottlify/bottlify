# Decisions we made, and where we could go faster

Two registers in one file, both of them things a reader should be able to find without reading the
code that implements them.

**Part A** is behaviour this project *decided* rather than established. It exists because Bottlify is
under no obligation to match any particular reimplementation of Windows: what a program observes is
the contract, and where no published expectation could be found, or where a different answer serves
this engine better, that is a choice to be defended on its merits and revisited when something
argues against it. Each entry says what the status actually is — verified, recalled, decided, or
never run.

**Part B** is where the implementation that is correct is knowingly the slow one. Performance is part
of correctness here, so these are debts rather than wishes.

Nothing in either list is a bug report. A bug goes in the code and gets fixed.

---

## A. Decided rather than established

### A1. DirectDraw refuses a 15- or 24-bit display mode

`SetDisplayMode` answers `DDERR_INVALIDMODE` for 15 and 24 bits per pixel. **Status: decided.**

There is no published expectation to check this against — the conformance corpus never calls it with
15, and its single 24-bit call is a fallback inside the tests' own helper with no assertion on the
result. The reference implementation forwards any of 8/15/16/24/32 to the mode set and lets that
succeed or fail. We refuse, because this layer has no such surface format to create and
`DDERR_INVALIDMODE` is the code DirectDraw uses for a mode it cannot set.

Revisit if a program is found that asks for one of these and treats the refusal as fatal. Supporting
24-bit properly means a three-byte pixel path through the blitter and the presenter, which is real
work for a format almost nothing chose.

### A2. This build announces itself as hardware, with transform and lighting

**Status: decided, with reasons, at the start of Direct3D 7 (master plan §3).** Until that step
`GetCaps` claimed no 3D and filled the hardware and emulation blocks identically; that changes with
it.

The decision: the hardware block reports 3D and the surface kinds a 3D device needs, the emulation
block reports the blitting and GDI capabilities only, and device enumeration names three devices in
the order a machine with a transform-and-lighting card lists them — software rasteriser, hardware
device, and hardware device with transform and lighting. All three are the same renderer
underneath; only the descriptions differ.

Why: there is a real GPU underneath, so the hardware claim is the true one — and programs of this
era branch on it. They look for the hardware device, prefer the transform-and-lighting one, and read
an emulation-only enumeration as "no accelerator", which sends them into software rendering or into
refusing to run. Announcing the capabilities we actually have, under the identifiers programs check,
is the generic contract and not a concession to any title.

The thing to watch: a capability bit set here is a promise about what draws correctly. Every bit
claimed is one a program may take a path on, so this list should grow as the renderer does and not
before.

### A3. The 64-bit arithmetic helpers pop their own arguments

`_allmul`, `_alldiv`, `_allrem`, `_aulldiv` and `_aullrem` in ntdll are declared stdcall with
sixteen argument bytes — the callee cleans up. **Status: decided against a published specification,
on evidence.**

The reference project's export specification declares them cdecl. Its own C implementation declares
them `WINAPI`, which is stdcall, and the compiler that generates these calls emits four pushes with
no stack adjustment afterwards. Two of the three sources agree with each other and with the call
site, so the specification file is the one we do not believe. If this is ever wrong, the symptom is
a caller whose stack is sixteen bytes off with nothing pointing at the cause — so if these are ever
suspected, remove all five rather than adjusting them; they are normally linked statically and
nothing else depends on them being present.

### A4. Three shift helpers are absent on purpose

`_allshl`, `_allshr` and `_aullshr` are not exported. They take their operand in EDX:EAX and their
count in CL, and the trap stub writes EAX and DX before any handler runs, so there is nothing left
to shift. An unresolved import that names the function is better than a shift of whatever the stub
left behind.

**This is the one entry here with a known fix**: a stub variant that saves EAX and EDX before the
trap, the way the existing result-preserving flag already saves EAX into ECX. Worth doing if a
program actually imports them.

### A5. ntdll's timer resolution is a plausible number, not a measured one

`SYSTEM_BASIC_INFORMATION`'s timer resolution is 156250 (15.625 ms). **Status: never measured** —
this engine has no timer interrupt to measure with. Every other field of that structure is a real
fact about this machine. Revisit when there is a periodic interrupt to time.

### A6. Ansi-to-Unicode conversion in ntdll ignores the code page

`RtlAnsiStringToUnicodeString` widens byte for byte. Correct for ASCII, wrong above 0x7f for
anything but Latin-1. `kernel32/locale.js` has a real single-byte decoder that is not exported;
threading it through is a small piece of work nobody has needed yet.

### A7. Only three information classes are answered

`NtQuerySystemInformation` answers `SystemBasicInformation`; `NtQueryInformationProcess` answers
`ProcessBasicInformation` and `ProcessDebugPort`. Every other class is refused with a status rather
than filled with plausible invented numbers. That is deliberate and should stay the rule: a refusal
is a message, a fabricated structure is a wrong answer that propagates.

### A8. There is one user and it is called "User"

`GetUserNameA` answers a constant. There is one account and no way to become another, so this is not
configuration. It exists at all because a program that cannot learn its own user name sometimes
refuses to start.

### A9. Thirty-two interrupt vectors, not two hundred and fifty-six

The boot ROM installs gates for the processor's own exception vectors and no others. A build with a
full table was tried and reverted: a vector fires during protected-mode entry and lands in a halting
stub, which reads as a hang — worse than a loud refusal.

### A10. Direct3D 7 offers only what the renderer can actually do

Three lists are narrower than the hardware of the era would have reported, and all three narrow for
the same reason. **Status: decided.**

`EnumTextureFormats` names thirty-two- and sixteen-bit colour and nothing else; `EnumZBufferFormats`
names sixteen bits of depth and twenty-four with eight of stencil, and no other combination; and the
capability words in `d3d7/caps.js` claim only the cull modes, depth compares, blend factors, stage
operations, filters and address modes the shader generator and pipeline implement today — no fog, no
stencil operations, no lighting, no bump mapping, no cube maps, no W-buffer.

The reasoning is the one recorded under A2 and is worth stating as a rule of its own: a capability
bit is a promise about what draws correctly. A claim the renderer cannot honour sends a program down
a fast path to a wrong picture, where the absence of the claim would have sent it down a slow path to
a right one. So these lists grow when the renderer grows, and never in anticipation of it.

What to watch for: a program that finds no format it wants and refuses to start. That is a signal to
implement the format, not to add it to the list.

### A11. Direct3D 8 refuses eight things it could have pretended to do

Shaders (`CreateVertexShader`, `CreatePixelShader`), cube maps, volume textures, palettes, additional
swap chains, the hardware cursor, `GetFrontBuffer` and `ProcessVertices` all fail rather than
succeed. **Status: decided, and it is the A10 rule applied a second time.**

The sharpest case is the shaders. The renderer *skips* any draw with a shader bound, so a
`CreateVertexShader` that succeeded would put a program on the programmable path where every draw is
silently dropped — a black screen reached by a fast route, where the refusal would have sent the same
program down the fixed-function path to a picture. `SetVertexShader` is implemented anyway, because
that one dword also carries the vertex format and every fixed-function draw needs it.

Three narrower notes from the same work, each a decision rather than a fact:

- **Multisampling is accepted everywhere and ignored everywhere.** The presentation parameters already
  dropped theirs, so render targets and depth buffers drop theirs too and the whole device is
  consistently one sample per pixel. `CheckDeviceMultiSampleType` says so. Degradation here is
  aesthetic rather than structural, which is why it is dropped rather than refused.
- **The gamma ramp and the clip planes are state without effect** — stored, read back, and changing
  no picture. The capabilities report zero for both, so a program that checks is told the truth and a
  program that does not gets readback rather than a refusal.
- **Sixty-four megabytes of texture memory**, a round number nothing measures, and the second copy of
  it: DirectDraw reports the same figure from a constant the Direct3D side cannot see. Two numbers
  that must agree and have no way to.

**The largest hole left in this API**, recorded here because it is known and unfixed:
`GetDeviceCaps` writes a `D3DCAPS8` that is almost entirely zero — no device capability bits at all.
A program that branches on hardware rasterisation will conclude there is no accelerator, which
directly contradicts A2. It was left empty deliberately rather than filled from recalled flag
constants, which is the right call; it wants a pass with a header, or with the constants this tree
has already checked for Direct3D 7.

### A12. The thiscall convention is kept although nothing uses it

Every COM interface method in this engine is stdcall, because that is what a COM method is: the
interface pointer is the first argument on the stack, which is precisely what makes the C bindings
binary-compatible with the C++ call. **Status: established against real compiled binaries** — twelve
call sites read instruction by instruction across five images, all agreeing, plus a census in which
the two libraries whose only virtual calls are COM show twenty-four and thirty stack-passed sites and
not one in a register. The same binaries do emit the register form in their thousands, for their own
C++ virtual calls, which is the control that makes the reading trustworthy.

The engine had it wrong until this was measured, and no test could see it: our own harness drove the
vtables in a way that agreed with the mistake. That is the lesson worth keeping — a convention is not
verified by a test written against the same assumption.

What is a decision rather than a fact: `Convention.THISCALL` now has no users and is kept anyway. The
argument for deleting it is real, and it is the argument that produced the bug — a convention that is
right in the abstract and wrong everywhere it has ever been reached for invites being reached for
again. It stays because a C++ runtime, one of the `msvcp` libraries on the porting register, exports
real member functions that genuinely use it, and its definition now carries a warning saying loudly
what it is not for.

### A13. A module's whole file stays in host memory for its resources

Every loaded image keeps its bytes on the host side, because a resource is read out of the file
rather than out of the mapping. Without it a library a program ships answers nothing for strings,
icons, dialogs, menus and version information. **Status: decided, with a known cost** — a game that
ships twenty libraries holds twenty images in host memory for the life of the process, tens of
megabytes for a large title. The alternative is re-reading from the volume on each resource call,
which is a wait on a guest thread, and holding a thread is the cost this project ranks above all
others. Revisit only with a measurement showing the memory matters more than the latency does.

### A14. One frame has now run against a real GPU; almost everything else has not

**Closed in part, and kept for what it still says.** A hand-written guest program of a few dozen
instructions creates a Direct3D 8 device, clears it, draws one triangle and presents — in a real
browser, on a real adapter — and the presented surface reads back byte-exactly at four named points.
Two colours in the whole frame, 53400 cleared and 23400 drawn, and 23400 is the triangle's exact
analytic area. So the path from a guest `CALL` to a lit pixel exists and is sound, and a failure past
this point is about a program's usage rather than about the path existing at all.

What that run does *not* cover is most of the layer: the DirectDraw blitter, the presenter's upload
path, textures, depth, blending, the device-context seam onto GDI, and every capability the entries
above say is claimed. Those are still verified against our own model alone, and every graphics
number in this repository that is not one of the four pixels above is a statement about that model
rather than about a picture. The scenario is `tools/cdp_test/triangle.mjs`; extend it as more of the
path becomes reachable rather than trusting the model further.

Worth recording about the run itself: the whole thing was blocked by a defect nothing in the test
suite could see — a trap stub taken after the stub table was written had no bytes behind it, so every
COM call in the engine walked into blank memory. Our tests call a published vtable's handler
directly; only executing the stub the guest would execute found it. That is the argument for this
scenario existing at all.

---

### A15. What the loader tells a library about how it arrived

`DllMain`'s third argument is not decoration. Windows passes NULL when a library came in through
`LoadLibrary` and a non-NULL value when the loader brought it in because the image imports it, and a
library is entitled to do genuinely different things in each case. We passed zero for both until a
real library's archive code turned out to build its hash table twice -- once, guarded, for itself,
and again with a different seed on the dynamic-load path only -- so that being told the wrong thing
made it overwrite a correct table with a useless one. Every archive lookup after that reported that
the file did not exist, with the archives open, the tables byte-exact in guest memory, and the names
hashed from the right characters.

The value we pass is 1, and only its non-nullness is contractual. `DLL_PROCESS_DETACH` carries the
same distinction the other way round -- NULL for `FreeLibrary`, non-NULL for process exit -- and
will matter when detach is implemented.

### A16. A Win32 name lives exactly as long as a handle to its object

A named event or mutex is destroyed when its last handle closes, and the name goes with it. Keeping
the name after that breaks the one idiom the name exists for: a program creates the object to find
out whether another copy of itself is already running, closes it, and creates it again for real --
and the second create must not be told the name is taken by the handle it has just closed. The
registry therefore checks, on every named create, whether anything still holds a handle to the
object it remembered, and forgets the name when nothing does.

### A17. VirtualAlloc places a reservation on a 64 KiB boundary

`GetSystemInfo` reports an allocation granularity of 64 KiB and an allocator built on `VirtualAlloc`
is entitled to believe it. A common design keeps no back-pointer in a block header at all, storing
only the top sixteen bits of the segment the block came from and recovering the segment by shifting
them back. Handing out a page-aligned base breaks that arithmetic silently: the recovered "segment"
lands in the middle of an earlier allocation and the header read from it is whatever data was there.
The cost of honouring it is address space, which is the thing this engine has most of.


### A18. A device's cursor advances on its own, not when the guest asks

A program is entitled to hand a buffer to a wave device and then spin on the `WHDR_DONE` flag the
device sets in that buffer's own header. The flag is the contract; a real device honours it from its
own clock and never learns whether anyone is watching. Our wave-out cursor advanced only inside a
`winmm` entry point, so for a program that spins rather than polls through an API the cursor never
moved at all -- the machine ran, the guest clock ran, and the one event that would have ended the
spin was waiting for a call that by construction would not come. Eighty per cent of one real title's
instructions were measured sitting on that single `test`/`je` pair.

So the run loop settles the devices every few turns, alongside mixing ahead into the audio ring.
The generalisation is worth stating: anything in this engine that a guest can wait on without making
a call has to be driven from the scheduler rather than from the call that would have driven it.

### A19. A COM method receives its arguments with the interface pointer already removed

`bridge/internal/vtable.js` strips the `this` pointer before calling an implementation, and says so
in its typedef. Two seams were written as though it did not, destructuring a leading hole and so
reading every argument one slot late. Nothing caught it because their test fixtures passed the
pointer too, which made the fixture agree with the bug instead of with the bridge -- so DirectSound
and DirectInput had never once worked, and a real sound engine was measured getting `E_INVALIDARG`
from `GetCaps` and `CreateSoundBuffer` and falling back to the wave API.

The rule that follows is about tests, not about arguments: a fixture that stands in for the bridge
has to call the way the bridge calls. Both seams now have a test that drives the real vtable
publisher by slot number over a flat buffer, pushing the interface pointer exactly as a guest does,
so the fixture can no longer disagree with the thing it stands for.

### A20. DirectShow answers, and answers that it cannot render

A program that plays a cinematic builds a filter graph, asks it to render a file, runs it, and then
sits in a modal message loop until the graph reports that the video finished, was aborted, or
failed. With no graph at all there is no event and the loop has no exit -- the program is not
crashed, it is waiting correctly for something that can never arrive.

So the graph exists and refuses: `RenderFile` answers `VFW_E_CANNOT_RENDER` and `Run` queues
`EC_ERRORABORT`. That is what a real machine without a decoder for the format does, and a program
written against Windows already has the path. The alternative -- making the file appear absent so
the program never asks -- would have been a lie about the filesystem to work around a gap in
something else.


### A21. The guest's clock runs while the guest does

Nothing credited it. `advance` was reached from two waiting paths and
`suspend`/`resume` from nowhere at all, so virtual time only moved when a
program waited -- and a program that does not wait saw no time pass whatsoever.
A frame loop concluded its frame took no time, a timed wait never expired, and a
device whose cursor runs on that clock never finished a buffer, stranding a real
title spinning on the flag the buffer would have set. The run loop now credits
the clock with the wall time each slice really took. Wall time rather than
retired instructions, because what a program measures is how long its own work
took, and on a machine this slow that is the wall time.

### A22. A window is told that it exists

A window procedure does its setup in `WM_CREATE`: it builds the object the
window stands for, arms its timers, and hangs that object off the window. We
made windows without ever sending it, so a program got a window that looked real
from every angle and did nothing -- and then waited for something it was
supposed to have started itself.

`WM_NCCREATE` is deliberately still not sent. Sending is running guest code, and
running it twice from one host call means the second starts while the first is
unwinding. The default answer to it is TRUE and the structure it carries arrives
again a moment later with `WM_CREATE`, so it is the one to leave out until a
program is seen to want it.

### A23. DefWindowProc does nothing with WM_DESTROY

Ours posted a quit, on the reasoning that a program whose procedure falls
through has no other way to end. Windows does nothing, and the difference is not
academic: a program of any size destroys windows constantly -- a dialog, a
tooltip, a splash screen -- and passes their `WM_DESTROY` to the default
procedure because it has nothing to add. Every one of those ended the process.
Ending the message loop is the program's own decision, made by calling
`PostQuitMessage` from the procedure of the one window it considers its main
one.

### A24. A timer is due against the guest's clock, and WM_TIMER is made up

`SetTimer` refused to make a timer, on the grounds that one that never fires and
one that fires continuously are both indefensible. Both halves were true when
there was no clock. There is one now. A timer is due against the guest's own
clock, and `WM_TIMER` is synthesised when a program asks for a message and finds
nothing else -- which is how Windows does it, and is why a handler that runs
long does not leave a backlog of ticks behind it. A program of this era drives
itself from here: its loop blocks in `GetMessage` and a timer is the only thing
that wakes it.

### A25. A graph with nothing to play finishes at once

Refusing to render was tried first and is worse. A program that plays optional
media checks `RenderFile`, releases the graph it cannot use, and carries on --
and then its own caption timer, armed unconditionally a moment earlier, reads
the pointer it has just released. A refusal handled entirely correctly still
ends with the program dereferencing nothing.

So a graph is built with no filters in it, which renders a presentation of no
length, and running it reports `EC_COMPLETE` at once. That is a real state
rather than a pretence, and it takes the same path finishing a real film takes
-- the path the program is written for. A decoder arriving replaces the one
function that decides this.

### A26. A thread is an object a program waits on

`WaitForSingleObject` on a thread handle is how a program joins one, and ours
failed on it because a thread carried no kind a wait could recognise. A thread
is now signalled by having ended and stays signalled: nothing is taken from it,
because a second join must not wait for ever.

### A27. A structure's offsets are written out in full or they are wrong

`D3DCAPS8` was tabulated as the handful of fields anyone fills in, and every one
of them was in the wrong place: five guard-band floats and an adjustment sit
between the texture limits and the blend-stage counts. The maximum texture size
went into the repeat limit, and the real maximum read as zero -- so a program
halving a texture until it fits halved it for ever, which is 97 per cent of a
measured profile sitting on one instruction. A partial table is not a partial
implementation; it is a wrong one.

### A28. A device's state lives in guest memory, and the host trusts none of it

The calls a program makes most between draws -- `SetRenderState`, `SetTransform`,
`SetStreamSource`, `SetIndices`, `SetVertexShader`, and a buffer's `Lock` and `Unlock` -- are guest
code that writes a block of guest memory the device owns, and the host never sees the call.
**Status: decided, measured on one title's menu.** The rules, which are the whole design:

- The block is one-way. The guest writes it; the host writes it only to mirror its own state into it
  -- when the block is made, after a state block is applied, after a reset -- so that "unchanged in
  the block" means "unchanged on the device".
- The block is untrusted. On entry to any method of the device the host compares the whole of it
  against its own copy and puts every difference through the real setter, which is where validation
  and invalidation live. Nothing the host derives from state -- a pipeline, a shader, a binding -- is
  keyed on the block; nothing depends on a flag the guest set. A `Get*` therefore answers what the
  guest wrote, because the sync ran on the way in.
- What the fast path cannot do stays with the host, by falling to the method's own trap: a state
  past the block, a shader handle (the host knows whether it is live), a lock already held, a lock
  for reading, a full ring, and -- by a flag the host raises -- everything while a state block
  records, because the block must then capture what was set rather than what changed.
- A value the device would have refused is refused at the next entry rather than at the call: the
  program was told success, and the difference is reported as a divergence, once.
- The block counts what it absorbed, in words the guest routines increment, so that the saving is a
  number in the diagnostics and not a belief; and an entry reads those words first, and reads no
  further when none has moved.
- The block takes a page of its own. A write into a page that holds compiled guest code makes the
  emulator throw that code away, and a block laid out of the heap right after the routines that
  write it had every call discarding the routines.

A buffer's storage was guest memory already, so its lock is an address handed back and a range
remembered, its unlock is the buffer's block appended to a ring in the device's, and the host
replays lock and unlock against the real buffer when it next looks -- before any draw, because a
draw is a crossing. A lock the guest holds across a crossing is mirrored as one the host holds, so a
second lock through either path is refused as the real interface refuses it.


## B. Where we could go faster

### B1. The x87 helpers, emitted as guest code

`floor`, `ceil`, `fabs`, `sqrt` and the float-to-long conversion currently cross the boundary into a
host handler. Emitting them as real x86 in guest memory means a program calling `floor` in a tight
loop pays for the arithmetic rather than for the crossing, which for a title that calls it tens of
thousands of times a frame is the whole cost. This needs the non-preemptible rounding-mode window
from `carried-knowledge.md`, and it is the single largest known win of this kind.

### B2. The floating-point seam builds a view per call

`layers/cpu/internal/fpu.js` takes a fresh `DataView` over the emulator's memory on every access,
because the memory can be grown and replaced underneath. Caching it against the current buffer
identity and rebuilding only when that changes removes an allocation from the hot path of every
maths function that returns a double.

### B3. The presenter uploads the whole primary

A blit into the visible surface causes the full surface to be read out of guest memory, converted
and uploaded. The buffer machinery already tracks the union of dirty ranges and uploads only that;
the same idea applies here, and the rectangle is known — every blit and every lock names one.

### B4. Nearest-palette-index search is a linear scan

Writing to an eight-bit surface through GDI searches all 256 palette entries for the closest colour.
It is cached per colour, so a fill pays once, but a gradient or a converted image pays repeatedly. A
coarse lookup table indexed by the top bits of each channel makes it a constant-time read.

### B5. A just-in-time compiler, an ahead-of-time cache, and a differential oracle

All three are known techniques for an emulator of this shape and none is taken up yet: nothing
here is fast enough for the interpreter to be the bottleneck. Worth a second pass when something is.

Measured since, on the title in a match: 99.7% of the guest's instructions run in generated
code and the module table never overflows, so the compiler's cache is not the missing piece.
What remains is the dispatch walk -- the guest leaves generated code about every 37
instructions, 3.3 million re-entries a second -- which the module-size knobs (pages per module,
extra basic blocks) address. Raised to 8 pages and 2,000 blocks, the run got worse, not better:
the compiler's threads took a core and a half for the whole of a map load, the guest ran a
quarter of the wall time, and the load had not finished after four minutes. The defaults stand;
a smaller step is untried.

### B6. Guest thread latency, not throughput

Recorded here because it decides which of the above is worth doing first: the cost that matters most
in this engine is how long a guest thread is held, not how much total work gets done. An
optimisation that improves throughput while lengthening a single hold is a regression.

### B7. The emulator does not honour the slice it is given

Measured, not suspected. `run_slice` bounds a slice by retired instructions, and the check sits
between blocks — but the just-in-time compiler emits its own loop-safety check against
`LOOP_COUNTER`, a compile-time constant of 100 003, in two places in `jit.rs`. A generated block
containing an internal loop therefore runs up to that many instructions before it returns, whatever
the caller asked for.

The numbers, from one title at its menu:

| quantum asked for | worst slice |
|---|---|
| 100 000 instructions | 59.9 ms |
| 2 000 instructions | 21.9 ms |

A fiftieth of the quantum bought a third of the overrun, which is what a constant bound looks like
from outside. Twenty milliseconds is the whole cost: the sound ring is fed once a turn, so a slice
that long is that long with nothing reaching the ring, and it is heard as a stutter. Frame pacing
takes it the same way.

The fix is named in our own fork commit and is a single idea: emit a load from a global where the
constant is emitted now, and have `run_slice` write the caller's bound into it. There is a free slot
in the global map, and the compiler already loads globals in generated code
(`builder.load_fixed_i32(global_pointers::…)`), so nothing new has to be invented — the care goes
into initialising it, because a zero there would end every block immediately.

**Done, in the fork.** The constant is a global the slice runner writes, and the interpreter's own
iteration limit honours the same bound. What remains is not this: with the bound in place a slice
still runs to some five million instructions now and then, at a film and at a load, and the shape of
guest code that does it has not been found -- every loop tried in a probe stops where it is told.

### B8. The per-call cost of a trap, paid fifteen hundred times a frame

Measured with the browser's profiler on a real title in a match: a draw call costs 46 µs of host
time (10 µs in a quiet scene), a texture bind 39 µs, and every trap pays 8-10 µs before its handler
runs. Fifteen hundred host calls a frame, so the dispatch alone is a tenth of a 100 ms frame.
Where it goes: the arguments and the caller's registers read out of guest memory; a record
`{name, args, from, result, error}` allocated per call for the detail ring; `performance.now()`
twice per call for the phase profiler; the last-error read; the interface pointer resolved to its
object; and the seam's `sync`, which reads six words of shadow state back and compares them.

The candidates: a detail ring of typed arrays (ids and arguments) rather than objects; a phase clock
taken every Nth call or only around phases known to be expensive; `sync` gated by a version counter
the shadow state bumps rather than a read on every call. Expected: four to six percent of a frame in
a match, and the garbage collector's share (four percent) with it. The 39 µs of a texture bind is
not explained by its handler, which does nothing; that path wants its own profile before anything
is changed.

### B9. The draw's preparation, recomputed for every draw

`prepare()` works the whole draw out from scratch each time: the vertex format decoded, the cascade
of texture stages, an array of stage bindings, the samplers, the lighting, the pipeline key, and the
uniform block -- two 4x4 products and a copy of some two hundred floats -- with objects and arrays
made along the way. Fifteen to twenty microseconds a draw. The program keeps a state cache of its
own, so consecutive draws mostly share their state and differ in the world transform alone.

The candidate: generation counters bumped by every state, texture, transform, material and light
call, and the prepared cascade, bindings and pipeline key reused while none changed since the last
draw; the uniform block rebuilt only when a transform, the material or the lights changed, and the
view-by-projection product cached across the frame so a draw costs one multiply. Expected: five to
seven percent of a frame in a match.

### B10. A command ring in guest memory, drained once a frame

The largest of the three. The state and draw calls -- texture, render state, stage state, material,
transform, indexed draw -- need no answer from the host but `D3D_OK`, and are the bulk of the
fifteen hundred traps a frame. As guest-side stubs that append a command to a ring in guest memory
and answer at once, they stop being traps at all; the host drains the ring in one trap at `Present`
or whenever a call arrives that does need an answer -- a lock, a creation, a getter. This is how a
real driver works, and the seam's shadow state in guest memory is part of the way there.

What it costs: a call that would have failed answers success and its failure is reported when the
ring is drained, as a divergence rather than as a return code; every draw is still prepared on the
host, but in one loop over the ring rather than through the dispatcher. Expected: ten to twelve
percent of a frame in a match. Together with B8 and B9 this is the 25 percent of a battle frame that
the draw path takes today brought to eight or ten, which is a fifth more frames.

### B11. What the generated code pays per instruction, and where to stop paying

The emulator retires about 184 million instructions a second on this machine, some fifteen to
twenty times slower than the processor the program was written for. Measured shares in a match:
generated code 48% of the page's time, the emulator's own runtime 11%, the x87 wrappers 8.5%.
Every candidate below is generic -- none knows a program -- and each is a patch to our fork.

- **Flat memory when paging is off.** Every load and store goes through the translation cache:
  a lookup, three flag tests and an address rewrite, some ten operations around one. The guest
  we build never turns paging on and its segments are flat, so a load could be a range check and
  one wasm load, with the has-code bitmap consulted on writes alone. The broadest win there is,
  because every instruction class touches memory.
- **Chaining modules and predicting returns.** Generated code leaves its module every forty
  instructions or so (three to four million exits a second) and comes back through the runtime:
  a lookup, a table call, the registers spilled and reloaded. Two remedies from the literature:
  an exit whose target is compiled jumps to that module directly, and a `ret` compares the popped
  address with the site that called before it asks the runtime. The dispatch cost (some six to
  eight percent) and much of the register traffic go with them.
- **Flags that are never read are never computed.** Every arithmetic instruction stores its
  operands and result for the lazy flags -- three stores -- and the flags are wanted by perhaps
  one instruction in ten. A liveness pass over a block, and the lazy-flag state held in locals
  rather than memory, drop most of that. Integer code, which is most code, gains.
- **x87, MMX and SSE inline.** The arithmetic now takes the double shortcut, but each operation is
  still a call with a ten-byte struct passed through memory and the stack pointer and empty bits
  checked in Rust; MMX and SSE go through calls as well. Emitted inline -- the eight FPU registers
  as doubles, MMX and SSE on wasm's own 64- and 128-bit lanes -- the 8.5% of wrappers goes, and
  the vertex code every 3D title of the era runs gets the same.
- **Measure the mix first.** The profiler build of the emulator counts retired instructions by
  opcode and exits by cause. Built once by the fork's workflow as a second artifact, it says which
  of the four above pays off first for a given title, and turns the rest of this list from an
  argument into a measurement.

## A redistributable runtime is ours to reimplement, whoever ships the file

The rule this project started with was "only Windows system libraries are reimplemented; anything
that arrives with a program is loaded and executed as real x86". That rule exists to stop a per-title
crutch, and for a program's own code it is exactly right: its logic is the thing being run, and
replacing it would be replacing the program.

Measurement moved the line. Profiling one title at its menu, by module and weighted by retired
instructions, over a window in steady state:

| module | share of the machine |
|---|---|
| the program's own code | 53.6% |
| an MP3 decoder shipped beside it | 27.3% |
| the program's archive library | 10.1% |
| the sound runtime it links against | 4.9% |
| our own thunks | **0.2%** |

A third of the machine goes to decoding audio in emulated x86, and the stream is supplied at about
60% of real time as a result — heard as a break in the music, and not fixable anywhere in the sound
path, which measured clean at every stage. Our own layer is 0.2%, so there is nothing to win by
optimising what we wrote.

**The decision: a library is ours to reimplement when it is a redistributable runtime with a stable
published API, regardless of who shipped the copy.** A system library is one case of that. A
middleware runtime — a sound engine, a video codec, an archive library that ships in hundreds of
titles — is another, and reimplementing one is the same act as reimplementing DirectSound: it helps
every title on that path, which is the test rule 4 actually cares about. What stays off-limits is
unchanged: the program's own code, and anything identified by which title shipped it.

Two things make this safe rather than a licence to substitute anything inconvenient. A decoder is a
pure function — bytes in, samples or frames out, no state of the program's own — so a host
implementation cannot diverge in behaviour the way a stateful subsystem can. And this project already
crossed the line deliberately for video: the `media` layer decodes a cinematic natively and says so
in its own contract, including the case of "a library a program linked against directly".

The obligation that comes with it: a substituted runtime reports its divergence the way every other
one does, and it is chosen for what the target titles actually need rather than built speculatively.

## Uniform blocks live in one ring and a bind group names nothing per draw

Measured on a title's main menu through the launcher, before the change: about 140 bind groups
created per frame and none reused over a run of 100,000 draws, because each draw's uniform block
had a buffer of its own and a bind group is keyed on the buffers it names. Every group also costs
the device a descriptor allocation, which is the kind of churn a driver can fall behind on.

**The decision: uniform blocks go into one ring buffer and are bound at a dynamic offset.** A bind
group then names a layout, a texture view, a sampler and the ring -- nothing that changes per
draw -- so the cache of groups lives for the backend's life instead of one pass. Measured after the
change on the same menu: 71 groups created in total against 890,000 reuses. The ring wraps rather
than growing; a write into it is ordered by the queue after every submit before it, so a wrap can
only overwrite blocks whose frames have finished. A block larger than the ring gets a larger ring.

What this did not change: a sky that alternates between its texture and its corner texel on the
machine this was measured on. That one was traced elsewhere (below), and the ring stays for what it
is -- a removal of per-draw descriptor churn.

## Sampler state is applied in the shader; every draw samples through one hardware sampler

Traced on the machine this project develops on -- a virtual machine whose adapter is "Parallels
Display Adapter (WDDM)", reached through Dawn's D3D12 backend, with Chrome's other adapters not
available -- with a title's main-menu sky that alternated between its cloud texture and a flat
wash of its corner texel for seconds at a time.

What was established, each step on the real title and then on a page of a few hundred lines
against the engine's own backend:

- The flat state is, to the unit at seven probe points, the dome sampled with a clamp-to-edge
  point sampler; the good state is its own repeat sampler.
- Every input the draw has was read back or replaced: vertices, indices, the uniform block, the
  pipeline, the shader module, the texture view, the sampler. A view of the texture's smallest
  level took effect; no sampler ever did.
- Eight draws of the dome in one pass, samplers alternating, all came out with one sampler; a
  pass per draw changed nothing; samplers in a bind group of their own changed only which sampler
  it was. Which one is in force switches every fifty-one frames whatever the frame rate.

So on this device the sampler a draw binds is not the sampler it samples with, and no arrangement
of bind groups makes it so. **The decision: one hardware sampler for all draws -- linear, repeating,
whole chain -- and the Direct3D sampler state carried in the uniform block and applied by the
shader.** Address modes fold or hold the coordinate and keep it inside the outermost texel centres
so the repeating sampler cannot blend across an edge; point filtering snaps to texel centres; the
mip mode chooses the level explicitly from derivatives taken before any of that. Nothing in the
picture then depends on which sampler the device believes is bound. The cost is a few operations
per sample and three words in the block; what it does not cover is anisotropy and border colour,
neither of which the target titles were seen to use.

An engine that binds one sampler for every draw does not show the symptom on this machine; a
comparison of how a frame is built (submit shape, uniform rings, bind-group keys and binding
order, buffer sizes on binding, upload counts) found no other difference that changed the outcome
when tried here.

## The MPEG decoder a sound middleware loads is hosted, as the provider it expects

A sound middleware of the late nineties decodes compressed music through a provider it loads
itself: it scans a directory beside the program for `*.asi` files, loads each with LoadLibrary
and expects the DllMain to register an "ASI codec" and an "ASI stream" interface through the
middleware's own RIB entry points; it then calls the registered functions directly. Run as guest
code, the decoder took a fifth of the machine's retired instructions on a title's main menu, and
the music was supplied in bursts.

**The decision: host the provider.** The audio layer offers a synthesised `Mp3dec.asi` whose
DllMain registers the two tables with the same entry types, attribute tokens and data subtypes
the redistributable decoder registers, and whose stream functions read compressed bytes through
the middleware's fetch callback and decode on the host through WebCodecs. This is the middle of
three options: stubbing the whole middleware replaces a library the program ships and runs
correctly, and patching the emulator for one decoder's hot loop is a per-title fix by another
name.

Three things had to be learned from the running middleware rather than from documentation: the
size it gives at open is its own read buffer (4096 bytes for a stream of megabytes), so the
stream is read until a read answers nothing; every read continues from where the last stopped,
because a read that names an offset outside the window the middleware holds was measured making
it copy a negative count (hundreds of megabytes past the end of guest memory, seen as the page
hanging); and after a seek the middleware serves again from the byte named, so what is already
held is dropped on arrival rather than appended. Two generic pieces of the process came with it: a synthesised module may have
an entry point, run on the thread that first asks for the module by LoadLibrary, and a module is
known by its file name however it was asked for. Measured on the title through the launcher, sixty
seconds at the main menu, hosted against shipped: starved frames at the device 0 against 9091
(189 ms of invented silence, the holes heard as crackle), sound delivered 60.0 s against 59.8 s
in 60 s of wall clock, engine frames 2007 against 1232, and the shipped decoder no longer appears
in the guest's instruction share.


## The guest's clock runs for the whole turn, and a sound buffer is read to its write cursor

Measured on the title at its main menu through the launcher, with the mixer's own counters:
the device found the ring empty in about 330 of every 1,880 blocks it asked for -- a tenth of
the sound was silence, heard as a constant crackle -- while the ring never held more than a
few hundred frames. Two causes, one on each side of the ring.

The guest's clock was credited only for the slices the guest ran. Everything between two
slices -- the yield to the browser, the mix, the cursors, the polls -- passed on the wall and
not on the clock, so the clock ran slow by the loop's own share, a tenth at a menu. A
DirectSound buffer's play cursor is paced by that clock and the device that plays it by the
wall, so the cursor fell behind the device by the same tenth, and the device filled the
difference with silence. **The decision: credit the clock with all the wall time between two
credits**, capped at a quarter of a second so that a stall -- a fetch, a hidden tab, a
debugger -- is not handed to the program as time it spent; a wait the program asked for is
still credited in full. A real clock runs while the machine is in a syscall.

A buffer was also read out only as far as its play cursor, so the ring held what the last turn
produced and nothing more, and any turn longer than one device block was a click. **The read
now runs to the write cursor**: the span between the two is what a real device has already
fetched, and fetching it here is what the ring holds against a long turn. Stopping pulls the
read point back to the cursor, so a resume reads from where the program sees playback, at the
cost of hearing the lead once more.

After both, forty seconds at the same menu: no starved block once the music had started (the
count stayed at what the start-up had cost), and the ring held 50-100 ms throughout. Whether
that is the whole of what was heard is for a listener to say; what was measured is gone.

## A poll never queues the thread

A zero-timeout wait was answered by queuing the thread on the object with a deadline of now
and reporting the timeout at once. The answer was right and the queue entry outlived it: the
thread went on to wait on something else, and when the polled object was later signalled the
stale entry handed it to the thread, which woke out of its real wait with an answer naming the
wrong object. Measured on the title: its sound loader thread polled a read-completion event on
every pass of its loop and then waited on its own pair of events, quit first; the completion
came, the thread was woken with index 0, read that as its quit signal and exited, and every
sound effect after that was requested and never loaded. **The decision: a poll is its own
primitive** -- it takes what is ready and never queues -- rather than a wait with no time in
it. After the change the middleware receives and starts every click sample (measured through
the import watch); what it sounds like is for a listener to say.

The instrument that found it is generic and stays: the kernel journals what a parked thread
is resumed with and from which wait (`kernel` category), because a call logged as parked has
no other record of its answer, and a watch stub now saves every register before it traps, so
a watch in front of a fastcall or thiscall routine no longer hands it the trap port as an
argument -- which had produced a wholly wrong account of why the sound tables were missing.

## A session is the files and the registry, kept on this machine, laid onto the mounted volume

A program's settings and its name live in the registry as often as in a file, and the session
carried only the files; the launcher, for its part, gave a bundle no storage at all. Measured on
the title: its options and its profile name are registry values, its profile is a file under
its own directory, and nothing of either survived a restart. **The decision: the hive announces
its changes and travels inside the session** as one more packed entry under a name no path can
have, and the launcher keeps a bundle's session in the origin's private file system, named by
the bundle, with local storage as the fallback for a browser without one.

The second half was an order of operations. The session's files were laid onto the volume
before the bundle was mounted, and the mount puts a fresh writable layer over the bundle: the
profile was saved faithfully, restored faithfully, and replaced by an empty layer before the
program's first instruction -- and a program that found its profile file gone cleared the
registry value that named it, so the registry half looked lost too. The files now go on after
the mount, pinned by an integration test that mounts a bundle over a session.

## The library carries its own emulator and ships built small

A caller starting a bundle from code had to name the emulator's module and fetch its binary
first. Both are the package's own and sit beside the built module, so `createApp` finds them
there unless a part is named to override it; the build tells the module where through
`import.meta.env`, and the source tree's prebuilt directory is the fallback of the same line.
The package is built minified and without a source map -- the source is in the repository for
whoever has it -- and the audio worklet ships as its own export, because an audio thread loads
it by URL rather than importing it.

## One vtable per interface, as a compiled program has it

Every published COM object got a table of stubs of its own -- a trap slot per method per
object -- and the stubs come out of a table of sixteen thousand. Measured on the title in a
match: 1,216 objects had taken 14,984 slots, every later publish was refused, the seam
reported each refused texture as out of video memory, and the program did what a program does
with a texture it cannot make: it made it again on the next frame, without a picture (white),
until the guest heap was full and its file layer reported the machine out of memory. The same
thing had shown in the menu as the same water texture created thirty times over.

**The decision: a shared table per interface description**, keyed by the method list's
identity, with the object found from the interface pointer the call arrived through -- which
is the first argument of every COM method, and the whole reason the pointer exists. An object
costs two words: the table pointer and its state word, given back when its last reference
goes. The three publishers (drawing, sound, input) hand every object of an interface the same
method list, and a method is reached through the adapter the call arrived on. Measured after:
5,079 objects published on 210 stubs, 1,606 slots in use, no refusal, textures stable at
about 1,600, heap steady at 168 MB, the match running with its terrain, units and panels
drawn.

## A picture codec a program ships is hosted, as the library it links

The title decodes every JPEG-compressed texture through the Intel JPEG Library it ships,
and that library's inner loops -- Huffman, inverse transform, colour planes -- are pure
arithmetic that the emulated path runs at a small fraction of native speed. Measured in a
match: 5.7% of the guest's time was in that library, on top of what the title's own code
costs, and each texture arriving mid-fight was a decode on the frame's critical path.

**The decision: host the library by its export contract**, the same rule as the MPEG
provider before it. `ijl15.dll` is a redistributable, imported by ordinal, and its whole
public surface is six functions over one structure; the media layer now publishes those
functions and a baseline JPEG decoder of its own answers them, so any program shipping the
library gets the host path without knowing it. Two things about that structure were learned
from the program's own memory rather than from a header: the DIB pointer is its second word
and the channel count precedes the colour space on both the DIB and the JPEG side; and the
rows are delivered in the picture's order for a positive height -- a texture atlas delivered
upside down hands the program the wrong cells, which showed as black tiles with the edge
variations of their neighbours. The decoder is checked byte-for-byte against the shipped
textures' own mips decoded by a second implementation (at most one level apart), and against
its own encoder for the layouts a texture library uses. Measured after: the library gone from
the guest's share, 1,877 decodes of a map load costing 1.9 s of host time in total, terrain
and panels correct.

## A trap pays for its record and its clock only when someone is reading them

**The cause.** The browser's profiler on a title in a match, thirty-two thousand host calls a
second: reading the arguments asked the region table for each word (2.3% of the page's time in
`assert`, a linear scan of the regions); a record and an argument array were allocated per call
for the detail ring (the garbage collector at 1.1%); and each call took two clock readings for a
phase of its own besides the two the crossing takes (1.2% in `performance.now`). Where the
launcher's stored settings still said to keep the text an argument pointed at, a fourth cost was
the largest: 2.6% reading up to six strings a byte at a time.

**The change.** The byte and word readers remember the region the last read fell in, by its span
and the table's version, and ask the table only on a miss; a register or protection change bumps
the version (B8). The detail ring's records and argument arrays are made once and written over,
and a reader of the ring gets copies. The per-call phase is on only when a measurement asks
(`profileCalls`, the launcher's `?profile=calls`); the crossing is always timed, so the host's
share of a frame is always known.

**The measurement.** Browser profiler on the saved battle, before and after: the region check
behind the arguments 2.34 to 0.08%, the garbage collector 1.06 to 0.56%, the clock 2.7 to 1.4%
(what is left is the crossing), the host's own code 22.8 to 19.9% of the page. Menu, settled,
with the argument text off: host 5.6 to 5.3 ms of a 16.0 ms frame. The saved battle ran at
25.5 ms a frame (guest 17.7, host 7.9), 43 fps on the canvas, in a scene the earlier runs did
not hold still for -- the shares are the comparison, not the frame.

**The tests.** The dispatcher's phase test expects only the crossing by default and all four
phases when asked; a test hands a record out of the ring, makes another call, and checks the
copy is untouched; a memory test reads bytes to the end of a region, past it, out of a region
added later, and out of one re-protected after being remembered.

## A view of a file waits for its bytes, and a refused allocation says what it refused

**The cause.** A title loading a saved match died one time in eight with its own critical
error, "not enough memory resources", its crash report naming its archive reader; the heap had
three quarters of a gigabyte free. Two of this engine's calls answer with that code for reasons
that are not memory: `MapViewOfFile` refused a file whose bytes had not arrived yet (a volume
backed by a bundle answers a read with a promise, and the map had nowhere to wait), and a refused
`VirtualAlloc` or `HeapAlloc` said nothing about what was asked or what was left.

**The change.** A view of a file whose bytes are not resident parks the caller until they are,
exactly as `ReadFile` does, and answers on that thread; the failed arrival sets the caller's own
error. A refused allocation is reported as a divergence with the size asked and the arena's
largest free span, free total and use. The mapping calls count views mapped, waited for and
failed, in the win32 diagnostics.

**The measurement.** On this title the mapping change is not the cause: a load of the match and
the save maps no file at all (views 0). The refused-allocation report is what the next crash is
caught with; the load loop polls the log for it.

A second silent path was `VirtualAlloc` committing inside a reservation: the reservation was
granted page-rounded where Windows grants whole 64 KB granules, so a program committing up to the
granule's end was refused as if it had left its reservation, with a code and no report; and a
commit named by an unaligned address was measured from that address rather than from its page.
Reservations are granules now, a commit covers the pages its bytes lie in, and a refused commit
is reported with the reservation it fell outside of.

**The tests.** A map whose bytes arrive later answers when they do, with the bytes and no error;
one whose bytes never come fails on the thread that asked, with `ERROR_IO_DEVICE`; a refused heap
or virtual allocation reports its size against the arena's state; a reservation's last granule
page and an unaligned commit are accepted, a commit past the granule is refused and reported.

## Without paging a block runs to its page's boundary and across it

**The cause.** The profiler build, on a title in a match, after the exits above were dealt with:
half of what remained ended at a page's end. The compiler stopped a block short of the last
fifteen bytes of its page, because an instruction there might reach into a page that is not
mapped; the instructions in those bytes ran in the interpreter after an exit and before an entry
back, at every crossing, and an entry point in those bytes was refused outright.

**The change.** With paging off the next page is always there (fork `2838382a`, `18c37ee5`): a
block runs to the boundary; a plain instruction across it is kept and the block goes on into the
next page by a jump of a page, the way a jump to another page does, so the page joins the module
and a write to the instruction's tail bytes throws the module away; a page reached only by
falling through joins without an entry point of its own. A jump, a boundary or an STI across the
page, or a page the module has no room for, is still left to the interpreter with the block
stopping short of it. Configuration index 10.

**The measurement.** Menu, settled: entries into generated code 173k to 70k a second,
instructions interpreted 490k to 160k a second (9k to 2k a frame); frame 14.8 ms, guest 9.3 ms
against 9.6 to 9.9 in the runs before. Saved battle: entries 245k to 83k a second, interpreted
33k to 4k a frame, guest speed 237 M instructions a second; a heavy moment of the same load loop
ran at 240 M/s with 81k entries where the build before had 230k.

**The tests.** A loop laid across the end of a page with one instruction straddling the boundary
runs compiled with the knob off and on: the same sum and the same straddled result; stopping
short, generated code was entered once an iteration, running across, once a slice, and warm the
interpreter ran nothing.

## The device block's six counters are read in place

**The cause.** Browser profiler on a title's menu: the seam's `sync`, run before every device
call to see whether the guest wrote to the block, was 1.4 to 2.2% of the page, and its unchanged
path -- the common one -- made two views of the block and an array to compare six counters.

**The change.** With a dword reader on the memory service the six counters are read in place and
compared one by one; nothing is allocated on the path that finds nothing changed (`shadow.js`).

**The measurement.** Menu, settled, before and after: `sync` 1.4 to 1.7% of the page in runs
whose spread is that wide; no difference the profiler can see, the allocations gone from the
path all the same.

**The tests.** A device block that changed nothing is checked with six reads and no copy; a
change is still read out of the block and reaches the device.

## GetLastError, SetLastError and a TLS read are guest code

**The cause.** The bridge's own count on a title loading a match: `TlsGetValue`, `GetLastError`,
`FlsGetValue` and `SetLastError` were four calls in five the program made into the host -- some
three and a half thousand a second of the four thousand -- and each is a crossing (an exit from
generated code, the dispatcher, a handler that reads or writes one word, an entry back) for work
that is one instruction.

**The change.** The thread's last error lives in its block, at the offset the compiler reads it
from (`TEB+0x34`), so the host's writes and the guest's reads agree; the three exports are guest
code placed once (`process.js`: `getLastErrorCode`, `setLastErrorCode`, `tlsGetValueCode`), the
way the critical-section fast paths already were. `TlsGetValue` reads the slot out of the block's
array through FS, clears the error as the host did, and goes to the host's own handler for an
index past the array; `FlsGetValue` is the same code. Freeing a slot clears it in every thread's
block, since the guest-side read has no generation to compare. A slot nobody allocated reads as
whatever it holds, as it does on Windows; the host path still refuses it.

**The measurement.** Menu, settled: entries into generated code 173k a second where the build
before had 230k -- the crossings that are gone. Frame 15.3 ms against 14.4 to 14.8 in the runs
before, within their spread; the menu makes few of these calls, the loading screen and a match
make most.

**The tests.** A thread with a block keeps its last error in the block and a thread without one
keeps its own; freeing a slot zeroes it in the block of every thread; the guest code's bytes are
checked where they carry an address: the jump the slow path takes lands on the trap, and the
fast path returns just before it.

## An instruction left to the interpreter no longer ends the block

**The cause.** The profiler build, on a title in a match, after the string instructions were
kept inside their blocks: the instructions the compiler leaves to the interpreter's helper --
`fnstsw m16`, `ldmxcsr`, `stmxcsr`, every non-custom form with a memory operand -- were a seventh
of what remained of the exits. The helper may raise a fault into the guest, so the emulator ended
the block after each with an exit and an entry back.

**The change.** Such a block is of a new kind (fork `5b214566`): the previous eip is set on the
instruction and eip after it, as for an exit; after the helper the block goes on to its
continuation when eip is still there, and leaves only when a fault has moved it -- the same
check the string instructions make. The SSE control-word moves, which the table ended blocks at
by hand, are compiled this way too. An instruction marked as a boundary by hand (a control
register write, a trap, a segment load) still ends its block.

**The measurement.** Menu, settled: entries into generated code 230k to 188k a second; frame
14.4 to 14.8 ms, within the run-to-run spread. The battle run of this build hung at the loading
screen (the same picture as the one hang before: main spinning, every other thread waiting on an
event), and the page died before its state could be read; a load loop with the state capture
runs on.

**The tests.** A loop with an x87 compare, a status-word store, and the control word read,
changed and written back runs compiled: the stored status and control words are right, and
generated code was entered fewer than once in ten iterations rather than three times each.

### B12. The audio layer on a thread of its own: the seam, and why it is not crossed yet

The engine now runs in a worker and the output already runs on the audio thread (the worklet
reading the ring). What is left on the engine's thread is the mixer's pump -- every open track
resampled and mixed into the ring once a turn -- the DirectSound, waveOut and MSS buffer reads out
of guest memory that feed it, and the hosted MPEG provider's WebCodecs callbacks. The user's
question was whether those should go to a second worker.

**What a split would have to look like.** The guest's memory is the emulator's own wasm memory
(`exports.memory` of the vendored build), and that build is not compiled with shared memory, so a
second worker cannot read a sound buffer where it lies. The seam is therefore not a shared view of
guest RAM but the buffer *writes*: an Unlock, a waveOutWrite, a stream feed copies the bytes the
program wrote into a block the audio worker owns, and the cursors and track state travel the other
way through a small shared control block (Int32 words for play/write positions and flags, read with
`Atomics`), so a `GetCurrentPosition` on the engine thread is a load rather than a round trip. The
ring stays where the mixer is; the MPEG provider and its decoder live with the mixer so its output
callbacks never queue behind a turn. The audio layer's boundaries do not move: it still requires
win32, bridge and memory through the module contract, and placing it elsewhere is a host decision
(`src/host/`), not a new import.

**Why it stays where it is, for now.** Measured on the main menu of a real title through the
harness, 60 000 scheduler turns, engine in a worker: the pump's self time was 921 ms of a 186 s
run, 0.5% of wall and 11 us a turn; on the page's thread the same run put it at 1196 ms of 209 s,
0.6%. A device that draws less than one percent of the thread is not what to move first, and the
decoder callbacks that were held behind the page's own work are, in the worker, held only behind
turns the loop yields between when something is pending. The seam above is what to build when a
measurement says the pump has become material -- many tracks, a resampler on every one -- and not
before.

## An unlocked buffer is read through a window, and the crossing is timed one call in eight

**The cause.** Browser profiler on the saved battle, after the trap's own costs were cut: the
largest host items left were the copy an unlock makes of a buffer's bytes before copying them
again into the staging buffer (1.9% of the page: a program refills its vertex buffers every
draw) and the two clock readings that time every crossing (1.7%: thirty-two thousand calls a
second, and `performance.now` is not free).

**The change.** The renderer reads an unlocked buffer through a window on guest memory and
copies once, into the staging buffer (B9's first piece). The dispatcher times one crossing in
eight and passes the eight as the phase's weight, so the profiler's rows and the frame's host
share still count and time every crossing, from a sample; the per-call phases a measurement asks
for are unchanged.

**The measurement.** Saved battle: the host's share of the page 22.7 to 20.4%, the copy 1.9 to
0.3%, the clock out of the top of the host list; host time in a settled frame 6.5 to 6.1 ms.
Menu: unchanged at 4.8 ms of host time.

**The tests.** A buffer locked, written and unlocked is read through the window, the bytes
reach the GPU; sixteen crossings open two timed phases, the second call phase closes with a
weight of eight; a weighted phase counts and times as all it stands for and relieves the phase
around it of the same.

## A read compiled while paging is off checks a range instead of the TLB

**The cause.** The profiler build, on a title in a match: a third of every instruction retired
has a memory operand, and a push or pop is a memory access too. Every read went through the
TLB path -- the page's entry loaded, masked and compared, the offset checked against the page's
end, the physical page folded into the address -- a dependent load and a dozen operations before
the read itself. The machine runs without paging, so the linear address already is the physical
one.

**The change.** A read compiled while paging is off checks one unsigned range -- plain RAM,
above the VGA window and below the end of memory -- and loads from the linear address plus the
RAM's base (fork `2602314c`); anything outside goes to the slow path the TLB path has, which also
raises the fault. Code compiled this way is thrown away when paging is switched on or off.
Writes keep the TLB path: they need the page's has-code bit, which is in the entry, so the load
would stay. Configuration index 9.

**The measurement.** Menu, settled: frame 16.0 to 14.0 ms (guest 10.6 to 9.2), 63 to 69 fps,
guest speed 209 to 218 M instructions a second. Saved battle: guest speed 221 to 248 M/s, the
generated code's share of the page 55.7 to 53.8%, in a scene the runs did not hold still for.

**The tests.** A loop reads a byte, a word, a dword, a double and sixteen bytes from plain RAM,
the last dword of RAM, a dword straddling its end, one in the VGA window and one below the range,
compiled with the check off and on: every value the same, the plain ones checked outright.

## A string instruction runs to its end inside the block

**The cause.** The profiler build, on a title in a match: `rep movs` was three exits from
generated code in ten (a sixth, once a prefix and its opcode are counted as one), and in the menu
a fifth. The helper that runs a repeated string instruction does a page's worth at a time and
puts eip back on the instruction when there is more to do, so the emulator ended the block at
every one: a copy of a few pages cost an exit, an interpreted chunk and an entry back per page.

**The change.** The compiled form sets eip and the previous eip as the interpreter would, runs
the helper, and runs it again while eip is back on the instruction; it leaves the block only
when a fault has taken eip somewhere else (fork `1211df9b`, `38d0d5d6`). Every repeated form,
and the compares and scans that used to end the block even unrepeated, is compiled this way.

**The measurement.** Menu, settled: entries into generated code 401k to 206k a second, the
runtime's share of the page 8.2 to 7.5%; frame 15.3 to 16.0 ms, within the run-to-run spread.
Saved battle: entries 347k to 254k a second, runtime 7.2 to 6.8%, frame 23.0 to 23.1 ms (guest
16.6 to 16.1) in scenes the runs did not hold still for.

**The tests.** A loop copies three pages and a bit with `rep movsd`, fills as much with
`rep stosb`, measures a string with `repne scasb` and compares two buffers with `repe cmpsb`,
compiled: the copy is the source byte for byte, the fill covers every byte, the scan and the
compares stop where they should, and generated code was entered fewer than once in ten
iterations rather than five times an iteration.

## fwait is compiled instead of ending the block

**The cause.** The profiler build, on a title's menu: a quarter of all exits from generated code
were `fwait`, and in the saved battle an eighth. The emulator left it a block boundary, because
it can raise #NM; a compiler puts one before every `fnstsw`, so each status-word read -- every
x87 compare a program branches on -- cost an exit to the runtime, an interpreted step and an
entry back.

**The change.** `fwait` is compiled (fork `59460919`): it raises #NM only when CR0's MP and TS
bits are both set, and otherwise waits for nothing, so the generated code checks the two bits
and goes on through the same fault exit every x87 instruction already has.

**The measurement.** Menu, settled: entries into generated code 602k to 401k a second, frame
15.9 to 15.3 ms (guest 10.6 to 10.3), 63 to 65 fps. Saved battle: entries 431k to 347k a second,
guest speed 208 to 226 M instructions a second, in a scene the runs did not hold still for.

**The tests.** The x87 semantics test, whose status-word reads go through `fwait`, runs through
the compiled path unchanged; the profiler build's counters test says what ran compiled.

## Flags nobody reads can go unrecorded, and here it made no difference

**The cause.** Every add, subtract, and, or and xor generated code compiles records its operands
for the lazy flags -- three stores -- and an increment first materialises the carry it keeps.
Where the instructions that follow overwrite every flag before any reads them, the recording is
work nobody uses.

**The change.** Before compiling an instruction that writes flags, the compiler decodes what
follows it within the block: one that overwrites all six (the eight arithmetic instructions,
test, neg) proves the flags dead; a move, a push or pop, lea, an x87 instruction leaves them and
the walk goes on; anything else, or the block's end, keeps them live (fork `71c38215`). Dead, the
arithmetic keeps only the operation, an increment only the step, a compare or test nothing at all.
The one observer traded away is a fault frame between: it holds the flags of an earlier
instruction, which a program's own exception filter could see. Configuration index 8; counter 11
says how many instructions were compiled that way.

**The measurement.** Menu, settled, the same build with the knob off and on: frame 15.9 and 15.9
ms, guest 10.6 and 10.6, guest speed 210 and 209 M instructions a second; the generated code's
share of the page 47.1 and 45.4%. Saved battle: the generated code 55.5 to 55.6%. On the menu
sixty-eight thousand instructions were compiled without their flags, for no time anyone could
measure -- the stores were cheap, or the engine was already dropping them. Off by default
(`137947a4`), kept behind the knob for a title whose frame says otherwise.

**The tests.** A loop mixes arithmetic whose flags are dead (an add before a store and a
subtract, an increment before an exclusive-or, an and before an or) with arithmetic whose flags
are read (a jump on carry past a move, a conditional set, a subtract with borrow, the loop's own
jump), compiled with the knob off and on: every stored value the same, the flag-dependent ones
checked outright, and the counter says four were left out.

## One lookup says whether an exit stays, chains or returns

**The cause.** With chaining on, an indirect exit from generated code -- a `ret`, a `jmp [r]` --
looked its page up twice: once to see whether the instruction pointer was still in the module,
once more to see which other module held it. On a title in a match the two were 3.9% of the
page's time (2.4 in the chain lookup, 1.5 in the in-page one); in the menu 2.4%.

**The change.** The chain lookup takes the module's own table slot and answers all three at once
(fork `a42a6804`): the dispatcher state when the pointer is in this module, the slot and state of
another compiled module, or -1 for the runtime. A direct exit that lands back in its own module
goes through the dispatcher rather than a tail call into itself. The registers are spilled and the
instruction count folded only on the way out to another module; the count the module has not yet
folded is passed in, so the slice's budget is judged on the same number as before.

**The measurement.** Browser profiler on the saved battle: the two lookups 3.87% to 2.82% of the
page, the runtime's share 8.2 to 6.9%; menu 2.42 to 2.32%, frame 16.0 to 15.5 ms at 63 to 65 fps.
The battle frame 25.5 to 23.1 ms (guest 17.7 to 16.6) in scenes the runs did not hold still for.

**The tests.** A loop calling four routines in its own page runs compiled with chaining off and
on: the same sum, nothing chained -- every return stays in the module -- and no slice of a
thousand retiring more than a block past that. The cross-page chaining test from before still
chains every call and return.

## Generated code goes on into the next module by a tail call

**The cause.** The profiler build of the emulator, on a title in a match: three exits from
generated code in four were a `call` or a `ret` crossing a page (33.7 / 23.7 / 16.1 / 5.5% for
`call`, `ret n`, `ret`, `call [r]`), 2.4 million exits a second, each a return to the runtime, a
lookup, a table call and the registers spilled and reloaded. The runtime around generated code
was 11% of the page's time, its dispatch 4.3%.

**The change.** An exit whose address another compiled module holds tail-calls that module
(`jit_chain_target`, fork `f1901d93`): the direct jump out, the conditional one, and the return or
indirect jump the module cannot resolve itself. The slice keeps its word -- a chain is refused
once the slice's budget is spent, and the loop bound the next module reads is what is left of
the slice. On when the engine accepts tail calls (configuration index 6); three counters say how
often a chain was taken, missed, or refused.

**The measurement.** Menu, settled: entries into generated code 2.25 M/s to 528 k/s, frame
19.0 to 18.3 ms (guest 13.6 to 12.6), 48 to 55 fps. Saved battle, first thirty seconds: entries
4.2 M/s to 406 k/s, guest speed 184 to 199 M instructions a second, frame 66.7 to 59.4 ms (guest
48.6 to 45.3), 16.2 to 17.7 fps. Browser profiler: the runtime's share 11.3 to 7.5%, dispatch
gone from the top; what remains is the lookup itself (`jit_chain_target` 2.1%, the in-page entry
lookup 1.4%). In the emulator alone, in node, the same program ran no faster chained -- the
gain is in what the browser's engine does with a tail call, and the browser is where it counts.

**The tests.** An integration test runs a loop calling four routines four pages apart, with the
knob off and on: the same sum, the calls and returns chained (790 thousand chains for 300
thousand iterations), runtime entries cut sevenfold, and no slice of a thousand retiring more
than a block past that.

## x87 arithmetic, loads and stores emitted inline on tagged doubles

**The cause.** With the arithmetic itself already cheap (the double shortcut), the x87 wrappers
-- one call per operation, an 80-bit value passed through memory, the stack's empty bits checked
in the runtime -- were 8.5% of the page's time in a match, and x87 is 12–17% of every instruction
the title retires (`fld m32` 3.4%, `fstp m32` 2.6%, `fmul` 1.1%, `faddp` 0.8%).

**The change.** Generated code keeps a register it writes as a double -- the bits in the mantissa
word, a tag in the exponent word (fork `c99b50e8`). An add, subtract, multiply or divide whose
operands carry the tag is one double operation; `fld m32`/`m64` push a tagged register; `fst` and
`fstp` to memory narrow and write it; `fld st(i)` copies a tagged one. Everything else goes to the
helper it always went to, and every helper turns a tagged register back into the 80-bit format
before reading it (`fpu_canonical`), so the runtime never sees the tag. Given up on the inline
path: the stack-fault and status-word bookkeeping. Configuration index 7; off, every operation is
the call it was.

**The measurement.** Menu, settled: frame 18.3 to 16.0 ms (guest 12.6 to 10.6), guest speed 179
to 214 M instructions a second, 55 to 62 fps. Browser profiler on the saved battle: the x87 share
7.4 to 3.5%, the remainder being the helpers still called (compares, integer stores, the
canonicalisation of tagged registers they read, 1.5–2.9 million a second); guest speed there 199
to 219 M/s.

**The tests.** The x87 semantics test from before runs through the inline path unchanged, and an
oracle test runs a program mixing loads, arithmetic against memory and registers, an exchange, a
compare and a helper-kept square root, compiled, with the inline path off and on, and compares
every stored result word for word, with the exact ones checked outright.

## The hosted Layer 3 provider answers in the call

**The cause.** The music that a title plays through its sound middleware was heard repeating at
the menu, and the frame rate collapsed with it. The repeats were laps of the streaming buffer
played again: the DirectSound diagnostics counted 460–656 KB of stale bytes in the 10–15 s bin
of a cold start, three to five laps. The middleware calls the provider's `ASI_stream_process`
expecting the count it asked for before the call returns, and it holds its own lock while it
asks. The hosted provider decoded through the platform's `AudioDecoder`, which answers on a
browser thread of its own -- measured starved for seconds by the burst of wasm compilation that a
start is -- so a request that ran ahead of it parked the guest thread (14–28 waits per 5 s),
the lock stayed held, and the main thread stalled on it. A lead decoded ahead of the position
hid the ordinary case and not this one. The redistributable decoder computes its samples inside
the call and never waits; the difference was ours.

**The change.** A hosted call answers in the call. The vendored FFmpeg build that decodes
cinematics gains a container-less entry (`media_open_audio` by WAVE format tag, `media_feed_audio`
one frame at a time, `media_flush_audio`) sharing the FIFO the container path drains; the media
layer publishes it as `openAudio`, synchronous, and the app hands it down to the audio layer as
configuration, the way the mixer is handed to win32. The provider's decoder contract stays; a
`createSynchronousDecoder` fulfils it by delivering each frame's samples inside `feed`, making up
a frame the decoder rejects with silence so that what came out always accounts for what went in,
and falling back to the platform decoder per stream when the media layer answers null -- a build
whose binary predates the entry, or one not yet instantiated, which the app now prepares at
assembly rather than on the first stream. The provider's wait path exists only for that fallback;
`waits` counts a request parked on the decoder, once, and is pinned at zero for the synchronous
decoder. The decoder build moves into this repository (`scripts/Dockerfile.video-decoder`,
`scripts/video-decoder/`, `build-video-decoder.mjs`, a job in the vendor workflow that publishes
a release on dispatch) against upstream FFmpeg at `n6.1` pinned by commit.

**The measurement.** Two cold starts through the launcher with the rebuilt binary, the same
sampler, the audio layer reporting the synchronous decoder in use and no fallback opened. The
provider never fell behind: fed and decoded samples equal in every sample, `waits` 0 against 39
and 42, no request answered short. The main thread was never blocked on the sound library's lock
(13 samples of it before), and the second hold -- a worker stall of 0.5 to 1.8 s at 20 to 35 s
with the machine retiring nothing -- did not recur. Stale bytes replayed by the music buffer in
the first 90 s: 199 and 283 KB against 680 and 1522; in the 10 to 15 s bin 13 and 21 KB against
626 and 149. The first draw of the menu came at 8.1 and 9.9 s after the engine was up against
10.7 and 12.9; frames on the canvas in the 10 to 15 s window 28 and 13 a second against 15 and
3.6. The decoder's own cost is not visible: the pump phase fell from 1.0 to 0.2 % of the frame
and the trap share, where the feed runs, did not move.

What remains is not the decoder. The stale bytes left come in two pieces: a few tens of
kilobytes before the stream is opened at all, while the guest waits on range requests for the
bundle, and a burst of 100 to 140 KB exactly at the first draws, when the main thread is in the
draw traps with seventy to eighty compilations in a frame and the streaming thread gets no
quantum -- the machine is slow there, and the scheduler hands the thread that feeds a device no
more than any other. The steady frame rate after the menu settled read lower than one earlier
run (50 and 39 a second against 63) with another process on the machine during the second
start; the two starts differ from each other by as much, so it is noise until a paired run in a
quiet machine says otherwise.

**The tests.** The decoder wrapper feeds silent Layer 3 frames and gets 1152 stereo samples of
zeros back per frame, in the call, and a tag the build cannot serve fails by name (skipped, with
the reason printed, on a binary without the path, which is tested to answer null rather than
fail). The synchronous decoder is tested against a fake stream: samples arrive
before `feed` returns, `flush` delivers the rest in the call, a short frame is padded, a failing
one is reported, and a null stream goes to the fallback. The provider is tested with a decoder
that answers in the call: every request is answered whole, a request within the lead without a
promise at all, and `waits` stays at zero to the end of the stream. The audio module's decoder
choice by configuration and the media module's null-until-ready answer are pinned as well.

## The turn goes to the highest-priority ready thread

**The cause.** With the sound provider answering in the call, the music buffer still replayed
stale bytes at one moment of a cold start: exactly at the first draws of the menu, when the main
thread sits in the draw traps with seventy to eighty code compilations a frame and the guest
retires 2 to 17 million instructions a second. The sound library's streaming thread has a
deadline there -- the looping DirectSound buffer plays whether it was refilled or not -- and the
scheduler was round-robin over equal quanta, so a thread with a deadline got the same turn as
one without. Measured through the launcher on two cold starts, sampled every 250 ms: a burst of
158 and 168 KB of stale bytes in the six seconds around the first draws (at 8.1 and 9.9 s after
the engine was up), 204 and 290 KB over 90 s. The program had asked for something else all
along (read with `?log=call.cpu`): from the main thread it raises a worker to `ABOVE_NORMAL`
a second after start and the streaming thread to `THREAD_PRIORITY_TIME_CRITICAL` when the sound
library comes up, one worker sets itself back to `NORMAL` every few hundred milliseconds, and the
main loop polls `GetThreadPriority(GetCurrentThread())` --
`SetThreadPriority` was accepted and ignored, and `GetThreadPriority` answered normal for
everyone.

**The decision.** Priority as Windows composes it for a normal-class process: a base of 8 moved
by the relative priority a program sets, with `THREAD_PRIORITY_IDLE` pinned to 1 and
`TIME_CRITICAL` to 15; the seven values a normal process may set are accepted and any other is
refused with `ERROR_INVALID_PARAMETER`. There is no `SetPriorityClass`, so the class is always
normal. The turn goes to the highest-priority ready thread; equals keep the round-robin order
and the quantum they had. Starvation control the way Windows does it: a ready thread passed over
for longer than a bound -- four seconds of guest time, the scheduler's own clock -- outranks
everything for one turn, so a high-priority thread that never yields cannot hold the machine for
ever. No wake boost: the measurement did not ask for one (see below), and a boost that is not
needed is a scheduling rule nobody can read back from a run. The kernel's thread record is the
one place the priority lives; the win32 calls read and write it there, and the report
(`byThread`) names each thread's absolute priority and how often it was boosted.

**The measurement.** Two cold starts through the launcher, the same sampler, the browser
restarted between them, against the two starts above. The burst of stale bytes at the first
draws: 8.5 and 24 KB against 158 and 168. Over 90 s: 64 and 204 KB against 204 and 290 -- the
second start's total is one burst of 137 KB at 15.6 to 16.1 s, after the menu was up, during
which the engine worker's own event loop answered a probe 2 s late and the guest retired 10
million instructions a second; the streaming thread was blocked on its own timer, not passed
over, and the scheduler was not asked for a decision it could have made differently. The first
draw of the menu came at 6.8 and 7.9 s against 8.1 and 9.9. The starvation control never fired:
zero boosts in both runs, and the streaming thread, which is the one at 15, holds 3 to 4 % of
the retired instructions before and after alike -- it wants the machine rarely and briefly, and
having it first is all it needed. The picture did not pay for the sound: frames on the canvas in
the 30 to 60 s window 50 and 55 a second against 50 and 39, in 60 to 90 s 52 and 55 against 56
and 39; guest instructions per second in the same window 112 and 122 million against 101 and
82; the main thread's share of the machine 86 and 87 % against 78 and 82. The 10 to 20 s windows
read 20 and 21 a second at 10 to 15 s against 29 and 13, and 20 and 29 at 15 to 20 s against 33
and 20 -- inside the spread of the two baseline starts, in a window the shader and code
compilation of a cold start dominates, so not a cost this measurement can attribute to the
scheduler; a paired run on a quiet machine would say. The ring starvation of the first two
seconds (8 to 15 thousand blocks a sample at 0.9 to 1.5 s) is unchanged by this: it precedes the
streaming thread's existence, while the intro is starting, and is a different defect.

**The tests.** The scheduler: priority composes as Windows composes it; the highest-priority
ready thread runs first and equals round-robin exactly as before, with every existing turn-order
test unchanged; a thread starved by a busier, higher one gets its turn when the bound is
reached and again one bound after that, with the boost counted on it and in the report; a thread
that raises its own priority mid-run is scheduled by it from the next turn and lowering it hands
the machine back. The win32 surface: every value a normal process may set round-trips through
`SetThreadPriority`/`GetThreadPriority` into the kernel record, the pseudo-handle for the
current thread names the caller, a value from the realtime class is refused with
`ERROR_INVALID_PARAMETER` and leaves the priority as it was, and a handle that is not a thread
answers `THREAD_PRIORITY_ERROR_RETURN` with `ERROR_INVALID_HANDLE`.
