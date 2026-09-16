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
| `network` | adapter `{ bind, unbind, find }` | loopback | The transport under Winsock. |
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
| `waveTick()` | Move every open wave device's play cursor; called by the driver, since nothing in the guest does. |
| `videoTick(nowMs, soundOwedMs?)` | Advance every running filter graph and return the frame to show. |
| `registry()` | The hive (`toJSON`/`fromJSON`/`onChanged`), whose contents outlive the process. |
| `lastError()` | The running thread's last error, for a tracer. |
| `com()` | The COM class registry; graphics and audio register their factories here. |
| `heap()` | The one allocator: `allocate`, `free`, `block`, `resize`, `diagnostics`. |
| `mappings()`, `ioCompletionWaits()`, `waveDevices()`, `waveThread()`, `criticalSections()`, `messages()`, `windows()`, `windowProcedures()` | Live views of the state below, used by `diagnostics()`. |
| `placeWindow(hwnd, x, y, width, height)` | Place a top-level window as the system would and tell the program with `WM_MOVE` and `WM_SIZE`. |
| `exitCode()` | Set once the program has asked to terminate; `null` before. |

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
| `KERNEL32.dll` | `kernel32/` | 316 | Console, threads and waits, heap and virtual memory, process and TLS, modules, files and directories, critical sections, locale and code pages, environment and command line, system info and time, `CreateProcess`, exceptions and SEH, resources, drives, file mappings and pipes, completion ports, file times, console I/O. |
| `USER32.dll` | `user32/` | 250 | Windows and classes, painting, system queries and display settings, objects (cursors, icons, menus, clipboard), dialogs, hot keys, `SendInput`. |
| `msvcrt.dll` | `msvcrt/` | 244 (193 without `fpu`) | The C runtime: strings, multibyte strings, conversion, formatting and scanning, heap, math, paths, streams (`stdio.js`: `fopen` and its family over the volume), threads (`threads.js`: `_beginthread`/`_beginthreadex` through kernel32's `CreateThread`), time, C++ support (`cxx.js`), CRT startup, CRT exception helpers. |
| `GDI32.dll` | `gdi32/` | 102 | Device contexts, objects and their lifetimes, metrics, drawing entry points. |
| `ntdll.dll` | `ntdll/` | 96 | Counted strings, status translation, machine queries, 64-bit helpers — and 76 entries that are the same function object kernel32 or msvcrt already publish. |
| `ADVAPI32.dll` | `advapi32/` | 71 | The registry API over the hive, `GetUserNameA`, SIDs, and a CryptoAPI provider (MD5, SHA-1, SHA-256, RC4, RSA signature verification). |
| `WINMM.dll` | `winmm/` | 55 | `timeGetTime`, wave-out with a real play cursor and a callback thread, multimedia file I/O (`mmio.js`: RIFF chunks over the volume's files); honest refusal for midi, mixer, aux, joystick, MCI and recording. |
| `ole32.dll` | `ole32/` | 40 | Apartments, `CoCreateInstance`, task memory, GUID conversions, over the COM object model in `objects.js`. |
| `OLEAUT32.dll` | `oleaut32/` | 39 | BSTR and VARIANT; imported by ordinal. |
| `WSOCK32.dll`, `WS2_32.dll` | `wsock32/` | 33 each | One socket registry under both names, over an injected adapter (loopback by default). |
| `SHELL32.dll` | `shell32/` | 21 | Launching a program (`ShellExecute`, `ShellExecuteEx`, `FindExecutable`), documented refusals where a registry or a person is needed (a document's handler, folder browse), the drag-and-drop truths, the namespace (`namespace.js`: `IShellFolder`/`IEnumIDList` over the volume), and `CLSID_ShellLink` (`IShellLinkA/W`, `IPersistFile`). |
| `COMCTL32.dll` | `comctl32/` | 17 | Image lists (indices only), mouse tracking, and `msctls_progress32`/`SysTreeView32` as built-in window classes. |
| `d3dx9_25.dll`, `d3dx9_26.dll`, `d3dx9_27.dll` | `d3dx9/` | 13 each | Stub tables for the D3DX helper libraries, shadowed by the real DLL whenever the DirectX system volume is mounted and a program does not ship its own ([`porting.md`](../../roadmap/registers/porting.md)). |
| `WININET.dll` | `wininet/` | 12 | HTTP as a handle tree; a request parks the caller. |
| `IMM32.dll` | `imm32/` | 10 | "There is no input method" — which is the state a game asks for. |
| `RPCRT4.dll` | `rpcrt4/` | 6 | `UuidCreate` and the other GUID/status helpers a COM-adjacent program links directly. |
| `VERSION.dll` | `version/` | 5 | The version block read out of a file's own image. |
| `LZ32.dll` | `lz32/` | 4 | The LZ compression stubs an older installer links and never has cause to call successfully. |
| `MSWSOCK.dll` | `wsock32/` | 4 | The Winsock extensions. |
| `COMDLG32.dll` | `comdlg32/` | 4 | File dialogs, answered as cancelled. |
| `SHLWAPI.dll` | `shlwapi/` | 4 | Path and string helpers an installer imports for convenience. |
| `WINSPOOL.DRV` | `winspool/` | 3 | Print spooler entry points, answered as "no printers". |
| `MPR.dll` | `mpr/` | 2 | Network provider entry points, answered as "not connected to a network". |
| `SHFOLDER.dll` | *(built in `module.js`)* | 2 | A two-export forwarder to shell32's `SHGetFolderPathA`/`SHGetFolderPathW`, sharing shell32's own function objects. |
| *(no DLL)* | `quartz/` | — | The DirectShow filter graph, reached through `CoCreateInstance(CLSID_FilterGraph)`; registered on the COM registry, not as an import table. |

Total: 1412 table entries across 27 libraries, 1284 distinct functions.

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
  Windows documents. What a program gives back with `MEM_DECOMMIT` is remembered as a range and
  cleared if it commits inside that range again, because there Windows takes the pages away and
  hands new ones back. The one thing this must never do is let one allocation's data reach the
  next, and that is the case the tests pin hardest.
- **Windows** (`user32/windows.js` with `paint.js`, `system.js`, `objects.js`, `dialogs.js`,
  `controls.js`, `frame.js`). One window table shared by the files. `windowService` is the
  outward view: `list()` of live windows with their screen rectangles and `place()`, which is what
  a fullscreen device uses through `placeWindow` so a program re-reading its rectangle on
  `WM_SIZE` clips its cursor to the picture. A window has the frame its styles give it
  (`frame.js`: border, caption with title and close box, scroll bars), which `DefWindowProc`
  paints on `WM_NCPAINT` and which `GetClientRect`, `ClientToScreen` and `AdjustWindowRect` all
  derive from the same metrics. Painting goes through the desktop surface the graphics layer
  owns (`docs/core/graphics.md`): `BeginPaint` sends `WM_NCPAINT` and `WM_ERASEBKGND` first, a
  window's update area is one rectangle, a window that is invalidated marks every window painted
  after it that overlaps it, and the desktop is presented when the queue finds nothing left to
  paint. The **system classes** — `Button`, `Static`, `Edit`, `ListBox`, `ComboBox`,
  `ScrollBar` and the dialog class `#32770`, also by their atoms — have their procedures on this
  side (`controls.js`); each has a real address (a bridge stub) that `GetWindowLong(GWL_WNDPROC)`
  reports and `CallWindowProc` reaches, so a program may subclass one. Dialogs are windows of the
  dialog class: the template is walked for real, coordinates are dialog units, the dialog
  procedure sees every message first and `DefDlgProc` the rest, and `IsDialogMessage` handles
  Enter, Escape and Tab. Pointer messages from the input layer are routed to the window under
  the point (or the capture), in that window's client coordinates, with the frame's hit test
  turning them into non-client messages; keys go to the focus window.
- **Message queue** (`user32/messages.js`). Posted messages are a list; `WM_MOUSEMOVE` is one
  slot, not a backlog; `WM_QUIT` is a flag that becomes a message when the queue is empty;
  `WM_TIMER` is never queued but synthesised when a program asks and a timer is due, with the due
  time moving only when the message is taken — a peek that does not remove leaves the tick.
  `nextTimerDue()` tells the driver when to look again, so a machine with nothing to run waits until
  the earliest timer rather than polling. Timers are due against the guest clock.
- **Registry** (`advapi32/registry.js`). A hive of keys and values; names compare without case,
  string types carry their terminator. It converts to and from JSON, and `onChanged` lets the
  session saver treat a registry write like a file write. Roots: `HKEY_CLASSES_ROOT`,
  `HKEY_CURRENT_USER`, `HKEY_LOCAL_MACHINE`, `HKEY_USERS`.
- **The display** (`user32/display.js`, `user32/system.js`). `displayModes(screen)` lists the sizes
  of the era up to the display's own — 640×480, 800×600, 1024×768, 1280×720, 1920×1080, plus the
  display's size and the current mode if not among them — at the screen's depth, every one at
  `REFRESH_HZ = 60`. `EnumDisplaySettingsA` walks that list by index and answers the current mode
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
`SuspendThread`, `ResumeThread`, `TerminateThread`, `ExitThread` exist; a wait on a *process* handle
never returns, because a child replaces its parent rather than running beside it (see
`kernel32/spawn.js`). Critical sections are the exception to "every call crosses into the host":
`kernel32/critical.js` emits the enter/leave/try-enter fast paths as guest x86 on the pre-Vista
algorithm over the program's own `CRITICAL_SECTION` fields, and only a contended entry or an owed
wake traps. Completion ports (`kernel32/iocp.js`) block a worker with the scheduler's own wait and
owe a packet from every overlapped read or write on a bound handle. TLS slots are read out of the running thread's own block through its TLS pointer rather than
tracked on the host, so what `TlsGetValue` answers cannot drift from what the guest reaches
through `FS`.

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
  reads its distance from the centre and warps back every frame needs to keep working.
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
- **A redistributable installer is a child that has already finished.** `CreateProcess` on
  `DXSETUP.exe`/`DXWebSetup.exe`, a `vcredist*`/`vc_redist*`, a `dotnetfx*`/`ndp*`/`netfx*`, or
  anything under a `DirectX\` directory answers a process record created `completed`: exit code 0
  from the start, and never the process this one hands over to. `WaitForSingleObject`,
  `WaitForMultipleObjects` and `GetExitCodeProcess` on it all return at once rather than parking for
  a runtime the engine already carries itself — the DirectX DLLs on its system volume, the C
  runtime under `msvcrt` — and would otherwise wait for a child that never runs
  (`kernel32/spawn.js`, `isRedistributableInstaller`).

## 4. Limitations and divergences

Stated as the code states them.

- **Every listed display mode can be set.** `ChangeDisplaySettingsA`/`ExA` switch the screen to
  any mode `EnumDisplaySettingsA` lists -- the metrics, the desktop rectangle and the current
  settings follow, the refresh rate is accepted as asked, `CDS_TEST` answers without switching, and
  a null mode returns to the display's own size -- and answer `DISP_CHANGE_BADMODE` for a size or
  depth the list does not carry. `EnumDisplayDevicesA` reports no devices.
- **One process, no children.** `CreateProcess`/`WinExec`/`ShellExecute` record the request and
  succeed; the child replaces the parent once the parent has nothing left to do. All three resolve
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
- **`__CxxFrameHandler` catches nothing.** It is declared with its four arguments and answers
  `ExceptionContinueSearch` with a divergence notice; a C++ exception thrown through such a
  frame is not caught by its `try` and the frame's destructors do not run.
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
(`src/layers/win32/msvcrt/harness.test.js`) or a stub host; there are 69 `*.test.js` files under
`src/layers/win32/`. Run with `npm test` from `modules/core`.

| area | files (all `src/layers/win32/…`) |
|------|----------------------------------|
| kernel32 | `consoleio`, `critical`, `drives`, `environment`, `exceptions`, `files`, `filetime`, `heap`, `iocp`, `locale`, `mapping`, `process`, `resources`, `seh`, `spawn`, `sync`, `system`, `teb`, `threading`, `vfs` `.test.js` |
| msvcrt | `convert`, `cxx`, `format`, `functions`, `heap`, `math`, `mbstring`, `paths`, `scan`, `seh`, `startup`, `strings`, `time` `.test.js` |
| user32 | `controls`, `dialogs`, `display`, `messages`, `objects`, `structs`, `system`, `windows` `.test.js` — `controls.test.js` paints a dialog through the real drawing engine and compares it byte for byte with `controls.reference.png` |
| gdi32 | `drawing`, `functions`, `objects` `.test.js` |
| the rest | `advapi32/functions`, `advapi32/registry`, `comctl32/functions`, `comdlg32/functions`, `imm32/functions`, `ntdll/{functions,integer,query,status,strings}`, `ole32/{functions,guid,objects}`, `oleaut32/functions`, `quartz/graph`, `shell32/functions`, `version/functions`, `wininet/functions`, `winmm/{functions,thread}`, `wsock32/{functions,sockaddr,sockets,transport}` `.test.js` |
| module | `module.test.js` — a configured screen reaches user32 and gdi32; a DC through user32 is GDI's; both fall back to 640×480 together; the C runtime family is cdecl and every other library stdcall. |

`kernel32/critical.itest.js` runs the hand-assembled critical-section fast paths on the real
emulator (`npm run test:integration`), pinning that the bytes the unit test checks are x86 that
does the job. End-to-end tests that drive a program through the whole surface live beside the
application entry point (`src/*.itest.js`) and in `tools/cdp_test/` (a real browser and GPU).
