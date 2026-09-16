# Process creation

**Status:** implemented, unproven against a real title. The design below stands as
written; what changed after building it is recorded in "What was built" at the end.

## The problem, as measured

Warcraft III's `Frozen Throne.exe` is a launcher. It reads its command line, calls
`CreateProcessA` to start `war3.exe`, and when that call fails it loads an error string and
shows a message box — then does it again. One probe run measured the loop directly:

```
1170  USER32.dll!LoadStringA        293  USER32.dll!MessageBoxA
 878  KERNEL32.dll!EnterCriticalSection    293  KERNEL32.dll!GetCommandLineA
 878  KERNEL32.dll!LeaveCriticalSection    292  KERNEL32.dll!CreateProcessA
                                           292  KERNEL32.dll!GetLastError
```

We currently side-step it by naming `war3.exe` as the bundle's entry point. That works, it is
honest, and it is the right thing to have done first. But the decision is being made by a
manifest, and a manifest cannot answer the cases that follow: a launcher that patches its child
before resuming it, an updater that re-execs itself with different arguments, a program that
spawns a helper and waits on its handle.

## What the engine is today

Four facts, each read out of the source rather than assumed. They are what any answer has to
live inside.

**The kernel has no notion of a process.** `layers/kernel/` is threads, handles, synchronisation
and a clock. Nothing there knows that a thread belongs to anything larger. Adding processes means
adding a concept, not extending one.

**Memory regions refuse to overlap and cannot be removed.** `regions.js` exports `register`,
`protect`, `find`, `assert`, `list` — and no `unregister`. Overlap is rejected as a layout bug,
deliberately, because "it is far cheaper to hear about it here". Two images that both want
`0x400000` therefore cannot coexist without either relocating one or teaching this layer to
release.

**win32's state is module-scoped, and `create()` reassigns it.** `libraries`, `exitCode`, `hive`,
`queue`, `com` are `let` bindings at module scope. A second `win32Module.create()` in the same
realm does not add a process — it overwrites the first one's registry hive, message queue and COM
registry. This is a latent defect today, independent of anything below.

**A second `createApp` in one realm works after the first is disposed; a second one alongside it
does not.** Measured (`scratchpad/restart-spike.mjs`):

```
first : exit=0 printed="Hello from Bottlify"
second: exit=0 printed="Hello from Bottlify"
RESULT: a second createApp in one realm works.
alive : exit=0 printed="Hello from Bottlify"
RESULT: nested createApp FAILED — cpu: already booted
```

That last line is the one that matters. Concurrency is blocked at the CPU layer before the win32
state sharing is even reached, and sequential replacement already works with no new machinery at
all.

## Three ways this goes wrong, known in advance

Replacement has been built before, elsewhere, and the shape of it is unremarkable: record the
request, restart the guest onto the child image. What is worth having in advance is the list of
defects that shape, built naively, walks into. Each of these costs a day to rediscover:

- **argv[0] must be quoted.** Win32 hands a child one string, and argv[0] ends at the first space
  unless it is quoted. Publishing the image name unquoted made a launcher that strips argv[0] to
  build its child's command line keep the tail as an argument and re-append it every restart —
  looping forever with the line growing. Our launcher is literally named `Frozen Throne.exe`.
- **The image lookup must be case-insensitive.** The bundle index is case-sensitive and Win32
  paths are not. A launcher naming `war3.exe` for an entry spelled `War3.exe` fell through to the
  manifest entry point — the launcher itself — and looped. Our bundle contains `war3.exe`,
  `Warcraft III.exe` and `Frozen Throne.exe`, so this is live.
- **Named objects have to survive the replacement.** A launcher creates a named mutex and re-execs;
  the child creates its own, and every single-instance or handshake protocol between the two
  silently passes when it should fail, or fails when it should pass.

And one piece of engineering to take rather than invent: **`CREATE_SUSPENDED` +
`WriteProcessMemory` + `ResumeThread` is handled by deferral.** The writes a launcher makes into
its suspended child are recorded as patches against an image that does not exist yet, and replayed
once the child's PE is mapped. No cross-process memory is ever needed. That is process hollowing
implemented as a queue.

Finally, a diagnostic constraint that follows from the design rather than from any bug: **a
replacement loop erases its own evidence**, because each restart wipes the logs and every in-memory
ring. So the request record has to outlive the restart — a ring of the last few requests with the
caller's backtrace — and there has to be a switch that refuses the replacement outright, so the
guest stands still at the call with its stack intact instead of rebooting past it.

## The decision

**Replacement.** `CreateProcess` records a request; the parent keeps running; when the parent
exits or waits on the child's handle, the engine tears the app down and rebuilds it on the child
image.

The argument is not that replacement is the most complete answer. It is that the alternatives buy
something we do not need at a price we cannot currently pay:

- **Two processes in one address space** requires per-process handles, heap, module table, message
  queue and registry — the whole of win32's module-scoped state — plus region release in the memory
  layer, plus relocating one of two images that both want `0x400000`. An image without relocations
  cannot move at all. This is weeks, and it is blocked behind `cpu: already booted` regardless.
- **Two machines** costs a second emulator, a second copy of everything in it, and a channel
  between them for the two facts that actually cross (a handle to wait on, an exit code). For a
  launcher that exits immediately after spawning, we would be paying for full isolation to model a
  process that lives for milliseconds.
- **Refusing** is what we do now, and it is fine until the first launcher that patches its child.
  It has no answer for a self-re-exec with different arguments, which is how a program applies its
  own settings changes.

Replacement gets the common case exactly right, costs almost nothing, and — the deciding point —
makes the `0x400000` collision disappear rather than solving it. There is only ever one image at
that address because there is only ever one process.

What it rules out, and we accept: a parent that genuinely runs alongside its child. If a title
needs that, this design does not stretch to cover it, and the honest move then is two machines,
not two processes in one.

## The concrete answers

**Where does the child's image go?** At `0x400000`, its preferred base, because the parent is gone
by the time it is mapped. This is the whole point.

**What is the process handle, and what does waiting on it do?** `CreateProcess` returns a real
handle to a process record — the kernel gains a `process` handle type, which is the one concept it
must learn. The record holds the pending image, its command line, its patches, and an exit code
that is `STILL_ACTIVE` (259). `WaitForSingleObject` on it is the trigger: a parent that waits for
its child has told us it has nothing left to do, so the wait is where the replacement happens. The
wait never returns, because the thread that issued it ceases to exist — except for the one child
the engine answers for itself rather than running: a redistributable installer (`DXSETUP` and
similar, §"What was built") is recorded `completed` at creation, and a wait on it returns at once
with its exit code, because there is no runtime left for it to install that this engine does not
already carry.

**What does `GetExitCodeProcess` return, and when?** `STILL_ACTIVE` for as long as the parent can
ask, for the same reason — there is no moment at which the parent is alive and an ordinary child
has finished, so any other answer would be a fiction — with the same one exception: a
redistributable installer reports its own code (0) from the moment it is created.

**`CREATE_SUSPENDED` + `WriteProcessMemory` + `ResumeThread`?** Made to work, by deferral.
`CREATE_SUSPENDED` records the request without scheduling the
replacement. `WriteProcessMemory` against a suspended child's handle appends a patch — an address
and bytes — to that record rather than touching memory. `SetThreadContext` records a start address.
`ResumeThread` on the child's thread handle is a second trigger alongside the wait. When the child
is mapped, the patches are replayed against it, and one that falls outside the mapped image is
refused and reported rather than applied. This is worth building at the same time as the rest: it
is a dozen lines given the record already exists, and without it a hollowing launcher fails in a
way that looks like the child being wrong.

**What has to change in win32's module-scoped state?** It has to become instance state — closed
over by `create()` rather than assigned at module scope. **This is worth doing now regardless of
which option is chosen**, because it is a live defect: two `createApp` calls in one realm already
clobber each other's registry, message queue and COM registry, and the only reason nothing has
broken is that nothing has done it yet. It is also what lets the replacement be
"dispose and rebuild" inside one realm rather than a page reload carrying state across it -- the
spike above shows the rebuild already works, and it only stays workable if nothing survives at
module scope to be clobbered.

**The smallest first step, and what it commits us to.** In order:

1. Make `win32`'s state instance-scoped. Independent of everything else, and a defect fix.
2. Give the kernel a process handle type and a record: image path, command line, patches, exit
   code. No scheduling, no execution.
3. `CreateProcessA/W` resolves the image against the volume **case-insensitively**, fills
   `PROCESS_INFORMATION`, and returns success. `WriteProcessMemory` on a suspended child appends a
   patch.
4. The driving loop in `app.js` learns one thing: when the running app has a pending replacement
   and its last thread has exited or is waiting on the child handle, dispose and rebuild on the
   child image, replaying the patches after the PE is mapped.
5. Quote argv[0] when publishing the child's command line, and keep a ring of the last replacement
   requests with the caller's backtrace plus a switch that refuses instead of replacing — because a
   replacement loop otherwise erases its own evidence once per iteration.

Step 4 is the only one that commits us to anything: it puts a process lifecycle in the app
assembler, which is where the cross-cutting decisions already live, and it is the step to revisit
if a title ever needs a parent and child running together.

The bundle's `entry` stays as it is. Naming the real executable remains correct — it is what a
shortcut on a desktop does — and it keeps working while the above is built.

## What is not established

- **Whether War3's launcher does anything besides spawn and exit.** The measured trace shows
  command line, spawn, failure, message box, repeat. Whether it also patches the child, passes it a
  handle, or waits for it is unknown until the spawn succeeds and it gets further.
- **Whether `war3.exe` behaves identically when started by the launcher rather than directly.** It
  is given a different command line, and it may check for a parent. Running it directly may be
  masking a check that has not fired yet.
- **The named-object question is real here but unmeasured.** A launcher that creates a named mutex
  and then hands over to the game expects that name to still be held; a replacement that drops it
  breaks a single-instance or handshake protocol silently, in whichever direction. Nothing in this
  tree implements named objects yet, so the problem cannot be observed — but it will arrive with the first title that
  uses a named mutex to detect a second copy of itself.
- **Whether a full dispose-and-rebuild is fast enough to be invisible.** The spike proves it works
  sequentially; it does not measure how long it takes with a real game's images and a mounted
  bundle. If it is slow, the replacement is still correct, just visible as a pause.

## What was built

The five steps, in order, and what each turned out to be.

**1. win32's state was already instance-scoped.** The defect this document describes had been fixed
before the rest was built: `libraries`, `exitCode`, `hive`, `queue` and `com` are closed over by
`create()`, and only a reference to the most recent api survives at module scope, for `diagnostics()`
alone. Nothing to do.

**2. The kernel gained processes** — `layers/kernel/internal/processes.js`, reached through
`kernel.processes`. A record holds the image path, the command line, `suspended`, a `completed`
flag, a list of patches, an exit code that is `STILL_ACTIVE` until the child runs (`0` from the
start when created `completed`), and the two handles the caller opens for it. `pending()` is the
first record that is neither suspended nor completed, which is the whole of the scheduling policy;
`finished()` answers whether a record's exit code is no longer `STILL_ACTIVE`, for a wait or an
exit-code query. Nothing in that file executes anything.

**3. `layers/win32/kernel32/spawn.js`** holds `CreateProcessA`, `CreateProcessW`, `WinExec` and
`WriteProcessMemory`; `CreateProcessA`/`W`'s refusals were deleted from `kernel32/system.js`.
`GetExitCodeProcess` there now answers for a child handle as well as for the running process.
`WaitForSingleObject` on a `process` handle blocks the thread for good (a zero timeout polls
`WAIT_TIMEOUT`, because a parent that is only checking must not be stopped), and `ResumeThread` on a
`process-thread` handle clears `suspended` — except for a redistributable installer
(`isRedistributableInstaller`, matched on the child's own file name: `DXSETUP`/`DXWebSetup`,
`vcredist*`/`vc_redist*`, `dotnetfx*`/`ndp*`/`netfx*`, anything under a `DirectX\` directory),
created `completed` so a title that starts one and waits on it is answered at once instead of
waiting for a runtime the engine already carries on its system volume.

Two things were settled from Win32's documented behaviour rather than from this document:

- **`WinExec` returns 33 on success** and the error code itself below 32 on failure, and takes no
  handle and no wait. `uCmdShow` is ignored.
- **The image is found the way `CreateProcess` finds it**: a quoted first token whole; an unquoted
  one by trying each space-separated prefix in turn (`C:\Program Files\Setup.exe /S` is otherwise
  `C:\Program` with three arguments); `.exe` appended to a name with no extension; a bare name
  looked for beside the running program first. The full search order — current directory, system
  directories, `PATH` — is not implemented, and neither are inherited handles, a supplied
  environment or a supplied current directory. Those are accepted and not acted on: the child runs
  in this machine's volume and environment, which is the parent's.

**Case folding was already free.** The pitfall this document lists as live is not: the whole
filesystem layer folds names (`filesystem/internal/paths.js`'s `foldName`, used by `tree.js` and by
the bundle source), so `volume.stat` finds `War3.exe` for a caller naming `war3.exe`. A test in
`kernel32/vfs.test.js` pins it against the real filesystem rather than a fake.

**4. `app.js` was split.** `buildApp` is one machine running one image; `createApp` is a facade over
it that rebuilds on the child. The events registry and the ring of requests are created in the
facade and handed down, so a caller's subscriptions and the record of what asked for a replacement
both outlive the process they were made against. The run loop ends the run when a child is pending
and either the guest exited or nothing can run — the second case is where a wait on the child's
handle lands, and it used to be reported as a deadlock. Then: read the child's image off the volume,
export the session, dispose, build again with the child's bytes, command line and patches, and seed
the volume with what the parent wrote. That seeding is what a self-extracting installer needs and is
worth naming: without it the payload goes with the machine that wrote it.

`placePatches` sorts the parent's deferred writes into the ones that land inside the child's image
and the ones that do not; the second are reported and dropped rather than written somewhere they
would corrupt.

**5. Diagnostics.** `spawned` reports every request while the calling stack still stands, with the
guest's backtrace attached; the facade keeps the last sixteen and `app.replacements()` reads them.
`refuseReplacement: true` throws at the handover instead of rebuilding.

**`SetThreadContext` was not built.** It needs a `CONTEXT` layout to be right, nothing in the
current corpus calls it, and the deferral machinery it would feed already exists — so it is a small
addition when a title asks for it, and a guess until then.

## What this did not unblock, measured

Three runs, headless, in Node:

- **Doom 3's Wise stub** (`_l*` file family, `GetTempFileNameA`) never reached `WinExec` as of the
  run this section records: it could not extract its payload, tried to `LoadLibrary` the temp file
  it failed to write, and exited 1. The missing calls were the ones `installers.md` already lists;
  process creation was not what stopped it. Not re-measured since `_control87`, `_ismbcspace` and
  the rest of the startup gap were closed, so whether it gets further is open again.
- **The Warcraft III demo installer no longer dies in the msvcrt startup.** The missing startup
  calls (`__set_app_type`, `_initterm`, `__getmainargs`, `_controlfp`) were closed, `va_list`'s
  window was bounded and the audio ring fix landed, and the installer now runs to its own end
  screen and exits 0 through the ordinary replacement path (`qwen-installer`, `qwen-endscreen`
  reports, `Frozen Throne.exe`'s launcher loop no longer the blocker — see below). In-map freezes
  during the run remain, host-bound and separate from process creation.
- **`Frozen Throne.exe`, the launcher this document was written about, was measured not to execute
  any host call at all** at the time this section was written — mapped, every import resolved, and
  then `eip=0` with nothing called, reproduced with the process-creation work stashed out. Whichever
  fix let the demo installer's own launcher loop complete (above) applies to the same class of
  program; this line is not re-verified against `Frozen Throne.exe` specifically since that
  measurement and should not be read as still current.
- **Battlefield 2 is the concrete "two machines" case this document predicted.** Its installer's
  parent process starts `Battlefield 2_code.exe`, waits for it, and then goes on to copy files
  itself — a parent that must resume after its child, not be replaced by it, which is exactly what
  §"The decision" named as out of scope for replacement (`qwen-installshield`
  `dbg/installers/qwen-report.md`, Task 2). It is what motivates the multi-process item in
  `../00-bottlify-master-plan.md`, and is unbuilt: the parent is torn down when the child is spawned,
  the same as any other replacement, so the copy step after the wait never runs.
