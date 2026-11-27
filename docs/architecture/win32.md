# Win32 in JavaScript: how a DLL comes about

Each system library is a set of tables in JS. For every function they record which handler runs it,
how many bytes of arguments to take off the stack, and its calling convention (stdcall unless
stated). For example, `AddAtomA: { argBytes: 4, handler: ([p]) => add(p) }` in
[`core/src/layers/win32/kernel32/atoms.js`](../../modules/core/src/layers/win32/kernel32/atoms.js).

When a process starts, the loader lays out real PE32 images of `kernel32.dll`, `d3d9.dll` and the rest
from these tables (PE32+, AMD64, in a 64-bit process): each module's span and every export's address
are fixed then, in the same order in every process, and its bytes are written into the program's
memory when something first loads it or is first handed one of its addresses; a module whose code
holds another's addresses (GLU32's calls into OPENGL32) writes that one with its own
([`process/system-modules.js`](../../modules/core/src/process/system-modules.js), decision A280).
The first process of a runtime lays the modules out and keeps the layout; a later one with the
same tables takes it and builds a module's exports only when it places it. What a module's
routines take for themselves - their code and data - comes from the engine's span before the
modules (`engineCode` in [`app.js`](../../modules/core/src/app.js)), each module from its own part
of it, and the stubs they fall back to take the slots their names took in the first process, so
a routine lies at the same address in every process and its translations are shared (A281).
The tables are made when first read ([`lazy-libraries.js`](../../modules/core/src/layers/win32/lazy-libraries.js)):
a process that imports kernel32 alone makes those its start needs (kernel32, ntdll and the msvcrt
ntdll is made of, advapi32). A library whose factory registers a COM class is made when a class
is first not found (`CLASS_SERVERS`), as Windows loads a class's server only then.
To the program they are ordinary DLLs, with headers, an export table and code. So the address
`GetProcAddress` returns is the one the import was bound to.

One table can be two libraries. comctl32 is system32's 5.82 to a program without Common Controls 6
in its manifest and version 6 to one with it, as on Windows: the same controls, two modules
(`commonControlsFaces` in [`comctl32/functions.js`](../../modules/core/src/layers/win32/comctl32/functions.js)).
The loader binds the second where the activation context puts the name in the engine's assembly
(`faceFor` in [`app.js`](../../modules/core/src/app.js)), for an import, `LoadLibrary` and
`GetModuleHandle` alike, and user32 makes a window by the class name the context redirects:
version 6's Button, reported as `Button` (`roadmap/decisions.md` A257).

| Where | What lives there |
| --- | --- |
| Engine thread (a process's own thread with `concurrency` above 1) | The function tables, image building, the bridge and the handlers |
| Program memory | The DLL images; the stub table from `0x100000` (16,384 slots of 16 bytes); COM objects and their method tables |

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 46, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart TB
  subgraph E1["Engine thread · when a process starts"]
    TBL["Function tables in JS<br/>win32/dll/*.js: name → argBytes, handler"]
    SYN["Image synthesis<br/>loader/internal/synth.js"]
  end
  subgraph IMG["A system DLL in program memory, a real PE32"]
    H1["MZ and PE headers"]
    H2["Export table: names, ordinals, addresses"]
    H3["A 16-byte slot per function: mov edi, edi, JMP to the stub, int3"]
    H4[".data, msvcrt's: _iob, __pioinfo, _environ"]
    H5["Functions written as x86 machine code"]
  end
  subgraph STB["Stub table, 0x100000"]
    TH["mov dx, 0xB077 · mov eax, id<br/>out dx, eax · ret N"]
  end
  BR["Bridge → JS handler"]
  IAT["The program's IAT, GetProcAddress"]
  TBL --> SYN --> H1
  H1 ~~~ H2 ~~~ H3 ~~~ H4 ~~~ H5
  IAT -->|"addresses from the exports"| H2
  H3 --> TH --> BR
```

A stub is 16 bytes, one per function:

```
66 BA 77 B0      mov dx, 0xB077     ; the trap port
B8 xx xx xx xx   mov eax, id        ; the function's number in the bridge
EF               out dx, eax        ; cork calls the bridge
C2 nn nn         ret N              ; C3 for cdecl
CC ...           int3 up to 16 bytes
```

ntdll's system calls (`Nt*`, `Zw*`) are not slots: each export is its stub's own bytes. On Windows
a system call is a few position-independent instructions, and a program may copy one elsewhere and
call the copy; a slot's relative JMP, copied, lands nowhere, while a stub carries its id and runs
wherever it is (`trapExport` in [`process/system-modules.js`](../../modules/core/src/process/system-modules.js), `stubAt` in `cpu/internal/thunks.js`).

How many bytes `ret N` takes off, the bridge decides from the calling convention: stdcall takes all
of `argBytes`, cdecl none, and thiscall and fastcall leave out the arguments passed in registers.

A handler is written once, in the 32-bit layout, and a 64-bit program's call is read back into it.
There every argument is one slot (RCX, RDX, R8, R9, then the stack), so an argument wider than a
dword says so in its table entry, by the dword it starts at: `quadwords` for an eight-byte integer or
a POINT by value (two dwords here, one slot there), `floats` for a float or a double (an XMM
register among the first four), `structs` for a structure wider than eight bytes by value, a GUID or
a VARIANT (a pointer to the caller's copy there). `IStream::Seek` is
`{ name: 'Seek', argBytes: 20, quadwords: [1] }`, counting `this` as 0. `npm run check:boundaries`
runs `tools/checks/check-wide-arguments.mjs`, which holds each entry to the signature comment
above it.

A dword argument reaches the handler as its slot's low half; an address reaches it whole. The
dwords that carry one are the function's `addresses` (`CreateThread` is `{ argBytes: 24,
addresses: [2, 3] }`), which the bridge joins to their high half when a 64-bit program keeps the
address past 4 GiB. A spec that does not declare them gets them from its signature comment:
`common/pointer-arguments.js`, written by `tools/checks/check-pointer-arguments.mjs` from every
comment the layers carry, is declared on each function when the layer is built
(`declareAddresses`), a C++ member's `this` among them. So a handler keeps an address with
`wholeAddress`, never `>>> 0`, and memory takes it whole. An answer typed an address is written
into RAX whole as well, past 4 GiB too. The same check holds each declared dword to an address
of the signature. An undeclared argument whose high half names an address past 4 GiB is watched
while its handler runs: a high half the handler never read (`pointerArg` reads it) is a loss,
said once a function - its bytes would be read or written 4 GiB below.

A handler reads and writes guest memory through one view, `host.guest`
([`common/guest.js`](../../modules/core/src/layers/win32/common/guest.js)), which the win32 layer
builds once per process over the memory layer's accessors and hands to each library, and to the
sound and input layers through its api: `u8`, `u16`, `u32`, `i32`, `u64`, `f32`, `f64` and `ptr`
read a value where it lies, `set8` to `setPtr` and `set32s` write one, `cstr` and `wstr` read a
string to its terminator or to a limit in bytes (cut there, a fault only where memory ends),
`writeAnsi` and `writeWide` write one cut to its room, `guid` and `setGuid` a GUID in its
canonical form, and `bytes` is the one read that copies, into a buffer it is given or into one it
makes. `ptr` and `setPtr` are as wide as the process's pointers. A library makes no accessor of
its own and copies no read again: `tools/checks/check-guest-access.mjs` (`npm run
check:boundaries`) fails a new one, and lists in its baseline the ones the layer still has, which
only shrinks.

## One call, from the program to JS and back

```mermaid
%%{init: {"theme": "base", "sequence": {"mirrorActors": false, "messageMargin": 24, "noteMargin": 8}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "actorBkg": "#FFFFFF", "actorBorder": "#2F3A40", "actorTextColor": "#1B2328", "actorLineColor": "#9AA6AC", "signalColor": "#5C6970", "signalTextColor": "#1B2328", "noteBkgColor": "#F3F5F6", "noteBorderColor": "#9AA6AC", "noteTextColor": "#1B2328", "labelBoxBkgColor": "#F3F5F6", "labelBoxBorderColor": "#9AA6AC", "labelTextColor": "#1B2328", "loopTextColor": "#1B2328"}}}%%
sequenceDiagram
  participant X as Program code
  participant K as kernel32 in memory
  participant Z as Stub
  participant C as cork
  participant B as Bridge
  participant H as JS handler
  X->>K: call [IAT]: ReadFile, 5 arguments
  K->>Z: JMP rel32
  Z->>C: out dx, eax
  C->>B: bridge call from the region, registers in the state block
  B->>H: ECX and EDX by convention, arguments from the stack
  alt the answer is ready
    H-->>B: result
    B-->>Z: EAX = result
    Z-->>X: ret 20
  else waiting for a file block, an event, the GPU
    H-->>B: Promise
    Note over B: the program thread parks in the scheduler,<br/>the other threads carry on
    B-->>X: when ready, the thread resumes at the return address, EAX = result
  end
```

- **COM objects** (Direct3D, DirectSound, DirectInput) live in the program's memory too. The
  object's first word points at its method table, and each method there is a stub like any
  other, except those that run in the guest: IUnknown's `AddRef` and `Release` for an object
  whose count lives in guest memory, and the Direct3D 8 and 9 methods a program calls most
  (section 7). A count's crossings of zero are the host's, but for an object whose first
  reference is one on its owner (a device's back buffer, depth surface, swap chain): the
  guest moves the owner's count with it, unless that is the owner's last reference. Methods are stdcall, with the interface pointer as the first argument on the
  stack. An object whose documented layout goes on past that first word (Media Foundation's
  `MFASYNCRESULT`, whose status and callback a program reads and writes itself) is given the
  bytes it needs after it, zeroed, and keeps its fields there.
  A library whose objects count their own references (Direct3D, DirectDraw, DirectSound,
  DirectInput) hands them to the bridge through one adapter,
  [`bridge/com-seam.js`](../../modules/core/src/layers/bridge/com-seam.js): one identity per
  object, one method table per interface description, QueryInterface's answer and the way
  back from a pointer to its object are written there once, and the library gives only how its
  objects count.
  A class that may be aggregated (DirectShow's filters and clocks) is made inside the program's
  controlling unknown when CoCreateInstance is given one: the program gets the object's own
  IUnknown, which counts the object alone, and every other interface it hands out answers
  QueryInterface, AddRef and Release through the controlling unknown, as COM's aggregation
  rules have it. Any other class answers CLASS_E_NOAGGREGATION.
  quartz's own filters (File Source, the WAVE Parser, the AVI Splitter, the AVI Decompressor
  over msvfw32, the ACM Wrapper over msacm32, the Color Space Converter, the renderers) are one base, `quartz/filter.js`: pins, media type
  negotiation, allocators. Each is registered as DllRegisterServer registers it, its moniker's
  property bag answering the FilterData a program reads (`devenum.js`); the devices devenum
  lists itself (the audio renderers, each installed video compressor) are `@device:cm:` monikers
  whose bags answer what their keys hold (`registrations.js`). A filter pushes its
  samples downstream from the graph's streaming thread - the same guest thread that feeds a
  renderer the program wrote - so a call into a peer never runs on the thread that started it.
- **Callbacks:** a window procedure, a COM callback, `DllMain`. The bridge stops the thread, builds a
  frame on the program's stack and runs the program's code until it returns into a sentinel trap.
  Where Windows calls the program inside an `__except` of its own (`DllMain` in the loader, a COM
  method a stub runs for another process, a `TIMERPROC` in `DispatchMessage`), the host puts a
  frame of its own on the chain just above the callback (`kernel32/dllentry.js`): an exception the
  routine leaves unwinds to it and ends the call with a fixed answer instead of reaching the
  caller's handlers. A host call that calls the program back many times in a row (a D3DX effect's pass setting each
  state through the program's own state manager) is written as steps (`bridge.drive`): a generator
  that yields each guest call. The bridge sends the thread into each routine in the slice the call
  came in and takes its answer at the sentinel there, with no park and no turn of the run loop
  between them. Through promises every guest call of a pass was a turn of the run loop of its own,
  and a frame of effect passes spent more time in turns than in the program. The steps are on by
  default (`driveGuestCalls`); off, the same calls run through promises, and
  `effect-steps.itest.js` holds the two to the same results. The bridge's `driveMs` and
  `driveCallMs` split the steps' time between the steps and the guest.
- **Some code runs in program memory directly.** Some exports and methods are x86 machine code
  the program runs itself, with no trap, at cork's speed; only what they cannot handle goes to the
  bridge. Some are written as x86: msvcrt's and kernel32's functions a program calls most, among
  them the interlocked calls, critical sections, slim reader/writer locks, one-time
  initialisation, SLists, the heap's small blocks (up to 1 KiB), and events and mutexes nobody
  waits on. An event has a word of its own in program memory: SetEvent and ResetEvent change it
  and WaitForSingleObject takes a signalled one with `lock cmpxchg`, and a poll of one that is not
  signalled times out there, so a thread on another executor handing work to another, or polling
  for it, does not wait for the process's executor to answer. The host takes the word over (one
  flag) while a thread is queued on the event, since only the host wakes a waiter. A mutex nobody
  else wants is taken and given back in the guest the same way, on a word of the mutex's own,
  which the host takes over as soon as anyone waits, the mutex is abandoned or the host otherwise
  touches it. Sleep(0) answers in the guest while no thread waits to run, read from a count the scheduler
  keeps. Others are written once in JavaScript, marked `@guestCode`, and compiled to i386 by the
  build ([`core/scripts/guest-code/`](../../modules/core/scripts/guest-code/)): the compiled bytes sit beside the source as `*.x86.js`. The
  JavaScript stays the host's handler and the reference a test holds the x86 to, and
  `return host()` hands a rare case to that handler. For a 64-bit process the same source is
  compiled to x86-64 too (`*.x64.js`): a parameter declared a pointer (`ptr`) is carried whole
  there, past 4 GiB as well, and the handler answers a 64-bit caller's RAX as the code does, by
  the type the source declares. D3DX's vector, matrix and quaternion math and
  its effect setters, msvcrt's string, float and math functions and GLU are written so.
- **When a function is missing.** Each name has a stub of its own. If it is known how many bytes of
  arguments to take off (an `@N` decoration, a C++ name, a cdecl library, or a library the program
  brought), it simply returns 0. Otherwise the program stops with `unimplemented import`, and the
  error names the function needed and its caller.

## Which DLL the program gets

```mermaid
%%{init: {"theme": "base", "flowchart": {"curve": "step", "nodeSpacing": 30, "rankSpacing": 40, "padding": 10}, "themeVariables": {"fontFamily": "Inter, Segoe UI, Helvetica, Arial, sans-serif", "fontSize": "13px", "primaryColor": "#FFFFFF", "primaryBorderColor": "#2F3A40", "primaryTextColor": "#1B2328", "lineColor": "#5C6970", "clusterBkg": "#F3F5F6", "clusterBorder": "#9AA6AC", "edgeLabelBackground": "#FFFFFF"}}}%%
flowchart TD
  A["The program needs a DLL: an import or LoadLibrary"] --> B{"A KnownDLL, or a library<br/>an engine layer replaces?"}
  B -->|"yes"| OUR["Ours: a synthesised image"]
  B -->|"no"| C{"File found?<br/>.exe folder → system32 → C:\WINDOWS<br/>(only for a name with no table) → current folder"}
  C -->|"yes"| REAL["The real DLL: relocations, dependencies,<br/>imports, DllMain. cork runs its code"]
  C -->|"no"| D{"Does the engine<br/>have a table for it?"}
  D -->|"yes"| OUR
  D -->|"no"| X["Not loaded:<br/>LoadLibrary returns 0"]
```

- **Always ours:** the KnownDLLs (`kernel32`, `user32`, `msvcrt`, `ole32` and others), the
  runtimes the engine stands in for whoever's copy it is (`DSETUP.dll`, `MSVCR80.dll`,
  `Mp3dec.asi` for sound and `ijl15.dll` for media), and the C runtime's API sets
  (`api-ms-win-crt-*`), which are `ucrtbase.dll` under the names they are imported by.
- **Ours when the bottle has no copy:** the other runtimes the engine has a table for - Visual
  C++ 2008's `MSVCR90.dll` and `MSVCP90.dll`, 2003's `MSVCR71.dll` and `MSVCP71.dll` - and the
  libraries Windows ships that a setup never installs, among them `OLEDLG.dll`, which every MFC
  program imports: its dialogs are not shown and answer Cancel, each said as a loss; and Visual
  C++ 6's `MSVCP60.dll`, whose `std::string` and `std::wstring` keep that compiler's layout and
  share their text by count, as its headers inline; a position past the end or a string too long
  throws out_of_range or length_error into the program, as the library does. Its iostreams
  (stringstreams, fstreams over the C runtime's FILE, `cin`/`cout`/`cerr`/`clog` laid out
  whole as static objects) are in that compiler's layout too, a stream reaching its virtual
  `basic_ios` through its vbtable; a locale says the decimal point Windows' locale data gives.
  A stream buffer or manipulator of the program's own class, whose virtual functions are its
  code, is not run from the library: the call reads as end of stream, said once as a loss.
- **The C runtimes share msvcrt's functions** and differ where Windows' do: an argument a function
  of `MSVCR80.dll` or `ucrtbase.dll` refuses calls that runtime's invalid-parameter handler, or
  with none set ends the process with 0xC0000417 and an error naming the call; msvcrt.dll answers
  EINVAL alone (decisions.md A255, `msvcrt/invalid-parameter.js`).
- **Where `LoadLibrary` looks:** the `.exe` folder, then `C:\WINDOWS\system32\`, `C:\WINDOWS\` and
  the current folder. A relative name with a folder in it (`plugins\x.dll`) is looked for under
  each of those in turn; a full path, one from a drive's current folder (`C:x.dll`) or one that
  starts with `.\` or `..\` names one file. `LoadLibraryEx`'s `LOAD_LIBRARY_SEARCH_*` flags (or
  the default `SetDefaultDllDirectories` set) replace the whole search with their folders - the
  library's own for its imports, the `.exe` folder, those `AddDllDirectory` named (the last added
  first) and `SetDllDirectory`'s, `system32` - for the library and its imports alike; the engine's own libraries count as
  `system32`'s. `LdrGetDllPath` answers that list. Static imports are looked up the same way, without the current folder. For
  a name the engine has a table for, the system directories are skipped: a copy an installer put
  there would be a second library of the name in the process beside the engine's.
- **A file that is no image** (no optional header, a `SizeOfImage` of zero, a file alignment
  coarser than its section alignment, a section or relocation past the image's end) fails
  `LoadLibrary` and `NtCreateSection(SEC_IMAGE)` alike with `ERROR_BAD_EXE_FORMAT`
  (`loader/internal/image.js`); `NtCreateSection(SEC_IMAGE)` first tells the other kinds apart as
  Windows does - no MZ, an unreadable or unknown new header, a 16-bit NE file, a PE32+ image on a
  32-bit Windows (`kernel32/mapping.js` `imageRefusal`) - and answers `SectionImageInformation`
  from the headers. An image is mapped in whole pages, one aligned below a page flat
  (the file as it lies), and an optional header cut short has no data directory past its end.
  A library with no relocation directory goes to its own base; where that is taken it is
  refused if its relocations are marked stripped (`IMAGE_FILE_RELOCS_STRIPPED`), and otherwise
  moved as it lies, nothing fixed up, as Windows' loader moves one (`app.js` `placeLibrary`).
  Once mapped and bound, an image's copy-on-write pages are watched by the engine's page marks:
  the first write to one makes it the process's own, `PAGE_READWRITE`, as `VirtualQuery` then
  answers on Windows (`win32.imageMapped`, decisions.md A248; 32-bit).
  A `DllMain` (or TLS callback) that raises on `DLL_PROCESS_ATTACH` is ended by the loader's
  own frame, and one that answers FALSE is told `DLL_PROCESS_DETACH`: either way the library is
  unloaded and `LoadLibrary` fails with `ERROR_DLL_INIT_FAILED`. A library file is read sharing
  reading and deletion, as Windows' loader opens it: one held open for writing fails the load with
  `ERROR_SHARING_VIOLATION`. A name's trailing spaces are dropped (`"kernel32   "` is kernel32).
  `LdrLoadDll` with a search path ends at the first file it finds: a file no image section takes
  answers that section's refusal, a failed `DllMain` `STATUS_DLL_INIT_FAILED`. A load as data
  (`LOAD_LIBRARY_AS_DATAFILE`) is of a file: a path not there is `ERROR_FILE_NOT_FOUND` even when
  a module of its name is loaded (one of the engine's answers its path in `system32`), an empty
  file `ERROR_FILE_INVALID`, any other that is no image `ERROR_BAD_EXE_FORMAT`. One made
  `LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE` holds the file open against writers until its last
  `FreeLibrary`. `LdrRegisterDllNotification`'s callbacks hear of every library read off the
  volume after it is mapped and before its `DllMain`, and on unload after it.
- **`GetProcAddress(NULL, ...)`** looks in the program's own image; what it does not export is
  `ERROR_PROC_NOT_FOUND`.
- **An export forwarder** (`"LIB.Name"`, `"LIB.#7"`) is followed to the library it names by one
  resolver (`exportOf` in `app.js`) for `GetProcAddress`, `LdrGetProcedureAddress` and the import
  tables. `GetProcAddress` loads a target not yet loaded, the caller waiting; an import through a
  forwarder has its target planned before the library at the start (`planDependencies`) and loaded
  before a run-time library is bound. The forwarding library then holds its target, a reference
  given back when it is unloaded, so a `FreeLibrary` of the target by name leaves it loaded while
  the forwarder stands. A missing target is `ERROR_MOD_NOT_FOUND`, a name it lacks
  `ERROR_PROC_NOT_FOUND`; past 32 forwarders, or back to itself, `ERROR_BAD_EXE_FORMAT`.
- **A DLL already loaded** is handed back with its count raised. A bare name finds the first module
  of that name; a path finds only the module read from that file, so a second file of a loaded
  module's name is a module of its own (the .NET Framework loads a mixed assembly's native image
  so while the assembly is loaded).
- **A real DLL** is parsed and relocated by the loader, its dependencies are loaded first (one
  loaded at run time holds the libraries its import table names, and gives them back when it is
  unloaded, as Windows counts a dependency; the program's own imports stay for the run), its
  imports (delayed ones included) are bound, and its `DllMain` is called through the bridge as
  program code. Every image's TLS is supported, a library's loaded at run time too: a slot, a
  copy of its block in every thread (those already running when it is loaded included), and TLS
  callbacks for every reason its `DllMain` hears, before it. `FreeLibrary` gives the slot and the
  copies back. A module keeps no copy of its file for its resources or its TLS directory: both are
  read where it lies in guest memory, as Windows reads them, and a DLL's file and mapped image are
  let go once it is bound.
- **DirectX's redistributables** (`d3dx9_*` and the rest) are not part of the engine: a game brings
  them, through its installer's DirectX setup, which puts them in `C:\WINDOWS\system32\`, or as DLLs
  beside its `.exe`. A copy beside the `.exe` is loaded as the real DLL; for every other the
  engine's table answers `d3dx9_*`, `d3dx10_*` and `d3dx11_42`/`_43`, the copy in `system32`
  included. D3DX 10 and 11 are one library over two devices: the image loaders make their
  textures through the device's own creates, the compiles go to `D3DCompile`.
- **Where an engine library stands as a file:** in the system folder, as a file a setup or a
  program can find, read and replace (`withSystemLibraries`). The programs the engine runs in
  place of the system's (`msiexec`, `rundll32`, `regsvr32`, `reg`, `regedit`, `notepad`, `winver`)
  stand the same way
  where Windows keeps them: a setup checks that the Windows Installer service's `msiexec.exe` is
  there before it installs anything. On a 64-bit machine the system folder's are 64-bit and
  SysWOW64's 32-bit, and the engine's libraries stand in SysWOW64 too.
- **WOW64's file system redirection** (`wow64-files.js`): a 32-bit process on a 64-bit machine
  that names `%windir%\System32` reaches `SysWOW64`, except System32's folders both widths share
  (catroot, catroot2, driverstore, drivers\etc, logfiles, spool), and names the 64-bit folder as
  `Sysnative`. It is the process's view of the volume (the filesystem layer's `redirect`), so
  every path it names goes through it - an open, a search, a library's load, a child's image.
  Wow64DisableWow64FsRedirection and its siblings turn it off and back on for the calling
  thread. The volume as the system reaches it - the machine's own folders, what the embedder
  reads and writes, and the Windows Installer's files, a 64-bit service's - goes through no view
  (`unredirected`).
- **WOW64's registry redirection** (`wow64-registry.js`): on a 64-bit machine each process reaches
  the run's registry through its width's view. A 32-bit one's HKLM\SOFTWARE is under
  `Wow6432Node`, but for the keys both widths share (Windows 7's list), and in the classes only
  CLSID, DirectShow, Interface, Media Type and MediaFoundation have a 32-bit view, under
  `Classes\Wow6432Node`. KEY_WOW64_32KEY and KEY_WOW64_64KEY name a view per call, and a key keeps
  the view it was reached through for the keys opened under it. Every layer of the process gets
  the view, so COM's lookups and the rest read what the process's own calls would. A 64-bit
  machine's own keys are in both views, as its setup writes them (`bothViews`). The Windows
  Installer writes each component's keys where its width's view has them (`registryPath`), as
  the 64-bit service does, and describes the 64-bit machine (`VersionNT64`, `Msix64`,
  `System64Folder`, `ProgramFiles64Folder`; `SystemFolder` is SysWOW64 there).
- **Program Files (x86)**: on a 64-bit machine a 32-bit process's program folders are
  `Program Files (x86)` - SHGetFolderPath's, the `ProgramFiles` variable's, the Windows
  Installer's `ProgramFilesFolder` and the `ProgramFilesDir` its registry view reads - and both
  widths' are named (`ProgramFiles(x86)`, `ProgramW6432`, CSIDL_PROGRAM_FILESX86,
  `ProgramFilesDir (x86)`), as `shellFolders` lays them out for the process's width.
- **A custom action library of the other width** - a 64-bit one in a 32-bit installation, as the
  .NET Framework's x64 package has - runs as Windows Installer runs it: in a custom action server,
  `msiexec.exe -Embedding` of the library's width, which loads it and calls its entry while the
  session stays in the installation (`msi/remote.js`). The two talk through the server's standard
  input and output, in values: properties, modes, messages, and the views the installation keeps
  open on its database for the server. A process in a worker of its own has no pipes its
  children inherit yet, so the server runs only for an installation on the run's thread.
- **The Windows Imaging Component** (`windowscodecs.dll`) is the engine's too, its factory a COM
  class as on Windows: its decoders reuse the D3DX and media layers' readers, and a bitmap's
  pixels live in guest memory, since its lock hands the program a pointer into them. The
  `<Interface>_<Method>_Proxy` exports .NET calls go straight to the object's method when the
  object is the engine's and through its vtable when the program wrote it.

- **DirectWrite** (`DWrite.dll`) is a table of the engine's over the same faces gdi32 draws:
  the system collection's files are TrueType tables written from the font engine's measurements,
  a program's own files and loaders are read through their streams, and a glyph run is drawn
  from the browser's glyphs as GDI's text is. A bitmap render target is a gdi32 memory context
  with a DIB section ([`core/src/layers/win32/dwrite/`](../../modules/core/src/layers/win32/dwrite/)).

Where to look in the code: [`core/src/layers/loader/internal/synth.js`](../../modules/core/src/layers/loader/internal/synth.js) (the image),
[`core/src/layers/cpu/internal/thunks.js`](../../modules/core/src/layers/cpu/internal/thunks.js) (the stubs), [`core/src/layers/bridge/`](../../modules/core/src/layers/bridge/) (the bridge), the
tables in `core/src/layers/win32/<dll>/`, the search order in [`core/src/app.js`](../../modules/core/src/app.js)
(`libraryCandidates`, `answeredByEngine`).
