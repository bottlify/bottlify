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

### API

| member | signature | meaning |
|--------|-----------|---------|
| `Convention` | `{ STDCALL, CDECL, THISCALL }` | |
| `register` | `(name, { convention = STDCALL, argBytes, handler, preserveResult?, lastError = true }) => number` | Makes a host function callable; returns the guest address of its stub. `argBytes` counts every argument including `this`. `lastError: false` says the function never sets the thread's error, so the trace does not read it afterwards; COM methods are registered so. |
| `watch` | `(name, { argBytes, target, convention?, handler }) => number` | A forwarding stub: `handler` sees the marshalled arguments, then the call goes on into `target`. For observing calls between guest modules. |
| `park` | `(thread?) => ParkedToken` | Parks the calling thread and returns the only value a handler may return instead of an answer. Throws outside a call. |
| `callGuest` | `({ entry, args?, thread? }) => Promise<number>` | Runs a guest routine and resolves with EAX. A handler that awaited before calling must pass `thread`. |
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
answers for the most recently created instance. After `dispose()`, a call that was in flight — or
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
which is what makes the C bindings binary-compatible with the C++ call. Nothing in the tree
uses `THISCALL` today; it exists for a C++ runtime library's real member exports.

### Dispatch (`internal/dispatch.js`)

`dispatch(id)` reads ESP (plus `forwardSave` for a forwarding stub), reads the arguments off
the stack into the function's own array (the convention was worked out once, at registration),
records the name in a ring and a detail record in another, fills the `frame` for this depth of
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
profiler's sums and never its per-occurrence figures), so the host's share of a frame is always
known without two clock readings per call; `callPhases` adds a phase per handler. A prompt
call allocates nothing: the argument array, the frame and the ring's records are made once and
written over, the answer is kept as a number and rendered as text only when a reader asks, and
the last error is read only after a function that can have set it. A call that answers late
keeps the array and frame it was given, and the next call is given new ones.
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

`IUnknown` is the bridge's: `QueryInterface` reads the GUID (three little-endian integers then
eight raw bytes), asks `interfaceFor`, publishes, `addRef`s the interface asked for, and answers
`S_OK`, `E_NOINTERFACE` (with `*ppv` zeroed), `E_POINTER` or `E_OUTOFMEMORY`; `AddRef` and
`Release` are passed to the object with the interface id (some object models count per
interface generation), and a release to zero forgets the pointer and frees its block. A method
without `invoke` answers `E_NOTIMPL`; a call through an unpublished pointer answers `E_POINTER`.
A method's `invoke` may return a promise, and the caller is parked on it.

A table that cannot be built — stub table full, or the arena refusing — is counted as a refusal
with its reason, and the guest gets a failure code rather than a null pointer with `S_OK`.

### Recording and replay (`replay.js`)

With `record > 0`, the seam events `call`, `park`, `guest`, `returned` and `finish` are kept in
order. `replaySession(session)` drives the real bridge module over a machine of stubs with the
recorded interleaving and no guest code; the bridge's own invariants decide whether the session
still fails. `sessions/README.md` documents the file format; `replay.test.js` plays every file
in `sessions/` and checks the refusals are exactly those the file lists.

## 4. Limitations and divergences

- **Three conventions**: `fastcall`, and anything passing arguments in registers other than
  thiscall's ECX, are not marshalled. A forwarding stub preserves all registers for its target
  but the handler only sees stack arguments (and ECX under thiscall).
- **Results are 32-bit integers.** A 64-bit result (EDX:EAX) or a floating-point result has to
  be placed by the handler through `cpu.writeReg32`/`cpu.fpu`; the bridge writes EAX only.
- **At most six arguments** are kept per detail record, and `peekString` guesses at pointers
  (printable ASCII under 96 bytes, address ≥ 0x1000); a trace line may name a value that only
  looks like a string.
- **Rings are bounded** at 4096 names and 4096 detail records; `calls()` is only complete until
  the ring wraps. A sink (`onCall`) is the way to keep everything.
- **Stub slots are never freed**; `comInterfacesRefused` rising is the sign a run is spending
  the table.
- **No guest exception unwinding across a callback.** A fault inside guest code started by
  `callGuest` halts the machine (see [`cpu.md`](./cpu.md)); the suspended host call is never
  answered.
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
| `internal/conventions.test.js` | contract | Cleanup per convention, unknown convention refused, stack and ECX argument reads, signed arguments. |
| `internal/dispatch.test.js` | unit | Marshal/invoke/EAX, negative results, forwarding stubs, parked calls leaving EAX, the parked token's identity, unimplemented/duplicate traps, a throwing handler, the bounded rings, the sampled `trap` phase, record reuse, the sink. |
| `internal/parking.test.js` | unit | `freeStackFor` per thread, nothing in flight, the token only inside a call. |
| `internal/callback.test.js` | unit | Suspended-call naming, `answered()`, nested frames below the stack in use, no call in flight, the right thread, address zero refused, `recentlyStarted`. |
| `internal/vtable.test.js` | unit | Refusal when stubs or arena run out, pointer identity, guest-code slots, shared tables finding their object. |
| `module.test.js` | unit | A handler calling back onto its own thread; a handler that awaited being refused without a thread and building on the named thread's stack; an off-stack frame refused; a second instance in one realm does not take the first one's traps; a disposed bridge answers harmlessly rather than throwing; `diagnostics()` answers for the most recently created instance. |
| `replay.test.js` | replay | Three sessions built in the test replayed through the real module (unnamed-thread refusal, the same session named replays cleanly, address zero names its sender), plus every `*.json` in `sessions/` — none is checked in today. |

Integration (`npm run test:integration`): `src/callbacks.itest.js` runs a real executable
that asks the C runtime to sort six integers with a comparator of its own, and checks the
order, that the comparator ran many times inside one host call, and determinism.
