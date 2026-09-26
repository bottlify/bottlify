# Decisions

Behaviour this project chose rather than derived from a specification, plus the handful of
standing rules that came out of measuring a real title rather than reading code. Bottlify is under
no obligation to match any particular reimplementation of Windows: what a program observes is the
contract, and where no published expectation exists, or a different answer serves this engine
better, that is a choice — defended here on its merits, revisited when something argues against
it. A bug is not a decision; a bug goes in the code and gets fixed, and an open one is tracked in
`roadmap/00-TODO-list.md`.

Each entry is dated to the commit that made the call (or, where a later commit corrected it, both).
Nothing here is rewritten to say something different than what was actually decided; a decision
later reconsidered is recorded as reconsidered.

## A. Win32, COM and the loader

**A1 — DirectDraw refuses a 15- or 24-bit display mode.** `SetDisplayMode` answers
`DDERR_INVALIDMODE` for 15 and 24 bpp; there is no conformance expectation either way, and this
layer has no three-byte pixel path to create such a surface with. Revisit if a title is found that
treats the refusal as fatal. *2026-09-07, `94e7f597`.*

**A2 — This build announces itself as hardware, with transform and lighting.** `GetCaps` reports a
real 3D hardware device (plus a software rasteriser and a T&L device, in that enumeration order)
because there is a real GPU underneath and programs of this era branch on the claim — an
emulation-only enumeration reads as "no accelerator" and sends them into software rendering or a
refusal. A capability bit claimed here is a promise the renderer has to honour, so this grows only
as the renderer does. *2026-09-07, `94e7f597`.*

**A3 — `_allmul`/`_alldiv`/`_allrem`/`_aulldiv`/`_aullrem` pop their own 16 argument bytes
(stdcall), against a published spec that calls them cdecl.** The spec's own C implementation is
declared `WINAPI`, and real compiled call sites emit four pushes with no cleanup after — two
sources against one, so the spec is the one not believed. If this is ever wrong the symptom is a
stack skewed by 16 bytes with nothing pointing at the cause; remove all five rather than adjust
them if it is ever suspected. *2026-09-07, `94e7f597`.*

**A4 — `_allshl`/`_allshr`/`_aullshr` are not exported at all**, rather than shipped as a wrong
shift: the trap stub already overwrites the operand before any handler runs, so a shift of "the
stub left behind" is worse than an unresolved import. A save-before-trap variant is the known fix,
worth building the day a program actually imports them. *2026-09-07, `94e7f597`.*

**A5 — `SYSTEM_BASIC_INFORMATION`'s timer resolution is a plausible 15.625 ms, not a measured
one** — there is no periodic interrupt here to measure with. Revisit once there is one.
*2026-09-07, `94e7f597`.*

**A6 — ANSI→Unicode widening in ntdll ignores the code page** (byte-for-byte, correct only below
0x80). `kernel32/locale.js` already has a real single-byte decoder that isn't threaded through yet.
*2026-09-07, `94e7f597`.*

**A7 — Only `SystemBasicInformation` and `ProcessBasicInformation`/`ProcessDebugPort` are
answered**; every other information class is refused with a status rather than filled with
invented numbers. A refusal is a message; a fabricated structure is a wrong answer that propagates.
*2026-09-07, `94e7f597`.*

**A8 — There is one user, called "User".** `GetUserNameA` answers a constant because there is one
account and no way to become another; it exists at all because some programs refuse to start
without a name. *2026-09-07, `94e7f597`.*

**A9 — The boot ROM installs thirty-two interrupt vectors, not two hundred and fifty-six.** A full
table was tried and reverted: a vector fired during protected-mode entry and landed in a halting
stub, which reads as a hang — worse than a loud refusal. *2026-09-07, `94e7f597`.*

**A10 — Direct3D 7's format and capability lists are narrower than the era's hardware, on
purpose.** `EnumTextureFormats`/`EnumZBufferFormats` name only what the renderer implements, and
`d3d7/caps.js` claims only the cull modes, compares, blends, stage ops, filters and address modes
the pipeline actually has — no fog, stencil, lighting, bump mapping, cube maps or W-buffer. A
capability bit is a promise; claiming one the renderer can't honour sends a program down a fast
path to a wrong picture instead of a slow path to a right one. Grows only when the renderer grows.
*2026-09-07, `765d7866`.*

**A11 — Direct3D 8 refuses shaders, cube maps, volume textures, palettes, extra swap chains, the
hardware cursor, `GetFrontBuffer` and `ProcessVertices`, rather than pretending to support them**
— the same A10 rule. The sharpest case is shaders: the renderer skips any draw with one bound, so
accepting `CreateVertexShader` would put a program on a path where every draw silently vanishes.
Multisampling is accepted and silently dropped everywhere (aesthetic, not structural); the gamma
ramp and clip planes are stored state with no effect and report zero capability so a checking
program is told the truth. `GetDeviceCaps` still writes an almost entirely zero `D3DCAPS8` —
known and unfixed, contradicts A2 for a program that branches on it. *2026-09-07, `ea288f16`.*

**A12 — Every COM interface method in this engine is stdcall, with the interface pointer first on
the stack — not thiscall.** Established against real compiled binaries: twelve call sites read
instruction-by-instruction across five images, plus a census where two COM-only libraries show 24
and 30 stack-passed call sites and zero register-passed ones, against the same binaries emitting
thousands of register-form calls for their own C++ virtual calls. This corrected an earlier wrong
assumption that no test caught, because the harness's own vtables agreed with the mistake — a
convention is not verified by a test written against the same assumption. `Convention.THISCALL`
is kept, unused, only because a `msvcp` C++ runtime on the porting list genuinely needs it one day.
*2026-09-07, `ea288f16`.*

**A13 — A loaded image's whole file stays in host memory, for its resources.** Without it a
library's strings, icons, dialogs, menus and version info answer nothing, since a resource is read
from the file rather than the mapping. Known cost: a large title's twenty libraries hold tens of
megabytes host-side for the process's life. The alternative — re-reading from the volume per
resource call — costs a guest-thread wait, which this project ranks above memory. Revisit only
with a measurement that says memory matters more. *2026-09-07, `ea288f16`.*

**A15 — `DllMain`'s third argument is 1 (only its non-nullness is contractual) for a program-import
load, and would be NULL for `LoadLibrary`.** A real library's archive code built its hash table
twice — once for itself, once (wrongly) for the dynamic-load path — when told the wrong thing,
silently corrupting every later lookup. `DLL_PROCESS_DETACH` carries the same distinction and will
matter once detach is implemented. *2026-09-08, `43aad592`.*

**A16 — A named Win32 object (event, mutex) is destroyed, and its name released, when its last
handle closes** — checked on every named create, not cached. Needed for the create-check-close-
create-again single-instance idiom to work at all. *2026-09-08, `43aad592`.*

**A17 — `VirtualAlloc` places a reservation on a 64 KiB boundary**, matching the granularity
`GetSystemInfo` reports, because an allocator that recovers its segment from the top bits of a
page-aligned base corrupts silently if handed a merely page-aligned one. Costs address space, the
resource this engine has most of. *2026-09-08, `43aad592`.*

**A18 — A device's cursor advances on the run loop's own clock, not only when the guest calls
in.** A program is entitled to hand a buffer to a wave device and spin on its `WHDR_DONE` flag
without ever polling an API — measured at 80% of one real title's instructions sitting on that
spin. Generalised: anything a guest can wait on without making a call has to be driven from the
scheduler. *2026-09-08, `33c69c47`.*

**A19 — A COM method receives its arguments with the `this` pointer already stripped** —
`bridge/internal/vtable.js`'s own contract. Two seams (DirectSound, DirectInput) were written as
though it hadn't been, reading every argument one slot late, and their own test fixtures agreed
with the bug instead of the bridge. Both now drive the real vtable publisher by slot number rather
than a stand-in. *2026-09-08, `33c69c47`.*

**A20 — DirectShow answers, and answers that it cannot render** (`RenderFile` →
`VFW_E_CANNOT_RENDER`, `Run` queues `EC_ERRORABORT`) rather than hiding the file so the program
never asks. A program that plays a cinematic sits in a modal loop until the graph reports an
outcome; with no graph and no error, that loop never exits. *2026-09-08, `33c69c47`.*

**A21 — The guest's clock is credited with the wall time a slice actually took, not just the
slices the guest ran.** Everything between two slices — the yield, the mix, the polls — used to
pass on the wall clock without moving virtual time, so a device paced by that clock (a
`DirectSound` cursor) never finished a buffer for a title that spins on it instead of waiting.
Capped at a quarter second so a genuine stall (a fetch, a hidden tab) isn't handed to the program
as time it spent. *2026-09-08, `33f251d6`.*

**A22 — `WM_NCCREATE` and then `WM_CREATE` are sent when a window is made.** A window procedure
does its real setup in `WM_CREATE`; without it a window looks real and does nothing. `WM_NCCREATE`
was at first left out, because it meant running guest code twice from one host call with the
second starting while the first unwound; creation has since come to chain the CBT hook,
`WM_CREATE`, `WM_SIZE` and `WM_MOVE` each after the previous one's answer, so that no longer held,
and a procedure that keeps `lpCreateParams` from `WM_NCCREATE` -- a common way to bind a window to
its object -- never got it. It is sent first now, and `FALSE` from it refuses the window, as user32's
message tests pin. *2026-09-08, `33f251d6`; revised 2026-09-26, `54c1d1f`.*

**A23 — `DefWindowProc` does nothing with `WM_DESTROY`**, rather than posting a quit. Windows
programs destroy windows constantly (dialogs, tooltips, splash screens) and pass `WM_DESTROY` to
the default handler with nothing to add; posting a quit there ended the whole process on every one
of those. Ending the message loop is the main window's own `PostQuitMessage` call. *2026-09-08,
`33f251d6`.*

**A24 — `SetTimer` makes a real timer, due against the guest's own clock, and `WM_TIMER` is
synthesised when a program asks for a message and finds nothing else** — the way Windows does it,
so a long handler doesn't leave a backlog. Refusing outright, tried first, is indefensible once
there is a clock to be due against. *2026-09-08, `33f251d6`.*

**A25 — A DirectShow graph with nothing to play finishes at once (`EC_COMPLETE`), rather than
`RenderFile` refusing outright.** A program checking `RenderFile`, releasing the graph it can't use
and arming its own caption timer unconditionally then dereferences a pointer it already freed —
refusing correctly still crashes it. An empty graph takes the same "finished" path a real film
does. *2026-09-08, `33f251d6`.*

**A26 — A thread handle is waitable: `WaitForSingleObject` treats a thread as an object that
signals once and stays signalled on ending**, nothing taken from it so a second join doesn't hang
forever. *2026-09-08, `33f251d6`.*

**A27 — Every field a structure declares gets written, never a partial table of "the fields anyone
fills in."** `D3DCAPS8` was tabulated as a handful of fields and every one was in the wrong offset
— the real maximum texture size landed on the repeat-limit field and read as zero, so a program
halving a texture until it fit halved it forever (97% of one measured profile on that one
instruction). A partial table is not a partial implementation; it's a wrong one. *2026-09-08,
`33f251d6`.*

**A28 — A Direct3D device's per-draw state (render state, transforms, stream/index sources, the
vertex shader handle, buffer lock/unlock) lives in a guest-memory block the guest writes directly,
and the host trusts none of it.** The block is one-way (guest writes it; host only mirrors its own
state into it), untrusted (every device-method entry diffs the whole block against the host's copy
and replays each difference through the real setter, so validation stays centralised), and counted
(the block tallies what it absorbed so the saving is a measured number, not a belief). What the
fast path can't do — an unknown state, a shader handle, a held lock, a full ring — still falls to
the method's own trap. Measured on one title's menu; the block takes a dedicated memory page so
writing it never evicts compiled guest code sitting next to the routines that write it. *2026-09-10,
`109d90f6`.*

**A29 — Video memory is a constant 256 MiB that creating a surface or texture never reduces.**
`GetAvailableTextureMem` (Direct3D 8 and 9) and `GetAvailableVidMem` (DirectDraw) answer the same
number however much has been created, where Wine's tests (`d3d9/tests/device.c`,
`ddraw/tests/ddraw7.c` and its older siblings) see it fall as render targets are made. A program
asks to size a cache, and what it does with a falling answer is evict and reload; here nothing is
ever evicted, because a texture's storage is the guest's own memory and its GPU copy lives as long
as it does, so a shrinking figure would make a program work around a pressure that does not exist.
The figure sits well below a signed 32-bit boundary so a caller treating it as signed cannot go
negative. Revisit if a program is found that checks the figure falls, or that refuses to run when
it doesn't. *Recorded 2026-09-26; the choice predates this repository's history (`7a469c3`).*

**A30 — `Present` never waits for the display, whatever presentation interval was asked for.**
The caps advertise `D3DPRESENT_INTERVAL_ONE` and `IMMEDIATE`, and the interval a program asks for
is parsed and handed back, but no path reads it: two presents in a row both return at once, where
the documented contract is at most one per refresh period. The pacer
(`webgpu/internal/pacer.js`) takes the newest frame at each display tick instead, so a frame
presented too soon is superseded rather than shown, and the guest thread is never held for a frame.
A guest thread parked for a refresh period costs more than any number of frames drawn. What this
gives up: a program that
relies on `Present` to throttle its loop runs that loop faster than the display, and burns guest
time on frames nobody sees. *Recorded 2026-09-26; the choice predates this repository's history
(`7a469c3`).*

## B. From measured optimisation work

**The vendored full-system emulator is replaced by a user-mode x86 → wasm translator of this
project's own (cork), behind the unchanged `cpu` contract, migrated in a hybrid mode with the
emulator as the fallback tier and the oracle.** Measured on a 2004 OpenGL title on an Apple M4
Pro: 1–3 ns per guest instruction, 10–25× slower than the processor the title was written for,
and 58 of a 92 ms frame in the emulator on a plain view. The cost is structural to an emulator
built to boot an operating system (paging on every access, x87 as a stack in memory, one basic
block per unit, an interpreter for the rest); per-title kernels that hand-replace hot loops buy
one program a frame, not the engine a property. Graphics are on the GPU, so the processor side
is the ceiling for every title; the target is 0.5–1 ns per instruction as an engine property.
Design, scope and milestones: `roadmap/cork-x86-translator.md`. *2026-09-20.*

**Translated code tests a page-flag table before every access instead of relying on the
wasm bounds check alone.** The design's §5.1 named the browser's bounds check as the only
check; a wasm trap, though, unwinds the region function and the registers held in its locals
with it, so a precise fault after a trap would need every dirty local written back before
every access — more stores than the test costs. The test is a shift, a byte load and a branch
per access (a second load when the access may span a page); it is also what delivers
self-modifying-code detection (a store into a page holding translated code leaves `stale`
after the instruction), the null page and, later, the memory layer's protections, none of
which the emulator gave a program. It stays measured: the plan's 2.9 reports the share the
check holds on the target title, and elision for a base register already checked in the same
block is the named follow-up if the share is material. *2026-09-20, cork 2.4.*

**A call into the bridge from translated code is the `trap` import called from inside the
region, as the design had it; a region holding x87 registers in its locals takes a `trap`
exit instead.** The exit form came first (the same crossing count on paper, no writeback and
reload machinery, no re-entrancy question), and the synthetic measurement showed why the
design wanted the call: the exit and re-entry through the host's slice loop cost about
0.6 µs per call on top of the bridge's own dispatch, and the import-calling loop ran slower
under hybrid than on the emulator. The call writes the state block back and reads it again
around the handler -- the prologue and epilogue halves the region already has -- so a
callback's nested slices see a complete block and the region's locals are refreshed after;
the x87 locals live in a per-block permutation those halves do not know, so a region with
x87 in it keeps the exit, which the hybrid host answers through the same handler. *2026-09-20,
cork 4.2, revised.*

**Each translated region is its own wasm module, not one module per batch.** The design's
2.6 put a batch of regions into one module to keep the module count down; the translation
cache (2.8) keeps regions, since a batch is what the sampler happened to gather and is never
the same twice, and a module per region is the record the store can hold and the unit a
page write drops. The cost is the helpers repeated per module (a few kilobytes) and an
instantiation per region rather than per batch, both measured small against the emitting a
hit saves; the module count is bounded by the regions live, which the invalidation already
bounds. *2026-09-20, cork 2.8.*


**B12 — The audio pump, the DirectSound/waveOut/MSS buffer reads and the hosted MPEG provider's
decoder callbacks stay on the engine's own thread rather than moving to a second worker, for
now.** A split needs the buffer *writes* copied into a block an audio worker owns (the emulator's
wasm memory isn't shared) and cursors travelling back through an `Atomics`-readable control block —
real work, not a refactor. Measured over 60 000 scheduler turns on a real title's menu: the pump's
self time was 921 ms of a 186 s run, 0.5% of wall, 11 µs a turn — under one percent of the thread
is not what to move first. Build the seam when a measurement says the pump has become material
(many tracks, a resampler on each), not before. *2026-09-12, `30f81135`.*

**A redistributable runtime is ours to reimplement, regardless of who shipped the copy.** The
project's original rule — only Windows system libraries are reimplemented, everything a game ships
is run as real x86 — is exactly right for a program's own code, but a profile of one title at its
menu found 27.3% of the machine in a bundled MP3 decoder and 10.1% in its archive library, against
0.2% in this engine's own thunks: a third of the machine decoding audio that then arrives at 60% of
real time, heard as a broken stream, unfixable anywhere in the sound path because the path measured
clean at every stage. **The decision:** a library is ours to reimplement when it is a
redistributable runtime with a stable published API, whoever's copy it is — a middleware sound
engine, a video codec, an archive library shipped in hundreds of titles is the same class of act as
reimplementing DirectSound, and helps every title on that path (rule 4's own test). Safe because a
decoder is a pure function (bytes in, samples/frames out, no state of the program's own) and the
`media` layer already crossed this line for cinematics. What stays off-limits: the program's own
code, and anything chosen by which title shipped it. A substituted runtime reports its divergence
like any other, and is picked for what the target titles actually need. *2026-09-11, `d4fe29ac`.*

**Uniform blocks live in one ring buffer, bound at a dynamic offset, rather than one buffer per
draw.** Measured before: ~140 bind groups created per frame on a title's menu, none reused over
100,000 draws, because a bind group is keyed on the buffers it names and every draw had its own.
After: 71 groups created in total against 890,000 reuses — the cache now lives for the backend's
life, not one pass. The ring wraps rather than growing; a write is ordered after every prior
submit, so a wrap can only overwrite a finished frame's blocks. *2026-09-11, `dae4d203`.*

**One hardware sampler serves every draw (linear, repeating); the Direct3D sampler state (address
modes, filtering, mip mode) is carried in the uniform block and applied in the shader.** Traced on
this project's own development adapter (Parallels' WDDM device through Dawn's D3D12 backend): a
title's main-menu sky alternated between its cloud texture and a flat wash of its corner texel for
seconds, and across dozens of controlled probes the sampler a draw *binds* on this device was
provably not the sampler it *samples with* — switching every 51 frames regardless of frame rate, in
no arrangement of bind groups. Address modes fold/hold the coordinate inside the outermost texel
centres so the one repeating sampler can't blend across an edge; point filtering snaps to texel
centres; mip level is chosen explicitly from derivatives taken beforehand. Costs a few operations
per sample and three words in the block; doesn't cover anisotropy or border colour, neither seen
in use by the target titles. *2026-09-11, `dae4d203`.*

**A sound middleware's bundled MPEG (Layer 3) decoder is hosted as the ASI provider it loads by
convention, decoding through WebCodecs, rather than run as emulated x86.** The redistributable
scans a directory for `*.asi` files and calls the registered provider directly; run as guest code
it took a fifth of the machine's retired instructions and delivered music in bursts. Three things
learned only from the running middleware: the open-time size argument is its own 4 KiB read
buffer (not the stream length); every read continues from the last stop, since a read naming an
offset outside the held window was measured copying a negative count; a seek serves fresh from the
named byte, dropping whatever was already held. Measured over 60s at the main menu: starved audio
frames 0 vs 9091 (189 ms of invented silence) and engine frames 2007 vs 1232, with the shipped
decoder gone from the guest's instruction share. *2026-09-11, `6717fb63`.*

**The guest's clock is credited with all real time between two turns (not only slices the guest
ran), and a DirectSound buffer is read out to its write cursor rather than only as far as its play
cursor.** Measured: about a tenth of every block asked for came back empty (a constant crackle)
while the ring never held more than a few hundred frames. The clock omission made a DirectSound
buffer's play cursor fall behind the real device by the loop's own uncredited share; reading only
to the play cursor meant a turn longer than one device block was a click. After both: no starved
block once music started, ring holding 50–100 ms throughout. *2026-09-11, `0d2ad55b`.*

**A zero-timeout wait is its own primitive — it takes what is ready and never queues the thread —
rather than a wait with no time in it.** A stale queue entry from treating a poll as a real wait
handed a later signal to a thread that had moved on to waiting on something else entirely; measured
on a title whose sound-loader thread polled a completion event every loop pass and then waited on
its own quit/data pair — the stale entry woke it with the wrong index, it read that as quit and
exited, and every sound effect after that was requested and never loaded. *2026-09-11, `f54a8136`.*

**A program's registry writes and its own file-based profile travel inside the session (packed
under a name no real path can have), laid onto the mounted volume after the bundle is mounted, not
before.** A title's options and profile name are registry values while its save profile is a file;
carrying only files lost the registry half, and laying session files on *before* the bundle mount
put a fresh writable layer over them, erasing a restored profile before the program's first
instruction (which then cleared the registry value naming the now-missing file). Pinned by an
integration test mounting a bundle over a session. *2026-09-11, `603384a1`.*

**The package carries its own vendored emulator artifacts and ships built minified, without a
source map.** `createApp` finds the module and its binary beside the built package unless a part
is named to override it; the audio worklet ships as its own export since an audio thread loads it
by URL rather than importing it. *2026-09-11, `603384a1`.*

**Every COM interface gets one shared table of stubs, keyed by the method list's identity, with
the object found from the interface pointer the call arrived on — not a table of stub slots per
published object.** A title in a match published 1,216 objects into a table of 16,384 slots and
exhausted it; every later publish was refused as "out of video memory," and the program's own
retry-without-picture behaviour (white textures, remade every frame) ran the guest heap out too.
After: 5,079 objects on 210 stubs, 1,606 slots in use, textures stable near 1,600, heap steady at
168 MB. An object now costs two words (table pointer, state word). *2026-09-11, `17ef05ad`.*

**A picture codec (JPEG) a program ships (`ijl15.dll`) is hosted by its export contract — six
functions over one structure — the same rule as the MPEG provider.** The title's own inner loops
(Huffman, inverse transform, colour planes) cost 5.7% of the guest's time in a match on top of the
title's own code, with each texture arriving mid-fight on the frame's critical path. Two facts
learned from the program's own memory rather than a header: the DIB pointer is the structure's
second word with channel count before colour space on both sides, and rows deliver in the picture's
own order for a positive height (an inverted delivery showed as upside-down atlas tiles). Checked
byte-for-byte against the shipped textures decoded a second way. Measured: the library gone from
the guest's share, 1,877 decodes of a map load costing 1.9 s of host time total. *2026-09-11,
`79276f0a`.*

**A ready thread's turn is chosen by priority the way Windows composes it for a normal-class
process** (base 8, moved by the seven values a normal process may set, `IDLE`→1, `TIME_CRITICAL`→
15; equal-priority threads round-robin as before), **with starvation control (four seconds of
guest time unserved outranks everything for one turn) and no wake boost.** `SetThreadPriority` had
been accepted and silently ignored. Measured: a title's own streaming thread raises itself to
`TIME_CRITICAL` when its sound library comes up; with priority honoured, the burst of stale
(re-played) audio bytes right at the menu's first draws fell from 158–168 KB to 8.5–24 KB per cold
start. No wake boost because the measurement never asked for one — a scheduling rule nobody can
read back from a run is not worth having. *2026-09-12, `06603a5d`.*

**A downloaded bundle block is never fetched again — cached under a bare filename the origin's
file system actually accepts — and a demand miss brings in its whole 2 MiB-aligned window, not
just the missed block.** The cache had been naming its files with a path separator, which the
origin private file system refuses; the refusal was swallowed and it silently fell back to an
in-memory store that nothing survives between starts, and the field reporting this (`backed:
false`) was never read anywhere. After the fix plus the window-on-miss change: a warm second start
issued zero range requests; across four cold starts, requests fell 38% for 60% more bytes fetched,
because misses stopped being served one block at a time. A block-fetch order recorded per bundle
(bounded to 4096 entries) lets the next start's background filler bring in what was actually
demanded last time, first. *2026-09-12, `9683fc51`.*

**The emulator is an optional layer, and `cork` is the default engine.** What was a hard
dependency of the package -- the emulator's artifacts in `dist/vendor/`, fetched and packed
whether or not a launch used them -- is now selectable: a build with `vendor/prebuilt/` empty and
the `vendor/v86` submodule absent builds, tests and runs the library's demos under `cork`, which
loads none of it; the package still exports `./libv86.mjs` and `./v86.wasm` for a build that
carries them, `check-package` accepts either and holds a present binary to a size floor, and a
launch that selects `emulator` or `hybrid` without the layer is refused with
`cpu: the emulator is not available in this build (engine "…" needs it)` rather than a fetch's
error. `cpu.decompressZstd` left the api: the project's own decoder (step 5.0) replaced its one
caller, and the emulator's decoder is reached directly by the differential test alone. The `jit`
option and the `jit.*` counters stay -- the schema is the same on every engine -- and report `-1`
under `cork`, which has no emulator compiler; the launcher's per-bundle engine selector is the
owner's. The paired browser table (`--engine emulator` as the control) that would confirm the
target ns per instruction is the owner's to run. *2026-09-22, cork 5.5.*

## C. Process model and porting

**Process replacement, not two processes in one address space or two machines.** `CreateProcess`
records a request; the parent keeps running; when it exits or waits on the child's handle, the
engine tears the app down and rebuilds it on the child's image. The alternatives cost real things
this project doesn't have a use for yet: two processes in one realm needs per-process handles,
heap, module table, message queue and registry plus region release and image relocation (weeks,
and still blocked behind "cpu: already booted"); two machines needs a second emulator and a
cross-machine channel to model a launcher that often exits within milliseconds of spawning.
Replacement gets the common case right at near-zero cost and, crucially, makes the classic
`0x400000`-collision impossible rather than solving it, because there is only ever one image at
that address. What it gives up: a parent that must run genuinely alongside its child (Battlefield
2's installer is the concrete case — tracked as work, not solved by this design).
`CREATE_SUSPENDED`+`WriteProcessMemory`+`ResumeThread` is handled as deferral: writes into a
suspended child are recorded as patches against an image that doesn't exist yet, and replayed once
it is mapped — no cross-process memory needed. *2026-09-07, `c3e8db9b`; built `2026-09-08`,
`6bb72c18`.*
A parent that waits on its child now goes on after it: the child runs on a second machine built
beside the parent's, which stays paused where it blocked, and the parent's wait is answered with
the child's exit code once it exits, the files and registry the child wrote copied back. Only one
of the two machines runs at a time, so this is still not two processes executing at once -- the
Battlefield 2 installer's shape (run a stage, wait, go on) is what it covers. *2026-09-24.*

**Only Windows system libraries are reimplemented; a redistributable middleware runtime is ours to
reimplement too (§B above); anything else a game ships in its own directory is loaded and run as
real x86.** `mss32`, `bass`, `openal`, `a3d`, `binkw32`, `smackw32`, `glide2x`, `galaxy` are
therefore read only for knowledge, never implemented. `d3dx9` is the one case with a third option:
the engine ships the June 2010 DirectX End-User Runtime as a read-only system volume and the
loader runs the real `d3dx9_24…43.dll` from it whenever a program doesn't bring its own; the
engine's own `d3dx9_25`/`26`/`27` stub tables (`layers/win32/d3dx9/`) still answer a program that
ships neither — the fallback now, not the primary path. *2026-09-07, `42e8e9bc`.*
