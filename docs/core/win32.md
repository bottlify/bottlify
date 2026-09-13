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
| `onOutput(handle, text)`, `onTrace(text)`, `onMessageBox(notice)`, `created(hwnd)`, `spawned(request)` | callbacks | no-ops | Console output, `OutputDebugString`, `MessageBox`, window creation, `CreateProcess`. |
| `divergence(api, detail)` | callback | none | See §3, "The divergence rule". |

### Provided API (`module.js`)

| method | one line |
|--------|----------|
| `libraries()` | `{ 'KERNEL32.dll': table, … }` — every DLL, each a map from export name to `{ argBytes, handler }`. |
| `ordinals()` | Export ordinals for the libraries imported by number: `WSOCK32.dll`, `WS2_32.dll`, `OLEAUT32.dll`. |
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
| `KERNEL32.dll` | `kernel32/` | 256 | Console, threads and waits, heap and virtual memory, process and TLS, modules, files and directories, critical sections, locale and code pages, environment and command line, system info and time, `CreateProcess`, exceptions and SEH, resources, drives, file mappings and pipes, completion ports, file times, console I/O. |
| `msvcrt.dll` | `msvcrt/` | 209 (158 without `fpu`) | The C runtime: strings, multibyte strings, conversion, formatting and scanning, heap, math, paths, time, C++ support (`cxx.js`), CRT startup, CRT exception helpers. |
| `USER32.dll` | `user32/` | 145 | Windows and classes, painting, system queries and display settings, objects (cursors, icons, menus, clipboard), dialogs. |
| `ntdll.dll` | `ntdll/` | 96 | Counted strings, status translation, machine queries, 64-bit helpers — and 76 entries that are the same function object kernel32 or msvcrt already publish. |
| `GDI32.dll` | `gdi32/` | 75 | Device contexts, objects and their lifetimes, metrics, drawing entry points. |
| `WINMM.dll` | `winmm/` | 47 | `timeGetTime`, wave-out with a real play cursor and a callback thread; honest refusal for midi, mixer, aux, joystick, MCI and recording. |
| `WSOCK32.dll`, `WS2_32.dll` | `wsock32/` | 33 each | One socket registry under both names, over an injected adapter (loopback by default). |
| `ADVAPI32.dll` | `advapi32/` | 18 | The registry API over the hive, `GetUserNameA`, SIDs. |
| `COMCTL32.dll` | `comctl32/` | 14 | Image lists (indices only), mouse tracking. |
| `OLEAUT32.dll` | `oleaut32/` | 14 | BSTR and VARIANT; imported by ordinal. |
| `ole32.dll` | `ole32/` | 13 | Apartments, `CoCreateInstance`, task memory, GUID conversions, over the COM object model in `objects.js`. |
| `WININET.dll` | `wininet/` | 12 | HTTP as a handle tree; a request parks the caller. |
| `IMM32.dll` | `imm32/` | 9 | "There is no input method" — which is the state a game asks for. |
| `SHELL32.dll` | `shell32/` | 7 | Documented refusals (`ShellExecute`, folder browse) and the drag-and-drop truths. |
| `MSWSOCK.dll` | `wsock32/` | 4 | The Winsock extensions. |
| `VERSION.dll` | `version/` | 3 | The version block read out of a file's own image. |
| `COMDLG32.dll` | `comdlg32/` | 3 | File dialogs, answered as cancelled. |
| *(no DLL)* | `quartz/` | — | The DirectShow filter graph, reached through `CoCreateInstance(CLSID_FilterGraph)`; registered on the COM registry, not as an import table. |

Total: 991 table entries across 18 libraries, 892 distinct functions.

**Inventory method.** A script in the session scratchpad created the module against the same stub
host `src/layers/win32/module.test.js` uses (`win32Module.create({ fpu: {} }, stubHost())`),
then counted `Object.keys(table).length` for each entry of `api.libraries()`, summed them, and
counted the keys of `Object.assign({}, ...tables)` for the distinct figure. `diagnostics().libraries`
reports the same per-library numbers on a running engine.

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
`LoadLibrary`. An import no table provides is bound to a stub that counts the call, emits an
`unimplemented` event and returns zero (`app.js`, `missingImport`).

`kernel32/modules.js` therefore creates nothing: `LoadLibrary` reports what is already synthesised
(or reads a library the program ships through `modules.load`), and an address taken at the first
instruction is the address that works at the last.

### The process model

Everything a process owns lives inside one `create()` call — a second process in the same realm
gets its own heap, hive, queue and COM registry.

- **Heap** (`kernel32/heap.js`). One free-list allocator over the arena serves `HeapAlloc`,
  `GlobalAlloc`, `LocalAlloc`, `VirtualAlloc`, `malloc`, `CoTaskMemAlloc`, DIB bits, vtables, and
  the graphics and audio layers' locked buffers, because a program frees with one what it allocated
  with another and Windows lets it. Bookkeeping stays on the host side, so an overrun corrupts a
  neighbour, as on Windows, and never the allocator. Blocks are 8-byte aligned; `VirtualAlloc`
  reservations begin on 64 KiB boundaries. `GlobalMemoryStatus` reports what is left of the arena.
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

## 4. Limitations and divergences

Stated as the code states them.

- **Display modes are listed but not switched.** `ChangeDisplaySettingsA`/`ExA` succeed only for
  the mode already in effect (and its depth, when named) and answer `DISP_CHANGE_BADMODE` for any
  other, while `EnumDisplaySettingsA` lists several. `EnumDisplayDevicesA` reports no devices.
- **One process, no children.** `CreateProcess`/`WinExec` record the request and succeed; the child
  replaces the parent once the parent has nothing left to do. `ShellExecute` answers
  `SE_ERR_NOASSOC`/`SE_ERR_ACCESSDENIED`; `SHBrowseForFolder` and the common dialogs are cancelled;
  `SHGetMalloc` writes null.
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
- **Unimplemented imports** are bound to a zero-returning stub and reported once per name; zero
  reads as failure under most conventions but as `S_OK` to a caller expecting an `HRESULT`.

Reported at runtime: `divergence` (each once), `unimplemented` (each import once, plus a count per
name in the application's diagnostics as `unimplementedCalls`), `message-box`, `output`, `debug`,
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
| module | `module.test.js` — a configured screen reaches user32 and gdi32; a DC through user32 is GDI's; both fall back to 640×480 together. |

`kernel32/critical.itest.js` runs the hand-assembled critical-section fast paths on the real
emulator (`npm run test:integration`), pinning that the bytes the unit test checks are x86 that
does the job. End-to-end tests that drive a program through the whole surface live beside the
application entry point (`src/*.itest.js`) and in `tools/cdp_test/` (a real browser and GPU).
