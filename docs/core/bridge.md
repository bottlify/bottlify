# `bridge` — the boundary a call crosses in either direction

Traps, calling-convention marshalling, host calls that cannot answer yet, callbacks into guest
code, and COM interfaces laid out in guest memory. Sits on [`cpu`](./cpu.md),
[`kernel`](./kernel.md), [`memory`](./memory.md) and `log`. Module machinery is described in
[`README.md`](./README.md) and [`system.md`](./system.md).

## 1. Purpose

Above the bridge, a host function is an ordinary JavaScript function of numbers. Below it, a
call is a stub, a trap, a stack frame and a register that has to end up holding the answer.
Neither side is allowed to know the other's shape: `win32` describes what a function is
without knowing how a guest reaches it, and `cpu` emits the stub without knowing what it
implements. The bridge is the table that joins the two, in both directions.

It does not implement any Win32 function, does not decide when threads run (it parks and
resumes them through the kernel), and does not know which guest module an address belongs to
(it labels addresses it is told about). The stubs themselves are the cpu layer's; the bridge
takes slots and gives them meaning.

## 2. Contract

| field      | value                                    |
|------------|------------------------------------------|
| `name`     | `bridge`                                 |
| `version`  | `0.1.0`                                  |
| `requires` | `['cpu', 'kernel', 'memory', 'log']`     |

Source: `src/layers/bridge/module.js`, `src/layers/bridge/internal/{conventions,dispatch,
parking,callback,vtable}.js`, `src/layers/bridge/replay.js`. `memory` is required as well as
`cpu` so a call frame is read through the region map: a wild ESP fails there rather than
marshalling whatever bytes live at it.

### Configuration

| option | type | default | meaning |
|--------|------|---------|---------|
| `record` | number | `0` | How many seam events to keep for `recorded()`; 0 disables recording. |
| `lastError` | `() => number` | `undefined` | Reads the running thread's last error after each call that can have set it, for the detailed trace. Handed down by the assembler because it belongs to `win32`, which is above this layer. |
| `traceStrings` | boolean | `false` | Read the text behind pointer arguments at call time (a scan of guest memory per pointer per call). |
| `callPhases` | boolean | `false` | Time every handler as a phase of its own in the profiler; the crossing itself is always sampled. |
| `onCall` | `(record) => void` | `undefined` | A sink handed every call record as it is made (and again when a waiting call answers). |

A call record handed to `onCall` is one of a ring the dispatcher reuses, fields written in place on every call; its `result` is an own, enumerable getter defined onto the record rather than written in its literal -- a getter in a literal puts the object in V8's dictionary mode, which made each of the record's seven writes per call a hash lookup (the dispatcher alone, 95 -> 30 ns a call). A sink's `{ ...record }` carries it all the same.

### API

| member | signature | meaning |
|--------|-----------|---------|
| `Convention` | `{ STDCALL, CDECL, THISCALL, FASTCALL }` | |
| `register` | `(name, { convention = STDCALL, argBytes, handler, preserveResult?, lastError = true }) => number` | Makes a host function callable; returns the guest address of its stub. `argBytes` counts every argument including `this`. `lastError: false` says the function never sets the thread's error, so the trace does not read it afterwards; COM methods are registered so, and OPENGL32's gl* entry points. Throws for `Convention.FASTCALL`: only `hook`'s stub pushes EDX before it traps, so a `register` stub built for it would hand a handler the return address as its second argument. |
| `watch` | `(name, { argBytes, target, convention?, handler }) => number` | A forwarding stub: `handler` sees the marshalled arguments, then the call goes on into `target`, always. For observing calls between guest modules. |
| `hook` | `(name, { convention = FASTCALL, argBytes, target, handler }) => number` | A slot hook: `handler` answers `true` (it computed the call itself) or `false` (run `target`, the guest's own function, instead) -- decided fresh on every call, unlike `watch`'s unconditional forward. Returns the guest address to write into whatever data word (a vftable slot, typically) a caller wants redirected; the caller writes it, this layer only builds the stub and the dispatch. |
| `siteHook` | `(name, { trampoline, resume, stackAdjust?, handler }) => number` | A site hook: `handler(registers, frame)` sees all eight general registers as a plain object and answers `true` (moves EIP to `resume`, ESP to `registers.esp + stackAdjust`) or `false` (restores every register to what the site held, moves EIP to `trampoline`) -- see "Site hooks" below. Returns the guest address a code patch at the site should jump to; the caller (the loader's `bindHooks`) writes the patch, this layer only builds the stub and the dispatch. |
| `reportHookMismatch` | `(name) => void` | Counts one of a hook's own comparisons against the guest as having disagreed. This layer does not know what was compared -- an oracle-mode kernel calls it once it has checked the guest's output against its own -- it only keeps the count, in `diagnostics().hooks`. |
| `park` | `(thread?) => ParkedToken` | Parks the calling thread and returns the only value a handler may return instead of an answer. Throws outside a call. |
| `callGuest` | `({ entry, args?, thread?, stackAtRest?, registers? }) => Promise<number>` | Runs a guest routine and resolves with EAX. A handler that awaited before calling must pass `thread`. `registers` are set before the routine's first instruction -- the frame pointer a funclet reads its parent's locals through. |
| `continueAt` | `(registers, { below? }?) => Continuation` | What an asynchronous handler resolves with when its call does not return: the thread continues at `registers` (`eip` and `esp` at least), and every host call and callback it was inside below `below` (default: the new ESP) is abandoned. An exception handler that found its block answers this way. |
| `holdForFault` | `(thread, { name, restingStack, hostReturn }, answer) => void` | Holds the running thread while a processor exception it took is offered to its handlers: sends it to the park loop from the vector's stub and records it as a suspended call; `answer` settles with a continuation (or a value, resuming at `hostReturn`). Called from inside the fault's trap. |
| `useHeap` | `({ allocate, free? }) => Vtables` | Wires COM publishing to a guest arena. |
| `publishInterface` | `(object, interfaceId) => number` | The interface pointer for an object model record, or 0. Throws before `useHeap`. |
| `suspended` | `() => number` | Host calls waiting on something right now. |
| `answered` | `() => Promise<void>` | Settles when the next suspended call answers. |
| `callerThread` | `() => Thread` | Whose call is being handled; read before an `await`. |
| `recentlyStarted` | `() => { entry, by, thread }[]` | The last eight guest routines the host started. |
| `recorded` | `() => SessionEvent[]` | The recorded seam events. |
| `failure` | `() => Error \| null` | An error thrown by a suspended handler that nothing was awaiting. |
| `sentinelTrap` | `() => number \| null` | The trap id a callback returns through. |
| `chain` | `() => string[]` | Suspended calls on the current thread, then the calls in flight. |
| `recent` | `(count = 12) => string[]` | The last few call names, oldest first. |
| `symbolize` | `(address) => string \| null` | The name a stub or labelled address has. |
| `label` | `(address, name) => void` | Names an address (a trampoline in a synthesised module, say). |
| `dispatch` | `(id) => void` | Handles a trap id by hand; a replay uses it. |
| `calls` | `() => string[]` | The calls the guest has made, as many as the ring holds. |

An instance owns its crossing. `create()` may run more than once in the same realm (a process
replacement runs it again; the plan for two machines in one worker needs two at once), so the
dispatcher, the parking table, the callback bookkeeping and the COM vtables live in the instance
the api closes over, and a second `create()` cannot take the first one's traps; `diagnostics()`
answers for its own graph's instance. After `dispose()`, a call that was in flight — or
a trap still arriving from a `cpu` that outlives this layer briefly during teardown — answers
harmlessly rather than throwing: `register`/`watch`/`callGuest`/`publishInterface` answer
`0`/`0`/`Promise.resolve(0)`/`0`, `park`/`useHeap`/`callerThread`/`failure`/`sentinelTrap`/
`symbolize` answer `undefined`/`null`/`null`/`null`/`null`/`null`, `suspended` answers `0`,
`answered` resolves at once, `recentlyStarted`/`recorded`/`chain`/`recent`/`calls` answer `[]`,
and `label`/`dispatch` are no-ops.

A handler is called as `handler(args: number[], frame)` where `frame` is
`{ name, freeStack, callerStack, restingStack, hostReturn }`. Arguments arrive **signed**, as
the guest pushed them. A handler returns a number (placed in EAX as `>>> 0`), the parked token,
or a promise (the call suspends and the thread parks until it settles).

Both `args` and `frame` are the dispatcher's own and are **written over by the next call**: a
handler that answers at once reads them and copies whatever it keeps. A handler that answers
later — it parked, or returned a promise — keeps the ones it was given, and the next call gets
fresh ones; so an `async` handler may read `args` after an `await`. A COM method's `invoke`
gets its arguments the same way.

### Diagnostics

`status` is `'ready'` once created. Metrics:

| metric | meaning | when it moves |
|--------|---------|---------------|
| `implemented` | Trap ids with a handler. | Each `register`/`watch`. |
| `calls` | Total traps dispatched. | Each call. |
| `lastCall` | Name of the most recent. | Each call. |
| `hot` | The forty commonest names in the 4096-entry ring, with counts. | Each call. |
| `recentDetailed` | Up to 4096 records `{ name, from, args[≤6], strings, result, error }`, oldest first. `result` is the answer in hex, or `parked`, `waiting`, `forwarded`, `threw`; `error` is 0 for a function registered with `lastError: false`. | Each call. |
| `sequence` | The last eighty names in order. | Each call. |
| `parked` | Calls that parked their caller. | Each `park`. |
| `callbacks`, `deepestCallback` | Guest callbacks started, and the deepest nesting seen. | Each `callGuest`. |
| `suspended`, `suspendedCalls` | Host calls waiting, and `{ thread, name, forMs }` for each. | Suspend / finish. |
| `comInterfaces`, `comMethods`, `comInterfacesRefused`, `comRefusedBecause` | Published interface pointers, stubs in shared tables, refusals and why. | `publishInterface`, `Release` to zero. |
| `hooks` | `{ name, calls, handled, fellThrough, mismatches, ms }[]`, one row per `hook`. | Every hook call; `mismatches` on `reportHookMismatch`; `ms` is the wall time inside the handler call itself, every call. |
| `failure` | Message of the first unawaited handler error. | Once. |

## 3. How it works

### Registration and the trap handler

`register` reserves the callback sentinel slot first (so it is in the table written into guest
memory), then takes a stub slot from `cpu.registerTrap(name, calleeCleanup(convention,
argBytes), { preserveResult })` and records `{ name, convention, argBytes, handler }` under the
id. The module claims `cpu.onTrap` at creation: a trap is either the sentinel (a callback has
returned) or a call to dispatch. A trap that reached anything but the bridge would be a call
nobody marshalled.

### Conventions (`internal/conventions.js`)

Two facts are kept apart because for stdcall they happen to be the same number: how many bytes
of arguments a function has, and how many it pops. `calleeCleanup` is `argBytes` for stdcall,
`0` for cdecl, `argBytes - 4` for thiscall (`this` was in ECX and never pushed). `readArguments`
reads stack arguments from `esp + 4` upward — the stub has pushed nothing by the time it traps —
and prepends ECX for thiscall. `argBytes` must be a non-negative multiple of four; an unknown
convention throws.

COM methods are **stdcall**, not thiscall: the interface pointer is the first stack argument,
which is what makes the C bindings binary-compatible with the C++ call. `win32/msvcrt/cxx.js`
registers two `THISCALL` exports of a C++ runtime library's real member functions; no title in
the tree is known to exercise them.

`FASTCALL` carries `this` in ECX and one more argument in EDX, the rest on the stack, callee
cleans the stack part -- MSVC's `__fastcall` with a leading receiver, which is `hook`'s own
convention (below) and the one a compiled SIMD-dispatch vtable method in the wild compiles
to. `registerArgumentCount` (`internal/conventions.js`) is the one place that knows how many of a
convention's arguments arrive in registers -- zero for stdcall/cdecl, one for thiscall, two for
fastcall -- and both `calleeCleanup` and the dispatcher's own marshalling read it rather than
each carrying the count of their own.

### Slot hooks (`hook`)

A hook stands in front of a call whose *slot* -- a data word somewhere a program reads a function
pointer from, a vtable most often -- was overwritten to point at the stub instead of the real
function; the real function is never touched and stays callable at `target`. Overwriting a slot
needs no code-page write, so nothing here has to invalidate compiled code or build a
displaced-prologue trampoline the way a code patch would; a caller writes the address `hook`
returns into the slot, this layer only builds the stub and the dispatch behind it.

Because the outcome is decided per call, a hook's stub cannot end in a fixed `ret` or `jmp` the
way every other stub does: it traps and stops, and this layer writes EIP itself once `handler` has
answered. `handler(args, frame)` returning `true` means it computed the call itself -- EDX is
restored to what the guest's call actually set (the trap sequence's own `mov dx, port` spent half
of it getting here; ECX is untouched and needs no restoring) and the dispatcher simulates the
callee's own `ret cleanup`: EIP becomes the return address, ESP advances past it and the cleanup
bytes. Returning `false` means "run the guest's own function instead": EDX is restored the same
way, but ESP is left exactly as the call arrived (return address and stack arguments untouched)
and EIP is redirected to `target`, which then runs precisely as though the original slot had never
been touched.

**A hook stands in only for a `void` function.** On `answered`, EAX is always written as `0`; a
handler has no way to place a value there for the caller to read as a return. A kernel that hooks
a non-void function (one whose callers use EAX) must fall through instead.

Because `FASTCALL`'s EDX carries a live argument that the trap sequence's own `mov dx, port`
would otherwise clobber before any handler runs, a hook's stub pushes it (`push edx`, four bytes)
before it traps -- `cpu`'s thunks call this `pushEdx`, distinct from `watch`'s `saveRegisters`
(`pushad`, thirty-two bytes): a hook runs on whatever stack depth the guest's own call already
reached, and the four bytes are the most that discipline can spend without asking a call already
near its thread's limit for room it does not have. `holdEip` is the other half: no `ret`, no
`jmp`, just the trap, so a fixed byte pattern is never asked to make a decision that has to be
made per call.

A hook's own counters (`calls`, `handled`, `fellThrough`) are kept automatically, from which
branch a call took; `mismatches` is not -- `reportHookMismatch(name)` only increments it, for
whichever kernel calls it and whatever it decided to compare. `ms` is also kept automatically:
the wall time between `performance.now()` readings taken immediately before and after the
`handler(...)` call, added up call by call -- a fallthrough accrues it exactly as an answered
call does, since the clock brackets the call itself and not which branch it took. Unlike the
`trap` phase (sampled one call in eight and weighted back up, timing the whole crossing), `ms`
times every call and only the handler's own work, which is what a kernel's per-call cost has to
be read from. Whether that comparison is even
attempted, and against what, is entirely the kernel's own code -- this layer never reads a guest
byte for a hook's sake beyond the arguments it marshals. A kernel that compares its own answer
against the guest's *at the next call it sees* is sound only when what it wrote survives
untouched until then -- a heap buffer the guest does not reuse, say. It is unsound against a
write target the guest owns and reuses, such as a caller's own stack temporary: a *different*
invocation reaching the same stack depth before the next crossing overwrites it first, so the
comparison reads memory nothing here wrote, not the guest's answer (found against a kernel's
`dst`, an `_alloca16` caller-stack local reused by the next call at the same depth).
A sound oracle for that case needs a *return* watch instead: redirect to `target` with the
return address swapped for a trampoline that traps on the way back, compare while the write is
still live, then hand control to the real caller -- a mechanism this layer does not build today.

With the journal's `call.hook` category on (off by default, like every call area), each crossing
of a hook writes two trace records: one before the handler runs -- the caller's ESP, the return
address and the marshalled arguments, as the guest's own call site left them -- and one after the
EIP write, with the branch taken (`answered` or `fellThrough`) and the EIP/ESP the guest resumes
at. The first is written before the handler, so a handler that never returns still leaves the
frame it was handed on the record.

### Site hooks (`siteHook`)

A site hook stands not in front of a call but *inside* a function: a code patch at one point in
it (`site`), resuming at another (`resume`), for a loop or a span of work a slot can never reach
-- a static function taken by `call rel32` from inside its own module, under a compiler-private
register convention no vtable or import ever names. The loader's `bindHooks` builds the patch
(the displaced instructions moved to a trampoline, a jump written at the site) once the sidecar's
three byte pins hold (see [`loader.md`](./loader.md) "Sidecar hooks"); this layer only builds the
stub and the dispatch behind it, exactly as `hook` does for a slot.

`handler(registers, frame)` sees all eight general registers as a plain object --
`{ eax, ecx, edx, ebx, esp, ebp, esi, edi }`, exactly as the site's own code held them when the
stub trapped -- and may edit any of them; unlike a slot hook's `args`, which only carries what a
call's own convention marshals, a site hook has no convention at all, because there was no call to
marshal. Answering `true` means the handler computed the site's own work itself: every register is
written back exactly as the object holds it, ESP becomes `registers.esp + stackAdjust` (so a
handler may move the stack itself -- what the instructions between the site and the resume point
would otherwise have popped), and EIP moves to `resume`. Answering `false` means "run the displaced
instructions instead": every register is restored to what the site's own call site held (not to
whatever the handler's object holds by then, if it edited before deciding to fall through), ESP is
left at the site's own value, and EIP moves to `trampoline` -- the instructions the patch displaced,
ending in a jump back into the function right after the site, as though it had never been patched.
**EFLAGS are never restored either way** -- a `pushad`/`popad` pair does not touch them either --
so a resume point that depends on flags a branch between the site and it would have set is not
safe to use. A sidecar's own kernel is responsible for loading whatever compare it needs before
such a branch, since this mechanism gives it none.

The assembling caller may hand a site kernel more than the image base in `frame` --
`host.md`'s `sidecarHooks` names `frame.gl` -- but nothing here changes: work a kernel issues
through it does not cross this layer and is not counted as a call.

A handler that throws is treated as `false`: every register restored, EIP to `trampoline`, the
same guard a slot hook's handler gets -- a bug in a sidecar's own code is not a reason to bring
the run down when the guest's own function is right there to fall back on.

The stub is `cpu`'s thunks' `saveRegisters` (`pushad`, the same as `watch`'s forwarding stub)
together with `holdEip` (the same as a slot hook's): every register saved, because the whole point
is to read and possibly rewrite all eight, and neither a `ret` nor a `jmp` baked in, because which
of the two exits above this takes is decided only once the handler has run. Each flag already
existed on its own; a site hook is the first stub to need both together.

A site hook's own counters (`calls`, `handled`, `fellThrough`, `mismatches`, `ms`) and the
journal's `call.hook` records work exactly as a slot hook's do -- a site record's "arguments" are the eight
registers, in the same declaration order the object exposes them. There is no in-browser oracle
for a site hook: the "compare at the next crossing" trick a slot hook's kernel may attempt (see
above) has no analogue here, because there is no return value and no single write target to
compare -- a site kernel is checked offline instead, against the real function in the real
emulator, before it is ever bound in `replace` mode.

### Dispatch (`internal/dispatch.js`)

`dispatch(id)` reads ESP (plus `forwardSave` for a forwarding stub), reads the arguments off
the stack into the function's own array (the convention was worked out once, at registration),
through one `memory.window` call over the whole span rather than a read per word; a stack that
straddles two adjacent regions (legal guest layout, though no guest here reaches it today) makes
`window` refuse the span, and dispatch falls back to reading each argument word on its own rather
than refusing the call. A span that runs past the end of the region it starts in -- a variadic
entry such as `printf` reads a fixed number of slots, and a call from a thread's first frame has
fewer words above it than that -- is read up to the region's end and zero beyond it, since past
the stack is nothing the caller passed; a span that starts in no region still fails. It records the name in a ring and a detail record in another, fills the
`frame` for this depth of
nesting — everything a handler might need about where it was called from, read **before** it
runs because a handler that calls the guest back overwrites that part of the stack — brackets
the handler with `parking.beginCall/endCall`, and then places the result:

- a number → `EAX = result >>> 0`;
- the parked token → EAX is left alone; whatever wakes the thread supplies it;
- a promise → `suspend(promise, frame)` (below);
- a forwarding call → EAX and EDX are restored from the `pushad` block and ESP is moved past
  it, so the real function sees the registers as its caller set them.

An unimplemented id or a second implementation of the same id throws. A handler that throws
still ends its call (`finally`), so the bridge is never left inside one.

The crossing is timed as a `trap` phase one call in eight (weighted by eight, which scales the
profiler's sums and never its per-occurrence figures), so the host's share of a frame is known
without two clock readings per call; `callPhases` adds a phase per handler. Both, and the clock
around a hook's kernel, are diagnostics a production bundle leaves out. A prompt
call allocates nothing: the argument array, the frame and the ring's records are made once and
written over, the answer is kept as a number and rendered as text only when a reader asks, and
the last error is read only after a function that can have set it. A call that answers late
keeps the array and frame it was given, and the next call is given new ones. A ring record's
argument array is kept while the call's arity matches it and replaced by one of the right
length when it does not: setting `length` on it every call was a trip into the runtime and a
fifth of the crossing. The engine's own sink (`app.js`, `journalCall`) keeps each call name's
trace answer until the journal's `revision` moves -- asking `enabled` by area on every call was a
tenth of the crossing -- and the last error's reader looks the win32 layer up once. Under cork, a
call of a function with no arguments (`GetCurrentThreadId` in a loop, alternating runs) went
266 -> 217 ns, and `lstrlenA`, whose string read crosses the stack, the TEB and the image, 1219 ->
834 with the memory layer's own share of it (`docs/core/memory.md`).
`internal/crossing.test.js` times a million of each kind and prints the figure.

### Parking (`internal/parking.js`)

A host function that cannot answer yet — it is waiting, or it has ended the thread that called
it — must not return a number, because the guest would take it as the answer. `park()` calls
`kernel.parkThread` with the in-flight frame's `restingStack` (parking any thread but the one
whose call is in flight is refused, since the kernel writes the return slot at the processor's
ESP) and returns a module-private immutable token; `isParkedCall` compares by identity. Nothing else produces the token, so "returned an asynchronous result without parking"
is not something a handler can say. `park` throws with no call in flight.

The same object keeps the stack of calls in flight (`beginCall`/`endCall`; depth rather than a
flag because a callback can trap into another host function). Each frame is stamped with the
thread that made it, and `freeStackFor(thread)` answers the frame's `freeStack` only when the
call in flight belongs to that thread — the whole reason it exists is that a handler which
awaited has had its call ended, the loop has turned, and the frame now standing belongs to
whichever thread trapped next.

### Suspended host calls

When a handler returns a promise, `suspend` (in `module.js`) calls `kernel.holdThread()` to
redirect the stub's return to the park loop, records the call on the thread via
`callbacks.suspended(thread, { name, restingStack, hostReturn })`, and sets
`thread.awaitingHost` (unless the thread is inside a callback, in which case it is the most
runnable thread there is). When the promise settles, `callbacks.finish(thread, value)` pops the
record, clears `awaitingHost`, settles the `answered()` promise so an idle driver loop wakes,
and `kernel.scheduleResume(thread, { eip: hostReturn, esp: restingStack, returnValue })`. A
rejected promise is kept in `failure()` — nothing above was awaiting it, and a thrown error
would otherwise vanish and leave the guest parked for ever.

A promise that settles with a continuation (`continueAt`) is a call that does not return.
`callbacks.transfer(thread, registers, below)` pops, from the top of the thread's two stacks,
every suspended host call resting at or below the line and every callback frame based below it,
and schedules the thread at the registers given. This is what a catch does: the throw was a
host call, the dispatch it started called the program's frame handler as a callback, and that
handler -- a host call again -- chose a block in a frame above all of them. None of those calls
returns; what is above the line (the window procedure the program threw in, and the dispatch
that called it) is still waiting and is kept. The abandoned promises never settle; nothing is
left that would read them.

`suspended()` tells the driver a call may be waiting on something outside the microtask queue
(a fetch, a file read), and `answered()` is what it waits on instead of a timer.

### Callbacks into guest code (`internal/callback.js`)

A handler that takes a function pointer — a comparator, a window procedure, an enumeration
callback — cannot call it directly: the handler runs inside the emulator's own loop, which
cannot be re-entered. So `callGuest` builds a frame below where the calling thread's stack
comes to rest (`restingStack`: inside the innermost callback frame if there is one, otherwise
where the suspended host call left it, or `freeStackFor(thread)` while the call still holds the
processor), writes the sentinel stub's address as the return address, the arguments above it
and one spare dword above those, pushes `{ frameBase, settle }` on the thread's callback stack, and
`kernel.scheduleResume(thread, { eip: entry, esp: frameBase })`. The handler awaits the promise
and returns it, so the dispatcher suspends the call.

When the callback `ret`s into the sentinel — a stub registered with `preserveResult`, so EAX
is moved to ECX before the trap — the trap handler calls `kernel.holdThread()` (the stub is
about to `ret` into whatever the callback left on the stack), pops the frame, and settles it
with ECX. The spare dword is what that `ret` pops: a stdcall callback has already popped its
arguments, so ESP is back at the top of the frame, and without the spare the park address is
written over the first live dword of the procedure whose call suspended — its saved register or
its return address. Both stacks are per thread and both are stacks: a callback may trap into another host
function, which may call the guest back in turn.

Three refusals, each a former silent corruption: an entry of zero is refused naming the host
call that asked; a frame that would land outside the thread's `[stackLimit, stackTop]` is
refused naming the thread; and a `callGuest` after an `await` with no `thread` named is
refused, because the thread on the processor is by then somebody else. `callerThread()` is
read at the top of such a handler, before the `await`.

### COM interfaces (`internal/vtable.js`)

An interface pointer is a real pointer to a word holding the vtable address, and guest code
walks it, calls through it by index, copies it and compares it — so the layout has to exist.
`useHeap` binds the publisher to a guest arena; `publishInterface(object, interfaceId)` asks the
object model for `object.interfaceFor(interfaceId)`, whose `methods` list describes each slot
(`{ name, argBytes, invoke?, guest?, builtin? }`).

One table of stubs per method list, shared by every object exposing it (a table per object
exhausted the stub table after a thousand textures); the first argument of every call is the
interface pointer, and an `owners` map takes it to the object. Per object and interface, a
two-word block: the vtable pointer and a state word (`object.guestState?.()`) for methods that
run as guest code. The same object and interface always answer the same pointer.

`IUnknown` is the bridge's: `QueryInterface` reads the GUID (three little-endian integers then eight
raw bytes), asks `interfaceFor`, publishes, `addRef`s the interface asked for, and answers `S_OK`,
`E_NOINTERFACE` (with `*ppv` zeroed), `E_POINTER` or `E_OUTOFMEMORY`; `AddRef` and `Release` are
passed to the object with the interface id (some object models count per interface generation), and
a release to zero forgets the pointer and frees its block. When the object then reports `destroyed`
as true -- the object itself is over, not only that interface -- every pointer it was published as
goes the same way, so one from an earlier `QueryInterface` does not keep the released object
reachable; without that word only the interface released through goes, which is right for every
way of counting (DirectDraw's generations each end apart). A pointer is kept instead when the object
answers an optional `reachable(interfaceId)` with yes: something besides the program keeps it (a
DirectSound device keeps its primary buffer), so the pointer stays, and every such pointer is asked
again after each later release and forgotten once the answer is no. `ole32`'s objects,
`oleaut32`'s, DirectInput's devices, DirectSound's devices and buffers (a primary buffer's pointers
then held by `reachable` while its device lives) and the drawing APIs' adapter
(`graphics/seam/com.js`: true when the release ended the object -- a count of zero on an object
that does not say it outlives it, which a DirectDraw object says while another generation is held)
report `destroyed`, and so does the DirectInput object itself. Each pointer forgotten is told to
its object through an optional `forgotten(pointer, interfaceId)` once its block is back in the
heap, so a map an object model keeps from pointers to objects drops it before the words can be
another interface's; the DirectInput and DirectSound publishers do. A method without `invoke`
answers `E_NOTIMPL`; a call through an unpublished pointer answers `E_POINTER`. A method's
`invoke` may return a promise, and the caller is parked on it.

A table that cannot be built — stub table full, or the arena refusing — is counted as a refusal
with its reason, and the guest gets a failure code rather than a null pointer with `S_OK`.

### Recording and replay (`replay.js`)

With `record > 0`, the seam events `call`, `park`, `guest`, `returned` and `finish` are kept in
order. `replaySession(session)` drives the real bridge module over a machine of stubs with the
recorded interleaving and no guest code; the bridge's own invariants decide whether the session
still fails. `sessions/README.md` documents the file format; `replay.test.js` plays every file
in `sessions/` and checks the refusals are exactly those the file lists.

## 4. Limitations and divergences

- **Four conventions.** Anything passing arguments in registers other than thiscall's ECX or
  fastcall's ECX/EDX is not marshalled. A forwarding stub (`watch`) preserves all registers for
  its target but the handler only sees stack arguments (and ECX under thiscall, ECX/EDX under
  fastcall).
- **A hook's fallback is a redirect, not a call.** `target` runs with the registers and stack the
  guest's own call set, but nothing about *this* call -- the trap, the marshalled arguments, the
  frame -- is visible to whatever the guest's function does next; a hook sees a call before the
  guest's own code does, never after it returns.
- **Results are 32-bit integers.** A 64-bit result (EDX:EAX) or a floating-point result has to
  be placed by the handler through `cpu.writeReg32`/`cpu.fpu`; the bridge writes EAX only.
- **At most six arguments** are kept per detail record, and `peekString` guesses at pointers
  (printable ASCII under 96 bytes, address ≥ 0x1000); a trace line may name a value that only
  looks like a string. For a site hook's eight registers this caps the detail ring at the first
  six (`eax, ecx, edx, ebx, esp, ebp`); the `call.hook` trace's own `args=` field is the same six.
- **A site hook's `ret=` in a `call.hook` trace is not a return address.** The field is read the
  same way for every hook, off whatever word sits at the site's own ESP; a site hook was never
  reached by a call, so that word is ordinary guest data, not an address -- harmless in a trace
  line, but not meaningful the way a slot hook's `ret=` is.
- **Rings are bounded** at 4096 names and 4096 detail records; `calls()` is only complete until
  the ring wraps. A sink (`onCall`) is the way to keep everything.
- **Stub slots are never freed**; `comInterfacesRefused` rising is the sign a run is spending
  the table.
- **An abandoned host call's own code never finishes.** A handler awaiting a callback that an
  exception left through a `continueAt` stays suspended in JavaScript for ever. It holds
  nothing the guest can see, but any bookkeeping it meant to do after the `await` does not
  happen -- which is why every handler that can be passed through does its bookkeeping before
  it calls the guest.
- **A suspended call that never answers stops the whole machine**; `suspendedCalls[].forMs` is
  the only sign.
- **`callGuest` defaults the thread to the call in flight**, which is right only while the
  handler still holds the processor; after an `await` the thread must be named, and the bridge
  throws otherwise.
- **No divergence hook.** Observable-behaviour warnings from API implementations are a `win32`
  and `graphics` configuration (`divergence`), not this layer's; what the bridge reports is the
  trace, the rings, `failure()` and the errors it throws.

## 5. Tests

Unit tests (`npm test`; filter with `node --test src/layers/bridge/internal/<file>` from
`modules/core/`). All run against stub `cpu`/`kernel`/`memory` objects.

| file | kind | covers |
|------|------|--------|
| `internal/conventions.test.js` | contract | Cleanup per convention including fastcall, unknown convention refused, stack and ECX argument reads, signed arguments. |
| `internal/dispatch.test.js` | unit | Marshal/invoke/EAX, negative results, forwarding stubs, fastcall's registers read from the saved block, a hook that answers vs. one that falls through (EIP/ESP either way), a hook's counters and a reported mismatch, parked calls leaving EAX, the parked token's identity, unimplemented/duplicate traps, a throwing handler, the bounded rings, the sampled `trap` phase, record reuse, the sink; a site hook: all eight registers read off the pushad block into a plain object, an answer writing back every edited register with ESP by `stackAdjust` and EIP to `resume`, a fallthrough restoring every register to the pristine reading even after the handler edited the object, counters and diagnostics shared with a slot hook, and the `call.hook` trace unchanged. |
| `internal/parking.test.js` | unit | `freeStackFor` per thread, nothing in flight, the token only inside a call. |
| `internal/callback.test.js` | unit | Suspended-call naming, `answered()`, nested frames below the stack in use, no call in flight, the right thread, address zero refused, `recentlyStarted`; a callback entered with registers of its own; a transfer abandoning every call and frame below its line and keeping the window procedure's above it, and drawing the line at the new ESP when none is given. |
| `internal/vtable.test.js` | unit | Refusal when stubs or arena run out, pointer identity, guest-code slots, shared tables finding their object, a pointer kept at zero while its object is reachable and forgotten once it is not, every pointer of an object that reports itself destroyed forgotten with it, one generation of a per-interface count ending alone, and the object told of each pointer as it is forgotten. |
| `module.test.js` | unit | A handler calling back onto its own thread; a handler that awaited being refused without a thread and building on the named thread's stack; an off-stack frame refused; a second instance in one realm does not take the first one's traps; a disposed bridge answers harmlessly rather than throwing; `diagnostics()` answers for the most recently created instance; a handler answering with a continuation sends the thread there and leaves nothing waiting; a continuation without ESP refused; a thread held for its fault spinning in the park loop until its answer sends it on. |
| `replay.test.js` | replay | Three sessions built in the test replayed through the real module (unnamed-thread refusal, the same session named replays cleanly, address zero names its sender), plus every `*.json` in `sessions/` — none is checked in today. |

Integration (`npm run test:integration`): `src/callbacks.itest.js` runs a real executable
that asks the C runtime to sort six integers with a comparator of its own, and checks the
order, that the comparator ran many times inside one host call, and determinism.
`src/exceptions.itest.js` drives continuations end to end: compiled programs whose catches
and `__except` blocks are reached through them, including a throw out of a comparator the
runtime called back, and checks no host call is left waiting afterwards.
