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
| `modules` | `{ find, byBase, imagePath, load?, dataFile?, attachedLibraries?, resolved?, findResource?, moduleBase?, loadString?, versionInfo?, systemLibrary? }` | inert | How a loaded module is found by name or base, how a library is read off the volume (`load(name, flags)`, with `LoadLibraryEx`'s flags), a library mapped as data by its handle, the libraries still attached in the order `ExitProcess` tells them, and whether a name is one of the libraries the engine answers for. |
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
| `ordinals()` | Export ordinals for the libraries imported by number: `WSOCK32.dll`, `WS2_32.dll`, `OLEAUT32.dll`, `COMCTL32.dll`'s one numbered entry point, `WINMM.dll`'s #2 (`PlaySoundA`) and `SFC.dll`'s two catalog calls (#8, #9), which have no names at all. |
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
| `rawInput(report)` | One event of the mouse or the keyboard as the device reported it, from the input layer: posted as `WM_INPUT` to a program that registered for that device, and nothing otherwise. |
| `placeWindow(hwnd, x, y, width, height, how?)` | Place a top-level window as the system would and tell the program with `WM_MOVE` when it moved and `WM_SIZE` when its client size changed -- nothing for a placement that changed neither, as `DefWindowProc` says nothing for one, since a program that resets its device on `WM_SIZE` would otherwise be reset by its own reset's placement without end. `how.announce` says the size whether or not it changed: what a mode switch says to the window it lands in, which the graphics layer asks for once, at a fullscreen device's first frame, when both the window and the device exist to hear it -- a program of this era configures its viewport and its full-speed/background state on that message. |
| `clientRect(hwnd)` | One window's client rectangle on the screen -- `GetClientRect`'s size at `ClientToScreen`'s origin, a child's inside its parent's frame -- or `null` for a handle that names no window: the size a device's back buffer takes when a program asks for zero, and where a film is placed inside the window a program named its video window's owner. |
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
| `KERNEL32.dll` | `kernel32/` | 368 | Console, threads and waits, heap and virtual memory, process and TLS, modules (`GetModuleHandleA`/`W`), files and directories, critical sections, SRW locks, condition variables and one-time initialisation (`slimsync.js`), locale and code pages, environment and command line, system info and time (`GetNativeSystemInfo` is `GetSystemInfo`'s answer and `IsWow64Process` answers FALSE: a 32-bit system has no WOW64), `CreateProcess`, exceptions and SEH, resources, drives, file mappings and pipes, completion ports, file times, console I/O, APCs and the alertable waits (`apc.js`), overlapped I/O with a completion routine (`ReadFileEx`/`WriteFileEx`). |
| `USER32.dll` | `user32/` | 287 | Windows and classes, painting, system queries and display settings, objects (cursors -- decoded to the picture the page shows, `cursors.js` -- icons, menus, clipboard), dialogs, hot keys, `SendInput`, raw input (`rawinput.js`), `TrackMouseEvent`, the keyboard-layout family (`GetKeyboardLayout`, `MapVirtualKey` A/W/`Ex`, `ToUnicode`/`Ex`, `ToAscii`/`Ex`, `VkKeyScan` A/W/`Ex`) over the one en-US layout this build has, read from one table in `keys.js` (`characterOf`/`keyForCharacter`) that `TranslateMessage`'s fallback reads too, under the modifiers held at the time. |
| `msvcrt.dll` | `msvcrt/` | 345 (294 without `fpu`) | The C runtime: strings, multibyte strings, conversion, formatting and scanning, heap, math (`_ftol` answering its `__int64` in EDX:EAX), paths and directory searches (`_findfirst`/`_findnext`/`_findclose`, the `i64` forms and the wide `_wfindfirst`/`_wfindnext` and `_wfindfirsti64`/`_wfindnexti64`), the low-level file calls over a descriptor table with text mode (`io.js`: `_open`, `_read`, `_write`, `_lseek`, `_stat`/`_stati64`/`_fstati64`, `_setmode` for `_O_TEXT`/`_O_BINARY` and the Unicode translations `_O_WTEXT`/`_O_U16TEXT`/`_O_U8TEXT` (`widetext.js`), `_tell`, `_eof`, `_filelength` and the rest, and `_lseeki64`/`_telli64`/`_filelengthi64` answering in EDX:EAX; `_get_osfhandle`/`_open_osfhandle` share one record, and so one position, with a kernel32 file handle; `_O_TEMPORARY` and fopen's `D` delete the file when that descriptor closes, or when the process ends however it ends), streams standing on those descriptors (`stdio.js`: `fopen` and its family, `_wfopen`, `ccs=` opening in a Unicode translation, `freopen` (of a standard stream too) and `_fdopen`, `fgetpos`/`fsetpos`, `_fcloseall`/`_flushall`, `getchar`/`putchar`, `printf`/`vprintf`/`puts` through `stdout` and `vfprintf`, the wide calls `fgetwc`/`fputwc`, `fgetws`/`fputws`, `ungetwc`, `_putws` and `fwprintf`/`wprintf`/`vfwprintf`/`vwprintf`, `_filbuf`/`_flsbuf` and the macros' `_flag`, and the standard three as `_iob`'s first records, writing to the console), the runtime's variables with `errno` per thread (`globals.js`), threads (`threads.js`: `_beginthread`/`_beginthreadex` through kernel32's `CreateThread`), time, C++ support (`cxx.js`), CRT startup and the exits (`atexit`, `_onexit`, `_cexit`, `exit`), structured and C++ exceptions (`seh.js`, `eh.js`). |
| `GDI32.dll` | `gdi32/` | 138 | Device contexts, objects and their lifetimes, metrics, drawing entry points. A device-dependent bitmap has rows of its own outside guest memory (`CreateBitmap` copies `lpBits`; `GetBitmapBits`/`SetBitmapBits` move them), and `GetObject`/`GetObjectW` report every object as the program reads it back -- a `BITMAP` with its stride, a whole `DIBSECTION`, a font's `LOGFONT`, a palette's entry count. Text and fonts in both spellings (`CreateFont`/`Indirect`, `GetTextMetrics` with TEXTMETRICW's WCHAR fields, `GetTextExtentPoint`/`32`, `GetCharWidth`/`32`, `GetCharABCWidths`, `TextOut`, `ExtTextOut`); ABC widths are each character's own advance as the black box, with no bearings. Mapping modes set the extents they fix (MM_TEXT one to one, the fixed modes the device's 96-dot inch against their units with y up, MM_ISOTROPIC starting from MM_LOMETRIC's, MM_ANISOTROPIC keeping its own), and `LPtoDP`/`DPtoLP`/`OffsetWindowOrgEx` answer through them; drawing itself is still in device units whatever the mode. Every spelling of adding and removing a font resource answers the documented failure, the font table being fixed; `GetTextCharset(Info)` and `GetFontLanguageInfo` answer for the selected font. `EnumFontFamiliesExA`/`W` call the program's callback on its own thread with each face the table offers (`gdi32/faces.js`), a substitute such as MS Shell Dlg found by name but never listed, for `ANSI_CHARSET` and `DEFAULT_CHARSET`; every face is reported as a vector font (`FontType` 0, `TMPF_VECTOR` in `tmPitchAndFamily`) rather than TrueType, since none has tables `GetFontData` could read, so a program that lists only TrueType faces finds none. `CreateBitmap` (and `CreateBitmapIndirect`, from a `BITMAP`) rounds a depth up to 1, 4, 8, 16, 24 or 32 and refuses a side past 0x7ffffff with `ERROR_INVALID_PARAMETER`; a zero width or height is the one stock 1x1 monochrome bitmap every memory DC starts with; `CreateCompatibleBitmap` and `CreateDiscardableBitmap` make a device-dependent bitmap at the DC's depth, or, with a DIB section selected, a DIB section in its format; `CreateDIBitmap` makes a device-dependent bitmap at the DC's depth. `CreateDIBSection` takes `BI_BITFIELDS` only at 16 and 32 bits with no mask empty and not with `DIB_PAL_COLORS`, refuses `DIB_PAL_COLORS + 1`, a plane count Windows refuses, and an image past 32 bits of bytes. A `BITMAPCOREHEADER` is taken wherever a DIB is, and `GetDIBits` fills one in with an RGBTRIPLE table. Scan lines go where Windows puts them, counted from the DIB's bottom whichever way it is stored: `SetDIBitsToDevice` draws only the lines handed in, `SetDIBits` (and `CreateDIBitmap`'s `CBM_INIT`) lays the DIB against the bitmap's top-left, and `GetDIBits` writes zeros for lines outside the bitmap. A `DIB_PAL_COLORS` table is read through the DC's palette, wrapping at its end; the stock `DEFAULT_PALETTE` holds its twenty colours, which `GetPaletteEntries` reads and `SetPaletteEntries` may not change. A pattern brush keeps its own copy of the bitmap's bits; `CreateDIBPatternBrushPt`, `CreateDIBPatternBrush` and `LOGBRUSH`'s `BS_DIBPATTERN` forms copy a packed DIB's, a palette-relative one resolved through the DC's palette each time it paints, and `BS_PATTERN8X8` is `BS_PATTERN`. |
| `ntdll.dll` | `ntdll/` | 96 | Counted strings, status translation, machine queries, 64-bit helpers — and 76 entries that are the same function object kernel32 or msvcrt already publish. |
| `ADVAPI32.dll` | `advapi32/` | 71 | The registry API over the hive, `GetUserNameA`, SIDs, and a CryptoAPI provider (MD5, SHA-1, SHA-256, RC4, RSA signature verification). |
| `WINMM.dll` | `winmm/` | 100 | `timeGetTime` and `timeGetDevCaps`, multimedia timers (`timers.js`: `timeSetEvent`'s routine runs on a timer thread of its own that the kernel's clock wakes at each due time; the event forms signal instead), wave-out with a real play cursor, a callback thread and one volume level applied as every track's gain, `PlaySound` of PCM whether its format chunk says so plainly or as `WAVE_FORMAT_EXTENSIBLE` with the PCM sub-format, multimedia file I/O (`mmio.js`: RIFF chunks over a file on the volume -- by name, or by the handle of one the program already has open, which `mmioClose` closes unless `MMIO_FHOPEN` keeps it -- a memory file, or a file the program's own I/O procedure holds, installed under a code, named by a compound name's extension or handed in the `MMIOINFO`, which is sent each open, read, write, seek and close as a call into its code; buffered through guest memory -- the caller's buffer or one mmio allocates on the program's heap -- with `mmioGetInfo`/`mmioSetInfo`/`mmioAdvance`, `mmioSetBuffer` and `mmioFlush`); MCI answered in either width as a machine with no MCI device, error text for the shared, wave and MIDI codes, and honest refusal for midi, mixer, aux, joystick and recording. |
| `ole32.dll` | `ole32/` | 49 | Apartments, `CoCreateInstance`, task memory, GUID conversions, over the COM object model in `objects.js`. `RegisterDragDrop`/`RevokeDragDrop` keep one drop target per window, which is also the window's `OleDropTargetInterface` property meanwhile, with the refusals ole32's tests expect, and nothing is ever dropped on it; the OLE clipboard never holds an object. Class objects: `CoRegisterClassObject`/`CoRevokeClassObject` keep a program's own (with a reference, revoked by its apartment's last `CoUninitialize`), and activation asks them first -- their `CreateInstance` gets the outer unknown, so aggregation is theirs to allow -- then the classes built in here (which refuse aggregation), then a class's `InprocServer32`, loaded and asked through `DllGetClassObject`. `CoGetClassObject` answers the same three ways, a built-in class through an `IClassFactory` of our own. |
| `OLEAUT32.dll` | `oleaut32/` | 39 | BSTR and VARIANT; imported by ordinal. |
| `WSOCK32.dll`, `WS2_32.dll` | `wsock32/` | 38 each | One socket registry under both names, over an injected adapter (loopback by default); readiness delivered as a window message (`WSAAsyncSelect`) or a signalled kernel event (`WSAEventSelect`/`WSAEnumNetworkEvents`), and name resolution the same way (`WSAAsyncGetHostByName`/`WSACancelAsyncRequest`). |
| `SHELL32.dll` | `shell32/` | 24 | Launching a program (`ShellExecute`, `ShellExecuteEx`, `FindExecutable`), file operations on the volume (`fileop.js`: `SHFileOperationA/W` copying, moving, renaming and deleting by the rules shell32's tests check, `SHCreateDirectoryExA/W`), documented refusals where a registry or a person is needed (a document's handler, folder browse), the drag-and-drop truths, the namespace (`namespace.js`: `IShellFolder`/`IEnumIDList` over the volume), and `CLSID_ShellLink` (`IShellLinkA/W`, `IPersistFile`). |
| `COMCTL32.dll` | `comctl32/` | 22 | Image lists (indices only), `_TrackMouseEvent` (user32's `TrackMouseEvent`), `msctls_progress32`, `SysTreeView32` and `SysTabControl32` (`tab.js`) as built-in window classes, and property sheets and wizards (`propsheet.js`: `PropertySheetA/W`, `CreatePropertySheetPageA/W`, `DestroyPropertySheetPage`) -- a `#32770` dialog built through user32's own calls around a tab control, each page the program's own template and dialog procedure, told the `PSN_*` notifications through `WM_NOTIFY`; Tab walks into a page's controls (`WS_EX_CONTROLPARENT`), `PSM_ISDIALOGMESSAGE` changes page on Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+PgDn/PgUp, as a modal sheet does in its own loop (user32's, lent through the window service), `PSH_WIZARD97` and `PSH_WIZARD_LITE` make a wizard whose interior pages stand under a header band with the header title and subtitle, a page that cannot be made is dropped, and a modal sheet answers 1 when changes were saved, 0 when none were, and `ID_PSRESTARTWINDOWS`/`ID_PSREBOOTSYSTEM` only when OK or Finish closed it. |
| `d3dx9_25.dll`, `d3dx9_26.dll`, `d3dx9_27.dll` | `d3dx9/` | 13 each | Stub tables for the D3DX helper libraries, shadowed by the real DLL whenever the DirectX system volume is mounted and a program does not ship its own ([`decisions.md`](../../roadmap/decisions.md)). |
| `WININET.dll` | `wininet/` | 12 | HTTP as a handle tree; a request parks the caller. |
| `IMM32.dll` | `imm32/` | 10 | "There is no input method" — which is the state a game asks for. |
| `RPCRT4.dll` | `rpcrt4/` | 6 | `UuidCreate` and the other GUID/status helpers a COM-adjacent program links directly. |
| `VERSION.dll` | `version/` | 8 | The version block read out of a file's own image, A and W: `VerQueryValueA` answers a text value in ANSI, in the room `GetFileVersionInfoSize` reserves behind the block (marked `FE2X`), or in place when the caller copied the block into less; `VerQueryValueW` answers the block's own UTF-16. A library the engine answers for itself, by bare name or in the system directory, has a block built here -- the system's version as `GetVersionEx` reports it, or for a DirectX component the DirectX version the registry holds -- unless a file of that name on the volume answers first. |
| `LZ32.dll` | `lz32/` | 4 | The LZ compression stubs an older installer links and never has cause to call successfully. |
| `MSWSOCK.dll` | `wsock32/` | 4 | The Winsock extensions. |
| `COMDLG32.dll` | `comdlg32/` | 4 | File dialogs, answered as cancelled. |
| `SHLWAPI.dll` | `shlwapi/` | 10 | Path and string helpers an installer imports for convenience, `PathCombine` and `PathMatchSpec` in both spellings among them, and the HLS colour pair. |
| `ADVPACK.dll` | `advpack/` | 1 | The Advanced INF helper an installer loads at run time: `IsNTAdmin`, true when the token holds `BUILTIN\Administrators` -- asked through `isTokenMember`, the same membership `CheckTokenMembership` answers from. |
| `SFC.dll` | `sfc/` | 5 | System File Protection's client, loaded at run time by an installer that replaces system files: `SRSetRestorePoint`/`A`/`W` answer FALSE with `ERROR_SERVICE_DISABLED` in `STATEMGRSTATUS.nStatus` (this machine keeps no restore points), and the undocumented catalog calls exported by ordinal alone -- #8 `SfpInstallCatalog(catalog, dependency)` copies a catalog into `system32\CatRoot\{F750E6C3-38EE-11D1-85E5-00C04FC295EE}`, #9 `SfpDeleteCatalog(name)` removes it -- answering an error code, zero for success, the shape their callers push and read. |
| `WINSPOOL.DRV` | `winspool/` | 3 | Print spooler entry points, answered as "no printers". |
| `MPR.dll` | `mpr/` | 2 | Network provider entry points, answered as "not connected to a network". |
| `MSACM32.dll` | `msacm32/` | 42 | The Audio Compression Manager with no codec drivers installed: the whole exported surface declared for its stack widths, every driver or stream request answered "not supported"/"not possible", so middleware that links against it loads and decodes on its own. |
| `SHFOLDER.dll` | *(built in `module.js`)* | 2 | A two-export forwarder to shell32's `SHGetFolderPathA`/`SHGetFolderPathW`, sharing shell32's own function objects. |
| *(no DLL)* | `quartz/` | — | The DirectShow filter graph, reached through `CoCreateInstance(CLSID_FilterGraph)`; registered on the COM registry, not as an import table. |

Total: 1767 table entries across 30 libraries, 1634 distinct functions.

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
`win32.ordinals()`, `audio.ordinals()` (`DSOUND.dll`) and `media.ordinals()` declare for the libraries imported by number
([`loader.md`](./loader.md)). An export's address is its trampoline inside that module, and it is
what both the import table and `GetProcAddress` hand out, so a program comparing the two finds them
equal. A table that exports `DllMain` is a module with an entry point, run on the first
`LoadLibrary`. An import no table provides is bound to a stub (`app.js`, `missingImport`) that
counts the call and emits an `unimplemented` event; whether it may return is decided by what the
caller expects of the stack (`missingImportCall`), since the argument bytes are the one thing that
must be right:

| import | stub |
|--------|------|
| `_name@N` (decorated stdcall) | Returns zero and pops N bytes. |
| A Visual C++ decorated name (`?…`) whose type sizes its parameters, from any library | Returns zero and pops what the name's convention and parameters say ([`loader.md`](./loader.md), "Decorated C++ names"): a C runtime class's `thiscall` member its parameters, a `cdecl` function nothing. |
| Any other name from a library `win32.libraryConvention()` declares cdecl — `msvcrt`, `msvcr*`, `msvcp*`, `crtdll`, `ucrtbase` | Returns zero and pops nothing; the caller cleans up. |
| An undecorated name (or an ordinal) from any other library — every Win32 system export is one — or a C++ name that does not carry its argument bytes (a class passed or returned by value, a constructor that may take a virtual-base flag) | **Stops the process** on the first call with a guest fault: `unimplemented import KERNEL32.dll!Name, called from 0x… image+0x… (rva 0x…); argument bytes unknown, the stack holds w0 w1 w2 w3`. No stub can return from it with the stack right, and a program that goes on fails somewhere unrelated several calls later. The full list of what is unbound is already reported at load as `import-unresolved`. |
| A name a library the program brought does not export | Returns zero as the name says -- N bytes for `_name@N`, a C++ name's own size, otherwise nothing (a mismatch between two of its own files, not a gap in this build); both events carry `origin: 'program'` rather than `'system'`. |

Zero is not a failure under every convention. It reads as one for the commonest shapes -- a null
pointer, a null handle, `FALSE`, a count of none -- so such a caller takes its own failure path and
says what it wanted; but an `HRESULT` or an error code of zero is success, and a C runtime call that
fails with -1 or `EOF` (`fgetc`, `_read`), or answers `feof`'s "not yet" with zero, reads it as a
result, which can leave a read loop going round for ever. No one value fails under every
convention; zero fails under most.

The fault is raised through `cpu.raiseFault` and the stub's return is sent into the park loop,
so the caller never runs another instruction; the run ends as `guest-fault`, the same way a
processor exception does.

`kernel32/modules.js` therefore creates nothing: `LoadLibrary` marks a synthesised library loaded
(or reads a library the program ships through `modules.load`), and an address taken at the first
instruction is the address that works at the last -- `FreeLibrary` of one of ours stops it being
loaded and unmaps nothing.

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
  each of these through a real program. **`VirtualQuery`** answers a `VirtualAlloc` reservation as
  its own allocation -- its base as `AllocationBase`, the run of pages sharing the asked page's
  state as the region, `MEM_COMMIT` or `MEM_RESERVE` page by page as the program committed them --
  the heap's own blocks as committed memory, and free arena as `MEM_FREE`; an address nothing maps
  outside the arena is `MEM_RESERVE`, since `VirtualAlloc` cannot reserve there and free means
  available to be allocated. Each answer covers the whole run of pages that share a state, so a
  guest walking its address space by `RegionSize` does not step a page at a time.
  `HeapSetInformation` turns the low-fragmentation heap on once and refuses to turn it off, as
  `HeapQueryInformation` then reports.
- **Modules** (`kernel32/modules.js` over the assembler's module table, `src/app.js`). Every system
  library is synthesised before the first instruction and binds whenever it is asked for, but it is
  *loaded* -- found by `GetModuleHandle`, listed in `PEB->Ldr` -- only once an image is bound to it
  or `LoadLibrary` asks for it, along with the system libraries it imports itself on Windows
  (`USER32` brings `GDI32` and `ADVAPI32`); `ntdll` and `kernel32` are in every process. A library
  loaded at run time counts its `LoadLibrary` calls, and `FreeLibrary` gives one back; the last
  `FreeLibrary` calls its `DllMain` with `DLL_PROCESS_DETACH` on the thread that asked, then unmaps
  it and takes it out of `PEB->Ldr` (one of ours stops being loaded instead). A library something
  imports is pinned, as Windows pins it. `LoadLibraryExA/W` act on their flags:
  `LOAD_LIBRARY_AS_DATAFILE` (and `_EXCLUSIVE`) maps the file apart as data,
  `LOAD_LIBRARY_AS_IMAGE_RESOURCE` lays it out as an image, and the handle is the view's base with a
  low bit set -- one for a file's view, two for an image's -- invisible to `GetModuleHandle`, its
  resources found through it, given back by `FreeLibrary`, while a library already loaded is
  answered with its own handle; `DONT_RESOLVE_DLL_REFERENCES` maps a library without binding its
  imports or running its entry point, as `LoadLibrary` of a program by name always does. A non-null
  `hFile` is `ERROR_INVALID_PARAMETER`. `ExitProcess` -- and the C runtime's exits, `exit` after its
  `atexit` handlers -- ends the other threads and calls every still-attached library's `DllMain`
  with `DLL_PROCESS_DETACH` (`lpvReserved` non-NULL), the last attached first, on the calling
  thread, before the exit code is recorded.
- **Windows** (`user32/windows.js` with `paint.js`, `system.js`, `objects.js`, `dialogs.js`,
  `controls.js`, `frame.js`). One window table shared by the files. `windowService` is the outward
  view: `list()` of live windows with their screen rectangles and `place()`, which is what a
  fullscreen device uses through `placeWindow` so a program re-reading its rectangle on `WM_SIZE`
  clips its cursor to the picture. A window has the frame its styles give it (`frame.js`: border,
  caption with title and close box, a menu bar below the caption for a window that is not a child
  and has a menu, scroll bars) at the classic metrics `GetSystemMetrics` answers at 96 dpi -- a
  dialog frame three pixels, a tool window's caption 16 -- which `DefWindowProc` paints on
  `WM_NCPAINT` and which `GetClientRect`, `ClientToScreen` and `AdjustWindowRect(Ex)` all derive
  from, so a window sized from `AdjustWindowRectEx` has the client area asked for. `CreateWindowEx`
  sends `WM_NCCREATE` and then `WM_CREATE`, with the same `CREATESTRUCT`, and for a window made
  visible `WM_SIZE`, `WM_MOVE` and `WM_SHOWWINDOW(1)` after them; a `WM_NCCREATE` answered `FALSE`
  refuses the window. `DestroyWindow` *sends* `WM_DESTROY`, then destroys the children, then sends
  `WM_NCDESTROY`, and only then stops the handle resolving -- the procedure runs before the call
  returns, while whatever the program keeps behind the window still exists; a window whose CBT hook
  refused it hears nothing, one whose `WM_NCCREATE` answered `FALSE` or whose `WM_CREATE` answered
  -1 hears `WM_NCDESTROY` alone. It destroys the menu of a window that is not a child (for a child,
  `hMenu` is its id). `GetDesktopWindow` answers one window of the class `#32769`, made when first
  asked for: visible, the screen in whatever mode it is in, the parent a top-level window is made
  on, never destroyed, and kept out of the table the other windows are walked in. Painting goes
  through the desktop surface the graphics layer owns (`docs/core/graphics.md`): `BeginPaint` sends
  `WM_NCPAINT` and `WM_ERASEBKGND` first, a window's update area is one rectangle, a window that is
  invalidated marks every window painted after it that overlaps it, and the desktop is presented
  when the queue finds nothing left to paint. `UpdateWindow` and `RedrawWindow(RDW_UPDATENOW)`
  *send* `WM_PAINT` (with `RDW_ALLCHILDREN`, to the descendants after the window), so the procedure
  has painted when the call returns. A region names its bounding rectangle (`InvalidateRgn`,
  `ValidateRgn`, `RedrawWindow`'s region, read through gdi32's `regionBox`; `GetUpdateRgn` fills one
  through `setRegion`). `ValidateRect` takes its rectangle out of the update area exactly when what
  is left is still a rectangle -- a band off one side -- and otherwise leaves the area whole. The
  **system classes** — `Button`, `Static`, `Edit`, `ListBox`, `ComboBox`, `ScrollBar` and the dialog
  class `#32770`, also by their atoms — have their procedures on this side (`controls.js`); each has
  a real address (a bridge stub) that `GetWindowLong(GWL_WNDPROC)` reports and `CallWindowProc`
  reaches, so a program may subclass one. A static's, a check box's, a radio button's and a group
  box's text is drawn in the text colour, background mode and background colour the parent left in
  the context on `WM_CTLCOLORSTATIC` (the default procedures set the system's there); an owner-drawn
  button or static is drawn by its parent through `WM_DRAWITEM`, with `ODA_DRAWENTIRE`, `ODA_FOCUS`
  and `ODA_SELECT` as it paints, gains or loses the focus and is pushed or let out; an owner-drawn
  list box or combo box without `LBS_HASSTRINGS`/`CBS_HASSTRINGS` keeps what `LB_ADDSTRING` is
  handed as the item's data; an edit answers `WM_COPY`, `WM_CUT`, `WM_PASTE`, `WM_CLEAR` and
  `WM_UNDO`, keeping one change to undo. Dialogs are windows of the dialog class: the template is
  walked for real, coordinates are dialog units, the dialog procedure sees every message first and
  `DefDlgProc` -- the dialog class's whole procedure, so a program's own dialog class reaches its
  `DWLP_DLGPROC` through it -- the rest, and `IsDialogMessage` handles Enter, Escape and Tab.
  Tab, `GetNextDlgTabItem`, `GetNextDlgGroupItem` and `DefDlgProc`'s `WM_NEXTDLGCTL` walk through a
  shown, enabled child with `WS_EX_CONTROLPARENT` as if its controls were the dialog's own
  (`user32/tabwalk.js`); a group runs from one `WS_GROUP` control to the next, round the end of the
  dialog to its start. A modal dialog's loop takes each message as `GetMessage` takes it -- the
  hit test asked, a press activating, `WM_SETCURSOR` sent -- on the thread `DialogBox` was called
  on, and `DialogBox` answers -1 for a dialog its procedure destroyed during `WM_INITDIALOG`; the
  window service lends the same loop to another library, each message offered first to a hook,
  which is how a modal property sheet runs its own. The
  default push button moves with the focus: a push button the focus reaches is styled
  `BS_DEFPUSHBUTTON` while it has it, `DM_SETDEFID` moves the style from the old default to the new,
  and Enter presses the focused push button only while it is the default. Pointer messages from the
  input layer are routed as they arrive to the window under the point (or the capture), in that
  window's client coordinates, with the frame's hit test turning them into non-client messages; as
  one is taken for a window whose procedure is the program's own, the windows under the point are
  sent `WM_NCHITTEST` from the top, deepest first, and the message goes to the first that does not
  answer `HTTRANSPARENT`, in the client form for `HTCLIENT` and the frame's otherwise --
  `WindowFromPoint` asks the same, and `PeekMessage`/`GetMessage` ask it before their range and window filter is applied, so a filter sees the message in the form it is delivered in. As each of the mouse's own messages is taken, `WM_SETCURSOR` is
  sent to the window it goes to, with the hit and the client form of the message (not for the wheel,
  while the mouse is captured, or for a message a program posted itself); `DefWindowProc` answers it
  by asking the parent first and then setting the class cursor over the client area and the arrow
  elsewhere. Keys go to the focus window. **Activation** is sent, not posted, from the call that
  causes it -- `SetFocus`, `SetActiveWindow`, `SetForegroundWindow`, `ShowWindow`, `CreateWindowEx`
  with `WS_VISIBLE` (after `WM_SHOWWINDOW`), a click taken from the queue -- in Windows' order:
  `WM_NCACTIVATE(0)` and `WM_ACTIVATE(WA_INACTIVE)` to the window losing it, `WM_NCACTIVATE(1)` and
  `WM_ACTIVATE` to the one gaining it, then `WM_KILLFOCUS`/`WM_SETFOCUS`. When none of the program's
  windows was active -- its first window shown -- every top-level window of the program hears
  `WM_ACTIVATEAPP(1)` first, and `WM_ACTIVATEAPP(0)` when the activation goes to the desktop,
  after which `GetActiveWindow`, `GetForegroundWindow` and `GetFocus` answer NULL until the program
  takes the activation back; a window never shown is never activated. A press activates its window
  when the program takes it from the queue (`GetMessage`, `PeekMessage` with `PM_REMOVE`):
  `WM_MOUSEACTIVATE` is sent (a child's default procedure asks its parent), and `MA_ACTIVATE`
  activates with `WA_CLICKACTIVE` and raises, the `NOACTIVATE` answers leave the activation alone,
  and the `ANDEAT` answers drop the press. `GetLastActivePopup` answers the popup of an owner chain
  that was active last; `IsChild` is true only through a chain of `WS_CHILD` windows, and
  `GetAncestor` answers `GA_PARENT` (the desktop for a window that is no child), `GA_ROOT` and
  `GA_ROOTOWNER`, none for the desktop. The input layer's foreground is the active window (`activeWindow()` on the
  API) -- not simply the last one created, which may be hidden or a child -- and only while none is
  active the last created. `GetWindow` walks top-level windows from the top of the Z order and
  children in creation order, a new child going below its siblings, so a dialog's first control is
  its `GW_CHILD`; a click, `WindowFromPoint` and `ChildWindowFromPoint` hit children in that same
  stacking, and `SetWindowPos` restacks a child by `hWndInsertAfter`.
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
  because anyone can post one. A message asked for later -- `TrackMouseEvent`'s `WM_MOUSEHOVER`
  once the pointer has rested for the hover time, `WM_MOUSELEAVE` as it leaves -- is posted when
  the queue is next looked at or waited on from its due time. `WM_INPUT` is a queue class of its
  own, `QS_RAWINPUT`: a program that registered a mouse or keyboard with
  `RegisterRawInputDevices` is posted one per event the input layer reports, to the window the
  registration names or else the focus, and only while its top-level window is active unless it
  registered as a sink; `GetRawInputData` reads the whole `RAWINPUT` or its header through the
  handle. The queue keeps the news a look clears apart from what it holds, so
  `MsgWaitForMultipleObjects(Ex)` ends for input of the kinds its wake mask names that arrived
  since the queue was last looked at (a paint or a timer come due counting as news), while it
  waits on events, semaphores or waitable timers too; with `fWaitAll` it needs the handles and the
  input together; `MWMO_INPUTAVAILABLE` lets input already seen end it; and a set holding a mutex,
  a thread or a process, or an alertable one, is held by kernel32.
- **Registry** (`advapi32/registry.js`). A hive of keys and values; names compare without case,
  string types carry their terminator. It converts to and from JSON, and `onChanged` lets the
  session saver treat a registry write like a file write. Roots: `HKEY_CURRENT_USER`,
  `HKEY_LOCAL_MACHINE` and `HKEY_USERS` are trees; `HKEY_CLASSES_ROOT` is not one of its own but
  the merged view of `HKLM\Software\Classes` with `HKCU\Software\Classes` over it, as
  advapi32's tests have it: a key opened through it reads the user's value first and the
  machine's otherwise, writes to the user's key when there is one, creates a new key on the
  machine's side, and deletes the user's key before the machine's -- so a class an installer
  registered under `HKLM\Software\Classes` is found by activation that only reads the classes
  root. A saved hive carries no classes tree of its own; one saved with it has it folded into the
  machine's classes without overriding what is there.
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
returns exits with its `EAX` as the exit code. The stack is the size `dwStackSize` asks, read as a
commit or, with `STACK_SIZE_PARAM_IS_A_RESERVATION`, as the reserve, and given back when the thread
ends itself; a stack the pool has no room for fails the call with `ERROR_NOT_ENOUGH_MEMORY`
([`kernel.md`](./kernel.md)). `CREATE_SUSPENDED` starts the thread with one suspension.
`WaitForSingleObject` / `WaitForMultipleObjects` poll when the timeout is zero -- a thread that has
ended reads as signalled there too -- and otherwise hand the thread to `kernel.wait` with a deadline
in guest time; the bridge parks the caller until it is woken. `Sleep(0)` yields; `Sleep(n)` sleeps
on the kernel's clock. Events, mutexes and semaphores are kernel objects behind kernel handles,
created by the plain calls or by their `Ex` forms, whose flags stand for the plain ones' BOOLs.
`SuspendThread` keeps a thread's wait -- it is handed nothing and gets no turn while suspended, and
the resume looks at the wait again -- and fails with `ERROR_SIGNAL_REFUSED` past 127 suspensions and
`ERROR_ACCESS_DENIED` on a thread that has ended; `ResumeThread`, `TerminateThread`, `ExitThread`
exist; a wait on a child's *process* handle hands over to the child and returns when it exits (see
below and `kernel32/spawn.js`). Critical sections are the exception to "every call crosses into the
host": `kernel32/critical.js` emits the enter/leave/try-enter fast paths as guest x86 on the
pre-Vista algorithm over the program's own `CRITICAL_SECTION` fields, and only a contended entry or
an owed wake traps; a release goes to the first waiter that can run, never to a suspended one, and
is kept owed when none can. SRW locks, condition variables and one-time initialisation
(`kernel32/slimsync.js`) are one word the program allocated, kept true -- zero while an SRW lock is
free, its low bit set while held and the sharing holders counted above it: a lock is taken at once
or queued, shared by readers but never past a writer already waiting, and handed on in arrival
order; a condition variable's sleep joins the queue and lets go of the lock in one host call, so no
wake falls between them, answers `FALSE` with `ERROR_TIMEOUT` when its time runs out, and takes the
lock back through the lock's own acquire -- for a critical section, `EnterCriticalSection`'s guest
code; `InitOnceExecuteOnce` is a few guest instructions around two host calls, so the program's own
function runs in the one thread that is to run it, and a synchronous begin while another thread runs
it waits. Completion ports (`kernel32/iocp.js`) block a worker with the scheduler's own wait and owe
a packet from every overlapped read or write on a bound handle. TLS slots are read out of the
running thread's own block through its TLS pointer rather than tracked on the host, so what
`TlsGetValue` answers cannot drift from what the guest reaches through `FS`.

Asynchronous procedure calls (`kernel32/apc.js`) are queued per thread -- by `QueueUserAPC`, or by a
waitable timer at each expiry for the completion routine `SetWaitableTimer` was given, queued to
the thread that set it -- and run only when that thread waits alertably: `SleepEx`,
`WaitForSingleObjectEx`, `WaitForMultipleObjectsEx`, `SignalObjectAndWait` with `bAlertable`,
`MsgWaitForMultipleObjectsEx` with `MWMO_ALERTABLE`. A thread that finds routines queued when it
starts such a wait runs them all, including any they queue, and answers `WAIT_IO_COMPLETION`
without waiting; one already waiting is taken off its objects' queues by `kernel.alert` and sent,
instead of back to its caller, to a stub whose return lands on the caller's address -- the stub
runs the routines on that thread and answers `WAIT_IO_COMPLETION` from the wait. `ReadFileEx` and
`WriteFileEx` transfer at the `OVERLAPPED`'s offset, write its status and count, and queue their
completion routine to the calling thread as an APC with (error, count, `OVERLAPPED`), so it runs at
the thread's next alertable wait and never before the call returns; a read at the end of the file
fails with `ERROR_HANDLE_EOF` and queues nothing.

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

C++ exceptions (`msvcrt/eh.js`) are the same chain. `_CxxThrowException` raises `0xE06D7363` with
the object and its type description; `__CxxFrameHandler`, `2` and `3` read the tables the compiler's
stub hands over and answer for the frame: being unwound, they run the destructors of every object
alive; otherwise they look for a catch among the try blocks around the frame's state, matching types
by descriptor or by decorated name and by the thrown object's qualifiers. On a match the frames
below are unwound, the catch object is built (a reference is a pointer to the thrown object, a class
with a copy constructor is constructed by it), the try block's own objects are destroyed, and the
catch block runs on the stack below the throw where the thrown object still lives; the function goes
on at the address the block returns, on the stack the frame's slot held before the block wrote its
own there, and the thrown object is destroyed unless the block threw it again. `throw;` rethrows the
innermost catch's object; with none being handled it terminates. A structured exception reaches only
a `catch (...)`, and not in code built with `/EHs`; `_set_se_translator`'s translator -- exported,
as msvcrt.dll exports it, only under its decorated C++ name -- is called first when one is
installed. `terminate` calls what `set_terminate` installed and then aborts; `abort` ends the
process with exit code 3.

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
back at unmap, and park the same way; a mapping handle and each view hold the file they map, as a
duplicated file handle does, so a program may close the file, the mapping and the view in any
order and the file closes with the last of them. The standard handles are never files: writing to
them goes to `onOutput`.

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
`CoCreateInstance` of an unregistered class, naming the CLSID (`ole32/functions.js`), the automation
library (`oleaut32/functions.js`), `InternetCanonicalizeUrl` browser mode (`wininet/functions.js`),
four DirectShow states (`quartz/graph.js`: stop cannot rewind, a film running on the host clock
without its sound, position and rate accepted and ignored), an `mmioOpen` through a program's own
I/O procedure in a build that cannot call it, or of a file whose built-in procedure the program
replaced (`winmm/mmio.js`), `RIDEV_NOLEGACY` (`user32/rawinput.js`), a replacement
`SHFileOperation` makes without asking (`shell32/fileop.js`), and what comctl32's image lists and
property sheets cannot do (`comctl32/`). The `NOT_IMPLEMENTED` stub of `system/stub.js` is not used
inside this layer; a function that is not implemented answers with the documented code that ends the
caller's loop (`ERROR_CALL_NOT_IMPLEMENTED`, `ERROR_NO_MORE_ITEMS`, `E_NOTIMPL` for a COM slot
nothing implements).

### Small contracts, one paragraph each

- **The C runtime's variables are data exports**, read through the address a program imported:
  `_acmdln`, `_pctype`, `__mb_cur_max`, `_adjust_fdiv`; the system version as `_osver`,
  `_winver`, `_winmajor` and `_winminor`, the figures `GetVersion` answers; `_HUGE` as
  infinity; `_environ` as the vector `__getmainargs` hands `main`; and `_iob`, twenty `FILE`
  records whose first three are stdin (at its end: nobody types), stdout and stderr (the console)
  -- `__iob_func` answers the same array. They live in the runtime module's writable `.data`
  section, apart from its read-only code, since the runtime writes a stream's `_flag` there
  itself. The variables a program reaches through an accessor -- `errno` through `_errno`,
  `_fmode`, `_commode` -- are one set shared by the start-up and the functions, and `errno` is the
  calling thread's own: a failing call sets it with the code its documentation gives, and a call
  that succeeds leaves it alone.
- **The C runtime's files are descriptors** (`msvcrt/io.js`). `_open` numbers them from 3 above the
  console's three, and each keeps its mode: `_O_TEXT`, `_O_BINARY` or else `_fmode`. In text mode a
  read folds CR LF to LF, stops at a ^Z until a seek, and resolves a CR that ends the read by the
  byte after it, and a write puts CR before each LF and answers the caller's count. A stream's
  `_file` is one of these descriptors, at the same position `_read` and `_lseek` see, and each
  change of its end-of-file and error state is written to the record's `_flag`, so the `feof`,
  `ferror` and `getc` macros read what the functions do. `_stat`/`_fstat` fill the 36-byte
  `struct _stat`; `_findfirst`/`_findnext` walk a directory as `FindFirstFile` does into a
  `_finddata_t`. `printf`, `vprintf` and `puts` are `fprintf` and `fputs` on `stdout`, so they
  follow it wherever `freopen` moved it. In a Unicode translation (`msvcrt/widetext.js`) -- a
  `_O_WTEXT`, `_O_U16TEXT` or `_O_U8TEXT` descriptor, or `fopen`'s `ccs=UNICODE`, `UTF-8` or
  `UTF-16LE` unless `b` overrides it -- the program's text is UTF-16: `_write`, `fwrite` and the
  wide calls keep it in the file as UTF-16 or UTF-8, LF as CR LF, a file opened empty for writing
  starting with the byte-order mark of its encoding, and `_read`, `fread` and the wide calls read
  a file the way its mark says, a file opened only to append to being looked at first. Outside
  one, the wide calls take a stream's bytes two to a character in binary mode, and one to a
  character in text mode, where the C locale has no byte for a character past U+00FF
  (`EILSEQ`). `_cexit` runs what `atexit` and `_onexit`
  registered, last first, closes every open stream, and returns; `exit` runs the handlers and then
  ends the process as `ExitProcess` does; `_exit` ends it without running a handler, and `_c_exit`
  runs none and returns. However the process ends, the runtime's descriptors close with it, as
  Windows closes every handle a process held -- which is when a temporary file goes.
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
- **The `cursor` event is user32's own report.** `ShowCursor`'s display count and the cursor
  `SetCursor` set derive one picture, reported to the page only on a change of that picture — a
  program that hides the cursor inside its frame loop does not flood the page's queue. For a cursor
  the program made or loaded it carries `width`, `height`, `hotSpot` and `bgra` -- the shape the
  Direct3D device cursor uses -- decoded the first time it is set (`user32/cursors.js`):
  `CreateCursor`'s two planes, or a resource's group directory's 32x32 image, deepest first, from
  its 1-, 4-, 8-, 24- or 32-bit DIB, the AND mask making it transparent and a 32-bit alpha channel
  used when there is one. A standard cursor carries none, so the page shows its own; a pixel the
  masks invert is drawn opaque black, since a page cannot invert what lies under a picture; and an
  image it cannot read (PNG-compressed, another depth) is reported as no picture.
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
- **One process running at a time.** `CreateProcess`/`WinExec`/`ShellExecute` record the request and
  succeed; the child runs once the parent has nothing left to do. A parent **waiting on the child**
  -- `WaitForSingleObject` on its process handle, or `WaitForMultipleObjects` for any of a set
  holding it -- is noted on the child's record, and the engine (`createApp`'s `runBeside`) builds
  the child a machine of its own beside the parent's, starting from the parent's registry and files,
  runs it (its own children the same way), copies back the files it wrote and the registry as it
  left it -- the parent's with the child's changes -- and wakes the wait with `WAIT_OBJECT_0` (or
  the child's place in the set); `GetExitCodeProcess` then answers the child's exit code.
  `childWaitedOn`/`childExited`/`refreshWindows` on the win32 API are that seam. A parent that
  exits, is idle for another reason, or waits for *all* of a set holding a child is replaced by the
  child as before. While the child runs nothing of the parent's does -- no time passes for it, so a
  wait's timeout is not armed -- and after it, layer diagnostics describe no instance (every layer
  keeps one current instance, which the child's disposal clears). All three resolve the image the
  same way (`kernel32/spawn.js`), so a program started through the shell is the one that was named.
  A child's working directory is its own image's: `lpCurrentDirectory` and `lpDirectory` are
  accepted, reported as a divergence, and not carried. `ShellExecute` runs a file whose extension is
  its own handler (`exe`, `com`, `bat`, `cmd`, `pif`, `scr`) under the `open` and `runas` verbs --
  `runas` without a prompt, there being one user -- and answers `SE_ERR_NOASSOC` for a document or
  any other verb, since the handler for one would come from a registry this build does not have; a
  file that is not on the volume is `SE_ERR_FNF`. `ShellExecuteEx` fills `hInstApp` and, for
  `SEE_MASK_NOCLOSEPROCESS`, `hProcess`; a record naming an item id list or a class is refused.
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
  without it -- `MMSYSERR_BADDEVICEID`, `JOYERR_PARMS`, and for MCI the string parser's own errors
  or `MCIERR_CANNOT_LOAD_DRIVER` for a registered device type or extension. Wave-out is real.
- **mmio's own procedures stay its own.** One a program installs under `DOS ` or `MEM ` is not
  used for those files, which the built-in procedure opens, reported; `MMIO_EXIST` through a
  program's procedure opens the file rather than only asking.
- **No drag and drop, no OLE clipboard object.** A registered drop target is never called, and
  neither `OleSetClipboard` nor `OleGetClipboard` is exported.
- **Raw input does not silence the legacy messages.** `RIDEV_NOLEGACY` is accepted and reported;
  the window still gets the mouse and key messages (an exclusive DirectInput device withholds
  them, [`input.md`](./input.md)).
- **File mappings are copies**: two views of one file do not see each other's writes.
- **`EnumSystemLocalesA`** answers `ERROR_CALL_NOT_IMPLEMENTED`; **`FormatMessageA`** handles only
  `FORMAT_MESSAGE_FROM_SYSTEM`; **`HeapWalk`** ends the walk at once.
- **DirectShow** decodes forward only: stop does not rewind, seeking and rate are ignored, and a
  graph with no decoder for a file answers `VFW_E_CANNOT_RENDER` and raises `EC_ERRORABORT` — the
  answer a machine without the codec gives. `IVideoWindow` starts hidden (`SW_HIDE`, `Visible`
  `OAFALSE`, `AutoShow` `OATRUE`), is shown by `Pause` and `Run` under `AutoShow`, and each frame
  carries its rectangle, visibility and full-screen mode; a hidden window's frames are not drawn, an
  owned one's are stretched over the rectangle `SetWindowPosition` gave inside the owner's client
  area, and the rest of that client area shows black while they arrive; one with no owner, or in
  full-screen mode, is fitted to the whole screen ([`media.md`](./media.md)).
- **The `double`-returning CRT functions exist only with an `fpu` host**; without one an import of
  `sin` is reported missing rather than bound to a function that never sets the result register.
- **The C runtime has one locale, C**: its wide calls on a text stream take a character to a byte
  and have none past U+00FF. `%S` and `%ls` in the narrow printers read a wide argument as bytes.
  The narrow character calls refuse a stream in a Unicode translation with `EINVAL` where the
  runtime asserts. A file opened to be deleted on close goes when the descriptor that asked for it
  closes, or the process ends, not once the last handle anyone holds on it is closed.
- **No input method** (`imm32` succeeds by having nothing to do), **no image drawing** in image
  lists, **no message tables or module strings** in `FormatMessage`.
- **The system classes are the classic look and the common messages**: a combo box's list does
  not drop down (the arrow keys change the selection; said once as a divergence), a scroll bar's
  thumb is not dragged, an edit undoes one change, and a static's image is drawn only when the
  bitmap has pixels this build can reach (said once otherwise). A tab control keeps its tabs'
  images as indices and draws none (`ImageList_Draw` is not built). A dialog template naming a
  class nothing registers fails to make the dialog, as Windows does, unless `DS_NOFAILCREATE`; a
  class Windows' own libraries register and this build does not implement (a list view, a rich
  edit) is still made, as a window with no procedure. A property sheet's
  windows are made through the ANSI calls, which are what user32 has, so a wide sheet's caption
  and titles are UTF-16 where a template or a tab carries them and Latin-1 where `SetWindowText`
  does. A wizard's header draws no bitmap, watermark or bold title.
- **Unimplemented imports** are reported once per name at load. A decorated stdcall name, a
  C++ name that sizes its arguments or a C-runtime name is answered with zero, which reads as
  failure under most conventions but as `S_OK` to a caller expecting an `HRESULT` and as a result
  to a C runtime call that fails with -1 or `EOF`; an undecorated name from any other library, or a
  C++ name that does not size its arguments, stops the process on its first call (§3, "From a
  table to a module").

Reported at runtime: `divergence` (each once), `unimplemented` (each import once, plus a count per
name in the application's diagnostics as `unimplementedCalls`), `message-box`, `clipboard` (the
text a program copied, once its clipboard closes), `output`, `debug`,
and the metrics in §2.

## 5. Tests

Unit tests are colocated with each file, `node:test`, over `fakeMemory`
(`src/layers/win32/msvcrt/harness.test.js`) or a stub host; there are 118 `*.test.js` files under
`src/layers/win32/`. Run with `npm test` from `modules/core`.

| area | files (all `src/layers/win32/…`) |
|------|----------------------------------|
| kernel32 | `apc`, `atoms`, `code-arena`, `consoleio`, `critical`, `drives`, `environment`, `file-holds`, `files`, `filetime`, `heap`, `iocp`, `locale`, `mapping`, `modules`, `named-objects`, `process`, `processor`, `profile`, `resources`, `seh`, `slimsync`, `spawn`, `sync`, `system`, `teb`, `threading`, `vfs` `.test.js` |
| msvcrt | `convert`, `cxx`, `eh`, `format`, `functions`, `globals`, `heap`, `io`, `math`, `mbstring`, `paths`, `scan`, `seh`, `startup`, `stdio`, `strings`, `threads`, `time`, `widetext` `.test.js` |
| user32 | `controls`, `cursors`, `dialogs`, `display`, `keys`, `messages`, `objects`, `paint`, `structs`, `system`, `windows` `.test.js` — `controls.test.js` paints a dialog through the real drawing engine and compares it byte for byte with `controls.reference.png` |
| gdi32 | `drawing`, `functions`, `objects` `.test.js` |
| the rest | `advapi32/{crypto,functions,registry,services,tokens}`, `advpack/functions`, `comctl32/{functions,progress,propsheet,tab,treeview}`, `comdlg32/functions`, `d3dx9/functions`, `imm32/functions`, `lz32/{expand,functions}`, `mpr/functions`, `msacm32/functions`, `ntdll/{functions,integer,query,status,strings}`, `ole32/{cfb,functions,guid,objects,storage}`, `oleaut32/{errorinfo,functions,invoke,objects,typelib}`, `quartz/graph`, `rpcrt4/functions`, `sfc/functions`, `shell32/{fileop,functions,namespace,shelllink}`, `shlwapi/functions`, `version/functions`, `wininet/functions`, `winmm/{functions,mmio,thread,timers,wave}`, `winspool/functions`, `wsock32/{functions,sockaddr,sockets,transport}` `.test.js` |
| module | `module.test.js` — a configured screen reaches user32 and gdi32; a DC through user32 is GDI's; both fall back to 640×480 together; the C runtime family is cdecl and every other library stdcall; the runtime's `_sleep` is kernel32's `Sleep`; the KnownDLLs; shfolder's forwarding; comctl32's `_TrackMouseEvent` is user32's. `wiring.test.js` builds the module and asks through it what each library's capabilities were handed: SHLWAPI's wide strings, ADVPACK's `IsNTAdmin` from the account's token, VERSION's system libraries, mmio's buffer from the program's heap, the synchronisation calls' and the profile structures' last errors and guest memory, `LoadLibraryEx`'s flags reaching the assembler, `ExitProcess` and the runtime's `exit` telling the attached libraries last first (and ending at once with none), `MWMO_INPUTAVAILABLE`. |

`kernel32/critical.itest.js` runs the hand-assembled critical-section fast paths on the real
emulator (`npm run test:integration`), pinning that the bytes the unit test checks are x86 that
does the job. `src/exceptions.itest.js` runs three compiled fixtures -- `seh.exe`, `cxxeh.exe`,
`unhandled.exe`, built from `test/fixtures/src/` by `scripts/build-fixtures.mjs` with clang and
lld against the MSVC ABI -- through every path above, processor faults and two threads throwing
at once included. `src/apc.itest.js` runs `apc.exe`, built the same way: APCs to itself and to
another thread's alertable sleep, one refused by a wait that is not alertable, a routine queued
by a routine, and a timer's completion routine. Others build their guest program in the test
itself, most answering one property per bit of its exit code: `src/condition.itest.js` sleeps on a
condition variable over an SRW lock and over a critical section; `src/suspend.itest.js` creates a
thread suspended, resumes it and joins it, and suspends it once it has ended; `src/fileex.itest.js`
drives `ReadFileEx`, `WriteFileEx` and `SleepEx`; `src/loadex.itest.js` loads a library as a
data file and unresolved, and a program by name; `src/unload.itest.js` counts a library's loads and
watches the last `FreeLibrary` detach and unload it; `src/exitdetach.itest.js` watches a library
the program imports be attached and then detached by `ExitProcess`; `src/arena.itest.js` ships a
library that ends just short of the stack pool and starts a thread.
End-to-end tests that drive a program through the whole surface live beside the application entry
point (`src/*.itest.js`) and in `tools/cdp_test/` (a real browser and GPU).
