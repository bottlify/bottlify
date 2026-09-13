# `kernel` — threads, scheduling, time and synchronisation

The execution core: threads, the round-robin scheduler, the single context-switch point, the
guest's clock, events/mutexes/semaphores, the handle table and child-process records. Sits on
[`cpu`](./cpu.md), [`memory`](./memory.md) and `log`. Module machinery is described in
[`README.md`](./README.md) and [`system.md`](./system.md).

## 1. Purpose

`kernel` is the engine's own kernel, not the guest-facing one. What a program calls to make a
thread is `win32/kernel32`'s business; what happens as a result — a stack is carved out, a
context is created, the thread takes turns on the one emulated CPU, waits on an object, is
woken with a result in EAX, and eventually ends — is here.

It owns *when* the CPU moves between threads; *what* a CPU context is belongs to `cpu`. It does
not run guest code itself beyond asking `cpu.runSlice` for a quantum, does not know what a trap
means (the bridge does), and does not implement Win32 semantics above the objects listed here:
completion ports, message queues, critical sections and named objects are built above it on
`block`/`wake` and the handle table. Child processes are recorded, never run.

## 2. Contract

| field      | value                          |
|------------|--------------------------------|
| `name`     | `kernel`                       |
| `version`  | `0.1.0`                        |
| `requires` | `['cpu', 'memory', 'log']`     |

Source: `src/layers/kernel/module.js` and `src/layers/kernel/internal/{threads,switch,sync,
time,handles,processes}.js`.

### Configuration

| option | type | default | meaning |
|--------|------|---------|---------|
| `quantum` | number | `100_000` | Retired guest instructions per scheduler turn. Below a page the emulator cannot honour a smaller one. |
| `stacks.base` | number | `0x00300000` | Where the first pool stack is placed (`0x00400000 - 0x00100000`). |
| `stacks.size` | number | `0x10000` | Bytes per pool stack. |
| `stacks.limit` | number | `Infinity` | Address the pool may not grow past. `createThread` throws when the next stack would cross it. |
| `clock.now` | `() => number` | `Date.now` | The host clock, in milliseconds. |
| `clock.floorMs` | number | `0.5` | A credited host interval below this is ignored. |
| `clock.ceilingMs` | number | `16` | No single credited interval exceeds this. |

The process assembler passes `quantum` through from its own options and sizes the pool from the
image's `SizeOfStackReserve` (see [`memory.md`](./memory.md) for the resulting layout).

### API

Constants: `ThreadState` (`READY`, `RUNNING`, `BLOCKED`, `TERMINATED`) and `WaitResult`
(`OBJECT_0 0`, `ABANDONED 0x80`, `TIMEOUT 0x102`, `FAILED 0xffffffff`).

Threads and turns:

| member | signature | meaning |
|--------|-----------|---------|
| `createThread` | `({ entry, parameter?, stackTop?, stackLimit?, tebAddress?, name?, returnTo? }) => Thread` | A ready thread with a primed stack (parameter above a return address). Stack from the pool unless `stackTop` is given. `returnTo` defaults to the park loop. Opens a `'thread'` handle on it. |
| `holdThread` | `() => number` | Replaces the return address at ESP with the park loop and returns what it was. For a stub about to `ret`. |
| `parkThread` | `(thread) => void` | The same, but remembers the address on `thread.parkedReturn` so the thread resumes where it left off. |
| `scheduleResume` | `(thread, { eip, esp?, returnValue? }) => void` | Where a stopped thread continues on its next turn; applied inside the switch. |
| `currentThread` / `threads` | `() => Thread \| null` / `() => Thread[]` | The thread on the CPU; every thread ever created. |
| `writeThreadId` | `(address, id) => void` | Writes a thread id into guest memory (an out-parameter helper). |
| `runOnce` | `() => { ran, instructions, switched }` | One turn. `ran: null` means nothing could run. |
| `nextDeadline` | `() => number \| null` | The soonest guest time a blocked thread waits for. |
| `exitThread` | `(thread, exitCode) => void` | Abandons the thread's mutexes, terminates it, releases everything waiting on it. |
| `block` | `(thread, reason?, { deadline?, result? }?) => void` | Blocks a thread on something the kernel does not hold a queue for. |
| `wake` | `(thread, result?) => boolean` | Makes a blocked thread ready, optionally with the value its call answers. |
| `onTimeout` | `(handler) => void` | Told when a timed wait expires, so an external queue can drop the thread. |
| `sleep` | `(thread, milliseconds) => void` | Block until a guest-time deadline, answering 0. |
| `diagnosticsSnapshot` | `() => object` | The scheduler's metrics alone. |
| `pages` | `() => Record<string, number>` | Retired instructions by 64 KiB page of guest code. A walk of every page of guest memory: for a one-off call on this thread, not a poll; the `kernel/pages` table is the same figures with no walk. |
| `syncObjects` | `() => { kind, name, waiters, state }[]` | Every synchronisation object ever made, one row each. Thousands in a running program, so asked for by name rather than carried in the diagnostics table. |

Synchronisation (`internal/sync.js`):

| member | signature | meaning |
|--------|-----------|---------|
| `createEvent` | `({ manualReset?, signalled?, name? }) => Event` | |
| `createMutex` | `({ name? }) => Mutex` | Recursive, owner-tracked, abandonment-aware. |
| `createSemaphore` | `({ initial, maximum, name? }) => Semaphore` | Throws unless `0 <= initial <= maximum`. |
| `wait` | `(object, thread, timed?) => number \| null` | Result now, or `null` after blocking the thread. |
| `poll` | `(object, thread) => number \| null` | Takes the object if available; never queues. |
| `waitAll` | `(objects, thread, timed?) => number \| null` | Takes nothing until everything is available. |
| `waitAny` | `(objects, thread, timed?) => { index, result } \| null` | |
| `setEvent` | `(event) => Thread[]` | Threads woken. |
| `resetEvent` | `(event) => void` | |
| `releaseMutex` | `(mutex, thread) => boolean` | False unless `thread` owns it. |
| `releaseSemaphore` | `(semaphore, count = 1) => number` | Previous count; throws past the maximum. |

Handles, processes and the clock:

| member | signature | meaning |
|--------|-----------|---------|
| `handles.open` | `(type, object) => number` | A fresh handle, a multiple of four. |
| `handles.resolve` | `(handle, type?) => object` | Throws on an invalid handle or a type mismatch. |
| `handles.close` | `(handle) => object` | Throws on a handle that is not open. |
| `handles.typeOf` | `(handle) => string \| null` | |
| `handles.holds` | `(object) => boolean` | Whether any handle still names the object. |
| `processes.create` | `({ imagePath, commandLine, suspended? }) => ProcessRecord` | A record, not a running process. |
| `processes.pending` | `() => ProcessRecord \| null` | The first non-suspended child. |
| `processes.all` | `() => ProcessRecord[]` | |
| `clock` | `{ virtualTime, wallClock, advance, skipTo, suspend, resume, diagnostics }` | The guest's clock (below). |

A `Thread` is a plain record: `id`, `name`, `state`, `tebAddress`, `stackTop`, `stackLimit`,
`entry`, `context`, `instructions`, `exitCode`, `waitingOn`, `awaitingHost`, `kind: 'thread'`,
`waiters`, `handle`, plus the scheduling fields `parkedReturn`, `resumeStack`, `waitResult`,
`deadline`, `timeoutResult`. It is itself a waitable object (`SyncKind.THREAD`): signalled once
its `exitCode` is not null, never taken.

### Diagnostics

`status` is `'ready'` once created. Metrics are the scheduler's, the switcher's and one
sub-record each for handles, sync objects, processes and time:

| metric | meaning | when it moves |
|--------|---------|---------------|
| `quantum` | As configured. | Never. |
| `turns` | Turns taken. | Each `runOnce` that ran a thread. |
| `overruns`, `worstSlice`, `worstSliceAt`, `worstSliceFrom`, `worstSliceOn` | Slices the emulator ran past the quantum; the worst, where it began and ended, and on which thread. | When a slice retires more than `quantum`. |
| `worstSliceMs`, `slowSlices` | The eight slices that held the machine longest by the host clock (40 ms and up), as `ms instructions thread 0xfrom->0xat`. | When a slice takes 40 ms or more. |
| `expiries` | Timed waits that ran out. | Each expiry. |
| `stackEscapes`, `stackEscaped` | Threads whose ESP has been seen outside their stack, and where. | Checked once a turn, before the slice. |
| `deepestStackUse` | `name used/size` per thread. | Once a turn. |
| `threads`, `byState`, `byThread`, `current`, `waiting` | Counts, per-state counts, `name instructions state` per thread, who is on the CPU, and what each blocked thread waits on. | Continuously. |
| `switches`, `selfSwitches` | Real context switches; switches to the thread already running (no-ops). | Each `switchTo`. |
| `handles` | `{ open, opened, closed, pendingReuse, byType }`. | Each open/close. |
| `sync` | `{ objects, event, mutex, semaphore }` — counts only; the rows are `syncObjects()`. | Each create. |
| `processes` | `{ created, suspended, pending }`. | Each `processes.create`. |
| `time` | `{ virtualMs, wallMs, creditedMs, capped, ignored, skippedMs, overtaken }`. | Each `advance`/`resume`/`skipTo`. |

`diagnostics()` builds this object on request — the `byThread` strings, the per-state counts, the
handle walk — and is the cold path, for a one-off look. What a reader polls comes from the tables
the kernel publishes through the log layer's registry, written in place and never walked here:

| table | rows | columns | when written |
|-------|------|---------|--------------|
| `kernel/counters` | 1 | `SCHEDULER_COUNTERS`: `quantum`, `turns`, `overruns`, `worstSlice`, `worstSliceAt`, `worstSliceFrom`, `worstSliceMs`, `expiries`, `boosts`, `stackEscapes`, `threads`, `current` (thread id), `frameThread` (the name id of the thread that retired the most since the last publish), `frameThreadInstructions`, `frameAt` (where the heaviest slice of that interval began, which names the module). | `turns` on every turn; the rest once a frame. The last three are the interval's rather than the run's, and are cleared by the publish that reports them — a frame's row in the log layer carries a copy, so a stall can name the thread and the module it was spent on. |
| `kernel/threads` | up to 512 | `THREAD_COLUMNS`: `id`, `name` (dictionary id), `instructions`, `state` (index in `THREAD_STATES`), `priority`, `boosts`, `boosted`, `waitingOn` (dictionary id or -1), `stackUsed`, `stackSize`. | Once a frame, by `publish()`. |
| `kernel/slowSlices` | 8 | `SLOW_SLICE_COLUMNS`: `ms`, `instructions`, `from`, `at`, `thread` (dictionary id). Longest first. | When a slice of 40 ms or more is recorded. |
| `kernel/pages` | one per 64 KiB of guest memory, plus one | `instructions`. | One add per turn. An address outside guest memory goes to the last row. |

"Once a frame" is the log layer's `endFrame()`, which runs every registered sampler; with no
registry (the log layer stubbed, a test's fake) the scheduler keeps the same figures in arrays of
its own and nothing about how it runs changes.

## 3. How it works

### Threads and the scheduler (`internal/threads.js`)

One emulated CPU, many threads: a thread is its saved context, its stack, its TEB and a state.
The scheduler runs the highest-priority ready thread and round-robins among equals (see §4 for
how the priority is composed); the quantum is retired guest instructions, so
the point at which one thread yields to the next is a function of what the guest did, not of
host speed.

`runOnce()`:

1. `expire()` — wake every blocked thread whose deadline has passed (only scanned once the
   clock has reached `noDeadlineBefore`, a lower bound kept so a polling program does not pay
   a full scan tens of thousands of times a second).
2. `ready()` — threads in `READY` that are **not** `awaitingHost`. A thread parked on a host
   call that has not answered is stopped on `hlt` with nothing to run; counting it ready would
   keep the scheduler from ever reaching the clock-skipping branch below.
3. If nothing is ready: `soonest()` finds the earliest deadline among blocked threads; if there
   is none, return `{ ran: null }`. Otherwise `skipTo(deadline)` asks the clock to move; if it
   answers 0 (the clock has caught up with the host's), return `{ ran: null }` — the machine
   really does have to wait. Else expire again and retry.
4. Take `candidates[0]`. If it has a `parkedReturn`, build a resume record
   `{ eip, esp: resumeStack, returnValue: waitResult }`, report it through `onResume` (logged
   at debug as `{thread} resumed from {reason} with {value}`), and clear the fields.
5. `switcher.switchTo(current, next, resume)`. Mark the outgoing thread `READY` if it was
   `RUNNING`; mark `next` `RUNNING`.
6. `watchStack(next)` — record ESP's low-water mark and note an escape (before the slice, so a
   fault stub's stack does not count).
7. `cpu.runSlice(quantum)`; credit the thread and the 64 KiB page the slice began on; time the
   slice by the host clock; record overruns and slow slices.
8. If `next` is still `RUNNING`, mark it `READY` and move it to the back of the queue.

`block(thread, reason, timed)` sets `BLOCKED`, remembers `reason` (kept as `lastWaitingOn`
past the wake for the resume log), and an optional guest-time `deadline` with the `result` the
call answers on expiry. `wake` sets `READY` and clears the deadline; it returns `false` for a
thread that was not blocked. `terminate` sets `TERMINATED` and drops `current` if it was that
thread.

### The one switch (`internal/switch.js`)

Every path that moves the CPU between threads goes through `switchTo(outgoing, incoming,
resume)`. Two switch primitives drift apart — one learns about a piece of state and the other
does not — so there is exactly one. It captures the outgoing thread's context (even a thread
that just blocked: its saved context from last time is older than what it has done since),
applies the resume redirection to the incoming context, and restores it with
`cpu.restoreContext(context, tebAddress)` — the TEB is a parameter so a resume that leaves FS
on another thread's TEB cannot be written. A switch to the running thread with no resume is a
counted no-op: round-tripping the same state would hide a bug in the round trip.

The FPU and every other piece of shared CPU state travel inside the context record; see
[`cpu.md`](./cpu.md) for what it contains.

### Parking and resuming

A thread stops in one of two ways. `holdThread()` swaps the stub's return address for the park
loop and hands the original back to the caller, which decides where the thread goes next
(`scheduleResume`). `parkThread()` does the same but keeps the address on the thread, so the
next turn resumes exactly where the call was made with `waitResult` in EAX. Both work because a
stub is about to `ret`: the park loop is `hlt; jmp`, a parking slot rather than code to run.
The redirection is applied inside the switch (`cpu.resumeContextAt`) so it happens exactly once
and after the thread's own state is saved — which matters most when the thread coming back is
the one already on the CPU.

### The guest's clock (`internal/time.js`)

Virtual time is a millisecond counter that starts at zero at boot. `wallClock()` is the host's
epoch at boot plus virtual time, so a program that samples the wall clock twice gets the same
interval its own timer reports.

The clock moves three ways:

- `advance(ms)` — the guest ran for real. The process assembler credits it with capped wall time
  between slices (`clockCredit` in `src/app.js`), so time spent yielding to the browser,
  mixing sound and polling counts too; a real clock runs during a syscall.
- `skipTo(target)` — every thread is in a timed wait and nothing else can run, so the clock
  jumps to the deadline, **never past the host's clock**. Overtaking is what makes animations
  run at several times their speed and a sound device asked for more than it can drain;
  `overtaken` counts the refusals.
- `suspend()`/`resume()` — bracket a stretch of host code and credit the interval with a floor
  (`floorMs`, so sub-millisecond trap noise does not drift the clock) and a ceiling
  (`ceilingMs`, so a one-second stall is not delivered whole). Nothing in the tree calls this
  pair today; `advance` is the path in use.

### Synchronisation (`internal/sync.js`)

Objects are plain records with a `waiters` queue in arrival order. Windows does not promise
FIFO; choosing an order and keeping it makes a multithreaded program reproducible.

- **Events**: auto-reset releases one waiter and closes; manual-reset releases everyone and
  stays open until `resetEvent`.
- **Mutexes**: recursive (`recursion` counter), owner-only release, and an `abandoned` flag set
  by `abandonMutexesOwnedBy` when a thread exits holding one — the next owner is answered
  `WAIT_ABANDONED`.
- **Semaphores**: count within `[0, maximum]`; release past the maximum throws.
- **Threads**: signalled once ended, never consumed, so a second join does not wait for ever.

`releaseTo(object)` hands a signalled object to the first waiter that can take it: a thread
waiting for **all** of a set is passed over unless every member is signalled or already owned
by it; a thread waiting for **any** is answered `base + index` where base is `OBJECT_0` or
`ABANDONED` and index is the object's position in its set. Whoever is released leaves the
queues of the rest of its set. `poll` exists because a zero-timeout wait that queued the thread
left a stale entry which later handed the object to a thread waiting on something else.

Timed waits carry a deadline into `block`; on expiry the scheduler's `onTimeout` handlers run,
and the sync layer's handler removes the thread from exactly the queues it stood in
(`thread.queuedOn`).

### Handles (`internal/handles.js`)

Handles are multiples of four from `4` upward. Reuse is deferred as long as possible: a fresh
value is issued until `limit` (`0x40000000`), and only then are closed handles recycled — so a
use-after-close lands on nothing, a diagnosable error, rather than on the next object created.
Invalid handles, type mismatches and double closes all throw with the handle in the message.

### Child processes (`internal/processes.js`)

There is one address space and one emulator, so a child is not started beside its parent. A
record holds the image path, command line, `suspended` flag, a queue of `patches` (writes the
parent made into the child before its image existed — process hollowing as a queue) and an
`exitCode` that is always `STILL_ACTIVE` (259). `pending()` names the first non-suspended child;
whoever drives the machine tears the parent down and rebuilds on that image when the parent has
nothing left to do. Ids start at `0x2000` and step by eight (a process id and its initial thread
id), for the same reason handles step by four.

### Exits

`exitThread` abandons the thread's mutexes, terminates it and releases every joiner. Process
exit is not the kernel's: a terminating call parks its caller through the bridge and the driver
stops the machine from outside the trap.

## 4. Limitations and divergences

- **Priority, then round-robin.** A turn goes to the highest-priority ready thread; equals take
  turns in queue order. The priority is composed as Windows composes it for a normal-class
  process (base 8, `THREAD_PRIORITY_IDLE` pinned to 1 and `TIME_CRITICAL` to 15); there is no
  `SetPriorityClass`, so the class is always normal. A ready thread passed over for `starvation`
  guest milliseconds (4000 by default) outranks everything for one turn; there is no wake boost.
- **A thread is never removed** from `threads`; a terminated one stays in the list and in
  `byState`.
- **Pool stacks are fixed-size** (`stacks.size`) and never freed; the pool is bounded by
  `stacks.limit` and `createThread` throws past it.
- **`stackLimit` is a diagnostic**, not a guard page: an overflow is reported as an escape in
  `stackEscaped`, not raised as an exception.
- **Timed waits expire on guest time**, which moves only by `advance`/`skipTo`; a deadline is
  never met by the host clock alone.
- **No completion ports, critical sections, condition variables, timers or named objects** in
  this layer; `block`/`wake` with a `timed` record is the hook the layers above use for them.
- **Waits do not fail** — there is no `WAIT_FAILED` path; an invalid object is a thrown
  `Unknown sync object`.
- **`releaseSemaphore` past the maximum throws** rather than returning `FALSE`; the caller
  turns it into an error code.
- **The handle table has no per-process scope, inheritance, or access rights.**
- **Children never run concurrently** and always report `STILL_ACTIVE`.
- `clock.suspend`/`resume` are implemented and tested but unused.

## 5. Tests

Unit tests (`npm test`; filter with `node --test src/layers/kernel/internal/<file>` from
`modules/core/`). All run against a stub `cpu` and need no emulator.

| file | kind | covers |
|------|------|--------|
| `internal/threads.test.js` | unit | Turn order, priority order and starvation, blocking/waking, `awaitingHost` excluded from candidates, quantum bound, overrun and slow-slice accounting, per-thread and per-page reports, deadline ordering. |
| `internal/switch.test.js` | unit | Save/restore, TEB travelling with the restore, first switch, self-switch as no-op, error on no thread. |
| `internal/sync.test.js` | contract | Event/mutex/semaphore semantics per Win32: auto vs manual reset, recursion, owner-only release, abandonment, wait-all atomicity, wait-any index and base, poll never queueing, thread objects, expiry leaving only its queues. |
| `internal/time.test.js` | unit | Advance, credit floor and ceiling, skip never past real time, diagnostics. |
| `internal/handles.test.js` | unit | Alignment, type assertion, invalid/closed handles, deferred reuse. |
| `internal/processes.test.js` | unit | Record contents, id spacing, suspended children not pending. |
| `module.test.js` | unit | `createThread` priming: return address, park-loop default, headroom, pool registration, a caller-supplied stack. |

Integration (`npm run test:integration`): `src/threads.itest.js` runs a real two-thread
executable contending on a mutex and checks the Windows answer, that both threads took turns,
and that the result is deterministic across runs.
