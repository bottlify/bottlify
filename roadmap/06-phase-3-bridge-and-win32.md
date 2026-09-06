# 06 — Phase 3: the call bridge and Win32. Roadmap

> Working document for the phase. Source of truth is `00-bottlify-master-plan.md` (below: Master
> Plan). Phase 2 is closed — its plan is `04-phase-2-threads-and-scheduler.md`.

## 0. What Phase 3 is

Phase 3 = "call bridge and Win32" from the Master Plan: traps, marshaling per calling convention,
callbacks into the guest, asynchronous operations — and on top of that the breadth of the API
surface (kernel32 in full, msvcrt, advapi32 and the registry, user32, gdi32).

**Phase acceptance (Master Plan):** a windowed Win32 application with a dialog, a menu and GDI
rendering runs and responds to input; its frame is compared against a reference.

The phase splits into two halves that are not alike. The **bridge** is small, load-bearing and full
of the kind of decision that is expensive to get wrong (§12.3 was paid for once already). The
**API surface** is the largest mass of mechanical work in the project, and it is only mechanical
*because* the bridge underneath it is right. This document plans the bridge in detail and sketches
the surface; the surface gets its own working notes as it is built.

Everything graphical depends on this phase and not on the graphics phase: DirectDraw cannot be
reached without COM vtables synthesised in guest memory (marshaling + thiscall), without callbacks
(`WNDPROC`, the `Enum*` families), without asynchronous parking (`Present`, `Flip`) and without a
window to attach a surface to.

## 1. Decisions fixed on entry

Grounded in the tree as it stands after Phase 2, not recalled.

| decision | value | evidence / consequence |
|---|---|---|
| where trap dispatch lives | in `bridge`, not in `app.js` | Today `app.js` reads ESP, pulls `argBytes / 4` DWORDs off the guest stack, writes EAX and then special-cases process exit. That is marshaling, and marshaling is the bridge's whole job. Leaving it in the assembly step means every convention added later is added to the wrong file |
| what `cpu` owns of a trap | the stub bytes, the port, the id — never the handler | `cpu` emits x86 and reports "id N fired"; what an id *means* is a contract, not a machine detail. So `registerTrap` returns `{ id, address }` and holds no handler, and `bridge` owns the table of implementations |
| calling conventions | stdcall, cdecl and thiscall, as data | The stub emitter currently derives the `ret` operand from the argument count (`argBytes > 0 ? ret argBytes : ret`), which is only correct for stdcall. A cdecl function with arguments would emit `ret 12` and eat the caller's own cleanup. The two numbers are different facts and stop being one field |
| `this` for thiscall | in ECX, counted inside `argBytes`, popped as `argBytes - 4` | MSVC's thiscall passes `this` in ECX and lets the callee pop only the stack arguments. Counting `this` in `argBytes` keeps one number meaning "the arguments this function has" across all three conventions, with the convention deciding where each one comes from |
| the async contract | a token that only parking can produce | §12.3 demands this be a type rather than a comment, and today it is a comment: `WaitForSingleObject` parks and then returns `0` with a note saying the value is ignored. The token is a module-private singleton returned by `park()` alone — a handler that has not parked cannot name it, so "returned async without parking" stops being expressible |
| who writes EAX | the dispatcher, and only for a value | A parked thread's EAX belongs to whatever wakes it (`resumeContextAt` already carries `returnValue`). Writing EAX for a parked call would overwrite the wait's result with a placeholder |
| exit | a parked call like any other | `app.js` currently polls `win32.exitCode()` after every single trap to decide whether to park. `ExitProcess` and `ExitThread` park exactly like a blocking wait does; the poll goes away with the special case |
| guest callbacks | run on the calling thread, asynchronously to the host | The trap handler runs *inside* `cpu.runSlice()`; the CPU cannot be re-entered from within it. So a host function that calls back into the guest parks the caller, points its context at the guest routine with a sentinel return address, and resumes its own execution when the sentinel traps. This is §12.3 used in the other direction |
| the driving loop must yield | one `await` per scheduler turn | `AppController.run()` is `async` but its turn loop contains no `await` on the normal path, so microtasks never flush between turns. A host handler suspended on a promise would never be resumed. This is a prerequisite for callbacks, not a detail of them |

## 2. Structure at the end of the bridge half

```
modules/core/src/layers/bridge/
├── module.js               # BottlifyModule: no longer a stub
├── internal/
│   ├── conventions.js      # stdcall / cdecl / thiscall as data: where args are, who pops
│   ├── dispatch.js         # a trap becomes a host call: marshal, invoke, place the result
│   ├── parking.js          # the async token; the only way to make one is to park
│   └── callback.js         # a host call becomes a guest call: frame, sentinel, resumption
└── *.test.js
```

`cpu` loses the handler from its trap table and gains the trap id in the return of `registerTrap`.
`win32` declares a convention per function and returns a parked token instead of a placeholder.
`app.js` stops marshaling and stops polling for exit.

## 3. Steps

### P3.1 — conventions and dispatch

Move marshaling into the bridge and make the convention a value rather than an assumption. A
function is registered as `{ convention, argBytes, handler }`; the bridge computes what the stub
must pop, reads arguments from where that convention puts them, and places the result.

**Done when:** the existing console and threading fixtures still pass unchanged through the new
path, and a cdecl function with arguments emits a stub that pops nothing.

### P3.2 — the async contract as a type

`park()` parks the calling thread and returns the only token the dispatcher accepts as "no value
yet". Handlers that wait return it; handlers that end a thread or a process return it.

**Done when:** the exit special case is gone from `app.js`, and a handler that parks without
returning the token — or returns a value after parking — is caught by a test rather than by a
corrupted EAX.

### P3.3 — the driving loop yields

One yield per scheduler turn, so a suspended host handler can make progress between turns.

**Done when:** a handler that resolves on a later turn resumes, and the cost of the yield is
measured rather than assumed.

### P3.4 — callbacks into the guest

A host function calls a guest routine and gets its result: build the frame on the calling thread's
stack, push a sentinel return address that traps, point the context at the routine, park the host
handler. When the sentinel fires, restore the pre-call context and resume the handler with EAX.

Re-entrancy is the interesting part: the guest routine may itself call an imported function, and it
may do so on a different thread than the one that started the callback. The sentinel therefore
belongs to a call, not to the process.

**Done when:** a fixture calls `qsort` with a guest comparator, the comparator runs many times, and
the array comes back sorted the way it does under Windows. A comparator that itself calls an
imported function is part of the same test.

### P3.5 — module synthesis and the resolution epoch

`GetProcAddress` must answer correctly at any stage of a module's life (§13.3), and guest code that
walks an export table itself must find our implementations — which means a synthesised in-guest
module with a real export directory and JMP trampolines, not just an IAT that we patched.

**Done when:** an address taken before a module is fully ready is still the address that works
afterwards, proven by a test that takes it early on purpose.

### P3.6 — the surface

kernel32 in full (heap, files, modules, TLS, errors), msvcrt (cdecl throughout), advapi32 and the
registry, user32 (windows, messages, dialogs), gdi32 (contexts, bitmaps, text). Mechanical, wide,
and the place where the Wine conformance expectations earn their keep: what succeeds, what fails,
and with which error code.

Order is by what the acceptance fixture needs, not by DLL: a window that receives messages before a
dialog that owns controls.

## 4. What this phase deliberately does not do

- **No rendering.** `gdi32`'s drawing half lives in `graphics/gdi/` and belongs to the graphics
  phase; this phase provides the device contexts and the bitmaps it will draw into.
- **No COM object model beyond what the marshaling needs.** Synthesising a vtable in guest memory is
  bridge work and lands here; the interfaces themselves belong to whoever implements them.
- **No filesystem.** File APIs get their real backing in Phase 4; here they are the API shape over
  whatever the filesystem layer offers at the time.
