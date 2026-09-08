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

The predecessor tree carries a substantial body of work on all three. It was read only at the level
of its commit messages and is deliberately not carried yet: nothing here is fast enough for it to be
the bottleneck. Worth a second pass when something is.

### B6. Guest thread latency, not throughput

Recorded here because it decides which of the above is worth doing first: the cost that matters most
in this engine is how long a guest thread is held, not how much total work gets done. An
optimisation that improves throughput while lengthening a single hold is a regression.
