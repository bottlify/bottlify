# Phase history

Phases 0 through 11 have all been carried out — the last two days alone landed 130+ commits past
where the phase documents left them (`git log 06d3a42..HEAD`). This file is what replaced
`roadmap/phases/*.md`: one section per phase, the decisions that are still load-bearing kept
close to how they were written (short ones verbatim), the rest compressed to what was decided and
when it landed. Nothing recorded as a decision here is rewritten to say something different than
what was actually decided; a decision later reconsidered is recorded as reconsidered, with the
commit. Open scope — anything never built or never measured to acceptance — is not repeated here;
it lives in `roadmap/00-TODO-list.md`, marked `[из фазы N]` where it came from a phase document
specifically. Registers (`roadmap/registers/*.md`) are unaffected by this file and keep recording
what they always have.

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

## Phase 2 — Threads, scheduler, synchronization

**Closed, and the two hardest decisions are still exactly as measured.** What a context must save
— GP registers, EIP, segment selectors and `segment_offsets`, materialised EFLAGS, the whole x87
stack including its tag state (`fpu_stack_empty`, not a separate field), MXCSR + XMM — was
grounded by reading `vendor/v86/src/cpu.js` rather than recalled, and nothing since has found a
field missing. The instruction-counted quantum is the scheduler's own primitive, not a wall-clock
slice: `run_slice(max)` is exported by the fork and drives guest instructions only, ending early
on `in_hlt`; the *achievable* granularity is one compiled page, and a hot loop inside one block
still runs to the JIT's own in-block ceiling (`LOOP_COUNTER`) regardless of what the caller asked
for — the fork patch for that (register-16.md B7) is done, and `roadmap/00-pitfalls.md` and
`registers/decisions-and-optimisations.md` B7 carry the numbers.

History: P2.1 (the context record, with an explicit MMX-interleaved-with-x87 test) through P2.6
(virtual time credited with a floor and ceiling) landed as planned; P2.7's multithreaded fixture
closed the phase. The document's two open questions are both answered: the TEB has an address-
space home (`layers/win32/kernel32/teb.js`), and virtual time is credited from the run loop
(`app.js`), not owned by the cpu layer — recorded as decision A21 in `registers/decisions-and-
optimisations.md`. **Still not built, and now the sharper form of what this phase called "not in
scope"**: SSE/MMX inline in the emulator, and x87 inline all the way (the double shortcut behind
the 80-bit float is landed; the round-trip through the software 80-bit helper on every operation
is not) — `[из фазы 2]`, tracked under "Эмулятор" in the TODO list.

## Phase 3 — The call bridge and Win32

**Closed for the bridge; the surface keeps growing, which is expected — it was never meant to
finish inside this phase.** Every decision fixed on entry held: marshaling moved into `bridge`
(never `app.js`), calling conventions (stdcall/cdecl/thiscall) as data rather than derived from
argument count, thiscall's `this` counted inside `argBytes` and popped as `argBytes - 4`, the
async contract as a type only `park()` can produce, EAX written only by whoever resumes a parked
call, `ExitProcess`/`ExitThread` parking like any wait, guest callbacks built on a sentinel return
address rather than re-entering the CPU, and one `await` per scheduler turn so a suspended host
handler can resume. `A12` in `registers/decisions-and-optimisations.md` records the one
correction made *after* this phase closed: every COM method is stdcall with the interface pointer
first on the stack (matching real compiled binaries measured instruction by instruction), not
thiscall — `Convention.THISCALL` is kept only for a `msvcp` C++ runtime that genuinely uses it.

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

## Phase 6 — Audio *(no document; partly built)*

Never had its own phase document — the master plan's row always said "partly built, no document"
— so there is nothing here to fold beyond recording where it stands. DirectSound models buffers
and cursors correctly; the guest's clock is credited for the whole turn and a buffer is read to
its write cursor rather than only to what the last turn produced (`registers/decisions-and-
optimisations.md`, "The guest's clock runs for the whole turn…"); a device's cursor advances on
its own rather than only when the guest calls in (A18); the audio ring is a service of the run,
attached to by a rebuilt machine rather than rebuilt with it (`1206037`). Middleware decoding is
hosted rather than run as emulated x86 where it is a redistributable with a stable contract
(the Miles MP3 provider, `ijl15.dll`'s JPEG codec) — the decision in `registers/decisions-and-
optimisations.md` under "A redistributable runtime is ours to reimplement, whoever ships the
file". Nothing new to add to the TODO list from this phase specifically; its open items are
already there under the WC3-demo and NFS rows.

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
`__set_app_type`) **is now built** (`registers/process-creation.md`, "What this did not unblock" —
the Warcraft III demo installer no longer dies in msvcrt startup and now runs to its own end
screen); `CreateProcessA/W` and `WinExec` **are now built** (replacement model,
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
and clock, an unlocked buffer read through a window). Each has its own before/after pair recorded
in `registers/decisions-and-optimisations.md` with the commit, which is where they still live —
this history file does not repeat the numbers.

**Open, and now with concrete progress against it since the document's own "still to try" list**:
x87 inline for the *interpreter's* arms (as against the compiled path's, already done) has a
built and CI-released fork patch (`claude-x87` worktree, branch `x87-inline-2`, tag
`build-96c1a10`) — the exception-flag parity, the configuration gate, and a per-address x87
retirement counter are all in and probed, but **not yet re-pinned into this tree's
`vendor-lock.json` and not yet measured on a real title through a browser**. That re-pin and
measurement is `[из фазы 11]`, now the lead item of the Doom 3 week-goal chain in the TODO list.
SSE/MMX inline on v128, dispatch metadata as flat arrays, the D3D9 command arena, and the
`d8a189fe` double-free class are all still open exactly as the document's own table says.
