# `win32` — the API surface a program was compiled against

Source: `modules/core/src/layers/win32/`. Module contract and host machinery:
[`system.md`](./system.md), [`host.md`](./host.md); layer index and directory conventions:
[`README.md`](./README.md), [`infrastructure.md`](./infrastructure.md). Neighbours this layer
depends on: [`bridge.md`](./bridge.md), [`kernel.md`](./kernel.md), [`memory.md`](./memory.md),
[`loader.md`](./loader.md), [`filesystem.md`](./filesystem.md), [`log.md`](./log.md).

## 1. Purpose

`win32` is the set of system libraries a 32-bit Windows program imports — kernel32, user32, gdi32,
advapi32, msvcrt, ntdll, ole32, winmm, winsock and the rest — implemented as host-side tables of
functions, one table per DLL, that the assembler turns into real in-guest modules. It also owns the
process-wide state those libraries share: the one heap allocator, the window records and message
queue, the registry hive, the COM class registry, the last-error slot, structured exception
handling.

It is not the execution engine (threads, scheduling and handles are `kernel`), not the marshalling
(`bridge`), not the loader, and not a drawing, sound, input or media device. Direct3D, DirectDraw,
OpenGL, DirectSound, DirectInput and the media codecs are libraries published by `graphics`,
`audio`, `input` and `media`, which sit *above* this layer and reach it through their declared
dependency; what those layers need from win32 that cannot be imported downward (a screen, a sample
sink, a cursor position) arrives as thunks in this module's configuration. Only Windows system
DLLs are reimplemented here; a DLL a program ships is loaded and executed as x86.

## 2. Contract

| field      | value |
|------------|-------|
| `name`     | `win32` |
| `version`  | `0.2.0` |
| `requires` | `['bridge', 'kernel', 'memory', 'loader', 'filesystem', 'log']` |

`src/layers/win32/api.js` still carries only the Phase 0 stub comment; the contract below is read
from `src/layers/win32/module.js`.

### Configuration

Every option is read when a guest calls, never at creation, so the assembler can fill them in after
the module graph is built. All are optional.

| option | type | default | meaning |
|--------|------|---------|---------|
| `arena` | `{ base, size }` | `{ 0, 0 }` | The byte range the process heap allocates from. |
| `modules` | `{ find, byBase, imagePath, load?, resolved?, findResource?, moduleBase?, loadString?, versionInfo? }` | inert | How a module is found by name or base, and how a library is read off the volume. |
| `idle` | `() => Promise` | resolves | How a waiting message pump gets to look again. |
| `fetchBlocks` | `(blocks) => Promise<void>` | `null` | Brings absent bundle blocks in; without it a block miss is a fault rather than a wait. |
| `threadBlock` | `(thread) => void` | none | Gives a new thread its TEB. |
| `registers` | `{ read(name), write(name, value) }` | zeros | CPU registers, for exception dispatch and the helpers that answer in a register pair. |
| `fpu` | `FloatHost` | none | The x87 stack; **without it the 51 functions returning `double` are not exported at all**. |
| `screen` | `{ width, height, bitsPerPixel, displayWidth?, displayHeight? }` | `640×480` fallback in each library | What `GetSystemMetrics`, `GetDeviceCaps` and `EnumDisplaySettings` answer. |
| `graphics` | thunks | none | Where GDI pixels go and which pixel formats exist. |
| `output` | thunk | none | Where wave-out samples go. |
| `video` | thunks | none | The decoder and the frame sink a filter graph uses. |
| `network` | adapter `{ bind, unbind, find }` or a `NetworkTransport` | loopback | The transport under Winsock; `createApp` hands its own `win32.network` option here. |
| `http` | request function | `null` | The transport under WinInet. |
| `cursor`, `keyState`, `clipCursor` | thunks | nothing pressed, origin | The input layer, handed down. |
| `commandLine`, `environment` | string, record | the quoted image path; `SystemRoot`, `TEMP`, `windir` under `C:\WINDOWS` | What the program is told it was started with. |
| `onOutput(handle, text)`, `onTrace(text)`, `created(hwnd)`, `spawned(request)` | callbacks | no-ops | Console output, `OutputDebugString`, window creation, `CreateProcess`. |
| `onMessageBox(notice)` | callback | the box's own default | A message box the program put up. `notice` is `{ id, text, caption, type, buttons, defaultButton, icon }`; the answer is the id of the button pressed, and a promise parks the calling thread until `answerMessageBox(id, button)` supplies it. |
| `onClipboard(text)` | callback | no-op | The text a program copied. Called from `CloseClipboard` when the clipboard was written under that open and holds `CF_UNICODETEXT` (preferred), `CF_TEXT` or `CF_OEMTEXT`; a close after a read alone, or with only non-text formats, calls nothing. A null handle (delayed rendering) is not rendered. |
| `divergence(api, detail)` | callback | none | See §3, "The divergence rule". |

### Provided API (`module.js`)

| method | one line |
|--------|----------|
| `libraries()` | `{ 'KERNEL32.dll': table, … }` — every DLL, each a map from export name to `{ argBytes, handler }`. |
| `ordinals()` | Export ordinals for the libraries imported by number: `WSOCK32.dll`, `WS2_32.dll`, `OLEAUT32.dll`. |
| `libraryConvention(name)` | `'cdecl'` for the C runtime family (`msvcrt`, `msvcr*`, `msvcp*`, `crtdll`, `ucrtbase`), `'stdcall'` for every other library — what an undecorated export of it is, when nothing else says. Asked about libraries this build lacks as well as the ones it has. |
| `resolve(name)` | One export by name, whichever library publishes it. |
| `gdi()` | `createSurfaceDc(attributes)` / `deleteSurfaceDc(handle)` — a DC over pixels GDI did not allocate, for the graphics layer. |
| `queue()` | The message queue; the input layer and the driver post here. |
| `paste(text)` | Text put on the clipboard from outside, as a paste on the page does: a program's `GetClipboardData` for `CF_TEXT`, `CF_OEMTEXT` or `CF_UNICODETEXT` answers with a copy laid down in guest memory in that format (`IsClipboardFormatAvailable`, `CountClipboardFormats` and `EnumClipboardFormats` list them), until the program empties the clipboard or the next paste replaces it. What the program set itself is answered first. |
| `waveTick()` | Move every open wave device's play cursor; called by the driver, since nothing in the guest does. |
| `videoTick(nowMs, soundOwedMs?)` | Advance every running filter graph and return the frame to show. |
| `registry()` | The hive (`toJSON`/`fromJSON`/`onChanged`), whose contents outlive the process. |
| `lastError()` | The running thread's last error, for a tracer. |
| `com()` | The COM class registry; graphics and audio register their factories here. |
| `heap()` | The one allocator: `allocate`, `free`, `block`, `resize`, `diagnostics`. |
| `mappings()`, `ioCompletionWaits()`, `waveDevices()`, `waveThread()`, `criticalSections()`, `messages()`, `windows()`, `windowProcedures()` | Live views of the state below, used by `diagnostics()`. |
| `activeWindow()` | The active top-level window, as `GetForegroundWindow` answers, or 0: where the input layer sends what names no window. |
| `placeWindow(hwnd, x, y, width, height, how?)` | Place a top-level window as the system would and tell the program with `WM_MOVE` when it moved and `WM_SIZE` when its client size changed -- nothing for a placement that changed neither, as `DefWindowProc` says nothing for one, since a program that resets its device on `WM_SIZE` would otherwise be reset by its own reset's placement without end. `how.announce` says the size whether or not it changed: what a mode switch says to the window it lands in, which the graphics layer asks for once, at a fullscreen device's first frame, when both the window and the device exist to hear it -- a program of this era configures its viewport and its full-speed/background state on that message. |
| `dispatchFault(fault)` | Offers a processor exception the running thread took to its structured exception handlers. `null` when the vector is not one a program is handed (see "Exceptions"); otherwise a promise of where the thread goes on, or `null` once nothing took it. The application wires `cpu.onFault` to this. |
| `exitCode()` | Set once the program has asked to terminate -- or once an exception nothing handled, or the C runtime's `abort`, ended it; `null` before. |

### `diagnostics()` metrics

| field | what it counts |
|-------|----------------|
| `libraries` | Exports per DLL, by name. |
| `implemented` | The sum of those. |
| `heap` | `blocks`, `used`, `free`, `largestFree` — a large free total next to a small largest span is fragmentation. |
| `mappings` | `views`, `waited`, `failed` file-mapping views. |
| `ioCompletionWaits` | Every thread parked on a completion port: port, thread, `waitedMs`, packets queued. |
| `waveDevices` | Per open device: cursor source, byte rate, queued/written/retired headers, notices owed. |
| `waveThread` | The callback thread, if it exists, and what it is doing. |
| `criticalSections` | `entered`/`left` in the guest without a crossing, `waits`, `wakes`, `handoffs`, `queued`, `owed`. |
| `messages` | Queue depth, posted/retrieved totals, `quitPending`, the twelve most-pumped messages, armed timers and how late their ticks are. |
| `windows` | Every live top-level window's rectangle and visibility. |
| `windowProcedures` | Messages a window procedure is still inside, and for how long. |
| `exitCode` | As above. |

## 3. How it works

### The per-DLL layout

One directory per library, named without `.dll`. What exists today, with the export counts an
instantiation of the module reports (method in "Inventory" below):

| library | directory | exports | what it covers |
|---------|-----------|--------:|----------------|
| `KERNEL32.dll` | `kernel32/` | 331 | Console, threads and waits, heap and virtual memory, process and TLS, modules, files and directories, critical sections, locale and code pages, environment and command line, system info and time, `CreateProcess`, exceptions and SEH, resources, drives, file mappings and pipes, completion ports, file times, console I/O, APCs and the alertable waits (`apc.js`). |
| `USER32.dll` | `user32/` | 268 | Windows and classes, painting, system queries and display settings, objects (cursors, icons, menus, clipboard), dialogs, hot keys, `SendInput`, the keyboard-layout family (`GetKeyboardLayout`, `MapVirtualKey` A/W/`Ex`, `ToUnicode`/`Ex`, `ToAscii`/`Ex`, `VkKeyScan` A/W/`Ex`) over the one en-US layout this build has, read from one table in `keys.js` (`characterOf`/`keyForCharacter`) that `TranslateMessage`'s fallback reads too, under the modifiers held at the time. |
| `msvcrt.dll` | `msvcrt/` | 277 (226 without `fpu`) | The C runtime: strings, multibyte strings, conversion, formatting and scanning, heap, math, paths, streams (`stdio.js`: `fopen` and its family over the volume, and the standard three as `_iob`'s first records, writing to the console), threads (`threads.js`: `_beginthread`/`_beginthreadex` through kernel32's `CreateThread`), time, C++ support (`cxx.js`), CRT startup, structured and C++ exceptions (`seh.js`, `eh.js`). |
| `GDI32.dll` | `gdi32/` | 114 | Device contexts, objects and their lifetimes, metrics, drawing entry points. Text and fonts in both spellings (`CreateFont`/`Indirect`, `GetTextMetrics` with TEXTMETRICW's WCHAR fields, `GetTextExtentPoint`/`32`, `GetCharWidth`/`32`, `GetCharABCWidths`, `TextOut`, `ExtTextOut`); ABC widths are each character's own advance as the black box, with no bearings. Mapping modes set the extents they fix (MM_TEXT one to one, the fixed modes the device's 96-dot inch against their units with y up, MM_ISOTROPIC starting from MM_LOMETRIC's, MM_ANISOTROPIC keeping its own), and `LPtoDP`/`DPtoLP`/`OffsetWindowOrgEx` answer through them; drawing itself is still in device units whatever the mode. |
| `ntdll.dll` | `ntdll/` | 96 | Counted strings, status translation, machine queries, 64-bit helpers — and 76 entries that are the same function object kernel32 or msvcrt already publish. |
| `ADVAPI32.dll` | `advapi32/` | 71 | The registry API over the hive, `GetUserNameA`, SIDs, and a CryptoAPI provider (MD5, SHA-1, SHA-256, RC4, RSA signature verification). |
| `WINMM.dll` | `winmm/` | 59 | `timeGetTime`, multimedia timers (`timers.js`: `timeSetEvent`'s routine runs on a timer thread of its own that the kernel's clock wakes at each due time; the event forms signal instead), wave-out with a real play cursor and a callback thread, multimedia file I/O (`mmio.js`: RIFF chunks over the volume's files); honest refusal for midi, mixer, aux, joystick, MCI and recording. |
| `ole32.dll` | `ole32/` | 43 | Apartments, `CoCreateInstance`, task memory, GUID conversions, over the COM object model in `objects.js`. Class objects: `CoRegisterClassObject`/`CoRevokeClassObject` keep a program's own (with a reference, revoked by its apartment's last `CoUninitialize`), and activation asks them first -- their `CreateInstance` gets the outer unknown, so aggregation is theirs to allow -- then the classes built in here (which refuse aggregation), then a class's `InprocServer32`, loaded and asked through `DllGetClassObject`. `CoGetClassObject` answers the same three ways, a built-in class through an `IClassFactory` of our own. |
| `OLEAUT32.dll` | `oleaut32/` | 39 | BSTR and VARIANT; imported by ordinal. |
| `WSOCK32.dll`, `WS2_32.dll` | `wsock32/` | 38 each | One socket registry under both names, over an injected adapter (loopback by default); readiness delivered as a window message (`WSAAsyncSelect`) or a signalled kernel event (`WSAEventSelect`/`WSAEnumNetworkEvents`), and name resolution the same way (`WSAAsyncGetHostByName`/`WSACancelAsyncRequest`). |
| `SHELL32.dll` | `shell32/` | 21 | Launching a program (`ShellExecute`, `ShellExecuteEx`, `FindExecutable`), documented refusals where a registry or a person is needed (a document's handler, folder browse), the drag-and-drop truths, the namespace (`namespace.js`: `IShellFolder`/`IEnumIDList` over the volume), and `CLSID_ShellLink` (`IShellLinkA/W`, `IPersistFile`). |
| `COMCTL32.dll` | `comctl32/` | 17 | Image lists (indices only), mouse tracking, and `msctls_progress32`/`SysTreeView32` as built-in window classes. |
| `d3dx9_25.dll`, `d3dx9_26.dll`, `d3dx9_27.dll` | `d3dx9/` | 13 each | Stub tables for the D3DX helper libraries, shadowed by the real DLL wherever the program ships one or its installer put one in `system32` ([`decisions.md`](../../roadmap/decisions.md)). |
| `WININET.dll` | `wininet/` | 12 | HTTP as a handle tree; a request parks the caller. |
| `IMM32.dll` | `imm32/` | 10 | "There is no input method" — which is the state a game asks for. |
| `RPCRT4.dll` | `rpcrt4/` | 6 | `UuidCreate` and the other GUID/status helpers a COM-adjacent program links directly. |
| `VERSION.dll` | `version/` | 8 | The version block read out of a file's own image, A and W: `VerQueryValueA` answers a text value in ANSI, in the room `GetFileVersionInfoSize` reserves behind the block (marked `FE2X`), or in place when the caller copied the block into less; `VerQueryValueW` answers the block's own UTF-16. |
| `LZ32.dll` | `lz32/` | 4 | The LZ compression stubs an older installer links and never has cause to call successfully. |
| `MSWSOCK.dll` | `wsock32/` | 4 | The Winsock extensions. |
| `COMDLG32.dll` | `comdlg32/` | 4 | File dialogs, answered as cancelled. |
| `SHLWAPI.dll` | `shlwapi/` | 4 | Path and string helpers an installer imports for convenience. |
| `WINSPOOL.DRV` | `winspool/` | 3 | Print spooler entry points, answered as "no printers". |
| `MPR.dll` | `mpr/` | 2 | Network provider entry points, answered as "not connected to a network". |
| `MSACM32.dll` | `msacm32/` | 42 | The Audio Compression Manager with no codec drivers installed: the whole exported surface declared for its stack widths, every driver or stream request answered "not supported"/"not possible", so middleware that links against it loads and decodes on its own. |
| `SHFOLDER.dll` | *(built in `module.js`)* | 2 | A two-export forwarder to shell32's `SHGetFolderPathA`/`SHGetFolderPathW`, sharing shell32's own function objects. |
| *(no DLL)* | `quartz/` | — | The DirectShow filter graph, reached through `CoCreateInstance(CLSID_FilterGraph)`; registered on the COM registry, not as an import table. |

Total: 1552 table entries across 28 libraries, 1419 distinct functions.

**Inventory method.** `dbg/docs/count-dlls.mjs` (throwaway; not part of the build) creates the
module against the same stub host `src/layers/win32/module.test.js` uses
(`win32Module.create({ fpu: {} }, stubHost())`), then counts `Object.keys(table).length` for each
entry of `api.libraries()`, sums them, and counts the keys of the union of every table for the
distinct figure. `diagnostics().libraries` reports the same per-library numbers on a running
engine.

### From a table to a module

A table entry is `{ argBytes, handler }` — the bytes the callee pops (zero for cdecl, where
`argBytes` describes the stack layout only) and a function of the argument array. An entry may
instead carry `guest`, a builder that emits guest code and registers the traps it falls back to
(critical sections do this). The assembler (`src/app.js`) merges `win32.libraries()` with the
tables from `graphics`, `audio`, `input` and `media`, registers every handler with the bridge under
`DLL!Name`, and asks the loader to synthesise one in-guest module per library, with the ordinals
`win32.ordinals()` declares for the libraries imported by number
([`loader.md`](./loader.md)). An export's address is its trampoline inside that module, and it is
what both the import table and `GetProcAddress` hand out, so a program comparing the two finds them
equal. A table that exports `DllMain` is a module with an entry point, run on the first
`LoadLibrary`. An import no table provides is bound to a stub (`app.js`, `missingImport`) that
counts the call and emits an `unimplemented` event; whether it may return is decided by what the
caller expects of the stack, since the argument bytes are the one thing that must be right:

| import | stub |
|--------|------|
| `_name@N` (decorated stdcall) | Returns zero and pops N bytes. |
| Any name from a library `win32.libraryConvention()` declares cdecl — `msvcrt`, `msvcr*`, `msvcp*`, `crtdll`, `ucrtbase` | Returns zero and pops nothing; the caller cleans up. |
| An undecorated name (or an ordinal) from any other library — every Win32 system export is one | **Stops the process** on the first call with a guest fault: `unimplemented import KERNEL32.dll!Name, called from 0x… image+0x… (rva 0x…); argument bytes unknown, the stack holds w0 w1 w2 w3`. No stub can return from it with the stack right, and a program that goes on fails somewhere unrelated several calls later. The full list of what is unbound is already reported at load as `import-unresolved`. |
| A name a library the program brought does not export | As the decoration says (a mismatch between two of its own files, not a gap in this build); both events carry `origin: 'program'` rather than `'system'`. |

The fault is raised through `cpu.raiseFault` and the stub's return is sent into the park loop,
so the caller never runs another instruction; the run ends as `guest-fault`, the same way a
processor exception does.

`kernel32/modules.js` therefore creates nothing: `LoadLibrary` reports what is already synthesised
(or reads a library the program ships through `modules.load`), and an address taken at the first
instruction is the address that works at the last.

### The process model

Everything a process owns lives inside one `create()` call — a second process in the same realm
gets its own heap, hive, queue and COM registry.

- **Heap** (`kernel32/heap.js`). One allocator over the arena serves `HeapAlloc`,
  `GlobalAlloc`, `LocalAlloc`, `VirtualAlloc`, `malloc`, `CoTaskMemAlloc`, DIB bits, vtables, and
  the graphics and audio layers' locked buffers, because a program frees with one what it allocated
  with another and Windows lets it. Bookkeeping stays on the host side, so an overrun corrupts a
  neighbour, as on Windows, and never the allocator. Blocks are 8-byte aligned; `VirtualAlloc`
  reservations begin on 64 KiB boundaries. `GlobalMemoryStatus` reports what is left of the arena.
  Free spans are kept by size class and coalesced through maps by address, so an allocation and a
  free are lookups whatever the heap holds; the maps are never deleted from, only written over,
  because deleting a key from a large map and setting it again -- what handing an address out
  and back does -- is slow in the engine underneath. Addresses are deterministic for a given
  sequence of requests.
  **Zeroes are not written where they are already there.** Guest memory begins zero and only the
  guest writes into it, so arena above the allocator's high-water mark reads as zero already and a
  caller promising zeroes — `HeapAlloc(HEAP_ZERO_MEMORY)`, `GMEM_ZEROINIT`, a reservation — clears
  only memory that has been handed out before. A commit inside a reservation writes nothing at
  all: the reservation was handed over reading zero, and a page the program had not committed it
  cannot have written. That also makes committing an already-committed page keep its contents, as
  Windows documents. What a program gives back with `MEM_DECOMMIT` is remembered as ranges, kept
  apart so a page between two of them stays committed, and cleared where it commits inside them
  again, because there Windows takes the pages away and hands new ones back. The one thing this
  must never do is let one allocation's data reach the next, and that is the case the tests pin
  hardest.
  **`VirtualAlloc` does what its allocation type says.** `MEM_RESERVE` with an address places the
  reservation there -- the address rounded down to its granule, the end to the page -- through the
  allocator's `allocateAt`, and fails with `ERROR_INVALID_ADDRESS` (487) if any of it is taken;
  `MEM_COMMIT` alone at an address commits inside an existing reservation, 487 outside one;
  `MEM_RESET` keeps the pages and their contents, since there is no paging to spare them from. A
  type with none of those, `MEM_RESET` with another, or a zero size is `ERROR_INVALID_PARAMETER`
  (87); `MEM_TOP_DOWN` and `MEM_WRITE_WATCH` are accepted and ignored. `VirtualFree` takes exactly
  one of `MEM_DECOMMIT` and `MEM_RELEASE` (87 otherwise); a release takes the reservation's base
  and no size (487 for an interior address, 87 for a size), a decommit any pages inside it. Both
  set the last error on every refusal. The compiled `virtual.exe` (`src/virtual.itest.js`) checks
  each of these through a real program.
- **Windows** (`user32/windows.js` with `paint.js`, `system.js`, `objects.js`, `dialogs.js`,
  `controls.js`, `frame.js`). One window table shared by the files. `windowService` is the
  outward view: `list()` of live windows with their screen rectangles and `place()`, which is what
  a fullscreen device uses through `placeWindow` so a program re-reading its rectangle on
  `WM_SIZE` clips its cursor to the picture. A window has the frame its styles give it
  (`frame.js`: border, caption with title and close box, scroll bars), which `DefWindowProc`
  paints on `WM_NCPAINT` and which `GetClientRect`, `ClientToScreen` and `AdjustWindowRect` all
  derive from the same metrics. `DestroyWindow` *sends* `WM_DESTROY`, then destroys the children,
  then sends `WM_NCDESTROY`, and only then stops the handle resolving -- the procedure runs before
  the call returns, while whatever the program keeps behind the window still exists; a window
  whose CBT hook refused it hears nothing, one whose `WM_CREATE` answered -1 hears `WM_NCDESTROY`
  alone. Painting goes through the desktop surface the graphics layer
  owns (`docs/core/graphics.md`): `BeginPaint` sends `WM_NCPAINT` and `WM_ERASEBKGND` first, a
  window's update area is one rectangle, a window that is invalidated marks every window painted
  after it that overlaps it, and the desktop is presented when the queue finds nothing left to
  paint. `UpdateWindow` and `RedrawWindow(RDW_UPDATENOW)` *send* `WM_PAINT` (with
  `RDW_ALLCHILDREN`, to the descendants after the window), so the procedure has painted when the
  call returns. A region names its bounding rectangle (`InvalidateRgn`, `ValidateRgn`,
  `RedrawWindow`'s region, read through gdi32's `regionBox`; `GetUpdateRgn` fills one through
  `setRegion`). `ValidateRect` takes its rectangle out of the update area exactly when what is
  left is still a rectangle -- a band off one side -- and otherwise leaves the area whole. The **system classes** — `Button`, `Static`, `Edit`, `ListBox`, `ComboBox`,
  `ScrollBar` and the dialog class `#32770`, also by their atoms — have their procedures on this
  side (`controls.js`); each has a real address (a bridge stub) that `GetWindowLong(GWL_WNDPROC)`
  reports and `CallWindowProc` reaches, so a program may subclass one. Dialogs are windows of the
  dialog class: the template is walked for real, coordinates are dialog units, the dialog
  procedure sees every message first and `DefDlgProc` the rest, and `IsDialogMessage` handles
  Enter, Escape and Tab. Pointer messages from the input layer are routed to the window under
  the point (or the capture), in that window's client coordinates, with the frame's hit test
  turning them into non-client messages; keys go to the focus window. **Activation** is sent,
  not posted, whenever a guest call causes it -- `SetFocus`, `SetActiveWindow`,
  `SetForegroundWindow`, `ShowWindow` -- in Windows' order: `WM_NCACTIVATE` and `WM_ACTIVATE` to
  the window losing it, the same to the one gaining it, then `WM_KILLFOCUS`/`WM_SETFOCUS`. A press
  activates its window when the program takes it from the queue (`GetMessage`, `PeekMessage` with
  `PM_REMOVE`): `WM_MOUSEACTIVATE` is sent (a child's default procedure asks its parent), and
  `MA_ACTIVATE` activates with `WA_CLICKACTIVE` and raises, the `NOACTIVATE` answers leave the
  activation alone, and the `ANDEAT` answers drop the press. Only a window made visible as it is
  created is still told by posting, there being no guest call to send from. The input layer's
  foreground is the active window (`activeWindow()` on the API) -- not simply the last one
  created, which may be hidden or a child -- and only while none is active the last created.
  `GetWindow` walks top-level windows from the top of the Z order and children in creation order,
  a new child going below its siblings, so a dialog's first control is its `GW_CHILD`.
- **Message queue** (`user32/messages.js`). Posted messages are a list; `WM_MOUSEMOVE` is one
  slot, not a backlog; `WM_QUIT` is a flag that becomes a message when the queue is empty;
  `WM_TIMER` is never queued but synthesised when a program asks and a timer is due, with the due
  time moving only when the message is taken — a peek that does not remove leaves the tick.
  `nextTimerDue()` tells the driver when to look again, so a machine with nothing to run waits until
  the earliest timer rather than polling. Timers are due against the guest clock. The queue is the
  process's, so a timer set with no window remembers the thread that set it: only that thread's
  pump is handed its ticks, `SetTimer(NULL, id)` from it retunes the timer rather than making
  another, and when the thread ends the timer goes with it (no wait wakes for it again). A
  window's timer goes to whichever thread pumps. `DispatchMessage` calls a `WM_TIMER`'s lParam
  only when it is the TIMERPROC a live timer of that window and id was set with, and hands it
  the message's time; any other `WM_TIMER` with an lParam is dropped, as Windows drops it,
  because anyone can post one.
- **Registry** (`advapi32/registry.js`). A hive of keys and values; names compare without case,
  string types carry their terminator. It converts to and from JSON, and `onChanged` lets the
  session saver treat a registry write like a file write. Roots: `HKEY_CLASSES_ROOT`,
  `HKEY_CURRENT_USER`, `HKEY_LOCAL_MACHINE`, `HKEY_USERS`.
- **The display** (`user32/display.js`, `user32/system.js`). `displayModes(screen)` lists the sizes
  of the era whatever the display's own — 640×480, 800×600, 1024×768, 1280×720, 1280×800,
  1280×832, 1440×900, 1512×982, 1600×900, 1680×1050, 1728×1117, 1920×1080, 1920×1200,
  2560×1440, 2560×1600, 2560×1664, 2880×1800, 3024×1964, 3456×2234 (the widescreen standards
  and the scaled and native sizes of today's laptop displays), plus the display's size and
  the current mode if not among them — at the screen's depth, each size at 60 and at 120 Hz
  (`REFRESH_RATES`), since a program that saved the rate of the display it was configured on
  looks for a mode at exactly that rate; the mode in effect answers
  `REFRESH_HZ = 60`. A mode larger than the display is not refused: the picture is a canvas the
  page scales, so it is shown smaller, and a person on a small screen still gets the size a program
  looks best at. `EnumDisplaySettingsA` walks that list by index and answers the current mode
  for `ENUM_CURRENT_SETTINGS` and `ENUM_REGISTRY_SETTINGS`; the enumeration ends. `GetSystemMetrics`
  and `GetDeviceCaps` answer from the same `screen`, so the desktop a program measures and the
  device it then creates agree.
- **COM** (`ole32/objects.js`). Classes, interfaces with declared method order (the vtable),
  reference counts, one `IUnknown` per object. `bridge.publishInterface` puts the vtable in guest
  memory.

### Threads and waits as a program sees them

`CreateThread` asks the kernel for a thread and gives it a return stub, so a start routine that
returns exits with its `EAX` as the exit code. `WaitForSingleObject` / `WaitForMultipleObjects`
poll when the timeout is zero and otherwise hand the thread to `kernel.wait` with a deadline in
guest time; the bridge parks the caller until it is woken. `Sleep(0)` yields; `Sleep(n)` sleeps on
the kernel's clock. Events, mutexes and semaphores are kernel objects behind kernel handles.
`SuspendThread`, `ResumeThread`, `TerminateThread`, `ExitThread` exist; a wait on a child's
*process* handle hands over to the child and returns when it exits (see below and
`kernel32/spawn.js`). Critical sections are the exception to "every call crosses into the host":
`kernel32/critical.js` emits the enter/leave/try-enter fast paths as guest x86 on the pre-Vista
algorithm over the program's own `CRITICAL_SECTION` fields, and only a contended entry or an owed
wake traps. Completion ports (`kernel32/iocp.js`) block a worker with the scheduler's own wait and
owe a packet from every overlapped read or write on a bound handle. TLS slots are read out of the running thread's own block through its TLS pointer rather than
tracked on the host, so what `TlsGetValue` answers cannot drift from what the guest reaches
through `FS`.

Asynchronous procedure calls (`kernel32/apc.js`) are queued per thread -- by `QueueUserAPC`, or by a
waitable timer at each expiry for the completion routine `SetWaitableTimer` was given, queued to
the thread that set it -- and run only when that thread waits alertably: `SleepEx`,
`WaitForSingleObjectEx`, `WaitForMultipleObjectsEx`, `SignalObjectAndWait` with `bAlertable`,
`MsgWaitForMultipleObjectsEx` with `MWMO_ALERTABLE`. A thread that finds routines queued when it
starts such a wait runs them all, including any they queue, and answers `WAIT_IO_COMPLETION`
without waiting; one already waiting is taken off its objects' queues by `kernel.alert` and sent,
instead of back to its caller, to a stub whose return lands on the caller's address -- the stub
runs the routines on that thread and answers `WAIT_IO_COMPLETION` from the wait.

### Exceptions

Structured exception handling is the chain a program keeps at `FS:[0]`, walked fresh on every
dispatch (`kernel32/seh.js`): each frame's handler is called in chain order with the record, its
frame and a context, all built on the program's own stack below where it stood. `RaiseException`
dispatches; a processor exception does too -- divide error, overflow, bound, invalid opcode,
breakpoint (reported at the `int3`, as the system reports one), protection and page faults as
access violations, alignment and SIMD -- with the faulting code's registers in the context, the
stub's two spent registers restored from what it saved. `RtlUnwind` calls each frame's handler with
the unwinding flag and takes the frame off the chain as the handler returns, not all at the end, so
a handler that raises while it runs starts from the chain as it now stands; an unwind to a frame
that is not on the chain unwinds nothing. What nothing handles goes to the program's last-chance
filter (`SetUnhandledExceptionFilter`) and then ends the process with the exception's code as its
exit code; a processor exception in a program with no filter stops the machine with the fault
report instead, since that report is the only account of it.

The C runtime's half is what the compiler registers. `_except_handler3` (`msvcrt/seh.js`) reads
the function's scope table and runs its blocks with EBP set to the frame plus `0x10`, as the
compiler's code expects: a filter finds the exception pointers at `[EBP-0x14]`, `__finally`
blocks nested inside an accepting level run innermost first with the level lowered before each,
and the `__except` block is entered with ESP reloaded from `[EBP-0x18]`. `_local_unwind2` is the
same walk for a `return` out of a `__try`, and `_abnormal_termination` answers whether the running
`__finally` is one this runtime started. `setjmp`/`_setjmp3` mark where the call returns to, with
the chain's head and -- for `_setjmp3` -- the routine and level that unwind the setting frame;
`longjmp` unwinds every frame registered since the mark and calls that routine
(`_seh_longjmp_unwind`, `__CxxLongjmpUnwind`) before going back.

C++ exceptions (`msvcrt/eh.js`) are the same chain. `_CxxThrowException` raises `0xE06D7363`
with the object and its type description; `__CxxFrameHandler`, `2` and `3` read the tables the
compiler's stub hands over and answer for the frame: being unwound, they run the destructors of
every object alive; otherwise they look for a catch among the try blocks around the frame's state,
matching types by descriptor or by decorated name and by the thrown object's qualifiers. On a
match the frames below are unwound, the catch object is built (a reference is a pointer to the
thrown object, a class with a copy constructor is constructed by it), the try block's own objects
are destroyed, and the catch block runs on the stack below the throw where the thrown object
still lives; the function goes on at the address the block returns, on the stack the frame's slot
held before the block wrote its own there, and the thrown object is destroyed unless the block
threw it again. `throw;` rethrows the innermost catch's object; with none being handled it
terminates. A structured exception reaches only a `catch (...)`, and not in code built with
`/EHs`; `_set_se_translator`'s translator is called first when one is installed. `terminate` calls
what `set_terminate` installed and then aborts; `abort` ends the process with exit code 3.

Every handler that finds its block answers the host call it is with a continuation
(`bridge.continueAt`, see [`bridge.md`](./bridge.md)): the throw, the dispatch and the handler
never return, and whatever the thread was doing below the catching frame is abandoned.

### Files through the VFS

`kernel32/vfs.js` translates the filesystem layer's named failures and handle objects into what
`CreateFile`, `ReadFile` and `FindFirstFile` are: calls that never throw, that tell "missing" from
"the directory above is missing", and that read at an offset they name. Which error number the
guest is told is `kernel32/files.js`'s decision (`ERROR_FILE_NOT_FOUND`, `ERROR_PATH_NOT_FOUND`,
`ERROR_SHARING_VIOLATION`, …). A `BLOCK_MISS` thrown by a bundle-backed volume becomes a promise:
`vfs.read` calls `fetchBlocks(miss.blocks)`, seeks back and reads **once** more — a second miss is
a fetch that did not deliver. `ReadFile` sees the promise and returns it; the bridge parks the
calling guest thread and resumes it with the bytes, exactly as it parks any call that has no answer
yet. A read that fails once parked writes `ERROR_IO_DEVICE` for the parked thread, not for whoever
is running by then. File mappings (`kernel32/mapping.js`) are a copy read at map time and written
back at unmap, and park the same way. The standard handles are never files: writing to them goes to
`onOutput`.

### Time and its clock source

Two clocks, both the kernel's ([`kernel.md`](./kernel.md)):

| function | source |
|----------|--------|
| `GetTickCount`, `QueryPerformanceCounter` (1 MHz), `timeGetTime`, `clock`, `Sleep` deadlines, message timers | `kernel.clock.virtualTime()` — the guest's clock. A frame loop that times an interval with one call and reads it with another must not disagree with itself. |
| `GetSystemTimeAsFileTime`, `GetSystemTime`, `GetLocalTime`, `time`, `timeGetSystemTime` | `kernel.clock.wallClock()` — the date. |

`GetTickCount` wraps at 32 bits as Windows does. `GetVersionExA` reports 5.1 build 2600,
`VER_PLATFORM_WIN32_NT`, workstation, no service pack.

### The divergence rule

A call that this build accepts but does not do all of what Windows promises **succeeds and
reports**, through `config.divergence(api, detail)`; it is never refused for that reason, because
refusing changes what the program does, usually by stopping it. The assembler emits each distinct
`(api, detail)` once as a `divergence` event, journalled at `warn`. Sites in this layer:
`HeapAlloc`/`VirtualAlloc` refusals with the allocator's state (`kernel32/heap.js`),
`CoCreateInstance` of an unregistered class, naming the CLSID (`ole32/functions.js`), the
automation library (`oleaut32/functions.js`), `InternetCanonicalizeUrl` browser mode
(`wininet/functions.js`), and four DirectShow states (`quartz/graph.js`: stop cannot rewind, a film
running on the host clock without its sound, position and rate accepted and ignored). The
`NOT_IMPLEMENTED` stub of `system/stub.js` is not used inside this layer; a function that is not
implemented answers with the documented code that ends the caller's loop
(`ERROR_CALL_NOT_IMPLEMENTED`, `ERROR_NO_MORE_ITEMS`, `E_NOTIMPL` for a COM slot nothing
implements).

### Small contracts, one paragraph each

- **The C runtime's variables are data exports**, read through the address a program imported:
  `_acmdln`, `_pctype`, `__mb_cur_max`, `_adjust_fdiv`; the system version as `_osver`,
  `_winver`, `_winmajor` and `_winminor`, the figures `GetVersion` answers; `_HUGE` as
  infinity; `_environ` as the vector `__getmainargs` hands `main`; and `_iob`, twenty `FILE`
  records whose first three are stdin (at its end: nobody types), stdout and stderr (the console)
  -- `__iob_func` answers the same array.
- **The processor is described once** (`kernel32/processor.js`): the emulated CPUID's leaf 1 --
  GenuineIntel, family 6 model 7 stepping 3, its EDX and ECX feature bits -- and everything a
  program can ask derives from it: `GetSystemInfo`'s level and revision, `IsProcessorFeaturePresent`
  (SSE3 and RDRAND included, execute-disable and PAE answered no since nothing enforces or pages),
  the registry's `CentralProcessor\0` identifier and speed, the process block's processor count
  and `NtQuerySystemInformation`'s. `src/processor.itest.js` runs CPUID in a program and holds the
  record to the answer.
- **`SendInput`** inserts mouse events into the same stream a real device feeds: each one goes to
  the input layer through `sendInput`, so it turns into a `WM_MOUSEMOVE`/button message and a
  DirectInput delta both, exactly as a physical move or click would. `cbSize` must be
  `sizeof(INPUT)` (28 bytes) or the whole call is refused with `ERROR_INVALID_PARAMETER`. Keyboard
  and hardware `INPUT` records are not injected; a program that asks for one gets a `divergence`
  naming the type it asked for, never a silent success (`user32/system.js`).
- **`RegisterHotKey`/`UnregisterHotKey`** claim a keystroke in the message queue rather than at the
  device. A null `hWnd` claims it for the calling thread: the `WM_HOTKEY` that follows is posted
  with no window, which is exactly what a pump asking for every window retrieves and what one
  naming a window never sees. A key already claimed answers `ERROR_HOTKEY_ALREADY_REGISTERED`;
  releasing one nobody claimed answers `ERROR_HOTKEY_NOT_REGISTERED`.
- **`LoadMenuA/W`** reads an `RT_MENU` resource out of the program's own module and builds it into
  the same menu records the rest of user32's menu calls use; a resource that does not exist
  answers zero, which is what a program checks before it puts the menu on a window.
- **`CloseWindow` minimises**, despite its name — a program that means to be rid of a window
  destroys it instead — and `IsIconic` reads back the minimised state that
  `ShowWindow(SW_MINIMIZE)` (or `CloseWindow`) set.
- **`SetCursorPos` moves the same cursor the input router owns**, through its `place()`: placing is
  not motion, so a relative device (DirectInput) sees nothing from it, but a real cursor warp is
  announced with `WM_MOUSEMOVE` when the position actually changes — what a mouse-look program that
  reads its distance from the centre and warps back every frame needs to keep working. A placement
  holds while the program holds the cursor — hidden, or with a button down, as in a drag that turns
  a camera — and the pointer's positions are taken as motion from it; once the cursor is shown with
  no button held, the pointer's next position is the cursor's again, since the page's pointer could
  not be warped and the person is looking at it (the router's `shown()`, fed by both `cursor`
  reporters).
- **The `cursor` event is user32's own report.** `ShowCursor`'s display count and `SetCursor`'s
  null/non-null answer both derive one picture, `{ shown }`, reported to the page only on a change
  of that picture — a program that hides the cursor inside its frame loop does not flood the page's
  queue — and it carries no image, because the bitmap behind a cursor handle is never decoded here.
- **`CLSID_ShellLink`** (`IShellLinkA/W`, `IPersistFile`) exists so an installer's shortcut step can
  finish: refusing the class turns every shortcut into "Access is denied" and ends the install in a
  warning dialog. `Save` writes an empty file at the target path — enough for a later "is the link
  there" check to pass — and it does not write a real `.lnk`, since the guest's Start Menu is never
  drawn and the launcher starts a game's executable directly; every method that stands in for work
  this build does not do reports so through the divergence channel, and the strings a program sets
  are kept and handed back verbatim (`shell32/shelllink.js`).
- **WMI is `CLSID_WbemLocator` and one class** (`ole32/wbem.js`): `ConnectServer` to `root\cimv2`,
  then `CreateInstanceEnum` or a WQL `ExecQuery` over `Win32_VideoController`, whose one instance
  answers `AdapterRAM` (256 MB, the figure Direct3D's `GetAvailableTextureMem` reports) and its
  name strings. A program refused the locator does not fail; it assumes the least video memory it
  supports and picks its lowest settings without saying so. Any other class enumerates empty, a
  `WHERE` is ignored, and every other method is refused, each through the divergence channel.
  `CoSetProxyBlanket` and `CoInitializeSecurity` succeed: every object lives in the caller's process.
- **`_control87` is `_controlfp` under its older name** — the same word, the same mask arithmetic,
  one piece of state — because a program may set the FPU control word through one entry point and
  read it back through the other, and answering from two separate words would make that read-back a
  coin toss (`msvcrt/startup.js`).
- **The `isw*`/`tow*` wide-character classifiers are bound to the byte classifiers** so the two
  families cannot disagree below `0x80`; above it they follow the C locale as a real Windows
  answers through `iswctype`: the Latin-1 letters are alpha (except the multiplication and division
  signs among them), `0x85` and `0xa0` are the two extra spaces the ASCII table does not carry, and
  case folding stays ASCII, so those letters are alpha with no upper or lower answer of their own
  (`msvcrt/mbstring.js`).
- **A `va_list` is read as a fixed window**, since the list carries no argument count of its own:
  `varargsSlots` reads slots up to the end of the memory region the pointer sits in — a thread's
  stack has a top, and a program formatting from just below it is within its rights, since every
  argument it reads is there — rather than faulting a read that would otherwise run past the region
  (`msvcrt/format.js`).
- **`(HANDLE)-1` and `(HANDLE)-2`** are the current-process and current-thread pseudo-handles
  wherever a handle is taken (`WaitForSingleObject`, `WaitForMultipleObjects`, `DuplicateHandle`,
  …): they are not entries in the handle table, which is what makes them always valid, so a lookup
  maps them before it ever misses. A wait on the current-process pseudo-handle can only time out or
  park for ever, since it can only be signalled once the waiter itself has stopped
  (`kernel32/threading.js`).
- **`WM_INITDIALOG` is sent, not posted**, during `CreateDialogParam`/`DialogBoxParam`: the dialog
  procedure runs after every control exists and has set itself up, and before a template's
  `WS_VISIBLE` shows the window — so a program that fills in a control from that handler finds it
  already filled when the window first appears (`user32/dialogs.js`).
- **A redistributable installer is a child that has already finished.** `CreateProcess` on a
  `vcredist*`/`vc_redist*`, a `dotnetfx*`/`ndp*`/`netfx*` or `oalinst.exe` answers a process record
  created `completed`: exit code 0 from the start, and never the process this one hands over to.
  `WaitForSingleObject`, `WaitForMultipleObjects` and `GetExitCodeProcess` on it all return at once
  rather than parking for a runtime the engine answers for itself — the C runtime under `msvcrt`
  (`kernel32/spawn.js`, `isRedistributableInstaller`). The DirectX setup (`DXSETUP.exe`) is not
  one of them: the engine carries no copy of the `d3dx`/`d3dcompiler` libraries it installs, so it
  runs as the child it is and puts them in `system32`.

## 4. Limitations and divergences

Stated as the code states them.

- **Every listed display mode can be set.** `ChangeDisplaySettingsA`/`ExA` switch the screen to
  any mode `EnumDisplaySettingsA` lists -- the metrics, the desktop rectangle and the current
  settings follow, the refresh rate is accepted as asked, `CDS_TEST` answers without switching, and
  a null mode returns to the display's own size -- and answer `DISP_CHANGE_BADMODE` for a size or
  depth the list does not carry. `EnumDisplayDevicesA` reports no devices.
- **One process running at a time.** `CreateProcess`/`WinExec`/`ShellExecute` record the request
  and succeed; the child runs once the parent has nothing left to do. A parent **waiting on the
  child** -- `WaitForSingleObject` on its process handle, or `WaitForMultipleObjects` for any of a
  set holding it -- is noted on the child's record, and the engine (`createApp`'s `runBeside`)
  builds the child a machine of its own beside the parent's, runs it (its own children the same
  way), copies back the files it wrote and the registry it changed, and wakes the wait with
  `WAIT_OBJECT_0` (or the child's place in the set); `GetExitCodeProcess` then answers the child's
  exit code. `childWaitedOn`/`childExited`/`refreshWindows` on the win32 API are that seam. A parent
  that exits, is idle for another reason, or waits for *all* of a set holding a child is replaced by
  the child as before. While the child runs nothing of the parent's does -- no time passes for it,
  so a wait's timeout is not armed -- and after it, layer diagnostics describe no instance (every
  layer keeps one current instance, which the child's disposal clears). All three resolve
  the image the same way (`kernel32/spawn.js`), so a program started through the shell is the one
  that was named. A child's working directory is its own image's: `lpCurrentDirectory` and
  `lpDirectory` are accepted, reported as a divergence, and not carried. `ShellExecute` runs a file
  whose extension is its own handler (`exe`, `com`, `bat`, `cmd`, `pif`, `scr`) under the `open` and
  `runas` verbs -- `runas` without a prompt, there being one user -- and answers `SE_ERR_NOASSOC` for
  a document or any other verb, since the handler for one would come from a registry this build does
  not have; a file that is not on the volume is `SE_ERR_FNF`. `ShellExecuteEx` fills `hInstApp` and,
  for `SEE_MASK_NOCLOSEPROCESS`, `hProcess`; a record naming an item id list or a class is refused.
  `SHBrowseForFolder` and the common dialogs are cancelled.
- **The shell namespace is the volume.** `SHGetDesktopFolder` answers an `IShellFolder` whose one
  child is the computer (`CSIDL_DRIVES`), under which the drives and their directories are
  enumerated (`IEnumIDList`), bound to, compared, named and parsed; every item id carries the full
  text of what it names, so a combined list turns back into a path. No view objects, no
  renaming, no storage binding (`E_NOTIMPL`).
- **Exceptions: what is not modelled.** Exception specifications (`throw(...)` on a function)
  are not checked, so `unexpected` is never called. `_except_handler4` is not provided: it
  belongs to the static C runtime a program links into itself, which brings its own. A handler
  that continues execution from a changed context gets its general registers and EIP back, not
  EFLAGS. And with no paging, no stray pointer faults (see [`cpu.md`](./cpu.md)): a program
  counting on an access violation from the null page carries on instead.
- **No network, no HTTP, by default.** Winsock runs over a loopback adapter; WinInet without a
  transport fails with "cannot connect". Both libraries load so a program that imports and never
  uses them still starts.
- **No midi, mixer, aux, joystick, MCI or recording devices**; opening one fails as on a machine
  without it. Wave-out is real.
- **File mappings are copies**: two views of one file do not see each other's writes.
- **`EnumSystemLocalesA`** answers `ERROR_CALL_NOT_IMPLEMENTED`; **`FormatMessageA`** handles only
  `FORMAT_MESSAGE_FROM_SYSTEM`; **`HeapWalk`** ends the walk at once.
- **DirectShow** decodes forward only: stop does not rewind, seeking and rate are ignored, and a
  graph with no decoder for a file answers `VFW_E_CANNOT_RENDER` and raises `EC_ERRORABORT` — the
  answer a machine without the codec gives.
- **The `double`-returning CRT functions exist only with an `fpu` host**; without one an import of
  `sin` is reported missing rather than bound to a function that never sets the result register.
- **No input method** (`imm32` succeeds by having nothing to do), **no image drawing** in image
  lists, **no message tables or module strings** in `FormatMessage`.
- **The system classes are the classic look and the common messages**: a combo box's list does
  not drop down (the arrow keys change the selection; said once as a divergence), a scroll bar's
  thumb is not dragged, an edit does not undo, an owner-drawn button or static paints its
  background only, and a static's image is drawn only when the bitmap has pixels this build can
  reach (said once otherwise).
- **Unimplemented imports** are reported once per name at load. A decorated stdcall name or a
  C-runtime name is answered with zero, which reads as failure under most conventions but as
  `S_OK` to a caller expecting an `HRESULT`; an undecorated name from any other library stops
  the process on its first call (§3, "From a table to a module").

Reported at runtime: `divergence` (each once), `unimplemented` (each import once, plus a count per
name in the application's diagnostics as `unimplementedCalls`), `message-box`, `clipboard` (the
text a program copied, once its clipboard closes), `output`, `debug`,
and the metrics in §2.

## 5. Tests

Unit tests are colocated with each file, `node:test`, over `fakeMemory`
(`src/layers/win32/msvcrt/harness.test.js`) or a stub host; there are 104 `*.test.js` files under
`src/layers/win32/`. Run with `npm test` from `modules/core`.

| area | files (all `src/layers/win32/…`) |
|------|----------------------------------|
| kernel32 | `apc`, `consoleio`, `critical`, `drives`, `environment`, `files`, `filetime`, `heap`, `iocp`, `locale`, `mapping`, `process`, `processor`, `resources`, `seh`, `spawn`, `sync`, `system`, `teb`, `threading`, `vfs` `.test.js` |
| msvcrt | `convert`, `cxx`, `eh`, `format`, `functions`, `heap`, `math`, `mbstring`, `paths`, `scan`, `seh`, `startup`, `strings`, `time` `.test.js` |
| user32 | `controls`, `dialogs`, `display`, `messages`, `objects`, `structs`, `system`, `windows` `.test.js` — `controls.test.js` paints a dialog through the real drawing engine and compares it byte for byte with `controls.reference.png` |
| gdi32 | `drawing`, `functions`, `objects` `.test.js` |
| the rest | `advapi32/functions`, `advapi32/registry`, `comctl32/functions`, `comdlg32/functions`, `imm32/functions`, `ntdll/{functions,integer,query,status,strings}`, `ole32/{functions,guid,objects}`, `oleaut32/functions`, `quartz/graph`, `shell32/functions`, `version/functions`, `wininet/functions`, `winmm/{functions,thread,timers}`, `wsock32/{functions,sockaddr,sockets,transport}` `.test.js` |
| module | `module.test.js` — a configured screen reaches user32 and gdi32; a DC through user32 is GDI's; both fall back to 640×480 together; the C runtime family is cdecl and every other library stdcall. |

`kernel32/critical.itest.js` runs the hand-assembled critical-section fast paths on the real
emulator (`npm run test:integration`), pinning that the bytes the unit test checks are x86 that
does the job. `src/exceptions.itest.js` runs three compiled fixtures -- `seh.exe`, `cxxeh.exe`,
`unhandled.exe`, built from `test/fixtures/src/` by `scripts/build-fixtures.mjs` with clang and
lld against the MSVC ABI -- through every path above, processor faults and two threads throwing
at once included. `src/apc.itest.js` runs `apc.exe`, built the same way: APCs to itself and to
another thread's alertable sleep, one refused by a wait that is not alertable, a routine queued
by a routine, and a timer's completion routine. End-to-end tests that drive a program through the whole surface live beside the
application entry point (`src/*.itest.js`) and in `tools/cdp_test/` (a real browser and GPU).
