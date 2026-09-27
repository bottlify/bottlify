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
| `graphics` | thunks | none | Where GDI pixels go, which pixel formats exist, and the display's gamma ramp (`setGammaRamp`, `gammaRamp`, `appliesGamma`). |
| `output` | thunk | none | Where wave-out samples go. |
| `video` | thunks | none | The decoder and the frame sink a filter graph uses. |
| `network` | adapter `{ bind, unbind, find }` or a `NetworkTransport` | loopback | The transport under Winsock; `createApp` hands its own `win32.network` option here. |
| `http` | request function | `null` | The transport under WinInet. |
| `cursor`, `keyState`, `clipCursor` | thunks | nothing pressed, origin | The input layer, handed down. |
| `windows` | `'win2000' \| 'winxp' \| 'win7' \| 'win10'` | `'winxp'` | The Windows the machine is: 2000 SP4 (5.0.2195), XP SP3 (5.1.2600), 7 SP1 (6.1.7601) or 10 (10.0.19045). One record (`kernel32/versions.js`) reaches every place a version is read -- the version calls, the hive, the default environment, shell32's folders, `VERSION.dll`'s system libraries, `RtlGetVersion` -- and any other name fails the layer's creation, the four choices in the message. |
| `compatibility` | `{ supportedOS?: string[], imageVersion?: { major, minor } }` | nothing declared | What the running program says it knows: its manifest's `supportedOS` GUIDs and its PE header's operating system version (`createApp` reads both from the image, `compatibilityOf`). Only `win10` consults it, for what the version calls tell the program (§3, "The version a program is told"). |
| `commandLine`, `environment` | string, record | the quoted image path; `SystemRoot`, `TEMP`, `TMP`, `windir` under `C:\WINDOWS`, and the profile folders of the Windows's layout (`defaultEnvironment`): `ALLUSERSPROFILE`, `APPDATA`, `USERPROFILE`, and for 7 and 10 `LOCALAPPDATA`, `ProgramData`, `PUBLIC` | What the program is told it was started with. |
| `onOutput(handle, text)`, `onTrace(text)`, `created(hwnd)`, `spawned(request)` | callbacks | no-ops | Console output, `OutputDebugString`, window creation, `CreateProcess`. |
| `onMessageBox(notice)` | callback | the box's own default | A message box the program put up. `notice` is `{ id, text, caption, type, buttons, defaultButton, icon }`; the answer is the id of the button pressed, and a promise parks the calling thread until `answerMessageBox(id, button)` supplies it. |
| `onClipboard(text)` | callback | no-op | The text a program copied. Called from `CloseClipboard` when the clipboard was written under that open and holds `CF_UNICODETEXT` (preferred), `CF_TEXT` or `CF_OEMTEXT`; a close after a read alone, or with only non-text formats, calls nothing. A null handle (delayed rendering) is not rendered. |
| `trustedRoots` | `(Uint8Array \| string)[]` | Microsoft's "Microsoft Root Authority" | The root store `WinVerifyTrust` judges Authenticode chains against, each root DER bytes or base64; an empty array trusts nothing. |
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
| `applicationDeactivated()` | Whether the application was last told `WM_ACTIVATEAPP(0)` and not `WM_ACTIVATEAPP(1)` since -- it stays active while the program activates its own windows. Read by the graphics layer: DirectDraw's exclusive mode is lost while it is `true`. |
| `applicationDeactivations()` | How many times the application has been told `WM_ACTIVATEAPP(0)`: a caller that asks only when a program next calls it -- DirectDraw, whose video memory an exclusive owner loses on each deactivation -- still learns of one that came and went in between. |
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
| `criticalSections` | `entered`/`left` in the guest without a crossing (a `TryEnterCriticalSection` that takes the section is an entry, one refused is not), `waits`, `wakes`, `handoffs`, `queued`, `owed`. |
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
| `KERNEL32.dll` | `kernel32/` | 397 | Console, threads and waits, heap and virtual memory, process and TLS, the version (`GetVersion`, `GetVersionExA`/`W`, `VerifyVersionInfoA`/`W`, `VerSetConditionMask`), modules (`GetModuleHandleA`/`W`), files and directories (`GetOverlappedResult` reading an operation's outcome out of its OVERLAPPED, and waiting on its event for one still pending), critical sections, the interlocked arithmetic (`interlocked.js`), `SwitchToThread` (yielding to a ready thread of any priority), SRW locks, condition variables and one-time initialisation (`slimsync.js`), locale and code pages, environment and command line, system info and time (`GetNativeSystemInfo` is `GetSystemInfo`'s answer and `IsWow64Process` answers FALSE: a 32-bit system has no WOW64), `CreateProcess`, exceptions and SEH, resources, drives, file mappings and pipes, completion ports, file times, console I/O, APCs and the alertable waits (`apc.js`), overlapped I/O with a completion routine (`ReadFileEx`/`WriteFileEx`), interlocked singly linked lists over the program's own `SLIST_HEADER` (`slist.js`), and `CreateRemoteThread`/`Ex` into this process (a child, which runs only after it, is refused with `ERROR_NOT_SUPPORTED`). A wide string argument is read to twice its length in characters, the memory layer's limit counting bytes. `GetTempPathW` zeroes what the path does not fill, the whole buffer when it is short; `GetTempFileName` names its file in upper-case hexadecimal before a lower-case `.tmp`. `HeapSummary` adds up a heap's live blocks. |
| `USER32.dll` | `user32/` | 324 | Windows and classes in both encodings (a class registered wide, or a procedure set through `SetWindowLongW`, reads wide text, and a message's text is converted between the sender's encoding and the procedure's -- see *Wide and ANSI windows* below; `EnumWindows` walks the top-level windows topmost first), painting, system queries and display settings, objects (cursors -- decoded to the picture the page shows, `cursors.js` -- icons, menus, clipboard), dialogs, hot keys, `SendInput`, raw input (`rawinput.js`), `TrackMouseEvent`, the keyboard-layout family (`GetKeyboardLayout`, `MapVirtualKey` A/W/`Ex`, `ToUnicode`/`Ex`, `ToAscii`/`Ex`, `VkKeyScan` A/W/`Ex`) over the one en-US layout this build has, read from one table in `keys.js` (`characterOf`/`keyForCharacter`) that `TranslateMessage`'s fallback reads too, under the modifiers held at the time. |
| `msvcrt.dll` | `msvcrt/` | 494 (436 without `fpu`) | The C runtime: strings, the secure copies and conversions (`secure.js`: `strcpy_s`, `strcat_s`, `strncpy_s`, `strncat_s` and their wide forms, `memcpy_s`, `memmove_s`, `strnlen`/`wcsnlen`, the case and set functions and the `_*toa_s` family -- a missing buffer or a size of zero is `EINVAL` with nothing written, any other refusal clears the first character, and a result that does not fit is `ERANGE` with the characters that fitted left behind the cleared one, a copy ahead of its own source reading back what it wrote, as msvcrt's loop does), multibyte strings (`wctomb` and `wcstombs` refusing a character past U+00FF with `EILSEQ`, as the C locale does), conversion, formatting and scanning (`%S`/`%ls` reading wide strings in the narrow printers, and `_vsnwprintf`), heap (`_aligned_malloc`/`_aligned_free`), math (`_ftol` answering its `__int64` in EDX:EAX, `div` and `ldiv` their two ints in EAX and EDX, and `_isnan`, `_finite` and `_fpclass`, which need no FPU), paths and directory searches (`_tempnam` and `_wtempnam` naming a file that is not there in TMP's directory, the one asked, or the current one; a path operation refusing no path with `EINVAL`; `_makepath`, `_wmakepath` and their secure forms taking the drive's first character, `_splitpath` reading by the multibyte code page so a trail byte is no separator, and `_searchenv`, `_wsearchenv` and their secure forms looking in the current directory and then in each directory the variable lists, a semicolon inside quotes part of a name; `_findfirst`/`_findnext`/`_findclose`, the `i64` forms and the wide `_wfindfirst`/`_wfindnext` and `_wfindfirsti64`/`_wfindnexti64`), the low-level file calls over a descriptor table with text mode (`io.js`: `_open`, `_read`, `_write`, `_lseek`, `_stat`/`_stati64`/`_fstati64`, `_setmode` for `_O_TEXT`/`_O_BINARY` and the Unicode translations `_O_WTEXT`/`_O_U16TEXT`/`_O_U8TEXT` (`widetext.js`), `_tell`, `_eof`, `_filelength` and the rest, and `_lseeki64`/`_telli64`/`_filelengthi64` answering in EDX:EAX; `_get_osfhandle`/`_open_osfhandle` share one record, and so one position, with a kernel32 file handle; `_O_TEMPORARY` and fopen's `D` delete the file when that descriptor closes, or when the process ends however it ends), streams standing on those descriptors (`stdio.js`: `fopen` and its family, `_wfopen`, `ccs=` opening in a Unicode translation, `freopen` (of a standard stream too) and `_fdopen`, `fgetpos`/`fsetpos`, `_fcloseall`/`_flushall`, `getchar`/`putchar`, `printf`/`vprintf`/`puts` through `stdout` and `vfprintf`, the wide calls `fgetwc`/`fputwc`, `getwchar`/`putwchar`, `fgetws`/`fputws`, `ungetwc`, `_putws` and `fwprintf`/`wprintf`/`vfwprintf`/`vwprintf`, `_filbuf`/`_flsbuf` and the macros' `_flag`, and the standard three as `_iob`'s first records, writing to the console), the runtime's variables with `errno` per thread (read and set through `_get_errno`/`_set_errno` and `_get_doserrno`/`_set_doserrno` too, and said in the runtime's words by `strerror` and `strerror_s` -- `errors.js`) and `_osver`/`_winver`/`_winmajor`/`_winminor` the version GetVersion reports (`globals.js`), threads (`threads.js`: `_beginthread`/`_beginthreadex` through kernel32's `CreateThread`), time (`time.js`: the 32- and 64-bit and secure forms, and the runtime's time zone -- `_timezone`, `_daylight`, `_dstbias`, `_tzname` and their accessors holding msvcrt's compiled Pacific time until the zone is read, `_tzset` reading TZ from the runtime's environment or else the machine's zone, UTC with no daylight time, and the first conversion reading it once; a TZ with a daylight name keeps daylight time by the United States' rules; `asctime` writes the fields as they are and refuses one out of range), C++ support (`cxx.js`), CRT startup and the exits (`atexit`, `_onexit`, `_cexit`, `exit`), the environment (`environ.js`: the runtime's own copy of the process's variables, taken as it starts -- `getenv`, `_putenv`, their wide and secure forms, `_environ` and `_wenviron` in the order the variables were set, a wide copy made from the narrow one when a wide call first asks, and `__initenv`/`__winitenv` keeping the arrays the first change leaves), structured and C++ exceptions (`seh.js`, `eh.js`), and `rand_s`, drawing on the machine's random source. |
| `GDI32.dll` | `gdi32/` | 157 | Device contexts, objects and their lifetimes, metrics, drawing entry points. A device-dependent bitmap has rows of its own outside guest memory (`CreateBitmap` copies `lpBits`; `GetBitmapBits`/`SetBitmapBits` move them), and `GetObject`/`GetObjectW` report every object as the program reads it back -- a `BITMAP` with its stride, a whole `DIBSECTION`, a font's `LOGFONT`, a palette's entry count. Text and fonts in both spellings (`CreateFont`/`Indirect`, `GetTextMetrics` with TEXTMETRICW's WCHAR fields, `GetTextExtentPoint`/`32`, `GetCharWidth`/`32`, `GetCharABCWidths`, `TextOut`, `ExtTextOut`); ABC widths are each character's own advance as the black box, with no bearings. Mapping modes set the extents they fix (MM_TEXT one to one, the fixed modes the device's 96-dot inch against their units with y up, MM_ISOTROPIC starting from MM_LOMETRIC's, MM_ANISOTROPIC keeping its own), and `LPtoDP`/`DPtoLP`/`OffsetWindowOrgEx` answer through them; `SetLayout`/`GetLayout` keep a DC's layout, an RTL one mirroring `LPtoDP` across the device and reading back `MM_ANISOTROPIC`. Drawing itself is still in device units whatever the mode or layout, but for `SetDIBitsToDevice`, which maps its destination point and, under RTL, places the picture from its right edge. Every spelling of adding and removing a font resource answers the documented failure, the font table being fixed; `GetTextCharset(Info)` and `GetFontLanguageInfo` answer for the selected font. `EnumFontFamiliesExA`/`W` call the program's callback on its own thread with each face the table offers (`gdi32/faces.js`), a substitute such as MS Shell Dlg found by name but never listed, for `ANSI_CHARSET` and `DEFAULT_CHARSET`; every face is reported as a vector font (`FontType` 0, `TMPF_VECTOR` in `tmPitchAndFamily`) rather than TrueType, since none has tables `GetFontData` could read, so a program that lists only TrueType faces finds none. `CreateBitmap` (and `CreateBitmapIndirect`, from a `BITMAP`) rounds a depth up to 1, 4, 8, 16, 24 or 32 and refuses a side past 0x7ffffff with `ERROR_INVALID_PARAMETER`; a zero width or height is the one stock 1x1 monochrome bitmap every memory DC starts with; `CreateCompatibleBitmap` and `CreateDiscardableBitmap` make a device-dependent bitmap at the DC's depth, or, with a DIB section selected, a DIB section in its format; `CreateDIBitmap` makes a device-dependent bitmap at the DC's depth. `CreateDIBSection` takes `BI_BITFIELDS` only at 16 and 32 bits with no mask empty and not with `DIB_PAL_COLORS`, refuses `DIB_PAL_COLORS + 1`, a plane count Windows refuses, and an image past 32 bits of bytes. A `BITMAPCOREHEADER` is taken wherever a DIB is, and `GetDIBits` fills one in with an RGBTRIPLE table. A run-length encoded DIB (`BI_RLE8` at eight bits, `BI_RLE4` at four, bottom-up, with its `biSizeImage`) is drawn by `StretchDIBits`, `SetDIBitsToDevice` and `SetDIBits`, whole whatever lines are asked for, only the pixels its runs reach; `GetDIBits` describes one and writes none. Any other DIB needs planes: one whose `biPlanes` is 0 is refused by all three. `StretchDIBits` answers as Windows does: a `SRCCOPY` copy at the source's own size the lines from the DIB's first to the rectangle's far edge, reading a top-down DIB's `ySrc` from its top; a stretch the DIB's height, negative for a top-down one under another operation, reading `ySrc` from the bottom; and 0, drawing nothing, for a source rectangle that begins before the DIB, a negative extent running below or left of the origin. Scan lines go where Windows puts them, counted from the DIB's bottom whichever way it is stored: `SetDIBitsToDevice` draws only the lines handed in, `SetDIBits` (and `CreateDIBitmap`'s `CBM_INIT`) lays the DIB against the bitmap's top-left, and `GetDIBits` writes zeros for lines outside the bitmap. A `DIB_PAL_COLORS` table is read through the DC's palette, wrapping at its end, and `SetDIBits` takes `DIB_PAL_INDICES` into a monochrome bitmap only; the stock `DEFAULT_PALETTE` holds its twenty colours, which `GetPaletteEntries` reads and `SetPaletteEntries` may not change, and `CreateHalftonePalette` makes 256, the default palette's first and last eight at its ends. A pattern brush keeps its own copy of the bitmap's bits; `CreateDIBPatternBrushPt`, `CreateDIBPatternBrush` and `LOGBRUSH`'s `BS_DIBPATTERN` forms copy a packed DIB's, a palette-relative one resolved through the DC's palette each time it paints, and `BS_PATTERN8X8` is `BS_PATTERN`. `SetDeviceGammaRamp` makes its 768 words the display's ramp, handed to the graphics layer, which shows every frame through it; a ramp with an entry more than 0x8000 from the identity (the index times 256) is refused and the one before it stays, as Wine's `dc.c` `test_gamma` pins. `GetDeviceGammaRamp` writes the ramp the display shows, whoever set it -- a full-screen Direct3D device's included -- and the identity when none was; without a graphics layer the ramp set is kept here and read back. `GetDeviceCaps(COLORMGMTCAPS)` claims `CM_GAMMA_RAMP` only where a ramp reaches the picture. `GetTextFaceA`/`W` name the face the selected font is drawn in -- the one asked for when the table has it (a substitute under its own name), else Times New Roman, Courier New or Arial by the font's family -- the ANSI answer counting no terminator and the wide one counting it; the stock `SYSTEM_FONT`, `SYSTEM_FIXED_FONT` and `DEFAULT_GUI_FONT` carry the face names Windows gives them. `TranslateCharsetInfo` maps a character set, code page or font signature's bit to the other two. `GetNearestColor` answers what the surface keeps of a colour, which is what a `SetPixel` of it reads back as. A context keeps its text character extra and its miter limit (a FLOAT from 10, never below 1), and `SaveDC`/`RestoreDC` keep both with the text alignment. `GetClipRgn` copies the clip the program selected (`SelectClipRgn`, `IntersectClipRect`, `ExcludeClipRect`) and answers 0 when it selected none, a paint's update area being the system's; `GetRgnBox` writes an empty region as zeros; `GetObjectType` names every kind of object and a context by whether it is a memory one. |
| `ntdll.dll` | `ntdll/` | 113 | Counted strings, status translation, machine queries (`RtlGetVersion`, `RtlVerifyVersionInfo` against the true version), the compiler's 64-bit helpers as code in the guest, `RtlWalkHeap` (HeapWalk's walk answered as a status) — and entries that are the same function object kernel32 or msvcrt already publish, `VerSetConditionMask` and the interlocked lists' `Rtl` names among them. A native call built over state only a kernel32 table holds rides on the kernel32 entry that shares it, as its `natives`, and is published here: `NtQueueApcThread` and `NtTestAlert` on `QueueUserAPC`'s, over the APC queues; `RtlInterlockedPushListSList`, whose `__fastcall` no trap can be bound as, is four guest instructions that put ECX and EDX under the return address and jump to a stdcall trap. |
| `ADVAPI32.dll` | `advapi32/` | 99 | The registry API over the hive in both spellings -- the enumerators, `RegQueryInfoKey`, `RegDeleteKey(Ex)` and `RegDeleteValue` one body each, and the Vista calls `RegGetValue` (holding a value to its `RRF_RT_` mask; a `REG_EXPAND_SZ` is answered as `REG_SZ` unexpanded, there being no environment here), `RegSetKeyValue`, `RegDeleteKeyValue`, `RegDeleteTree` and `RegCopyTree`; an enumerated value too long for its buffers writes nothing but its size, and data in the never-mapped 64 KiB is `ERROR_NOACCESS` -- `GetUserNameA`, SIDs, and a CryptoAPI provider (MD5, SHA-1, SHA-256, RC4, RSA signature verification, the algorithms themselves in `crypto/`). |
| `WINMM.dll` | `winmm/` | 134 | `timeGetTime` and `timeGetDevCaps`, multimedia timers (`timers.js`: `timeSetEvent`'s routine runs on a timer thread of its own that the kernel's clock wakes at each due time; the event forms signal instead; sixteen at most, and a one-shot timer stays its routine's until the routine returns, so the routine may kill it), wave-out with a real play cursor -- `waveOutGetPosition` counting from the open or the last reset, in bytes or samples and in bytes for any other unit asked --, the driver messages `waveOutMessage` and `waveInMessage` answer (the device's interface name, the mapper's preferred device), a callback thread and one volume level applied as every track's gain, `PlaySound` of PCM whether its format chunk says so plainly or as `WAVE_FORMAT_EXTENSIBLE` with the PCM sub-format, multimedia file I/O (`mmio.js`: RIFF chunks over a file on the volume -- by name, or by the handle of one the program already has open, which `mmioClose` closes unless `MMIO_FHOPEN` keeps it -- a memory file, or a file the program's own I/O procedure holds, installed under a code, named by a compound name's extension or handed in the `MMIOINFO`, which is sent each open, read, write, seek and close as a call into its code; buffered through guest memory -- the caller's buffer or one mmio allocates on the program's heap -- with `mmioGetInfo`/`mmioSetInfo`/`mmioAdvance`, `mmioSetBuffer` and `mmioFlush`; `mmioRename` on the volume or through the procedure, and `mmioSendMessage` for a program's own messages to its procedure); MCI answered in either width, command and string, as a machine with no MCI device, error text for the shared, wave and MIDI codes and MCI's own, and honest refusal for midi, mixer, aux, joystick and recording. |
| `ole32.dll` | `ole32/` | 55 | Apartments -- `CoGetApartmentType` naming the main STA, another STA or the MTA, a thread that entered none being in the MTA implicitly while any thread is, and `TEB.ReservedForOle` pointing at a record whose flags say which apartment the thread entered --, `CoCreateInstance`, task memory, GUID conversions, over the COM object model in `objects.js`. `PropVariantCopy`/`PropVariantClear` (`propvariant.js`) over the types, forms and refusals ole32's propvariant tests hold a PROPVARIANT to: a deep copy in task memory, a BSTR and a SAFEARRAY through oleaut32's own calls, an interface with a reference of its own. `RegisterDragDrop`/`RevokeDragDrop` keep one drop target per window, which is also the window's `OleDropTargetInterface` property meanwhile, with the refusals ole32's tests expect, and nothing is ever dropped on it; the OLE clipboard never holds an object. Class objects: `CoRegisterClassObject`/`CoRevokeClassObject` keep a program's own (with a reference, revoked by its apartment's last `CoUninitialize`), and activation asks them first -- their `CreateInstance` gets the outer unknown, so aggregation is theirs to allow -- then the classes built in here (which refuse aggregation), then a class's `InprocServer32`, loaded and asked through `DllGetClassObject`. `CoGetClassObject` answers the same three ways, a built-in class through an `IClassFactory` of our own. A stream over an HGLOBAL seeks and sizes in a DWORD, as Windows' does, with `STG_E_SEEKERROR` for a seek before the start, and its block is freed with the last of the stream and its clones. |
| `OLEAUT32.dll` | `oleaut32/` | 39 | BSTR and VARIANT; imported by ordinal. |
| `WSOCK32.dll`, `WS2_32.dll` | `wsock32/` | 38 each | One socket registry under both names, over an injected adapter (loopback by default); readiness delivered as a window message (`WSAAsyncSelect`) or a signalled kernel event (`WSAEventSelect`/`WSAEnumNetworkEvents`), and name resolution the same way (`WSAAsyncGetHostByName`/`WSACancelAsyncRequest`). |
| `SHELL32.dll` | `shell32/` | 24 | Launching a program (`ShellExecute`, `ShellExecuteEx`, `FindExecutable`), file operations on the volume (`fileop.js`: `SHFileOperationA/W` copying, moving, renaming and deleting by the rules shell32's tests check, `SHCreateDirectoryExA/W`), documented refusals where a registry or a person is needed (a document's handler, folder browse), the drag-and-drop truths, the namespace (`namespace.js`: `IShellFolder`/`IEnumIDList` over the volume), and `CLSID_ShellLink` (`IShellLinkA/W`, `IPersistFile`). |
| `COMCTL32.dll` | `comctl32/` | 29 | Image lists (`imagelist.js`), which copy each image, and its mask with `ILC_MASK`, into bitmaps of their own and draw them through gdi32 (`ImageList_Draw`, `DrawEx`, `DrawIndirect`: through the mask, onto the background colour for `ILD_NORMAL`, the mask for `ILD_MASK`, the image alone for `ILD_IMAGE`, by `ILD_ROP`'s operation; alpha, the blend flags and the state effects are not drawn), `_TrackMouseEvent` (user32's `TrackMouseEvent`), `msctls_progress32`, `SysTreeView32` and `SysTabControl32` (`tab.js`) as built-in window classes, and property sheets and wizards (`propsheet.js`: `PropertySheetA/W`, `CreatePropertySheetPageA/W`, `DestroyPropertySheetPage`) -- a `#32770` dialog built through user32's own calls around a tab control, each page the program's own template and dialog procedure, told the `PSN_*` notifications through `WM_NOTIFY`, and every message the sheet sends -- to a page, to its own window, to a control -- answered before it sends the next, since any of them may run the program's code; Tab walks into a page's controls (`WS_EX_CONTROLPARENT`), `PSM_ISDIALOGMESSAGE` changes page on Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+PgDn/PgUp, as a modal sheet does in its own loop (user32's, lent through the window service), `PSH_WIZARD97` and `PSH_WIZARD_LITE` make a wizard whose interior pages stand under a header band with the header title and subtitle, a page that cannot be made is dropped, and a modal sheet answers 1 when changes were saved, 0 when none were, and `ID_PSRESTARTWINDOWS`/`ID_PSREBOOTSYSTEM` only when OK or Finish closed it. |
| `d3dx9_24.dll` ... `d3dx9_43.dll` | `d3dx9/` | 89 each | One table for every version of the D3DX helper library, shadowed by the real DLL wherever the program ships one or its installer put one in `system32` ([`decisions.md`](../../roadmap/decisions.md)): the whole of its mathematics as the library exports it -- the 87 matrix, vector, quaternion, plane, colour, Fresnel and half-float functions of `d3dx9_36.spec`, each with its own stack width (below, "d3dx9's mathematics") -- is code in the guest's own library (`d3dx9/inguest.js`, `inguest-matrix.js`, `inguest-vector.js`, `inguest-quaternion.js`, compiled as msvcrt's is), floats read, computed on the x87 under the program's control word and stored rounded to nearest; the effect facilities answer `E_NOTIMPL`. The inline helpers of the SDK's headers (`D3DXMatrixIdentity`, `D3DXVec3Dot`, `D3DXVec3Cross`, `D3DXQuaternionConjugate` and their kin) are not exports and compile into the program. |
| `WININET.dll` | `wininet/` | 12 | HTTP as a handle tree; a request parks the caller. |
| `IMM32.dll` | `imm32/` | 10 | "There is no input method" — which is the state a game asks for. |
| `RPCRT4.dll` | `rpcrt4/` | 8 | `UuidCreate` and the other GUID/status helpers a COM-adjacent program links directly; `UuidToStringA` spells a UUID without braces, in lower case, into a string the library allocates on the process heap, which `RpcStringFreeA` frees before clearing the caller's pointer. |
| `VERSION.dll` | `version/` | 8 | The version block read out of a file's own image, A and W: `VerQueryValueA` answers a text value in ANSI, in the room `GetFileVersionInfoSize` reserves behind the block (marked `FE2X`), or in place when the caller copied the block into less; `VerQueryValueW` answers the block's own UTF-16. A library the engine answers for itself, by bare name or in the system directory, has a block built here -- the machine's own version, `major.minor.build.0` of the configured Windows (the real one, even where `GetVersionEx` tells a program an older one), or for a DirectX component the DirectX version the registry holds -- unless a file of that name on the volume answers first. |
| `LZ32.dll` | `lz32/` | 4 | The LZ compression stubs an older installer links and never has cause to call successfully. |
| `MSWSOCK.dll` | `wsock32/` | 4 | The Winsock extensions. |
| `COMDLG32.dll` | `comdlg32/` | 4 | File dialogs, answered as cancelled. |
| `SHLWAPI.dll` | `shlwapi/` | 10 | Path and string helpers an installer imports for convenience, `PathCombine` and `PathMatchSpec` in both spellings among them, and the HLS colour pair. |
| `ADVPACK.dll` | `advpack/` | 1 | The Advanced INF helper an installer loads at run time: `IsNTAdmin`, true when the token holds `BUILTIN\Administrators` -- asked through `isTokenMember`, the same membership `CheckTokenMembership` answers from. |
| `SFC.dll` | `sfc/` | 5 | System File Protection's client, loaded at run time by an installer that replaces system files: `SRSetRestorePoint`/`A`/`W` answer FALSE with `ERROR_SERVICE_DISABLED` in `STATEMGRSTATUS.nStatus` (this machine keeps no restore points), and the undocumented catalog calls exported by ordinal alone -- #8 `SfpInstallCatalog(catalog, dependency)` copies a catalog into `system32\CatRoot\{F750E6C3-38EE-11D1-85E5-00C04FC295EE}`, #9 `SfpDeleteCatalog(name)` removes it -- answering an error code, zero for success, the shape their callers push and read. |
| `SETUPAPI.dll` | `setupapi/` | 20 | The Setup API an installer loads at run time. INF files (`inf.js`: the syntax setupapi's parser is observed to accept -- sections merged by name, quotes and `""`, continuation backslashes, `%strings%` and DIRIDs, the load errors with their line; ANSI, or UTF-16 after a byte-order mark) are opened by path, or by bare name from the INF directory and then the system directory, and read line by line (`SetupFindFirstLineA`, `SetupFindNextLine`, `SetupGetLineTextA`, `SetupGetInfInformationA`). `SetupIterateCabinetA` sends `SPFILENOTIFY_CABINETINFO`, `FILEINCABINET` and `FILEEXTRACTED` to the program's callback on the caller's thread, with the structures in its memory, and extracts where the callback says. `SetupInstallFromInfSectionA` with `SPINST_FILES` queues `CopyFiles`, `DelFiles` and `RenFiles` through `DestinationDirs`, `SourceDisksNames` and `SourceDisksFiles` and commits the queue (`queue.js`) with `SetupCommitFileQueue`'s notification sequence, a source that is not beside the INF taken out of the cabinet its disk's tag file names; `SetupDefaultQueueCallbackA` answers each notification as the default handler does with nobody to ask. `SetupCopyOEMInfA` places an INF as `oemN.inf`, the first number free, and its catalog in the catalog store under the same number; `SetupDiGetClassDevsA` and the four device calls beside it work over a device tree with no devices in it. |
| `WINTRUST.dll` | `wintrust/` | 2 | `WinVerifyTrust` and `WinVerifyTrustEx` under `WINTRUST_ACTION_GENERIC_VERIFY_V2` over a file, as Microsoft's Authenticode specification describes the policy (`authenticode.js`): the file's digest (`subject.js`: a PE image's by the published rule, a cabinet's by the rule every signed Microsoft cabinet measured obeys) is the one `SpcIndirectDataContent` states, the one signer signed it, a PKCS #9 countersignature holds and its authority chains to a trusted root with the time-stamping usage at the time it states, and the publisher's chain reaches a trusted root and allows code signing at that time -- or now, with no timestamp or under lifetime signing. The answer is Windows' code for the first thing that fails, and the last error too. The root store is `trustedRoots`, Microsoft's 1997 root by default (`roots.js`). |
| `WINSPOOL.DRV` | `winspool/` | 3 | Print spooler entry points, answered as "no printers". |
| `MPR.dll` | `mpr/` | 2 | Network provider entry points, answered as "not connected to a network". |
| `MSACM32.dll` | `msacm32/` | 42 | The Audio Compression Manager with no codec drivers installed: the whole exported surface declared for its stack widths, every driver or stream request answered "not supported"/"not possible", so middleware that links against it loads and decodes on its own. |
| `SHFOLDER.dll` | *(built in `module.js`)* | 2 | A two-export forwarder to shell32's `SHGetFolderPathA`/`SHGetFolderPathW`, sharing shell32's own function objects. |
| *(no DLL)* | `quartz/` | — | The DirectShow filter graph, reached through `CoCreateInstance(CLSID_FilterGraph)`; registered on the COM registry, not as an import table. |
| *(no DLL)* | `cabinet/` | — | The cabinet reader SETUPAPI extracts through (`cabinet.js`: `CFHEADER` with its reserved areas and set links, `CFFOLDER`, `CFFILE`, and every `CFDATA` block checked against its checksum when it has one, from the Cabinet SDK's format documents) and its decoders: MSZIP (`inflate.js`, one RFC 1951 stream per block, the 32 KiB history carried across the folder) and LZX (`lzx.js`, windows 2^15 to 2^21; verbatim, aligned-offset and uncompressed blocks; the `E8` call translation undone). A Quantum folder is refused as unsupported. |
| *(no DLL)* | `crypto/` | — | The cryptography every library shares: MD5, SHA-1 and SHA-256 (`digest.js`), RC4, the RSA arithmetic and PKCS#1 v1.5 verification (`rsa.js`, `signature.js`), a DER reader (`der.js`), X.509 certificates (`x509.js`) and PKCS #7 SignedData with its signers and countersigners (`pkcs7.js`). |

Total: 1828 table entries across 32 libraries, 1694 distinct functions.

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
(kernel32's critical sections, interlocked arithmetic, last error, TLS reads and writes and clocks
do this, and such an export is bound to its code, crossing into the host only where the code
jumps to a trap), `data`, a variable the program reads through the address it imported, or
`code`, a function that is code in the guest's own library (below), placed in the module's
read-only code section apart from every variable ([`loader.md`](./loader.md)); such code that
hands some calls to the host is given a builder too, and the trap it jumps to is registered under
the export's own `DLL!Name`, so a trace and the bridge's `hot` counts show each call handed over.
The assembler (`src/app.js`) merges `win32.libraries()` with the
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

### Runtime functions that run in the guest

A call into a host handler costs a crossing: out of translated code, the bridge's dispatch, the
arguments read from guest memory, the way back -- 0.8-4 us a call under cork in node
(`tools/host-call-bench.mjs`), where a function as small as `toupper` is a few instructions. The
C runtime's pure functions -- no state, no call into the host -- are therefore code in the guest's
own `msvcrt`: the export's `code` is x86, and the program's call reaches it as it reaches any
function, translated with the program's own code. A function that calls back into the program
(`qsort`'s comparator) makes an ordinary `call`, where a handler ran the guest from the host once
a comparison.

Such a function is written once, in JavaScript, in `msvcrt/inguest.js`, and marked `@guestCode`:

```js
/**
 * int strncmp(const char *left, const char *right, size_t count)
 *
 * @guestCode cdecl
 * @param {Guest} guest @param {u32} left @param {u32} right @param {u32} count
 * @returns {i32}
 */
export function strncmp({ u8 }, left, right, count){ ... }
```

The tag names the convention (`cdecl` or `stdcall`); `@param` and `@returns` give each value's
machine type -- `i32`/`u32` a stack slot or EAX, `f64` two slots or ST0, `f32` one slot or ST0 (a
value a float holds), `x87` a double the caller left on the x87 stack and the callee pops (`_ftol`,
the `_CI` functions), `i64` EDX:EAX (a double truncated as `fisttp` truncates, or an integer
extended), `void`. A function that touches guest memory takes the helpers it uses from its first
parameter: loads `u8`, `i8`, `u16`, `i16`, `u32`, `i32`, `f32`, `f64`, stores `setU8`, `setU16`,
`setU32`, `setF32` (rounded to nearest, as `fstp dword` stores), `setF64`, `call(fn, ...args)`
through a cdecl pointer, the x87's words -- `controlWord()` and `statusWord()` (`fnstcw`,
`fnstsw`, the status word without the stack's top), `setControlWord(word)` (`fldcw`) and
`clearExceptions()` (`fnclex`), which the handler reaches through the FPU seam where it offers
them -- and
`copyUp`/`copyDown`/`fill` (`rep movsd` or `rep stosd` for the whole dwords, down with the
direction flag set for `copyDown`, the bytes left as the byte forms leave them -- a turn of a
`rep` translated code moves one element at a time (a page holding code, an element across a
page) counts as an instruction of the thread's quantum, and a dword a turn is a quarter of the
turns, where one it moves a page at a time -- up or down -- counts by its bytes, whatever their
width; a copy whose ends are one to three bytes apart goes a byte at a time).

A function that leaves a rare case to the host's handler says `return host()` (`host` taken
with the other helpers): the frame is taken down -- ESP at the return address, EBX, ESI, EDI and
EBP as the caller left them -- and the code jumps to a trap into the handler, which answers the
call as it came, arguments and all. The jump is a `jmp rel32` whose displacement the compiler
leaves empty and names (`host` in the compiled module): the binding registers the trap
(`guestEntry`'s fallback, the handler the function stood for) and the loader, which places the
code, aims the jump at it ([`loader.md`](./loader.md)). A function with x87 instructions jumps
through a register instead, `mov eax, trap; jmp eax`, the trap's address written in as the export
is bound: cork forms the trap's stub into the region a direct jump comes from, and a region with
x87 instructions leaves to its host's loop for a trap, where the stub's own region calls it from
its code (`_CIpow` handing a power over, `_CIsqrt` of a negative, 942 and 661 ns a call through
the direct jump, 725 and 413 through EAX). A parameter such a function assigns is a
variable of its own, copied from the argument at entry, so the arguments the handler reads are the
call's. The function goes to the host before it writes anything, so there is nothing to undo; one
with x87 parameters pushes them back first, the last in ST0, as the call left them.
`strtol` and `strtoul` hand over a value out of range -- the handler clamps it and sets `errno`,
which is the calling thread's own and reached only through the host -- and a base outside 2..36
other than 0, and answer everything else themselves.

`npm run build` (and `npm run build:guest-code` alone) compiles every `@guestCode` function under
`src/` with `scripts/guest-code/compile.mjs` -- parsed by `espree`, the parser ESLint already
brings; nothing the running product loads -- into the module beside its source, `inguest.x86.js`,
which is committed: the source tree runs with no build step, and the compiler is a development
tool. `scripts/build-guest-code.test.js` fails when a committed module is not what its source
compiles to. EAX and ECX are an expression's, EBX the tables' base; the integer variables and
parameters that earn one are in registers. A function is compiled three times: once to count
each variable's uses, a use in a loop weighing eight times one outside it; once with the
heaviest in registers -- EDX first, which costs nothing to take, then EBX, ESI, EDI and EBP,
saved and put back -- to find the frame that leaves; and once to emit it. EDX goes only to a
variable in whose scope no call through a pointer is made, and not in a function that copies or
fills; EBX not where the function reads a table, ESI and EDI not where it copies or fills; a
variable a byte is stored from is dealt EDX or EBX, which have a low byte. The frame is
addressed from ESP, the bytes an expression pushed counted in, so there is no frame pointer and
EBP is a register like the others; a load a variable is given is made straight into its
register, `x = (x + y) | 0` is done in place, and a load named by registers alone is made into
ECX with EAX standing. The one x87 parameter of a function that reads it once, before any
other double, jump or call, stays in ST0 until that read: `_ftol` is `sub esp, 8; fisttp qword
[esp]; pop eax; pop edx; ret`. Each function is position-independent (the loader places a
`code` export wherever the module's `.text` has room, and nothing tells the bytes their
address), a table reached through the address a `call $+5` pushes -- or, in a function whose x87
stack is deeper or shallower at its return than at its entry (one that answers a double), a call
to a four-byte routine after the code that returns it: cork's translator follows `call $+5` as a
call that returns to the pop, and with the x87 stack changed between them it stops at the pop and
never gets past it.

The subset is the part of JavaScript 32-bit integer and x87 code reproduces exactly, and everything
outside it is a compile error naming its place in the source (the full rules are at the top of
`compile.mjs`): `let`/`const`, `if`, `while`, `do`, `for`, `break`, `continue`, `return`; integers
typed as asm.js types them (`|0`, `>>>0` and the bitwise operators bring a value back to 32 bits;
a sum may feed an address, another sum, a bitwise operator, an index or a store, and is brought
back before a comparison, a variable or a result); a comparison of two signed or two unsigned
values, never one of each; `*` by a constant, `Math.imul` otherwise, no integer division (`/` of
two integers is a double's); a module-level constant folded in; an exported module-level typed
array read by index, its contents placed after the code; a module-level function of one `return`
inlined. Objects, arrays, strings, closures, `await` and calls to other handlers are refused, and
the host is reached only by `return host()`.

Doubles are the x87's. `+`, `-`, `*`, `/` and unary `-` are its instructions -- an operand in the
frame, read through registers alone, or in the table of constants after the code taken as the
instruction's memory operand (`fsubr`/`fdivr` when it is the left one), an integer in the frame
through the `fi` forms, exact -- `%` is `fprem` until the remainder is whole (JavaScript's exact
remainder), `Math.sqrt` `fsqrt`, `Math.sin`, `Math.cos`, `Math.tan` `fsin`, `fcos`, `fptan` (for
an argument the source keeps below 2^63 in magnitude, past which the instruction leaves it),
`Math.atan2` and `Math.atan` `fpatan`, `Math.log2` `fyl2x` of 1, `Math.abs` `fabs`,
`Math.floor`/`ceil`/`trunc` `frndint` under the rounding control they name (set around it and
put back), and `Math.fround` a store to a float and back. An integer becomes a double exactly,
and a double an integer by `| 0` or `>>> 0`, JavaScript's modulo 2^32 (`fisttp`, and `fprem` by
2^32 where that answers the integer indefinite). `Math.exp`, `Math.log`, `Math.log10` and
`Math.pow` are refused: no one instruction is any of them, and the x87's sequence for each is not
JavaScript's to the last bit under an engine that keeps the x87 in doubles. A source writes them
with the instructions they are made of, through `X87` (`msvcrt/x87.js`: `X87.f2xm1`, `X87.yl2x`,
`X87.scale`, `X87.rint` -- `frndint` to nearest --, `X87.exponent` and `X87.significand` of
`fxtract`, and the constants `fldl2e`, `fldln2`, `fldlg2`, `fldl2t`, `fldpi` load), whose
JavaScript is the double the engines compute for each, held to cork's by `msvcrt/x87.test.js`.
Under a double-precision control word every one of these answers what JavaScript does; under the
one the program set, each rounds as the x87 rounds -- the arithmetic and the square root to its
precision control -- which is how the runtime a program links computes. The compiled code never
changes the precision control but where the source loads a control word itself, and changes the
rounding control only around the `frndint` that names one; the model rounds, from a word the
source loads on, as that word says.

The same function is the export's handler (`guestEntry`, `msvcrt/guest-code.js`): its arguments
read off the stack as the x86 reads them, its result answered where the x86 leaves it. That is
the reference `msvcrt/inguest.test.js` holds the x86 to on cork's test machine, input by input --
boundary values and random ones from a fixed seed, under five control words for the doubles; under
single precision against the x87's model of the source (`scripts/guest-code/model.mjs`: the
module rewritten with each double's `+ - * /` and square root rounded to 24 bits, as the x87 and
the translator round them) --
the result registers, the x87 stack and memory byte for byte, and what a callee owes its caller:
EBX, ESI, EDI and EBP kept, ESP past the return address, the direction flag clear, the control
word as it was, the x87 stack empty but for a double result. It is also what answers wherever a
handler is asked for directly (ntdll's `memset` family calls msvcrt's). A function that calls the
guest has no handler in the engine -- a handler cannot run the guest and wait for it
synchronously -- and is `guestExport`, the x86 alone; its tests run the JavaScript with a
stand-in for the call.

In the guest now: `floor`, `ceil`, `fabs`, `_ftol`/`_ftol2`/`_ftol2_sse` (ST0 popped, EDX:EAX;
a handler only where the host can set EDX); `abs`/`labs`; `toupper`, `tolower`, the classifiers
`isalpha`, `isdigit`, `isalnum`, `isspace`, `isupper`, `islower`, `ispunct`, `isxdigit`,
`isprint`, `iscntrl` and their wide forms `iswalpha` ... `iswgraph`, `iswascii`, `towupper`,
`towlower` (the classes in `CLASSES` and `WIDE_CLASSES`, which `_pctype`, `_isctype` and
`iswctype` read too); `strlen`, `strcpy`, `strcat`, `strncpy` (padded, and unterminated when cut
short), `strcmp`, `strncmp`, `_strnicmp`, `_stricmp` (and `_strcmpi`, its older name),
`strchr`, `strrchr`, `strstr`, `_strlwr`, `_strupr` (ASCII only, in place); the multibyte
family a program calls in its loops -- `_mbslen`, `_mbclen`, `_mbsinc`, `_mbsdec`, `_ismbblead`,
`_mbschr`, `_mbsrchr`, `_mbsstr`, `_mbscmp`, `_mbsicmp`, `_mbsncmp`/`_mbsnbcmp`,
`_mbsnicmp`/`_mbsnbicmp`, `_mbsncpy`/`_mbsnbcpy`, `_mbslwr`, `_mbsupr` -- which answers a
string that is ASCII as far as the answer, a byte a character under any code page (no byte below
0x80 leads in any), and hands the host a string with a byte past it or a character past 0x7f
(`msvcrt/mbcs.js`), which reads it by the page `_setmbcp` selected; `wcslen`, `wcscmp`, `wcscpy`; `memcpy`/`memmove` (one function: as if the source
were read whole first, copied up or down), `memset`, `memcmp` (four bytes at a time while they
match); `atoi`/`atol` (wrapping past 32 bits, as msvcrt.dll's does: `"4294967296"` is 0);
`strtol`/`strtoul`, handing the host what they leave to it; `qsort` (Shell's sort) and
`bsearch`, the program's comparator called with a `call`. `_EH_prolog` is a `code` export too,
assembled by hand (`EH_PROLOG_CODE`, `msvcrt/cxx.js`): it takes its handler in EAX and builds the
frame on its caller's stack and in the caller's EBP, which neither a handler nor the compiler's
subset can express.
Each keeps the answers of the handler it replaced (see the divergences below) but where
msvcrt.dll answers otherwise: bytes compare as unsigned chars, `strncmp` answers the difference of
the first two that differ, `atoi` wraps, `towupper` and `towlower` hand WEOF back, and the wide classes of the Latin-1 page are msvcrt's; `strtol` and
`strtoul` are held to theirs input by input as well, the JavaScript against the handler, since
the handler is part of them.

The mathematics is in the guest too (`msvcrt/inguest-math.js`), in both its shapes -- `sqrt`,
`sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `log`, `log10`, `pow`, `fmod`,
`sinh`, `cosh`, `tanh`, `_hypot`/`hypot`, `ldexp`, `frexp`, `modf`, and the `_CI` forms of each
the runtime has, with `_CIfabs`, `_CIfloor` and `_CIceil` -- computed on the x87 under the
program's control word, as the runtime computes: a program under Direct3D gets its square roots,
arcsines and exponentials to 24 bits, where the handlers answered in doubles whatever the word
said. Each answers what the x87 answers for the instructions it is (`fsqrt`, `fsin`, `fcos`,
`fptan`, `fpatan`; `asin` and `acos` as the runtime's own, `fpatan` of x and `fsqrt((1 + x)(1 -
x))`; `log` and `log10` `fyl2x` of ln 2 and of log10(2); `fmod` `fprem`; `ldexp` `fscale`; `frexp`
`fxtract`), and `exp` -- and `sinh`, `cosh`, `tanh` through it, `f2xm1` below ln 2 -- reduces its
argument by ln 2 in two parts (Cody and Waite's) where the runtime multiplies by `fldl2e` in the
x87's 64 bits: in a double's 53 that product costs up to 187 units in the last place, the
reduction one. `pow` answers the powers exact in any precision -- x squared, the square root of a
positive, x, its reciprocal, 1 -- and hands every other to the handler: 2^(y log2 x) in doubles
missed powers that are exact (pow(10, 2) was 99.99999999999997). A case msvcrt
answers with errno goes to the handler (`math.js`), which answers JavaScript's value and sets
errno as msvcrt does -- `EDOM` for a NaN of arguments that were none, `ERANGE` for an infinity of
finite ones, and `EDOM` for a NaN given to `atan`, `tanh` or `exp`, which answer it with that NaN
-- and so does an argument past `fsin`'s reduction (2^63), a NaN or an infinity where
the function checks for one, and a result past a double's range.
`tools/math-bench.mjs` times each of these calls in a loop, d3dx9's arithmetic beside them and
the x87's instructions inline, under both precisions, and sets cork's answers beside the
emulator's.

The rest of the runtime's floating point is in the guest as well (`msvcrt/inguest-float.js`).
`_control87` and `_controlfp` read the thread's x87 control word, translate it into `float.h`'s
portable bits (`_MCW_EM`, `_MCW_RC`, `_MCW_PC`, `_MCW_IC`; `_controlfp` leaves `_EM_DENORMAL` out
of its mask), change the ones the mask names and load the word back, answering it as they read it
again -- so a precision a program sets is the precision its arithmetic then rounds to, where the
handler remembered a word and applied nothing; `_statusfp` and `_clearfp` read the status word's
exception flags, and `_clearfp` clears them. `_isnan`, `_finite` and `_fpclass` read a double's
bits as integers (no x87 load, so a signalling NaN raises nothing); `_copysign` and `_chgsign`
are `fabs` and `fchs`; `_logb` is `fxtract`'s exponent (0 the handler's, -infinity and ERANGE);
`_scalb` is `ldexp`'s code; `_nextafter` steps by the unit in the last place on its side, under
double precision, a step past the largest double the handler's (ERANGE). `strtod` and `atof` read
their number in the guest -- white space, a sign, digits and a point, an exponent after `e`, `E`,
`d` or `D` where a digit follows, msvcrt's reading -- and compute what Clinger's fast path makes
exact, up to fifteen significant digits scaled by up to 10^22 in one multiplication or division
under double precision and rounding to nearest, the program's control word put back after; more
digits, a larger scale, an overflow and an underflow go to the handler, which answers the double
JavaScript reads and sets ERANGE for an infinity or a zero out of digits that were not all zeros.
`div` and `ldiv` are assembled by hand (`DIVIDE_CODE`, `msvcrt/math.js`): the quotient in EAX and
the remainder in EDX, where a compiler takes an eight-byte structure, from one `idiv`, which
faults as msvcrt's own does for a zero divisor or INT_MIN over -1. `msvcrt/inguest-float.test.js`
holds each to its JavaScript on cork's test machine -- the control word it leaves and the flags it
clears among what is compared -- and `src/crt-float.itest.js` calls them through the import on
cork and on the emulator, the program's own 1 / 3 rounding to the precision `_controlfp` set.

kernel32's `MulDiv` and ntdll's 64-bit helpers are code in the guest too, assembled by hand, since
the compiler's subset has neither a 64-bit product nor `div`. `MulDiv` (`MULDIV_CODE`,
`kernel32/system.js`) takes the product from one `imul`, adds half the divisor's magnitude to the
product's and divides the magnitudes with one `div` -- a half rounds away from zero -- after
checking that the quotient fits a word, so it cannot fault; a divisor of 0 and a magnitude past
2^31 - 1 answer -1, a quotient of INT_MIN's among them, as Wine's kernelbase answers (Wine has no
conformance test of it; the handler answered INT_MIN). `_allmul`, `_alldiv`, `_allrem`,
`_aulldiv`, `_aullrem`, `_alldvrm` and `_aulldvrm` (`INTEGER_CODE`, `ntdll/integer.js`) pop their
sixteen bytes and answer in EDX:EAX, the `dvrm` forms the remainder in EBX:ECX: a divisor of one
word divides the high word and then the low, a longer one is shifted right with the dividend until
it fits a word and `div`'s estimate taken one lower where its product passes the dividend; a zero
divisor faults in the guest, as `div` does. `_allshl`, `_allshr` and `_aullshr` shift EDX:EAX by CL
and pop nothing, a count of 64 or more leaving the sign or zero, and their handlers refuse, a
handler being passed no registers. The `dvrm` forms and the shifts are new, where an import of one
stopped the program. `ntdll/integer.test.js` and `kernel32/system.test.js`
hold the code to BigInt arithmetic on cork's test machine -- edges and random operands, the
registers a callee keeps and the bytes it pops -- and `src/integer-helpers.itest.js` calls them
through the import on cork and on the emulator, none crossing into the host.

### d3dx9's mathematics

Every mathematical export of the D3DX 9 library is code in the guest, the same table under each
name from `d3dx9_24.dll` to `d3dx9_43.dll` (their mathematics does not differ): the matrices --
`D3DXMatrixMultiply`, `MultiplyTranspose`, `Transpose`, `Inverse`, `Determinant`, `Translation`,
`Scaling`, `RotationX`/`Y`/`Z`, `RotationAxis`, `RotationYawPitchRoll`, `RotationQuaternion`,
`LookAtLH`/`RH`, `PerspectiveLH`/`RH`, `PerspectiveFovLH`/`RH`, `PerspectiveOffCenterLH`/`RH`,
`OrthoLH`/`RH`, `OrthoOffCenterLH`/`RH`, `Reflect`, `Shadow`, `Transformation`,
`AffineTransformation`, their `2D` forms, and `Decompose`; the vectors -- `D3DXVec2`/`3`/`4`
`Normalize`, `Hermite`, `CatmullRom`, `BaryCentric`, `Transform`, `TransformCoord`,
`TransformNormal` and their `Array` forms, `D3DXVec3Project`/`Unproject` and theirs,
`D3DXVec4Cross`; the quaternions -- `Multiply`, `Normalize`, `Inverse`, `Ln`, `Exp`,
`RotationAxis`, `RotationYawPitchRoll`, `RotationMatrix`, `ToAxisAngle`, `Slerp`, `Squad`,
`SquadSetup`, `BaryCentric`; the planes -- `FromPoints`, `FromPointNormal`, `Normalize`,
`IntersectLine`, `Transform` and its `Array` form; `D3DXColorAdjustContrast`/`Saturation`,
`D3DXFresnelTerm`, `D3DXFloat32To16Array` and `D3DXFloat16To32Array`. Each reads its floats,
computes on the x87 under the program's control word -- to 24 bits under the single precision
Direct3D leaves, as the library does -- and stores floats rounded to nearest; an angle past
`fsin`'s reach (2^63) is reduced by 2π first. Each reads every input before it writes an output,
so an output over an input answers what it would elsewhere, but for
`D3DXPlaneFromPointNormal`, which writes (a, b, c) before it reads the point, as the library does
(d is -1826, not -950, for a plane made over its own point in Wine's test).

The library's forms, as Wine's conformance tests (`dlls/d3dx9_36/tests/math.c`) pin them, and
`d3dx9/conformance.test.js` holds each function to their values and tolerances: a quaternion is
used as it is, not normalised -- the matrix of (1, -4, 7, -11) is the formula's, -129 on the
diagonal -- and `D3DXMatrixTransformation` turns its scaling by R' S R, the transposed matrix
the scaling rotation's inverse, its scaling rotation and centre unused without a scaling; the
logarithm of (v, w) is v acos(w) / sin(acos(w)) for |w| below 1 and v itself otherwise, whatever
v's length; the exponential ignores w; a slerp goes toward the nearer of q2 and -q2 and is a
straight line where their product is 1 or more; `D3DXQuaternionSquadSetup` negates q0, q2 and q3
toward their predecessors and takes true inverses; `D3DXQuaternionRotationMatrix` roots the
diagonal's sum and 1 where the sum is above 0, the largest diagonal element otherwise;
`D3DXMatrixInverse` of a singular matrix answers NULL and leaves both the output and the
determinant as they were; `D3DXMatrixDecompose` answers `D3DERR_INVALIDCALL` for a row of length
0; a vector, plane or axis of length 0 normalises to zero; `D3DXPlaneIntersectLine` answers NULL
for a line parallel to the plane; `D3DXVec3Project`/`Unproject` take NULL for any matrix (the
identity) and for the viewport (the transformed point itself). A half is converted as the
library's 32-bit build does it: exponent 31 is an exponent like the others, not infinity (80000
is `0x7ce2`, `0x7c00` reads back as 65536), every magnitude from 131008 up is `0x7fff` with its
sign, a NaN `0xffff`, a normal half rounded to nearest even and a subnormal one truncated.

Where the tests leave the library's answer open, these answer: a point transformed to a w of 0 is
divided by 1 in every `TransformCoord`, `Project` and `Unproject`, as before; `D3DXVec3Unproject`
and its `Array` form answer NULL and write nothing for a product with no inverse;
`D3DXQuaternionBaryCentric` answers q1 where f + g is 0, the limit of its two slerps. Under
single precision every value of Wine's tests is within its tolerance but one:
`D3DXMatrixTransformation2D` with a scaling centre and rotation, whose translation cancels terms
near 100 down to 13, answers -13.4019327, the value in doubles, where the library's floats leave
-13.401899 (148 units in the last place). Under double precision the answers are the doubles'
rounded once, a few units from the library's floats.

`d3dx9/inguest-matrix.test.js`, `inguest-vector.test.js` and `inguest-quaternion.test.js` hold
each function's x86 to its JavaScript on cork's test machine under three control words and to the
x87's model under single precision -- random floats of every size, angles past 2^63, NULL for
every pointer that may be one, zero vectors, singular products, strides, outputs over inputs --
and `src/d3dx9-math.itest.js` calls a selection through the import on cork and on the emulator,
both of which answer the model's floats to the bit, and none of which crosses into the host.

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
  **A heap's small blocks are the guest's** (`kernel32/guest-heap.js`). A heap is its control
  block, 64 KiB-aligned as on Windows, and its handle; `PEB->ProcessHeap` holds the process heap's.
  A block of up to a kilobyte comes from a slab of one size class (twenty-four classes from 8 to
  1024 bytes, 16 KiB a slab), and `HeapAlloc`, `HeapFree`, `HeapSize` and `HeapReAlloc` -- and
  `malloc`, `free`, `calloc`, `realloc` and `_msize` over the runtime's own heap, made through
  `HeapCreate` the first time the runtime allocates -- are guest code that takes a cell off a
  class's cache in the control block and gives it back there, under the heap's lock, taken with
  one `xchg`. What that code does not keep goes to the handler above through a trap of its own
  (`<heap-alloc>`, `<malloc>`, ...): a block past a kilobyte, a flag other than
  `HEAP_NO_SERIALIZE`, `HEAP_GENERATE_EXCEPTIONS` and `HEAP_ZERO_MEMORY` (and
  `HEAP_REALLOC_IN_PLACE_ONLY` for a resize), a resize past the block's cell, a pointer that is no
  live cell of that heap, an empty cache, a full one, and a lock another thread holds -- the host
  runs while no guest thread does, so it touches a cache only while the lock is free and otherwise
  keeps the free cells itself. Nothing of this sits beside a block: the guest finds a cell's slab
  through a directory with a word for every 16 KiB of the arena, and its size in the slab's record,
  one more than what was asked for (zero free), which is how `HeapSize` is exact and a double free
  is refused. Every host path goes through the arena's allocator with those cells found, sized and
  freed where they are (`wrap()`), so `HeapValidate`, `HeapSummary`, `HeapDestroy`,
  `GlobalSize`/`LocalFree` of such a block and a block the host allocated and the guest frees, or
  the other way round, all agree; a slab whose cells are all back with the host returns to the
  arena, and `HeapDestroy` takes a heap's slabs with it. In node on cork (a loop of allocations
  and frees, the tree before and this one alternated, each its own process on one core), a pair
  of 16 to 1000 bytes costs about a tenth of what two crossings cost -- 98-119 ns against
  909-1206 -- and a block past a kilobyte, still the host's, about 70 ns more (904 against 836).
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
  window's client coordinates, with the frame's hit test turning them into non-client messages,
  and nothing of the program runs then -- a dialog's procedure is not asked, since the dialog class
  hands every message to the program's dialog procedure first; as one is taken for a window whose
  procedure is the program's own, or a dialog, the windows under the point are
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
- **Wide and ANSI windows** (`user32/unicode.js`). A window procedure reads text in one encoding:
  wide for a class registered through `RegisterClass(Ex)W` or a procedure set through
  `SetWindowLongW(GWL_WNDPROC)`, the ANSI page for one set through the A forms, and for a system
  class, whose procedure takes both, the encoding of the `CreateWindowEx` call -- which is what
  `IsWindowUnicode` answers. A message carries its text in its sender's encoding (`SendMessageW`,
  `CallWindowProcW`, `DispatchMessageW`, `CreateWindowExW`'s `CREATESTRUCT` are wide), and a
  window's own procedure is handed it converted when the two differ: `WM_SETTEXT`'s string,
  `WM_GETTEXT`'s buffer (filled in the procedure's encoding in memory the heap lends for the call,
  then copied back in the caller's, the answer the characters it took), the two names of
  `WM_NCCREATE`'s and `WM_CREATE`'s `CREATESTRUCT` (an atom kept) and the character code of
  `WM_CHAR`, `WM_DEADCHAR`, `WM_SYSCHAR` and `WM_SYSDEADCHAR`. The procedures on this side --
  `DefWindowProc` and the system classes' -- read the ANSI page, so `DefWindowProcW` converts as
  an ANSI procedure of the program's would be converted to. A procedure named by address, as
  `CallWindowProc` names one, is handed the message as it came: Windows converts there only for
  the handle `GetWindowLong` gives out for a procedure of the other kind, and that handle is the
  procedure's own address here. A posted message keeps its sender's encoding, and `GetMessage`
  and `PeekMessage` give a character to each kind of caller as its own code. Without a heap, a
  text to set or fill fails rather than reach a procedure in the wrong encoding.
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
  machine's classes without overriding what is there. A hive is made for a Windows
  (`createHive({ windows })`), and restoring a saved one keeps everything a program wrote but for
  the values that describe the machine: the version values under `Windows NT\CurrentVersion`
  and both `Shell Folders` keys are written over, and a version value this Windows lacks is
  removed, so a bottle whose setting changed describes the Windows it now runs; the processor's
  `HARDWARE` branch is rewritten whole, as the kernel writes it at every boot.
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
below and `kernel32/spawn.js`). Critical sections are an exception to "every call crosses into the
host": `kernel32/critical.js` emits the enter/leave/try-enter fast paths as guest x86 on the
pre-Vista algorithm over the program's own `CRITICAL_SECTION` fields, and only a contended entry or
an owed wake traps -- the waiter is queued and parked in the host, and the leave that finds it
hands the section over by writing the owner and recursion count before the waiter runs; a release
goes to the first waiter that can run, never to a suspended one, and is kept owed when none can.
SRW locks, condition variables and one-time initialisation (`kernel32/slimsync.js`) are one word
the program allocated, kept true -- zero while an SRW lock is
free, its low bit set while held and the sharing holders counted above it: a lock is taken at once
or queued, shared by readers but never past a writer already waiting, and handed on in arrival
order; a condition variable's sleep joins the queue and lets go of the lock in one host call, so no
wake falls between them, answers `FALSE` with `ERROR_TIMEOUT` when its time runs out, and takes the
lock back through the lock's own acquire -- for a critical section, `EnterCriticalSection`'s guest
code; `InitOnceExecuteOnce` is a few guest instructions around two host calls, so the program's own
function runs in the one thread that is to run it, and a synchronous begin while another thread runs
it waits. Completion ports (`kernel32/iocp.js`) block a worker with the scheduler's own wait and owe
a packet from every overlapped read or write on a bound handle. The interlocked calls
(`InterlockedIncrement`, `Decrement`, `Exchange`, `ExchangeAdd`, `CompareExchange`) are the other
exception: each is its one locked instruction on the program's dword, placed as guest code
(`kernel32/interlocked.js`) with no trap at all, so it is atomic for the reason it is on Windows --
the scheduler preempts only between instructions -- and a bad pointer faults in the guest at the
instruction that touched it. `GetProcessHeap` (`PEB->ProcessHeap`), `GetVersion`, `GetCurrentProcess`
and `GetCurrentThread` are a few instructions of code in kernel32's own module, and so are `lstrlenA`/`W` and
`lstrcpyA`/`W` (`kernel32/lstr.js`) for the pointers they can read without a fault -- a null
pointer to `lstrlen` is 0 there, and a pointer in the null region's 64 KiB, at or past the top of
RAM, or a string or copy reaching it goes to the handler, which answers what it cannot read with 0
as Windows' exception handler does; a copy into its own source is made from the end, as the
handler, which reads before it writes, leaves it. `lstrcmpA` and `lstrcmpiA` stay the host's:
on Windows they are `CompareString` under the user's locale. TLS slots below 64 live in the running thread's own array behind its
TLS pointer (`FS:[0x2c]`), the one record of them: `TlsGetValue`/`FlsGetValue` and
`TlsSetValue`/`FlsSetValue` read and write it as guest code -- the get clearing the last error, the
set leaving it and not checking the index against the allocation, as on Windows -- and the host's
own handlers read and write the same array, so what they answer cannot drift from what the guest,
the compiler's `__declspec(thread)` sequence included, reaches through `FS`. `TlsFree` clears the
slot in every thread's array, and so does `TlsAlloc` handing it out: a set on a freed index lands
in the array as on Windows, and the slot's next owner reads zero all the same (Windows clears only
the allocating thread's; every thread's here is what a slot from 64 up already gets from its
generation). An index from 64 up jumps to the host, which keeps those values per
thread under the slot's generation and fails an index nobody allocated with
`ERROR_INVALID_PARAMETER`.

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

Each handler of the walk, and the last-chance filter, starts with TF, DF and AC clear, as Windows
enters its dispatcher, whatever the exception left on the processor: compiled code assumes DF clear
at every call, and a fault inside a copy going down (`std; rep movsd`, which is how the guest's own
`memmove` copies an overlapping run) would otherwise have every `rep` in the handler run
backwards. The context keeps the flags the exception had -- a raised exception's too, read at the
call -- and a handler that answers `EXCEPTION_CONTINUE_EXECUTION` continues with the context's
flags: the arithmetic ones, TF, DF, AC and ID as the handler left them, the rest (the reserved bit,
IF, IOPL) the thread's own.

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

### Drives and discs

`kernel32/drives.js` answers for the volumes. The machine's own disk is a fixed drive
(`DRIVE_FIXED`), labelled `Bottlify`, on `NTFS`, with invented free space large enough to refuse no
installation. A disc image mounted as a drive (`discs`, [`host.md`](./host.md)) is what it is: a
CD-ROM (`DRIVE_CDROM`), and `GetVolumeInformationA`/`W` answer with the disc's own label and serial
number ([`filesystem.md`](./filesystem.md), "Disc images"), the file system `CDFS`, a longest name
of 110 characters on a Joliet disc and 221 on one without, and the flags `FILE_CASE_SENSITIVE_SEARCH`,
`FILE_UNICODE_ON_DISK` (Joliet only) and `FILE_READ_ONLY_VOLUME`. `GetDiskFreeSpace` reports it
full, 2048-byte sectors one to a cluster, as large as the disc; `SetVolumeLabel` on it fails with
`ERROR_WRITE_PROTECT`.

On the disc every name is read-only (`FILE_ATTRIBUTE_READONLY`, files and directories alike, and
no archive bit), a name the disc records as hidden is hidden, and a file's time is the disc's
recording time (`kernel32/filetime.js`'s `fileAttributes`, used by `GetFileAttributes`,
`FindFirstFile` and `GetFileInformationByHandle`). Every change aimed at it -- `CreateFile` asking
for write access or to create or empty a file, `CreateDirectory`, `DeleteFile`, `RemoveDirectory`,
`MoveFile` off or onto it, `CopyFile` onto it, `SetFileAttributes`, `OpenFile`, `_lopen` and
`_lcreat` for writing -- fails with `ERROR_WRITE_PROTECT` (19), the device's refusal, rather than
`ERROR_ACCESS_DENIED`; `vfs.writeProtected(path)` is how the surface knows. Reading, and copying
off the disc, are as on any drive.

### Time and its clock source

Two clocks, both the kernel's ([`kernel.md`](./kernel.md)):

| function | source |
|----------|--------|
| `GetTickCount`, `QueryPerformanceCounter` (1 MHz), `timeGetTime`, `clock`, `Sleep` deadlines, message timers | `kernel.clock.virtualTime()` — the guest's clock. A frame loop that times an interval with one call and reads it with another must not disagree with itself. |
| `GetSystemTimeAsFileTime`, `GetSystemTime`, `GetLocalTime`, `time`, `timeGetSystemTime` | `kernel.clock.wallClock()` — the date. |

`GetTickCount` wraps at 32 bits as Windows does. `GetTickCount` and `QueryPerformanceCounter` are
reads of a block the engine rewrites whenever the guest's clock moves, as guest code in the guest's
own kernel32 (`kernel32/process.js`), and `WINMM.dll!timeGetTime` is bound to the same routine as
`GetTickCount` (`win32/module.js`): it answers the same milliseconds off the same clock with the
same wrap, `timeBeginPeriod` changing nothing here, so it is one `mov eax, [block+8]` and no
crossing -- under cork in node, a loop of it went 395 -> 24 ns a call (`host-call-bench.mjs
--baseline`, N 2M, five rounds pinned to one core). Its handler answers for a build with no block.

### The version a program is told

The machine is one of four Windows, the `windows` configuration (`kernel32/versions.js`), each
with the last service pack its release had; XP SP3 is the default
([`decisions.md`](../../roadmap/decisions.md)). Every place a program reads the version agrees:

| where | 2000 | XP | 7 | 10 |
|-------|------|----|---|----|
| `GetVersion`, `GetVersionExA`/`W` (`dwMajor.Minor.Build`, `szCSDVersion`) | 5.0.2195, Service Pack 4 | 5.1.2600, Service Pack 3 | 6.1.7601, Service Pack 1 | 10.0.19045, none -- or 6.2.9200 / 6.3.9600, below |
| `OSVERSIONINFOEX` `wServicePackMajor.Minor`, `wSuiteMask`, `wProductType` | 4.0, 0, workstation | 3.0, `VER_SUITE_SINGLEUSERTS`, workstation | 1.0, `VER_SUITE_SINGLEUSERTS`, workstation | 0.0, `VER_SUITE_SINGLEUSERTS`, workstation |
| the process block (`OSMajorVersion`, `OSMinorVersion`, `OSBuildNumber`, `OSCSDVersion`, `CSDVersion`, `OSPlatformId`) and `RtlGetVersion` | as above | as above | as above | 10.0.19045 always |
| `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`: `CurrentVersion`, `CurrentBuildNumber`, `CurrentBuild`, `CSDVersion`, `ProductName` | 5.0, 2195, `1.511.1 () (Obsolete data - do not use)`, Service Pack 4, Microsoft Windows 2000 | 5.1, 2600, the same placeholder, Service Pack 3, Microsoft Windows XP | 6.1, 7601, 7601, Service Pack 1, Windows 7 Professional | 6.3, 19045, 19045, none, Windows 10 Pro, and `CurrentMajorVersionNumber`/`CurrentMinorVersionNumber` 10 and 0, `DisplayVersion` 22H2, `ReleaseId` 2009, `UBR` 6456 |
| a system library's file version (`VERSION.dll`) | 5.0.2195.0 | 5.1.2600.0 | 6.1.7601.0 | 10.0.19045.0 |
| the profile (`shellFolders`, the environment) | `C:\Documents and Settings\User`, `...\All Users` | as 2000 | `C:\Users\User` (`AppData\Roaming`, `AppData\Local`, `Documents`), `C:\ProgramData`, `C:\Users\Public` | as 7 |

All four are 32-bit systems with the platform `VER_PLATFORM_WIN32_NT`: `IsWow64Process` answers
FALSE and there is no `Program Files (x86)`. The Windows directory is `C:\WINDOWS` whichever is
chosen, and so is the temporary one, `C:\WINDOWS\TEMP` (`GetTempPath`, `TEMP`, `TMP`). The
profile's folders exist on the volume from the start (`profileDirectories`, made by kernel32's
file functions beside `WINDOWS`, `TEMP` and the program directories), so a program can make its
own directory in `%APPDATA%` without making the folder first.

Windows 10 answers `GetVersion`, `GetVersionEx` and `VerifyVersionInfo` with the newest Windows the
program says it knows, never newer than itself (`reportedVersion`): the highest its manifest's
`supportedOS` elements name, or, when they name none, its PE header's operating system version
rounded down to 10.0 or 6.3 -- and 6.2.9200 when older still, which is what a program of the era
with no manifest is told. 8.1's answer is 6.3.9600. The process block, `RtlGetVersion`, the
registry and a library's file version keep 10.0.19045. The other three answer every program the
truth.

`VerifyVersionInfo` compares the major and minor version and the two service pack numbers as one
version: an `EQUAL` condition demands its own field and passes to the next, the first ordering
condition decides the rest together, and a version field the type mask names with no condition, or
with `AND` or `OR`, is not met (Wine's kernel32 `test_VerifyVersionInfo`). The suite compares as a
set (`AND`: every suite asked for, `OR`: any, or none asked). An empty type mask or condition mask
is `ERROR_BAD_ARGUMENTS`; a request not met is `ERROR_OLD_WIN_VERSION`. ntdll's
`RtlVerifyVersionInfo` is the same comparison against the version the process block holds, the
truth `RtlGetVersion` answers, with `STATUS_INVALID_PARAMETER` and `STATUS_REVISION_MISMATCH`.

The C runtime's `_osver`, `_winver`, `_winmajor` and `_winminor` are still the default XP's figures
whatever the configuration (`msvcrt/startup.js` reads `kernel32/process.js`'s constants).

### The divergence rule

A call that this build accepts but does not do all of what Windows promises **succeeds and
reports**, through `config.divergence(api, detail)`; it is never refused for that reason, because
refusing changes what the program does, usually by stopping it. The assembler emits each distinct
`(api, detail)` once as a `divergence` event, journalled at `warn`. Sites in this layer:
`HeapAlloc`/`VirtualAlloc` refusals with the allocator's state (`kernel32/heap.js`),
`CoCreateInstance` of an unregistered class, naming the CLSID (`ole32/functions.js`), the automation
library (`oleaut32/functions.js`), `InternetCanonicalizeUrl` browser mode (`wininet/functions.js`),
four DirectShow states (`quartz/graph.js`: stop cannot rewind, a film running on the host clock
without its sound, position and rate accepted and ignored), an `mmioOpen` or `mmioRename`
through a program's own I/O procedure in a build that cannot call it, an `mmioOpen` of a file
whose built-in procedure the program replaced, and one of mmio's own messages sent to a built-in
procedure (`winmm/mmio.js`), a `VT_RECORD` a `PropVariantCopy` shares rather than copies and an
interface it or `PropVariantClear` cannot AddRef or Release in a build that cannot call the
program (`ole32/propvariant.js`), `RIDEV_NOLEGACY` (`user32/rawinput.js`), a replacement
`SHFileOperation` makes without asking (`shell32/fileop.js`), and what comctl32's image lists and
property sheets cannot do (`comctl32/`). The `NOT_IMPLEMENTED` stub of `system/stub.js` is not used
inside this layer; a function that is not implemented answers with the documented code that ends the
caller's loop (`ERROR_CALL_NOT_IMPLEMENTED`, `ERROR_NO_MORE_ITEMS`, `E_NOTIMPL` for a COM slot
nothing implements).

### Small contracts, one paragraph each

- **The C runtime's variables are data exports**, read through the address a program imported:
  `_acmdln`, `_pctype`, `__mb_cur_max`, `_adjust_fdiv`; the system version as `_osver`,
  `_winver`, `_winmajor` and `_winminor`, the default Windows's figures (not yet the configured
  one's); `_HUGE` as
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
  follow it wherever `freopen` moved it. Every printer formats a double as msvcrt does
  (`msvcrt/format.js`, `cvtDigits`, which `_ecvt` and `_fcvt` share): seventeen significant
  digits rounded half up, zeros past them, an exponent of three digits, and an infinity or NaN as
  `1#INF`, `1#QNAN`, `1#SNAN` or `1#IND` rounded as if digits (`%.2f` of one is `1.#J`); a
  conversion it does not know is written as its own character. The scanners (`msvcrt/scan.js`)
  read as msvcrt does -- width digits and length modifiers in any order, a character that is no
  conversion matched as it stands, `%p` with no `0x`, a scanset range either way round --
  `swscanf` storing wide text for `%s` and `%c`, and `fscanf` reading its stream a line at a time
  until the scan stops short of what it read, giving back what the scan did not consume. In a
  Unicode translation (`msvcrt/widetext.js`) -- a
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
- **The `isw*`/`tow*` wide-character classifiers answer below `0x100` from msvcrt.dll's own
  table**, which it reads in every locale and asks the system (`GetStringTypeW`) only past `0xff`
  (`WIDE_CLASSES` in `msvcrt/inguest.js`, derived rather than transcribed, and checked entry by
  entry against the table Wine keeps for msvcrt.dll): ASCII as the byte classifiers class it, but
  for the tab, which is blank; the C1 controls `0x80`..`0x9f` are controls, `0x85` among them and
  no space; the no-break space is space and blank; `0xa1`..`0xbf` are punctuation, the ordinal
  indicators and the micro sign included, and the superscript one, two and three digits as well;
  `0xc0`..`0xff` are letters, upper or lower, but for the multiplication and division signs. The
  classifiers ask that table as msvcrt's do -- `iswprint` the blanks, punctuation, letters and
  digits, `iswgraph` the same without the blanks, so a tab prints -- and `iswctype` answers
  msvcrt's own bits from it. Case mapping stays ASCII's, as the C locale's does, and a unit past
  `0xff` has no class at all here, where msvcrt.dll asks the system.
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

- **The C runtime's comparisons answer -1, 0 or 1.** `strcmp`, `strncmp` and the case-blind
  `_stricmp`/`_strnicmp` compare bytes as unsigned chars -- the case-blind ones after folding
  ASCII's letters -- as msvcrt.dll does, and normalise the sign, where 32-bit msvcrt.dll's
  `strncmp` answers the difference of the bytes (Wine's conformance tests record it) and C
  promises only the sign. A string past 1 MiB, which the handlers read no further than
  (`strlen`'s stopped the run without a terminator by then), is
  measured, copied and compared whole by the x86, as msvcrt's are, and `strtol`/`strtoul` read
  only as far as the number goes, where their handler read the whole string first; so is a wide
  string past 65536 units, where `wcslen`, `wcscmp` and `wcscpy`'s handlers stopped, having
  read 128 KiB from the pointer whatever the string's length. `strcpy`
  copies as `memmove` does, as if the source were read whole first, where C leaves an overlap
  undefined.
- **The C runtime's mathematics is the x87's, under the program's control word, and not the
  runtime's own to the last bit.** It rounds to the precision control the program set, as msvcrt
  does, and to nearest whatever the rounding control says, as msvcrt sets it for its maths. Where
  the engines' x87 is a double, `exp`, `sinh`, `cosh` and `tanh` are within a unit or two in the
  last place of JavaScript's (`exp` the same double in 92 % of arguments), `log` and `log10`
  within one (`log10` of a power of ten exact), `asin` and `acos` within two -- the runtime
  computes them with the x87's 64 bits and Windows answers nearer; `pow` hands a power it cannot
  make exact to the handler, which answers JavaScript's. `sin`, `cos` and `tan` of an argument past
  2^63 answer JavaScript's value, where msvcrt reduces it by its own 2π; `sinh`, `cosh`, `tanh` and
  `_hypot` are written here, not after the runtime's code. errno is set as msvcrt sets it for
  a domain or a range error; a NaN argument sets none. `ldexp` of a count past a double's range
  scales in two steps and answers the double the result is (`ldexp(1e300, -1100)` is 7.4e-32),
  where the handler multiplied by `Math.pow(2, n)`, zero or an infinity by then. The emulator's
  `f2xm1` is 2^x less one in doubles and its `fldlg2` and `fldl2t` a unit off the doubles cork
  loads: of the calls `crt-math.itest.js` makes, `exp(1)` and `log(10)` come a unit from cork's
  under it and `sinh(0.1)` five, and `log10` takes the double nearest log10(2) rather than
  `fldlg2`, which made `log10(1000)` 2.999999999999999 there. The emulator's `fprem` is not the
  exact remainder either: of `math-bench.mjs`'s 256 pairs, `fmod` under it missed cork's answer
  -- JavaScript's `%`, the x87's exact remainder -- in 91, by up to 3.8 million units in the last
  place of a remainder that cancelled.
- **The floating-point environment is the x87's alone.** `_control87` and `_controlfp` load the
  x87 control word and answer it; msvcrt.dll on a processor with SSE2 sets MXCSR's masks, rounding
  and denormal control alongside and folds its bits into the answer (`_EM_AMBIGUOUS` where the
  two differ), which the handler before this did not either, and `_statusfp`/`_clearfp` read and
  clear the x87's flags only. A precision in `_MCW_PC` both bits name loads the x87's 24 bits and
  reads back as `_PC_24`. `strtod` and `atof` answer the correctly rounded double, JavaScript's
  reading, whether the guest or the handler answers, and read `d` and `D` as exponents, as
  msvcrt does, where the handler stopped at them; their handler no longer drops digits from an
  overflowing number until it is finite (`1.7976931348623159e+308` read as 1.79e30): it answers
  the infinity and sets ERANGE.
- **d3dx9's arithmetic is the x87's, under the program's control word, over floats.** A matrix
  product, a transform or a normalisation computes in doubles under a double-precision control
  word and to 24 bits under Direct3D's, and stores floats rounded to nearest; the library picks
  its own code by the processor, and the last bit of a result may differ from Windows'. `D3DXVec3TransformNormal` takes no part of the matrix's last row, as the
  library does, where the handler added it times zero (a NaN out of an infinity there);
  every `TransformCoord`, `Project` and `Unproject` divides by 1 a point that comes to a w of 0,
  `D3DXVec3Unproject` answers NULL for a product with no inverse and `D3DXQuaternionBaryCentric`
  q1 for an f + g of 0, cases Wine's tests leave the library's answer open in;
  `D3DXMatrixTranspose` moves the floats'
  bits as they are. `D3DXMatrixTransformation2D` with a scaling centre and rotation answers its
  translation as doubles compute it, up to 150 units in the last place from the library's floats
  ("d3dx9's mathematics").
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
- **A `VT_RECORD` PROPVARIANT is shared, not copied.** `PropVariantCopy` takes a reference on its
  `IRecordInfo` and hands the copy the same record data, reported; the clear gives the reference
  back and leaves the data.
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
- **The C runtime has one locale, C**, and a multibyte code page apart from it: `_setmbcp`
  takes the pages Windows has -- the double-byte 932, 936, 949, 950 and 1361, whose lead and trail
  bytes `_mbctype` marks and the `_mbs*` family walks by, and the single-byte ANSI and OEM pages --
  and refuses the rest with `EINVAL`; a double-byte character has no case, and no character past
  a byte is mapped to Unicode. `_mbctype` is rewritten where the loader placed it only where the
  assembler hands the runtime `addressOf`, as `_environ` and `_wenviron` are; the runtime's
  environment starts as the process's only where it is handed `environment`, and `_putenv`
  reaches the process's block only through `setVariable`; `system` has no command interpreter
  to run. `wctomb`, `wcstombs`, the wide calls on a text
  stream and a wide argument in the narrow printers take a character to a byte and have none past
  U+00FF -- a printed wide string stops before its first such character, as the older runtimes'
  did.
  The narrow character calls refuse a stream in a Unicode translation with `EINVAL` where the
  runtime asserts. A file opened to be deleted on close goes when the descriptor that asked for it
  closes, or the process ends, not once the last handle anyone holds on it is closed.
- **No input method** (`imm32` succeeds by having nothing to do), **no image drawing** in image
  lists, **no message tables or module strings** in `FormatMessage`.
- **The system classes are the classic look and the common messages**: a combo box's list does
  not drop down (the arrow keys change the selection; said once as a divergence), a scroll bar's
  thumb is not dragged, an edit undoes one change, and a static's image is drawn only when the
  bitmap has pixels this build can reach (said once otherwise). A tab control draws its tabs'
  images from the image list it was given, as an image list draws them, with no alpha. A dialog template naming a
  class nothing registers fails to make the dialog, as Windows does, unless `DS_NOFAILCREATE`; a
  class Windows' own libraries register and this build does not implement (a list view, a rich
  edit) is still made, as a window with no procedure. A property sheet's
  windows are made through the ANSI calls, so a wide sheet's caption
  and titles are UTF-16 where a template or a tab carries them and in the ANSI page where
  `SetWindowText` does, where a character the page does not hold is the default character. A wizard's header draws no bitmap, watermark or bold title.
- **Unimplemented imports** are reported once per name at load. A decorated stdcall name, a
  C++ name that sizes its arguments or a C-runtime name is answered with zero, which reads as
  failure under most conventions but as `S_OK` to a caller expecting an `HRESULT` and as a result
  to a C runtime call that fails with -1 or `EOF`; an undecorated name from any other library, or a
  C++ name that does not size its arguments, stops the process on its first call (§3, "From a
  table to a module").
- **SETUPAPI installs files and nothing else.** `SetupInstallFromInfSectionA` carries out
  `SPINST_FILES`; any other directive it is asked for (registry, INI, services, registering
  libraries) is reported once as a divergence and not done. The default queue callback aborts
  on a copy, rename or delete error rather than asking. There are no Plug and Play devices, so
  every device set is empty. The OS component calls are undocumented: a component is kept as
  its two structures under
  `HKLM\SYSTEM\CurrentControlSet\Control\Setup\OsComponents\{GUID}`, a place of this build's
  choosing rather than a documented one, and one never registered is `ERROR_FILE_NOT_FOUND`,
  the code its callers test for. The wide (`W`) spellings do not exist.
- **A disc refuses as the device, and some of its answers were not measured.** Every change on a
  disc is `ERROR_WRITE_PROTECT` before its name is looked up, so `CreateFile` with `CREATE_NEW` on a
  name the disc has is `ERROR_FILE_EXISTS` only because that is checked first here; which of the
  two Windows gives there, and the longest-name and flag values `GetVolumeInformation` reports for
  a disc, are how the CD-ROM file system is known to answer, not something measured here. `GetFileInformationByHandle`
  gives a file on the disc the machine's own serial number, and the C runtime's `_access` and
  `_stat` do not see that a file on it is read-only. There is no media change: one image per drive,
  as long as the program runs.
- **WINTRUST verifies Authenticode files and nothing else.** An action other than
  `WINTRUST_ACTION_GENERIC_VERIFY_V2` is `TRUST_E_PROVIDER_UNKNOWN`, and a subject other than a
  file (a catalog member, a blob, a signer, a certificate) `TRUST_E_SUBJECT_FORM_UNKNOWN`, each
  said once as a divergence; a file of a form with no subject package here (an MSI, a catalog, a
  script) is `TRUST_E_SUBJECT_FORM_UNKNOWN` too. The file is read by its path, never through
  `hFile`. Revocation is not
  checked: there is no network path to a CRL, and a request for it is said once. A timestamp
  is the PKCS #9 countersignature; an RFC 3161 one is not read, and such a signature is judged
  now. No window is shown, whatever `dwUIChoice` asks. A signer whose RSA signature does not
  verify answers `NTE_BAD_SIGNATURE`, a message digest that is not the content's
  `TRUST_E_BAD_DIGEST`, and a malformed signature `TRUST_E_NOSIGNATURE`; which codes Windows
  gives for those three was not measured.

Reported at runtime: `divergence` (each once), `unimplemented` (each import once, plus a count per
name in the application's diagnostics as `unimplementedCalls`), `message-box`, `clipboard` (the
text a program copied, once its clipboard closes), `output`, `debug`,
and the metrics in §2.

## 5. Tests

Unit tests are colocated with each file, `node:test`, over `fakeMemory`
(`src/layers/win32/msvcrt/harness.test.js`) or a stub host; there are 138 `*.test.js` files under
`src/layers/win32/`. Run with `npm test` from `modules/core`.

| area | files (all `src/layers/win32/…`) |
|------|----------------------------------|
| kernel32 | `apc`, `atoms`, `code-arena`, `consoleio`, `critical`, `disc`, `drives`, `environment`, `file-holds`, `files`, `filetime`, `lstr` (the two widths of lstrlen and lstrcpy on cork's test machine: what the guest answers, an overlap either way, what it hands to the host, the registers, the stack and the direction flag kept), `guest-heap` (the heap's guest routines on cork's test machine over the memory the host's half keeps: a cache filled by the host and emptied by the guest, what they hand over, zeroing, a full cache handed back and an empty slab returned, `HeapDestroy`'s half, and four thousand random calls from both sides with every block's contents, extent and size checked), `heap`, `iocp`, `locale`, `mapping`, `modules`, `named-objects`, `process`, `processor`, `profile`, `resources`, `seh`, `slimsync`, `spawn`, `sync`, `system`, `teb`, `threading`, `versions`, `vfs` `.test.js` |
| msvcrt | `convert`, `cxx`, `eh`, `format`, `functions`, `globals`, `heap`, `inguest`, `inguest-math`, `io`, `math`, `mbstring`, `paths`, `scan`, `seh`, `startup`, `stdio`, `strings`, `threads`, `time`, `widetext`, `x87` `.test.js` -- `inguest.test.js` and `inguest-math.test.js` hold each `@guestCode` function's x86 to its JavaScript on cork's test machine, and `x87.test.js` `X87`'s JavaScript to the instructions on it; the compiler's own tests (every form of the subset against JavaScript, and against the x87's model under single precision, every refusal with its place) are `scripts/guest-code/compile.test.js`, and `scripts/build-guest-code.test.js` fails on a stale `inguest.x86.js` |
| user32 | `controls`, `cursors`, `dialogs`, `display`, `keys`, `messages`, `objects`, `paint`, `structs`, `system`, `unicode`, `windows` `.test.js` — `controls.test.js` paints a dialog through the real drawing engine and compares it byte for byte with `controls.reference.png` |
| gdi32 | `drawing`, `functions`, `objects` `.test.js` |
| the rest | `advapi32/{crypto,functions,registry,services,tokens}`, `advpack/functions`, `cabinet/{cabinet,inflate,lzx}`, `crypto/{der,digest,pkcs7,pki,rc4,rsa,signature,x509}` (`pki.test.js` builds the keys, certificates and signed messages the others read), `comctl32/{functions,imagelist,progress,propsheet,tab,treeview}`, `comdlg32/functions`, `d3dx9/{functions,inguest}` (`inguest.test.js` holds the arithmetic's x86 to its JavaScript as msvcrt's does), `imm32/functions`, `lz32/{expand,functions}`, `mpr/functions`, `msacm32/functions`, `ntdll/{functions,integer,query,status,strings}`, `ole32/{cfb,functions,guid,objects,propvariant,storage,wbem}`, `oleaut32/{errorinfo,functions,invoke,objects,typelib}`, `quartz/graph`, `rpcrt4/functions`, `setupapi/{functions,inf}`, `sfc/functions`, `shell32/{fileop,functions,namespace,shelllink}`, `shlwapi/functions`, `version/functions`, `wininet/functions`, `winmm/{functions,mmio,thread,timers,wave}`, `winspool/functions`, `wintrust/{authenticode,fixtures,functions,roots}` (`fixtures.test.js` signs cabinets and images with a chain of its own), `wsock32/{functions,sockaddr,sockets,transport}` `.test.js` |
| module | `module.test.js` — a configured screen reaches user32 and gdi32; a DC through user32 is GDI's; both fall back to 640×480 together; the C runtime family is cdecl and every other library stdcall; the runtime's `_sleep` is kernel32's `Sleep`; the KnownDLLs; shfolder's forwarding; comctl32's `_TrackMouseEvent` is user32's. `wiring.test.js` builds the module and asks through it what each library's capabilities were handed: SHLWAPI's wide strings, ADVPACK's `IsNTAdmin` from the account's token, SETUPAPI's INF found on the volume by bare name and its OS components in the hive advapi32 reads, WINTRUST's file read from the volume and judged against the configured roots, VERSION's system libraries, mmio's buffer from the program's heap, mmio reading a file by the program's own kernel32 handle and calling its own I/O procedure through the bridge on the caller's thread, a drop target as its window's property through user32, a PROPVARIANT's BSTR and SAFEARRAY copied by oleaut32's own calls, the synchronisation calls' and the profile structures' last errors and guest memory, `LoadLibraryEx`'s flags reaching the assembler, `ExitProcess` and the runtime's `exit` telling the attached libraries last first (and ending at once with none), `MWMO_INPUTAVAILABLE`. |

`kernel32/critical.itest.js` runs the hand-assembled critical-section fast paths on the real
emulator (`npm run test:integration`), pinning that the bytes the unit test checks are x86 that
does the job. `src/kernel32-inguest.itest.js` calls the guest-code exports through the import, on
cork and on the emulator: each interlocked call's answer, the dword it leaves, the stack it pops
and the registers it keeps, and three preempted threads counting through two of them; a TLS value
set in the guest read back by the API, by the compiler's `FS:[0x2c]` sequence and not by another
thread, the last error each call leaves, a slot past the array through the host, an index past
every slot refused, a freed slot zero, and a value set in a freed slot gone once `TlsAlloc` hands
the slot out again; the calls a few instructions long -- `GetProcessHeap` against the process
block and a heap to allocate from, `GetVersion` against the block's version, the pseudo-handles,
`GetCurrentThreadId` (the host's) against the block and against the id `CreateThread` answered
for a second thread, lstrlen and lstrcpy in both widths -- with none of the guest's crossing but
the `lstrlenA` of a pointer at 0x100; three threads through one critical section with recursion,
sleeping while they hold it, the count exact, every entry through the fast path and every waiter
handed the section; and a thread that finds a section held refused by `TryEnterCriticalSection`,
then waiting in the host, with the lock count showing it queued, while the owner's own try is a
recursion, until the owner's last leave hands it over. `src/heap-inguest.itest.js` calls the
heap through the import on cork and on the emulator: a block sized, validated by the host, grown in
place and moved past its cell, freed and no longer valid; `HEAP_ZERO_MEMORY` over a recycled cell;
a heap of the program's own added up by `HeapSummary` and taken whole by `HeapDestroy`; the
runtime's family; another heap's block refused; and ten thousand pairs with next to none of them
crossing -- and three threads preempted every 97 instructions allocating, filling, checking and
freeing eight blocks a turn from the process heap and from `malloc`. `src/winmm-inguest.itest.js` calls
`timeGetTime` and `GetTickCount` one after the other through the import, twice with a `Sleep`
between, on cork and on the emulator: each pair in order on one clock, the sleep seen, the stack
and the kept registers as they were, `timeBeginPeriod` granted, `GetProcAddress` handing out the
address the import took, and neither clock crossing into the host. `src/crt-inguest.itest.js`
calls the runtime's in-guest functions through the import of a small program, under cork and
under the emulator: `_ftol`'s two halves, `qsort` and `bsearch` through the program's comparator, and the
rest against the handlers' answers -- each copy, fill or move read back by a comparison -- with
the program's ESI and EDI kept across each call, and where msvcrt.dll answers otherwise than the
handlers did, against its answers: 0x80 below 0xa0 in each comparison, `atoi("4294967296")` 0,
WEOF back from `towupper` and `towlower`, and the Latin-1 classes; and under cork a program that
calls `floor` while the host writes stdout's record in `_iob` at every turn has every instruction
translated.
`src/exceptions.itest.js` runs three compiled fixtures -- `seh.exe`, `cxxeh.exe`,
`unhandled.exe`, built from `test/fixtures/src/` by `scripts/build-fixtures.mjs` with clang and
lld against the MSVC ABI -- through every path above, processor faults and two threads throwing
at once included; beside them a program built in the test takes an invalid opcode with DF set, on
cork and on the emulator, and its handler runs with DF clear -- a `rep stosb` in it fills upwards
-- while the context has DF, and the block the handler continues at gets DF back.
`src/apc.itest.js` runs `apc.exe`, built the same way: APCs to itself and to another thread's
alertable sleep, one refused by a wait that is not alertable, a routine queued
by a routine, and a timer's completion routine. Others build their guest program in the test
itself, most answering one property per bit of its exit code: `src/condition.itest.js` sleeps on a
condition variable over an SRW lock and over a critical section; `src/suspend.itest.js` creates a
thread suspended, resumes it and joins it, and suspends it once it has ended; `src/fileex.itest.js`
drives `ReadFileEx`, `WriteFileEx` and `SleepEx`; `src/loadex.itest.js` loads a library as a
data file and unresolved, and a program by name; `src/unload.itest.js` counts a library's loads and
watches the last `FreeLibrary` detach and unload it; `src/exitdetach.itest.js` watches a library
the program imports be attached and then detached by `ExitProcess`; `src/arena.itest.js` ships a
library that ends just short of the stack pool and starts a thread; `src/system-modules.itest.js`
holds the system modules to their own images' room in the module window, each where the one before
it ends, and has a program import `d3dx9_30`, `d3dx9_43` and `msvcrt`, load and free `d3dx9_36`,
and find each version's handle, exports and file name its own, on cork and on the emulator.
End-to-end tests that drive a program through the whole surface live beside the application entry
point (`src/*.itest.js`) and in `tools/cdp_test/` (a real browser and GPU).
