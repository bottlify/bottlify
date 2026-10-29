# Limits

What is missing, and where the engine answers differently from Windows. A call that answers
differently raises a `divergence` event naming the API.

## Programs

- 32-bit x86 programs: a PE32 image for i386. A 64-bit (PE32+) image runs on one executor, with
  its pages below 4 GiB, as far as console programs on msvcrt or vcruntime140 go, structured and
  C++ exceptions, floating-point arguments and results, and a window program's classes,
  windows, messages, hooks and painting, and Direct3D 9 and OpenGL included, every call into
  them a trap: dialogs, MDI, DirectDraw and the other Direct3D versions are not there yet at
  64 bits (`roadmap/x64.md`). A message's WPARAM and LPARAM keep 32 bits there. A run whose
  first program is 64-bit is on a 64-bit Windows, where a 32-bit child runs under WOW64 without
  the file system's and the registry's redirection.
  A structured exception there passes no `_set_se_translator` translator. A 16-bit (NE) image is
  refused when it is loaded.
- Only user mode. There is no kernel underneath; the engine's layers answer every system call.
- Reading or writing through a null pointer does not fault: memory from address 0 is readable and
  writable. Running code below `0x10000` does fault, as an access violation.
- An import nothing implements returns 0 when its argument size is known (a decorated name, a cdecl
  library, a library the program brought). Otherwise the program stops with `unimplemented import`
  and the function's name.
- The guest's zone is measured, not enforced: a program that holds more than 1 GiB of its RAM marks
  the zones' table `over` and goes on.
- The tab's memory is held to 1.5 GiB in three zones ([configuration.md](configuration.md#memory-zones)).
  Not every pool of the engine's own heaps is measured yet: the zones' table names those that are
  not, and the bytes they hold are counted nowhere.

## Processes

- With several executors (`cpu.cores`), the others see what one thread does in the order the host
  keeps. The locked instructions, `xchg` and the kernel's own objects are atomic and ordered
  everywhere; a plain store is ordered after the stores before it only on a host that keeps that
  order itself (x86 does). On a host that does not (an ARM machine), a program passing a message
  through plain stores alone (a flag after its payload, a spinlock released with `mov`) may see
  the flag before the payload. A page that sets `cork.config.ordered` to `true` turns on cork's
  `ordered` variant, which keeps that order at a cost in speed: counted on arm64, about an eighth
  more machine code on a game's main thread.
- With several executors, a store into bytes another executor is translating at that instant can
  be missed: when the store's page check came before the other set the page's code flag, and the
  store landed after it read the bytes back. The window is a few instructions, longer (at most a
  loop's checked turns) for a loop's stores checked once for several turns. The translation then
  keeps the old bytes. Windows makes no promise either until the thread running the code
  synchronises with the one writing it; here the old translation stays after that too. A store
  made before the code was translated, or after its page was flagged, is always seen. Memory
  another thread frees or protects meanwhile is not faulted by a loop's accesses checked before.
- HeapLock and HeapUnlock check the handle and exclude nothing: other threads' heap calls go on
  meanwhile, each one whole, so a HeapWalk between them can meet a block another thread allocated
  or freed.
- An image's thread-local slot is one of the first 64 that TlsAlloc hands out, the ones the
  thread-local array holds; Windows keeps the images' slots apart from TlsAlloc's. A library
  loaded at run time after the program has taken all 64 is refused (LoadLibrary answers NULL),
  where Windows loads it.
- A thread's environment block, its thread-local array and its copies of the images'
  thread-local blocks come from the arena the heap is carved from, and go back to it once the
  thread has ended and runs on no executor (checked when the next thread is made). With no room
  left there, CreateThread stops the run with an error, where Windows answers
  ERROR_NOT_ENOUGH_MEMORY.
- A program is told it has one processor for each of its executors
  ([`cpu.cores`](configuration.md#cpu)), and a thread's affinity mask keeps it to those executors.
  Not done: a child process does not inherit its parent's narrowed process mask; a process handle
  other than the caller's own reads and sets the caller's mask;
  `NtSetInformationProcess(ProcessAffinityMask)` is accepted and ignored;
  `NtQueryInformationThread`/`NtSetInformationThread` know no affinity; GetActiveProcessorCount,
  GetLogicalProcessorInformationEx and the processor-group calls are not exported.
- The instructions a thread retired (the kernel's `byThread`) are the same on any number of
  executors for the same path through the program, and the cpu's `instructions` are every
  executor's together. A call that blocks retires its stub up to the call into the host; its
  return belongs to the resume and is not counted, so it counts one instruction fewer than the
  same call answered at once. A wait that finds its object already signalled takes a shorter path
  through WaitForSingleObject's guest code than one that blocks, as on Windows, so a thread whose
  waits find their objects in another state on several executors retires a few instructions more
  or fewer.
- With several executors the translation store keeps apart the translations of the process's own
  executor and of the others (the others translate for the layout they share), and those of one
  executor and of several (on several the locked instructions are atomic). Changing `cpu.cores`
  starts cold once, and a thread that ran on the process's own executor in one run and on another
  in the next warms up there again.
- With `concurrency` 1 a child started with `CreateProcess` takes turns with its parent on one
  thread; with 2 or 4 they run at once (`concurrency` in [api.md](api.md)). A parent reaches into
  its child -- its memory (`VirtualAllocEx`, `VirtualFreeEx`, `VirtualProtectEx`,
  `VirtualQueryEx`, `ReadProcessMemory`, `WriteProcessMemory` and ntdll's forms), its first
  thread (`SuspendThread`, `ResumeThread`, `GetThreadContext`), and a thread it makes there with
  `CreateRemoteThread`, which it waits on and reads the exit code of -- either way. A wait on a
  child's thread is answered within a few milliseconds of its end, asked of the child until
  then. `NtQueryInformationProcess` on a child's handle is answered by the child; once it has
  ended, its id, parent and exit status remain and its PEB address does not. Not yet:
  `SetThreadContext` (refused for every thread: one stopped inside a call into the system would
  have the registers put in its place overwritten as the call returns), `OpenThread` of a child's
  thread the parent was not told of, and reading another process's TEB or PEB. A call made in a
  child in a worker of its own takes about 1.4 ms when the child is busy or suspended and about
  15 ms when every thread of the child waits, measured in Node.
- A mutex, event, semaphore or waitable timer opened by name carries the rights it was granted: no
  rights at all, or rights the kind does not have, are refused, and a handle without SYNCHRONIZE
  cannot be waited on, nor one without the modify right set, reset or released. Handles a process
  creates, and every other kind, have every right. Not exported, as on Windows 7: the
  synchronization barrier, `GetProcessInformation` and job objects.
- In `compatible` mode a child's sound is mixed into its parent's output (the engine's mixer has
  no arena to lend it a table on), and goes on after a parent that exits first.
- With `concurrency` 2 or 4 a process's own journal (its calls, phase profile and frames) stays in
  its worker: the run's log holds the events every process reports and what the engine's thread
  writes. A process in a worker takes its translations from the run's one store, which the
  engine's thread keeps open, and puts what it makes there; a batch's lookups cross the link
  together, one wait per batch. It places no hooks (`hooks`, `watchImport`) and reaches no network
  transport the page handed in (`win32.network`). The run's diagnostics are the program's tables as
  it last answered (its `log` with phases and frames, and `audio`, as with one process), with the
  engine thread's own journal and sound output beside them as `system-log` and `system-audio`.
- The run's translation workers are a pool ([`cork.pool`](configuration.md#cpu)). On a machine
  whose cores a loading game already keeps busy (four cores, measured), a second worker makes
  loading slower, and the pool gives it back after its trial; the gain is for machines with cores
  to spare and has not been measured on one yet. Only translation runs in the pool so far: bundle
  blocks are still decoded on the thread that mounted the bundle.
- With `concurrency` 1 the process of an out-of-process COM server runs beside the program that
  uses it, on the engine thread, not counted in `concurrency`. With 2 or 4 the class table is the
  run's, kept on the engine thread: a server COM starts runs in a worker of its own while the run
  has room for one, and otherwise beside the process that asked, in its worker; a call from one
  worker to another goes through the engine thread and back.
- Named pipes are the run's, between the processes on the engine's thread: byte and message
  pipes, overlapped reads and connects completed through their event and completion port, and a
  pipe end a child inherits (`bInheritHandles`, or a STARTUPINFOEX handle list) under its parent's
  number. A process in a worker of its own makes and opens none (`CreateNamedPipe` is refused, as
  Windows 9x refuses it). Writes are never held back by a full buffer, `DuplicateHandle` into
  another process duplicates into the caller's own, and `GetOverlappedResult` on a pipe operation
  whose OVERLAPPED has no event waits on nothing.
- A child in a worker of its own shares the run's registry, files, window directory (it finds,
  reads, posts and sends to every other process's windows, and they to its), ids, bundle (a block
  it misses is fetched for it), named events, semaphores and mutexes, and the position of a file
  its parent handed it as its output; a named file mapping or waitable timer is its own. A set of
  objects of which one was named by a process in another worker is answered when polled, with a
  zero timeout or by a message wait (`MsgWaitForMultipleObjects`, COM's
  `CoWaitForMultipleHandles`, which polls); a wait that would block on such a set is refused. Its
  Direct3D 8 and 9 devices draw on the run's graphics worker, and what they present is shown as
  the run's frames. Its sound goes onto the run's track table, in a span its parent lends it,
  where that table is shared memory (none otherwise). The page's input reaches it where its
  windows are under the pointer or in the foreground. Its DirectDraw primary and the desktop its
  windows are drawn on are sent to the engine as bytes and shown there. Its COM classes are the
  run's: it serves them to every other process and calls theirs. So is the running object table:
  an object one process registers (`RegisterActiveObject`, `IRunningObjectTable::Register`) is
  found from every other by class (`GetActiveObject`), by moniker and by display name
  (`MkParseDisplayName`, `CoGetObject`), and goes when its process does. The error information a
  server sets on a failed call is the caller's to read.
- Windows are the run's: a process finds another's window (`FindWindow`), reads who made it, its
  caption and class, and posts to it. A message sent to another process's window is answered with
  every concurrency; its pointers cross only for `WM_COPYDATA`, `WM_SETTEXT` and `WM_GETTEXT`.

## Graphics

- A picture needs WebGPU. A canvas that gives no WebGPU context fails the start (`reason: 'gpu'`).
- While windows of more than one process are showing, the run's top-level windows compose the
  screen from each process's newest picture, the topmost last; the canvas takes the size of the
  foreground window's process's picture. A process's picture is what it presented last, whole: a
  windowed Direct3D device's back buffer is placed at the screen's corner rather than in its
  window, and the windows of a process that has presented nothing show what is under them.
- No Direct3D 11 or 12.
- Direct3D 10 and Vulkan draw on the engine thread; Direct3D 7, 8, 9 and OpenGL in the graphics
  worker.
- OpenGL keeps a texture's data only where it draws, in the graphics worker, and lets a level's
  texels go once the device holds them (a compressed level keeps its blocks). `glGetTexImage`
  reads black, as `glReadPixels` on a device does, and says so as a divergence.
- Direct3D 10 has no geometry shaders: WebGPU has no geometry stage and none is emulated, so
  `CreateGeometryShader` and its stream-output variant answer `E_NOTIMPL` for a valid shader. An
  effect pass that sets one is drawn without it, and the effect says so.
- Direct3D 10 multisamples at four samples only, the count WebGPU has:
  `CheckMultisampleQualityLevels` answers one quality level at four for the colour and depth
  formats WebGPU multisamples, and none at two, eight or any other count. A multisampled texture
  array is refused. A resolve, and the present of a multisampled swap chain, average the four
  samples equally.
- A DXGI swap chain goes fullscreen as a Direct3D 9 device does: the reported display takes its
  mode and its window covers the whole of it. Going windowed again gives the display its mode back
  but leaves the window where fullscreen put it, and `ResizeTarget` on a windowed swap chain does
  not resize the window.
- A lost GPU device is not recovered: `Present` and `Reset` answer `D3DERR_DEVICELOST`
  (`D3DERR_DEVICEREMOVED` on 9Ex) and no new frames arrive.
- DXT textures are decoded on the CPU unless `graphics.compressedTextures` is on and the GPU has
  `texture-compression-bc`.
- Shaders and pipelines are cached in memory only; every run builds them again.
- Direct3D 9 claims vertex and pixel shader model 3.0. A draw from a stream whose offset, past
  its whole vertices, is not a multiple of four bytes is refused (WebGPU binds a vertex buffer
  only at such offsets). What WebGPU lacks, the shader makes up, at a cost only to the draws that
  ask:
  - six user clip planes (Direct3D 8 and 9), clipped by the GPU where the device has WebGPU's
    `clip-distances` and otherwise by a discard in the fragment stage; vertices already in
    screen space are not clipped by them;
  - a mip level-of-detail bias (`D3DSAMP_MIPMAPLODBIAS`, Direct3D 8's `D3DTSS_MIPMAPLODBIAS`),
    held to ±16;
  - the border and mirror-once address modes, over a clamping sampler: the border colour is
    selected where the coordinate lies outside [0, 1], so a filtered read does not blend the
    edge texels into it over the last half texel, and a cube map's faces take neither.
- Direct3D 9's 32-bit float formats are kept as half floats, and A16B16G16R16/G16R16 as half
  floats of their value.
- The engine's own `d3dx9` reads BMP, DDS, TGA, PNG and JPEG images; `D3DXCreateTeapot`,
  `D3DXCreateTextA`, `D3DXSimplifyMesh`, `D3DXUVAtlasPartition` and `D3DXComputeNormalMap` answer
  `E_NOTIMPL`.
- No DirectX redistributables ship with the engine: a program brings `d3dx9_*`, XAudio2 and the
  rest itself (through its installer's DirectX setup, or as DLLs beside its exe); without them the
  engine's own `d3dx9` table answers.
- `maxFps` is accepted but not applied: the presenter is given no scheduler, so frames reach the
  canvas as fast as the program presents them.

## Sound

- Without `SharedArrayBuffer` (the `compatible` mode) sound is mixed on the engine's thread and
  posted to the worklet. A DirectSound buffer is then read out on the guest's clock rather than by
  the device, and what piles up while the device runs short stays queued: the sound can lag the
  picture by up to the ring's depth, a third of a second.
- 64 voices play at once.
- DirectSound 3D keeps every parameter but does not position the sound: a 3D buffer plays as with
  3D processing off.
- No capture: recording answers `DSERR_NODRIVER`.

## Input

- Only keyboard, mouse and gamepads reach the program. The page's focus, visibility and lifecycle
  never do.

## Installer

- The Windows Installer is the engine's own (`msi.dll`, version 3.1 on Windows XP SP3): it
  installs, repairs, changes and removes products, applies transforms and patches, advertises,
  and keeps each installed package's copy in `C:\WINDOWS\Installer` without its embedded
  cabinets. It reports Windows Installer 4.5 on XP and exports what 4.5 and 5.0 added, except
  `MsiGetPatchFileList`; a transaction's rollback keeps what was installed in it.
- A package's own dialogs are never drawn: an installation runs without the internal user
  interface, as a setup that drives its own does. `MsiCollectUserInfo` and the dialog previews
  show nothing.
- JScript and VBScript custom actions run in the engine's own script engines, with the
  installer's Session, Installer, Database, View and Record objects; a script asking
  `ActiveXObject` or `CreateObject` for any other class is told it cannot be made. VBScript's
  `MsgBox` shows the installation's message box; `InputBox` fails with error 70.
- The script engines are also COM classes (`JScript`, `VBScript`) for a program that hosts
  Active Scripting itself. VBScript does not import a type library's constants (`AddTypeLib`),
  keeps English formats whatever `SetLocale` asks, has no `Escape`, `Unescape` or encoded scripts,
  and names a program's own objects `Object` in `TypeName`. Deep recursion fails sooner than on
  Windows, at a few hundred levels.
- A patch's deltas are applied (the Patch API, `mspatcha.dll`), except a delta made against a
  32-bit executable with the executable transforms (that layout is not public) or against an old
  file only Windows' PE normalisation would match; such a patch fails with
  `ERROR_PATCH_DECODE_FAILURE`.
- No service runs: a service a package installs is registered with the service manager and stays
  stopped. ODBC drivers and data sources, COM+ applications and side-by-side or global assembly
  cache assemblies are not installed.
- An advertise script cannot be written or read (`MsiAdvertiseScript`,
  `MsiProcessAdvertiseScript`, `MsiGetProductInfoFromScript`, `MsiAdvertiseProduct` to a file).
- `msiexec.exe`, `rundll32.exe` and `regsvr32.exe` in `C:\WINDOWS\system32` are the engine's own:
  a program that starts one gets a process that drives `msi.dll`, the named library's entry point
  or its registration exports, and exits with what Windows' program would. The volume shows no
  file at those paths, so a setup that checks for one before starting it does not find it.
- `notepad.exe` (in `C:\WINDOWS` and `C:\WINDOWS\system32`) is the engine's too: it shows a text
  file read-only and exits when its window is closed; it does not edit, save or print.
  ShellExecute opens `.txt`, `.log`, `.ini`, `.inf`, `.nfo` and `.diz` files in it; an address
  (`http`, `https`, `ftp`, `mailto`, a `.url` shortcut) becomes an `open-url` event for the page.
  Other documents have no handler (`SE_ERR_NOASSOC`).
- In `C:\WINDOWS\system32` the libraries the engine implements exist as files to a check by their
  exact name (GetFileAttributes, FindFirstFile); a wildcard search does not list them, and they
  cannot be opened.
- An installation's log (`MsiEnableLog`, `msiexec /l`) has its messages, its actions and, when
  asked, its properties; the verbose trace of the engine's own decisions (`/lv`) is not written.
- Nothing is rolled back: an installation that fails leaves what it had done.

## Network

- No raw TCP or UDP. Sockets go through the relay over WebSocket; without `network` only the
  loopback adapter exists.
- The relay links tabs in one room and reaches outside hosts only from its server's allow list.
- A single TCP `send` over 64 KiB fails: the relay's frames carry at most 64 KiB and are not split.
- crypt32 builds a certificate chain from the certificates it was given and the ROOT store
  (`win32.trustedRoots`); it fetches nothing, so a missing intermediate is a partial chain and
  revocation, when asked, is unknown and offline (`CRYPT_E_REVOCATION_OFFLINE` under the SSL
  policy). Only RSA signatures are verified: a certificate signed with an ECDSA key fails as
  not signature valid.

## Files

- The bundle is read-only. What the program writes goes into the session, kept per `id`.
- A file mapping is a copy: a view reads the file when it is made and writes it back when it is
  closed, so two views of one file do not see each other's writes.
