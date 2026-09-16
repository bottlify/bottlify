# Phase history

Phases 0 through 11 have all been carried out — the last two days alone landed 130+ commits past
where the phase documents left them (`git log 06d3a42..HEAD`). This file is what replaced
`roadmap/phases/*.md`: one section per phase, the decisions that are still load-bearing kept
close to how they were written (short ones verbatim), the rest compressed to what was decided and
when it landed. Nothing recorded as a decision here is rewritten to say something different than
what was actually decided; a decision later reconsidered is recorded as reconsidered, with the
commit. Open scope — anything never built or never measured to acceptance — is not repeated here;
it lives in `roadmap/00-TODO-list.md`, marked `[из фазы N]` where it came from a phase document
specifically. The decisions register (`roadmap/decisions.md`) is unaffected by this file and keeps
recording what it always has; the six knowledge/planning registers that used to sit beside the
phase documents (`registers/`) have been folded in below, into this file, `decisions.md` and
`roadmap/00-pitfalls.md` by what each entry was.

## Phase 0 — Skeleton, and the `@bottlify/core` package

**Closed.** The technology contour fixed at the outset is still exactly the contour in force:
vanilla ES modules + JSDoc (`tsc --checkJs --noEmit`, no transpilation), WASM only for the
vendored v86, one npm-workspaces monorepo, `@bottlify/core` in `modules/core/`, the v86 fork
pinned as a submodule at `modules/core/vendor/v86`, zero runtime dependencies, `node:test`
colocated as `*.test.js`, `check:boundaries` enforcing the layer graph in CI. None of this has
been revisited; every later phase was built inside it without exception.

The module contract fixed here — `BottlifyModule { name, version, requires, create, diagnostics,
dispose }`, a scoped host with no singletons, a registry that turns configuration into a
topologically-ordered creation plan, a stub answering `NOT_IMPLEMENTED` for anything disabled —
is unchanged in shape through every phase since; `system/*` still never imports `layers/*`, and
`check:boundaries` still parses the real `requires` arrays rather than trusting a separately
maintained rule.

History: P0.1–P0.5 (monorepo/CI, vendor v86 build + reproducibility, the module system itself,
`tools/cdp_test/` before any core code, and the end-to-end accept scenario) all landed and are
the foundation every later phase runs on. Nothing here is open.

## Phase 1 — CPU, memory, loader

**Closed.** The four decisions fixed on entry all held without reversal: no SeaBIOS (a 64 KiB
boot ROM of our own), protected mode entered by the ROM executing real instructions rather than
by poking CPU internals, the guest→host trap an `OUT` port write dispatched from `layers/cpu`
alone, and `dist/vendor/` consumed as a prebuilt artifact on machines without the Rust toolchain
(the reproducible Docker build stays CI-only, per `bottlify-use-the-prebuilt-v86-do-not-build`).

History: P1.1 (cold boot into protected mode) through P1.6 (the generated `hello.exe` fixture,
verified against real Windows as the oracle) all landed exactly as planned; the acceptance —
`hello.exe` prints and exits with the guest's own exit code, in CI — is long since subsumed by
much larger fixtures. The one open question the document carried ("how is the trap id passed")
was settled during P1.2/P1.4 and never revisited; nothing here is open.

**Guest memory is cleared where it lies, rather than zeroed into a host buffer and copied across.**
A capture of a real title found `VirtualAlloc` the largest single writer into guest memory in 24 of
29 long frames (up to 12.3 MB in the worst one), each megabyte paying three passes over the same
bytes (allocate, zero, copy) where the guest's memory is already a typed array that can be filled
in place. Every caller whose length comes from the program — heap growth, `memset`/the two `Rtl`
fills, `calloc`, the in-memory stream, safe-array clears — now goes through one fill that asserts
its region, charges the writer account once, and falls back to a byte-at-a-time write only over
executable memory (a write there has to announce itself to the compiler regardless). Measured in
Node over the real accessors: 1 MB fell from 1.020 ms to 0.025 ms, 12 MB from 16.203 ms to
0.333 ms, and 20,000 install-sized clears (2.48 GiB) from 2636.8 ms to 63.3 ms. Not yet measured on
a title's own frame. *2026-09-13, `06d3a429`.*

## Phase 2 — Threads, scheduler, synchronization

**Closed, and the two hardest decisions are still exactly as measured.** What a context must save
— GP registers, EIP, segment selectors and `segment_offsets`, materialised EFLAGS, the whole x87
stack including its tag state (`fpu_stack_empty`, not a separate field), MXCSR + XMM — was
grounded by reading `vendor/v86/src/cpu.js` rather than recalled, and nothing since has found a
field missing. The instruction-counted quantum is the scheduler's own primitive, not a wall-clock
slice: `run_slice(max)` is exported by the fork and drives guest instructions only, ending early
on `in_hlt`; the *achievable* granularity is one compiled page, and a hot loop inside one block
used to run to the JIT's own in-block ceiling (`LOOP_COUNTER`, a compile-time constant of 100,003)
regardless of what the caller asked for — measured on one title's menu, a fiftieth of the quantum
(2,000 vs. 100,000 instructions) only bought a third of the overrun (21.9 ms vs. 59.9 ms worst
slice), which is what a constant bound looks like from outside, and 20 ms with nothing reaching the
sound ring in that time is heard as a stutter. **Fixed in the fork**: the constant becomes a global
`run_slice` writes on entry, so the interpreter's own iteration limit honours the caller's bound
too — nothing new invented, the compiler already loads globals this way. What remains, unresolved:
a slice still runs to some five million instructions now and then, at a film or a load, and the
shape of guest code that does it hasn't been found; every loop tried in a probe stops where it's
told. `roadmap/00-pitfalls.md` §12.2 carries the general rule.

History: P2.1 (the context record, with an explicit MMX-interleaved-with-x87 test) through P2.6
(virtual time credited with a floor and ceiling) landed as planned; P2.7's multithreaded fixture
closed the phase. The document's two open questions are both answered: the TEB has an address-
space home (`layers/win32/kernel32/teb.js`), and virtual time is credited from the run loop
(`app.js`), not owned by the cpu layer — recorded as decision A21 in `roadmap/decisions.md`.
**Still not built, and now the sharper form of what this phase called "not in scope"**: SSE/MMX
inline in the emulator, and x87 inline all the way (the double shortcut behind the 80-bit float is
landed; the round-trip through the software 80-bit helper on every operation is not) —
`[из фазы 2]`, tracked under "Эмулятор" in the TODO list.

## Phase 3 — The call bridge and Win32

**Closed for the bridge; the surface keeps growing, which is expected — it was never meant to
finish inside this phase.** Every decision fixed on entry held: marshaling moved into `bridge`
(never `app.js`), calling conventions (stdcall/cdecl/thiscall) as data rather than derived from
argument count, thiscall's `this` counted inside `argBytes` and popped as `argBytes - 4`, the
async contract as a type only `park()` can produce, EAX written only by whoever resumes a parked
call, `ExitProcess`/`ExitThread` parking like any wait, guest callbacks built on a sentinel return
address rather than re-entering the CPU, and one `await` per scheduler turn so a suspended host
handler can resume. `A12` in `roadmap/decisions.md` records the one correction made *after* this
phase closed: every COM method is stdcall with the interface pointer first on the stack (matching
real compiled binaries measured instruction by instruction), not thiscall — `Convention.THISCALL`
is kept only for a `msvcp` C++ runtime that genuinely uses it.

**A program is told it became the active application only once it has a window, not the moment a
run starts.** Input is wired to the viewport before the program has executed a single instruction,
and activation (`WM_ACTIVATEAPP`/`WM_ACTIVATE`/`WM_SETFOCUS`) used to fire at that moment, landing
on window zero and dispatching to no procedure at all — with the latch set on having *tried*, so
nothing could correct it later. Symptom, confirmed by the person playing: a title whose opening
cinematic couldn't be skipped and whose buttons did nothing, while the same build worked elsewhere,
differing only in when its first window happened to appear. Fixed by setting the latch on having
*delivered*: activation does nothing while the target window is zero and is offered again whenever
one appears — the order Windows itself uses. Page focus still never becomes activation; a click
beside the canvas is not a program going into the background. *2026-09-13, `06d3a429`.*

History: P3.1–P3.6 landed; the acceptance was a windowed program answering its own window
procedure ten times running the same way. Three defects the phase's own §3a records (a stub taken
after the table was written, a callback frame built below the live stack, a memory read handing
back a live window instead of a copy) were found by running rather than by reading, and are the
kind `roadmap/00-pitfalls.md` now carries forward. §3b's "known gaps carried forward" — timed
waits other than `INFINITE`/zero, `CoUninitialize` releasing nothing, no `IClassFactory` reaching
the guest, estimated font metrics, an unapplied map mode, input going only to the most recently
created window — are **still true** except where a later phase closed one narrowly (`WM_ACTIVATE`
now posts on activation moves, `4862ac5`); the rest are `[из фазы 3]`, filed into the TODO list's
Win32/GDI areas since nothing since this phase touched them specifically.

## Phase 4 — Filesystem, bundles and sessions

**Closed**, and the bundle-format decision it exists to record has not been revisited: `.btl`
(fixed 40-byte header, 256 KiB blocks — not the phase's original 1 MiB, corrected in §1.2a once
the sweep was rerun exactly rather than by sampling — a codec per block chosen by trying both
`deflate-raw` and zstd and keeping the smaller, an index at the end) over ZIP64, because ZIP
compresses per entry and a per-block format is three orders of magnitude faster on the access
pattern a game actually does (seeking into a big archive for one asset). §1.2b's finding —
**the emulator we already ship contains a zstd decoder** (`zstddeclib.c`, part of v86's own
build) — closed what had looked like a second third-party dependency; nothing about the decision
needed revisiting once that was found, it only removed the cost of taking it. The three-tier
distinction (bundle: cached, never synced; overlay: the guest's writes; session record: ours,
travels) and the "OPFS specifically, for two structural reasons" (a bundle does not fit in
memory; a guest read is synchronous and only OPFS answers synchronously from a worker) are both
still exactly the architecture in force.

History: P4.1 (the bundle format, `tools/btl.mjs`/`tools/make-btl.mjs`) through P4.6 (sessions,
the Master Plan's write-close-reopen-elsewhere acceptance) all landed. What the phase named as
deliberately out of scope — installers, a streaming-download policy beyond what range reads make
possible, a session-sync server — are still out of scope in exactly the sense the phase meant:
installers became Phase 8, a download/prefetch policy and the sync backend are both named in
`roadmap/00-auth-and-shareplay.md` rather than here. Nothing from this phase is open as a defect;
what remains is product work already tracked elsewhere.

## Phase 5 — Graphics

**Was "active"; is now substantially past what the document anticipated finishing first.** The
plan ordered streams by what the two target titles call (Warcraft III, World of Warcraft), and
that ordering held even as a third and fourth title (Quake III, Doom 3, NFS Most Wanted) pulled
OpenGL and Direct3D 9 forward alongside it. P5.0's contract-tests-first rule and the specific
order inside it (DirectDraw ownership, the scene state machine, default device state, lock
discipline, lock↔GetDC, pointer arithmetic of a partial lock, validity tables, the d3d8/d3d9
reference-count contract, flip-chain topology) is still how new contract work in this layer is
written, and the closing rule — "every one of these ends by asserting the device's reference
count reached zero" — is still the pattern.

**State today, corrected against the code rather than against this document's own claim**: GDI's
drawing half and DirectDraw are done; Direct3D 7 and 10 are verified by tests alone (P5.3, P5.8);
**Direct3D 8, OpenGL and Direct3D 9 have each drawn a real program on a real GPU** — Warcraft III
(menu), Quake III (menu) and Doom 3 (a lit ARB2 level) for the first two, and NFS Most Wanted's
intro film for Direct3D 9 (`d3dx9_26.dll` through the loader's KnownDLL rule, `2f5002b`). This
corrects `roadmap/README.md`'s own stale line, carried over from this document, that Direct3D 8
was the only one to have drawn a real title. Glide is not started (P5.7, "only if something needs
it" — nothing has asked yet).

What §3's todo-cluster analysis called out as *our* burden and not Wine's — `test_caps`,
`test_check_device_format`, `test_surface_attachment` — remains generally true; no single sweep
against those clusters has been run since. **Open, `[из фазы 5]`**: the render-target ownership
gap the phase's contract work did not anticipate (a Direct3D surface reachable two ways ending up
as two different backend textures) was found and mostly fixed on branch `d3d9-rendertarget`
(reviewed, "merge after changes" — two required fixes named in `dbg/d3d9/review-rt.md` in that
worktree, not yet merged); the p90 pipeline-compile stutter on the OpenGL path; the bind-group
rule measured on one headless adapter only. All three are in the TODO list's graphics sections.

**A surface now describes itself completely, and every implicit back buffer/depth-stencil gets
storage for every pixel of its actual mode.** Two faults on the same per-frame path, found together
because a credits-roll screen (reading what it just rendered) exercises both every frame: the
implicit back buffer was allocated a fixed one-megabyte block regardless of mode, so anything above
512×512 at four bytes/pixel ran a lock off the end of it; and a surface descriptor's length and
sample-type fields were never written at all, left holding whatever was on the caller's stack — a
title sizing its own work from a length this engine never gave it wrote past its own buffer and hit
its own stack-cookie check, terminating with `STATUS_STACK_BUFFER_OVERRUN`. Fixed at the source for
every field either structure version declares; pinned by a test that writes a recognisable pattern
into the caller's struct first and checks not one word of it survives untouched. A windowed
device's 0×0 "size of my window" back-buffer request is resolved against the configured display and
reported as a divergence, not silently defaulted. *2026-09-13, `06d3a429`.*

## Phase 6 — Audio *(no document; partly built)*

Never had its own phase document — the master plan's row always said "partly built, no document"
— so there is nothing here to fold beyond recording where it stands. DirectSound models buffers
and cursors correctly; the guest's clock is credited for the whole turn and a buffer is read to
its write cursor rather than only to what the last turn produced (`roadmap/decisions.md`, "The
guest's clock is credited with all real time between two turns…"); a device's cursor advances on
its own rather than only when the guest calls in (A18); the audio ring is a service of the run,
attached to by a rebuilt machine rather than rebuilt with it (`1206037`). Middleware decoding is
hosted rather than run as emulated x86 where it is a redistributable with a stable contract
(the Miles MP3 provider, `ijl15.dll`'s JPEG codec) — the decision in `roadmap/decisions.md` under
"A redistributable runtime is ours to reimplement, regardless of who shipped the copy". Nothing
new to add to the TODO list from this phase specifically; its open items are already there under
the WC3-demo and NFS rows.

**The hosted Layer 3 (MP3) provider was made to answer inside the call, closing a repeat-loop
defect the hosting itself hadn't caused.** Music at a title's menu was heard repeating — the
streaming buffer lapping itself, 460–656 KB of stale bytes in the 10–15 s bin of a cold start — even
after the decoder had been hosted (Phase 6, "A redistributable runtime…"). Cause: the middleware
calls the provider's stream function expecting the requested sample count *before the call
returns*, holding its own lock while it asks; the hosted provider decoded through the platform's
`AudioDecoder`, which answers on its own browser thread and was measured starved for seconds by a
cold start's burst of wasm compilation, so a request that ran ahead of it parked the guest thread
with the middleware's lock still held. The fix moved decoding into the same vendored FFmpeg build
this engine already uses for cinematics, given a container-less WAVE-tag entry point that delivers
samples inside the call, falling back to the platform decoder per-stream only when that build isn't
available. Measured over two cold starts: stale-byte replay fell from 680/1522 KB to 199/283 KB in
the first 90 s, and the provider's `waits` counter (a request parked on the decoder) fell to 0 from
39–42. *2026-09-12, `83b157df`.*

## Phase 7 — Input *(no document; partly built)*

Also never had its own document. Keyboard, mouse and gamepad reach the guest; `EnumDevices`
writes real device instances through a guest callback (`d32abd2`, and the thread-naming fix for a
second device's callback, `ff0d2d3`/`ee5c8af`); `GetAsyncKeyState`'s low bit and
`GetKeyboardState`/`SetKeyboardState` are answered; `SetCursorPos` moves the router's cursor; a
cursor hidden through user32's own `ShowCursor`/`SetCursor` is now reported to the page as a
`cursor` event, the same channel Direct3D's device methods already fed (`a99d1f2`), which is what
a launcher's pointer lock actually waits on. `SendInput` covers the mouse; keyboard and hardware
`INPUT` are refused with a divergence rather than faked (`[из фазы 7]`, already in the TODO
list's Win32/kernel section).

**A press is written to the log, at trace level, with the position it was mapped to and the window
message it became.** Tracing input meant watching the calls a program makes into USER32/DINPUT,
which say what was *asked* and never what *arrived* — so "did the click get in, and where did it
land" was unanswerable from a journal, which is the one question a viewport that ignores the mouse
actually raises. One record per press or release, formatted behind the trace-level check and
written into the shared ring with nothing asked of the engine thread — the cost when nobody reads
it is one comparison per press, and a press is a human gesture, so no rate makes that matter.
*2026-09-13, `06d3a429`.*

## Process creation

Cross-cutting rather than a phase of its own — it grew out of a measurement during Phase 8's
bring-up (Warcraft III's launcher looping `CreateProcessA`/message-box/repeat) and its design
(replacement rather than two processes or two machines) is recorded in `roadmap/decisions.md`.
This section is what the design turned into.

**Built, in order.** win32's per-process state (`libraries`, `exitCode`, `hive`, `queue`, `com`)
was already instance-scoped by the time this was built — nothing to do there. The kernel gained a
`process` handle type (`layers/kernel/internal/processes.js`): a record with an image path, command
line, a `suspended`/`completed` pair, deferred `WriteProcessMemory` patches, and an exit code that
is `STILL_ACTIVE` until the child runs. `layers/win32/kernel32/spawn.js` holds
`CreateProcessA`/`W`, `WinExec` and `WriteProcessMemory`; `WaitForSingleObject` on a `process`
handle blocks its thread for good (a zero timeout polls `WAIT_TIMEOUT` instead, since a parent only
checking must not be stopped); `ResumeThread` on the child's thread handle clears `suspended`. A
redistributable installer (`DXSETUP`/`DXWebSetup`, `vcredist*`, `dotnetfx*`/`ndp*`/`netfx*`,
anything under a `DirectX\` directory, matched on the child's own file name) is recorded
`completed` at creation, since this engine already carries the runtime it would have installed, so
a title that spawns one and waits gets an immediate answer instead of a real wait. `app.js` was
split into `buildApp` (one machine, one image) and a `createApp` facade that rebuilds it on the
child's image when the parent's last thread has exited or is waiting on the child's handle — reading
the child off the volume, exporting the session, disposing, rebuilding with the child's bytes,
command line and deferred patches replayed against its now-mapped image, then reseeding the volume
with whatever the parent wrote (what a self-extracting installer's payload needs). Diagnostics
(`spawned`, the last sixteen replacement requests with backtraces, a `refuseReplacement` switch)
close the loop the design flagged: a replacement loop otherwise erases its own evidence, one
restart at a time. `SetThreadContext` was not built — nothing in the corpus calls it yet, and the
deferral machinery it would feed already exists.

**What this did not unblock, measured.** The Warcraft III demo installer no longer dies in msvcrt
startup (`__getmainargs`, `_initterm`, `_controlfp`, `__set_app_type` closed alongside it) and now
runs to its own end screen through the ordinary replacement path. `Frozen Throne.exe`'s own
launcher loop — the case this design was written for — was measured at the time not to execute a
single host call at all (`eip=0`, nothing called); whichever fix let the demo installer's launcher
loop complete likely applies to the same class of program, but that line was not re-verified
against `Frozen Throne.exe` specifically after the fact and should not be read as still current.
Doom 3's Wise-format installer stub never reached `WinExec` in the run this recorded — it couldn't
extract its own payload — so process creation was not what stopped it; not re-measured since the
missing calls that blocked extraction were closed. **Battlefield 2 is the concrete "two machines"
case the design named as out of scope**: its installer's parent starts a child, waits for it, and
only then copies files itself — a parent that must resume *after* its child rather than being
replaced by it. Confirmed by a real run: the engine waits, replaces onto the child, and the parent's
post-wait code (its own file transfer into `C:\App`) never executes. Tracked as work, not solved
here — `roadmap/00-TODO-list.md`, Win32/ядро.

## Phase 8 — Installers

**Partly built, and the document's own "Where this stands" note is still accurate against the
code** — checked directly: `tools/make-btl.mjs pack` still takes only a directory, so I1/I2/I6
(host-side zip/ISO/RAR readers) remain unbuilt and families A and B are still acquired by hand.
`@bottlify/installer` (the prefix model — a temp OPFS scope, the installer's media mounted
read-only beside it, the user drives it, the last process exiting hands back the prefix as the
answer) exists and is wired into the launcher behind `allowInstall`, exactly as the phase decided
in "The shape the install takes". `.bottlify\registry.json` is written on capture; the engine
does not yet read it back on mount (`[из фазы 8]`, TODO Инсталляторы) — a bottle made this way
still loses its registry when played.

What the document listed as missing Win32 surface has moved substantially since it was written,
and the corrections matter: the msvcrt C startup set (`__getmainargs`, `_initterm`, `_controlfp`,
`__set_app_type`) **is now built** ("Process creation" above — the Warcraft III demo installer no
longer dies in msvcrt startup and now runs to its own end screen); `CreateProcessA/W` and
`WinExec` **are now built** (replacement model,
`kernel/internal/processes.js`, `win32/kernel32/spawn.js`); shell32's `ShellExecute`, an
executable associated with itself, and `CLSID_ShellLink` **are now built**. Still missing, exactly
as the document said: the kernel32 `_l*`/16-bit file family, `GetTempFileNameA`, the profile (INI)
functions, `GetShortPathNameA`, `MoveFileExA`; advapi32's token half (`OpenProcessToken` and the
rest, answering "yes, administrator"); shell32's special folders (`SHGetSpecialFolderLocation`,
`SHGetDesktopFolder`); and — the largest single item, unchanged — `DialogBoxParamA`/
`DialogBoxIndirectParamA` with a real modal loop and window procedures for the system control
classes. A concrete instance of that last gap was found this range and is new: the EA AutoRun
wizard used by NFS Underground 2's second stage is a modeless-dialog state machine whose app
reads the dialog handle a `WM_INITDIALOG` handler is supposed to have published — and this engine
*posts* `WM_INITDIALOG` rather than sending it during creation, so the handle the app reads is
still zero (`qwen-installshield/dbg/installers/qwen-report.md` Task 3, stop 5). `[из фазы 8]`,
filed as its own row in the TODO list rather than folded into the existing AutoRun line, because
it names the exact contract (send during `CreateDialogIndirectParamA`, not post after).

I4 (process replacement + `WinExec`) is done and has run real installers past it (Mafia end to
end, NFS Underground 2's SFX stage). I5's forced decision is now observed rather than theoretical:
Battlefield 2's installer needs a parent and child *alive together* — the exact "two machines"
case the phase predicted — and is parked on the master plan's multi-process item, not solved by
replacement (`[из фазы 8]`, already the TODO's Win32/kernel item 1). Splinter Cell's stop is now a
different one than the document guessed: not a missing Win32 function but an unhandled MSVC C++
exception (`__CxxFrameHandler` dispatch), because `UnrealizeObject` — the actual first gap — was
closed (`qwen-installshield` Task 1). The document's two open questions ("where do special
folders live", "does the loader handle a UPX-packed image") are both still open; UPX is now
answered by measurement rather than by inference — Mafia's UPX-packed stub installed end to end,
so the loader and memory layer are happy with a section that is all virtual and then written to
(`qwen-installshield` Task 3). `[из фазы 8]`: the special-folders policy question, TODO
Документация/Инсталляторы.

## Phase 9 — Networking

**Partly built, further along than the master plan's one-line entry ever suggested, and this
document's own account (written directly against `modules/networking/` and `layers/win32/
wsock32/`) is current — no networking-specific commit landed in the range this history covers.**
The seam (`layers/win32/wsock32/transport.js`, a stream named by an engine-allocated id rather
than an address pair, bytes copied at hand-off, a refused dial recorded on the socket as well as
returned, a lost link answered rather than left silent) and the socket registry above it are
built and tested without a network at all. `WSOCK32.dll`/`WS2_32.dll` cover socket lifecycle,
send/recv variants, `select`, byte order, name resolution, and the overlapped extensions
(`AcceptEx`, `ConnectEx`, `DisconnectEx`). `@bottlify/networking` (the relay, RFC 6455 server side,
room addressing on a private `10.86.0.0/16`, default-refuse policy, `--allow`/`--origin`) has zero
runtime dependencies and is tested end to end against fake peers and a real WebSocket client.

**Still not built, unchanged from the document**: `WSAAsyncSelect`/`WSAAsyncGetHostByName` (named
as "the largest single gap between what exists and what a game of the target era will actually
call" — `[из фазы 9]`, now the lead item of the Quake III network chain in the TODO's week goal);
`WSAEventSelect`; DirectPlay (nothing at all beyond the master plan's one sentence); a room
manager as a product; WebRTC NAT traversal; and, most importantly, **a measurement with two real
peers** — every existing test drives fake peers or a loopback, and nothing has yet played a
networked game between two tabs or two machines. The document's own ordering (`WSAAsyncSelect`
first, then the two-tab LAN-browser measurement, then DirectPlay only if a target title's import
table asks for it) is unchanged and is what the week-goal chain in the TODO list now follows.

## Phase 10 — Bringing up Warcraft III

**W1 through W3 closed; W4 in progress**, and this is the phase whose own text already says so —
nothing here needed correcting against the code, only carrying forward. Warcraft III runs in a
browser on a real GPU and draws its main menu (`node tools/cdp_test/game.mjs
warcraft-iii-frozen-throne`). What closed each stage, kept for the reasoning rather than the
numbers: the suspected wrong COM calling convention (thiscall) was corrected to stdcall-with-
pointer-on-the-stack and every COM call in the engine moved at once, which is the shape a wrong
convention always takes; the Direct3D 8 device grew from about thirty of ninety-four slots
answered to eighty-two; the cheapest path to a first real-GPU frame was a hand-written
thirty-instruction guest program, not the game, and it and the game now share the same path.

W4's list — input routing, audio output, windowing, pacing under load against the master plan's
thresholds — is **partially closed** since the document was written: keyboard, mouse and gamepad
now reach the guest and sound leaves the engine (Phase 6/7 above). What is still open from W4,
now measured rather than guessed: the frame cost on deep water is the per-draw crossing doubling
with the draw count (618 vs 312 draws/frame — `qwen-installer/dbg/wc3/report-water.md`,
`report-draws.md`), and a preparation cache plus a lock-range fix landed against it
(`0aefa0c`, `edf821a`) with no after-table on water itself, because every attempt to reach deep
water on the branch that carries the fix stalled first on a distinct, reproduced-twice defect —
the engine keeps running while it stops presenting anything after the intro
(`qwen-installer/dbg/wc3/report-after.md`, §1) — which is `[из фазы 10]`, now the lead blocker of
the Warcraft III week-goal chain in the TODO list, ahead of the water measurement itself.

## Phase 11 — The generated code, and the frame it has to fit in

**Active, and substantially executed already** — the document is explicit that every step is
measured before being kept, and the "Done" section inside the phase document itself already
records: step 0 (the profiler build), step 1 in two forms (module chaining, then one lookup per
exit), step 3's first form (x87 inline on the compiled path, not yet the interpreter's arms),
step 5 (dead flags, measured no difference, off by default), step 6's read half (flat memory
without paging), the exit-mix fixes (`fwait` compiled instead of ending its block, string
instructions looping inside their block, the interpreter fallback continuing the block, blocks
crossing a page end without paging), and Part II's B8/B9 first piece (the trap's per-call record
and clock, an unlocked buffer read through a window). Each below was found with the browser
profiler on a real title (menu, or the saved battle where noted), fixed, and re-measured; all
compare `frame`/`guest`/`share-of-page` before → after unless stated otherwise.

- **Trap dispatch's own overhead** (the argument-region lookup, a per-call detail-ring allocation,
  two clock reads for a phase nobody asked for, per-call argument-string reads): region check
  2.34%→0.08% of the page, GC 1.06%→0.56%, clock reading 2.7%→1.4%, host's own code 22.8%→19.9%;
  argument strings gated behind a flag that is off by default. *`a0cfa971`.*
- **A file view now waits for its bytes instead of answering "out of memory", and a refused
  allocation reports what it asked for against the arena's largest free span** — the actual cause
  of a title dying one run in eight with a bogus "not enough memory" while 3/4 GB sat free; a
  second silent path (`VirtualAlloc` committing past a page-rounded reservation Windows would have
  granted whole-granule) fixed alongside it. *`b74caa01`.*
- **Reads and writes compiled while paging is off check one address range (a write also a
  has-code-per-page byte) instead of walking the TLB**, since the machine never turns paging on:
  menu frame 16.0→14.0 ms (guest 10.6→9.2), 63→69 fps on reads; writes add a per-byte code table so
  a page mixing data and code only loses its compiled modules when a write actually lands on an
  instruction. *`a0cfa971`* (reads), *`1a03d167`* (writes, unmeasured on a title as of this pass).
- **A compiled block now runs across a page boundary instead of stopping short of it** (half of all
  block exits used to be "ended at the page's last 15 bytes" for fear of an unmapped next page,
  which paging-off makes moot): menu entries into generated code 173k→70k/s, interpreted
  instructions 490k/s→160k/s. *`a0cfa971`.*
- **The device-state block's six shadow counters are read in place rather than copied into an
  array to diff** — no measurable time difference, but the per-call allocation is gone.
  *`a0cfa971`.*
- **`GetLastError`/`SetLastError`/`TlsGetValue`/`FlsGetValue` are guest code reading/writing the
  TEB directly**, since together they were four calls in five a title made into the host: entries
  into generated code 230k→173k/s (the crossings removed). *`a0cfa971`.*
- **An interpreter-fallback instruction (`fnstsw`, `ldmxcsr`/`stmxcsr`, any non-custom memory form)
  no longer ends its compiled block**, only exiting when a fault actually moves EIP: menu entries
  230k→188k/s. *`a0cfa971`.*
- **A locked-and-unlocked vertex buffer is read through a window on guest memory, copied once,
  and the per-call clock reading samples one crossing in eight** rather than every one: saved
  battle host share of the page 22.7%→20.4%, the buffer copy 1.9%→0.3%. *`a0cfa971`.*
- **`rep movs`/`stos`/`scas`/`cmps` now run to completion inside their compiled block** instead of
  exiting per page: menu entries 401k→206k/s, runtime share of the page 8.2%→7.5%. *`a0cfa971`.*
- **`fwait` is compiled instead of ending the block** (it can raise `#NM`, but only when CR0's MP
  and TS bits are both set — checkable inline): menu entries 602k→401k/s, frame 15.9→15.3 ms.
  *`a0cfa971`.*
- **Flags an instruction writes and nothing downstream reads go unrecorded**, decided by a
  same-block lookahead at compile time: measured no frame-time difference on the title tried, kept
  behind a configuration flag rather than defaulted on. *`a0cfa971`.*
- **One lookup on an indirect exit (`ret`, `jmp [r]`) answers all three questions** (stayed in
  module / chained to another / fell to the runtime) instead of two separate lookups: saved battle
  3.9%→2.8% of the page. *`a0cfa971`.*
- **Generated code tail-calls into another compiled module directly on a resolvable exit**
  (`call`/`ret`/indirect jump crossing a page, three exits in four in one title's match) instead of
  returning to the runtime to look the target up: menu entries 2.25M→528k/s, frame 19.0→18.3 ms;
  saved battle entries 4.2M→406k/s, runtime share of the page 11.3%→7.5%. Measured node-only (no
  browser), the same program ran no faster chained — the gain is what the browser's own engine does
  with a tail call. *`a0cfa971`.*
- **x87 arithmetic, loads and stores are emitted inline on registers tagged as doubles**, falling
  to the 80-bit helper only where a double can't hold the value: menu frame 18.3→16.0 ms (guest
  12.6→10.6), saved battle x87 share of the page 7.4%→3.5%. *`a0cfa971`.*
- **The exchange, constants, sign changes, compares, register-to-register stores, square root and
  narrow integer loads/stores keep the double tag too**, closing the "one untagged form poisons
  every inline op downstream that reads it" gap: menu frame 18.3→16.0 ms, guest speed 179→214
  M instructions/s. *`1345e750`.*
- **An exhaustive kept/wide counter, and more helper forms (80-bit/word/quadword loads, exchange,
  round-to-integer, scale, remainder, conditional move, `fsave`/`frstor`, the transcendentals) now
  leave a register tagged too** — on an oracle program, helper writes that kept their tag rose from
  a baseline to 370,526 of 390,526, with the remaining 20,000 being one value no double can hold by
  construction. Not yet measured on a title's own frame. *`7f074014`.*
- **A release build can now say *why* the interpreter ran and on which page** (no compiled code for
  the page at all / entry point missing / near the page's end with cross-page compiling off /
  module compiled for a different state), where before the profiler-only counters didn't exist in a
  release build at all and "no code at all" had no counter in any build. Built as an instrument,
  not yet spent — the capture that uses it on a real stall is next. *`b94d3d7e`.*
- **Per-frame diagnostics now carry the same reasons, their step counts and the compiled-step
  count** (13 more loads/stores at frame close, 53→66 columns), so a long frame's interpreter time
  can be attributed without a 250 ms timer sample landing on the wrong frame. Also not yet spent.
  *`06d3a429`.*

**Open, and now with concrete progress against it since the document's own "still to try" list**:
x87 inline for the *interpreter's* arms (as against the compiled path's, already done) has a
built and CI-released fork patch (`claude-x87` worktree, branch `x87-inline-2`, tag
`build-96c1a10`) — the exception-flag parity, the configuration gate, and a per-address x87
retirement counter are all in and probed, but **not yet re-pinned into this tree's
`vendor-lock.json` and not yet measured on a real title through a browser**. That re-pin and
measurement is `[из фазы 11]`, now the lead item of the Doom 3 week-goal chain in the TODO list.
SSE/MMX inline on v128, dispatch metadata as flat arrays, the D3D9 command arena, and the
`d8a189fe` double-free class are all still open exactly as the document's own table says.

## UI: quick start

A small, deliberately shallow first pass at the product UI, kept independent enough of the engine
that it could be built and thrown away without the runtime noticing — the point was to have
something to click while the engine grew, and to prove the public `@bottlify/core` surface is
actually enough to build on, never to reach past `createApp`/`AppController` for anything.

**Built, and moved.** All four steps (U1 the shell, U2 the catalogue, U3 the session view wired to
`createApp`, U4 pause/resume) are done. It now lives at `ui/` in the working copy — outside the npm
workspaces and gitignored, shipping from its own place with its own assets — rather than at the
originally planned `modules/ui`. The session view shows a real canvas, not the placeholder the plan
described, and an install screen (behind `allowInstall`) exists that the plan explicitly excluded.

**The decisions fixed on entry all held**: React + MUI confined to this package alone, so the
engine stays framework-agnostic and dependency-free; talk to the engine only through `createApp`
and its `AppController`; Vite over webpack, because the engine is plain ES modules Vite serves
natively rather than bundling first, and it handles the worker entry point and the `.wasm` asset
with no configuration; a monochrome look (graphite `#4a4e52`, paper `#ffffff`, backdrop `#1e2022`)
with emphasis carried by weight/size/contrast/space rather than an accent hue, so colour stays free
to mean something later (a failure, a warning); the engine runs in a worker, the UI never drags
execution onto the main thread.

**Not in scope, and still true**: accounts/saves/sync/anything server-side, mobile layout and
touch controls, and graphics/audio/input surfaces beyond the session view's own placeholder region
(superseded in practice — the session view now shows a real canvas, per above).
