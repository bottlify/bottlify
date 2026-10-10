# Limits

What is not there, and where the engine answers differently from Windows. A call that answers
differently raises a `divergence` event naming the API.

## Programs

- Only 32-bit x86 programs: a PE32 image for i386. A 16-bit (NE) or 64-bit image is refused when
  it is loaded.
- Only user mode. There is no kernel underneath; the engine's layers answer every system call.
- Reading or writing through a null pointer does not fault: memory from address 0 is readable and
  writable. Running code below `0x10000` does fault, as an access violation.
- An import nothing implements returns 0 when its argument size is known (a decorated name, a cdecl
  library, a library the program brought). Otherwise the program stops with `unimplemented import`
  and the function's name.

## Processes

- A child started with `CreateProcess` runs while its parent waits; the parent resumes when the
  child ends. With `concurrency` 2 or 4 every process runs in a worker of its own, the program the
  page started too, and a child starts at `CreateProcess` and runs beside its parent; one past
  that many at once runs beside its parent taking turns with it in its parent's worker.
- With `concurrency` 2 or 4 a process's own journal -- its calls, its phase profile, its frames --
  stays in its worker: the run's log holds the events every process reports and what the engine's
  thread writes. A process in a worker takes its translations from the run's one store, which
  the engine's thread keeps open, and puts what it makes there; a batch's lookups cross the link
  together, one wait for the batch. It places no hooks (`hooks`, `watchImport`), and reaches no
  network transport the page handed in (`win32.network`).
  The run's diagnostics are the program's tables as it last answered, with the journal and the
  sound output the engine's thread keeps.
- The run's translation workers are a pool (`cork.pool`): each process is lent one, and more only
  while its translation lags and a trial shows they make it go faster. On a machine whose cores a
  loading game already keeps busy -- four cores, measured -- a second worker makes loading slower,
  and the pool gives it back after its trial; the gain is for machines with cores to spare, and
  has not been measured on one yet. Only translation runs in the pool so far: bundle blocks are
  still decoded on the thread that mounted the bundle.
- With `concurrency` 1 the process of an out-of-process COM server runs alongside the program that
  uses it, outside `concurrency`, beside it on the engine thread. With 2 or 4 the class table is
  the run's, kept on the engine thread: a server COM starts runs in a worker of its own while the
  run has room for one, and beside the process that asked, in its worker, otherwise; a call from
  one worker to another goes through the engine thread and back.
- A child in a worker of its own shares the run's registry, files, window
  directory -- its windows found, read, posted and sent to by every other process, and theirs by
  it -- ids, the run's bundle (a block it misses is fetched for it), named events, semaphores
  and mutexes, and the position of a file its parent handed it as its output; a named file
  mapping or waitable timer is its own. A set of objects one of which another process across a
  worker named is answered when polled -- with a zero timeout, or by a message wait
  (`MsgWaitForMultipleObjects`, COM's `CoWaitForMultipleHandles`), which polls -- and a wait
  that would block on such a set is refused. Its Direct3D 8 and 9 devices draw on the run's
  graphics worker and what they present is shown as the run's frames; its sound goes onto the
  run's track table in a span its parent lends it, where that table is shared memory (none
  otherwise); the page's input reaches it where its windows are under the pointer or in the
  foreground. Its DirectDraw primary and the desktop
  its windows are drawn on are sent to the engine as bytes and shown there. Its COM classes are the
  run's: it serves them to every other process and calls theirs. So is the running object table:
  an object one process registers (`RegisterActiveObject`, `IRunningObjectTable::Register`) is
  found from every other by class (`GetActiveObject`), by moniker and by display name
  (`MkParseDisplayName`, `CoGetObject`), and goes when its process does. The error information
  a server sets on a failed call is the caller's to read.
- Windows are the run's: a process finds another's window (`FindWindow`), reads who made it, its
  caption and class, and posts to it. A message sent to another process's window is answered in the
  with `concurrency`; its pointers cross only for `WM_COPYDATA`, `WM_SETTEXT` and `WM_GETTEXT`. Where
  a parent waits while its child runs, a message the child sends to the parent's window is refused
  at once, as one that timed out.

## Graphics

- A picture needs WebGPU. A canvas that gives no WebGPU context fails the start (`reason: 'gpu'`).
- While windows of more than one process are showing, the screen is composed of each process's
  newest picture by the run's top-level windows, the topmost last; the canvas takes the size of the
  foreground window's process's picture. A process's picture is what it presented last, whole:
  a windowed Direct3D device's back buffer is placed at the screen's corner rather than in its
  window, and a process that has presented nothing has its windows show what is under them.
- No Direct3D 11 or 12.
- Direct3D 10 and Vulkan draw on the engine thread; Direct3D 7, 8, 9 and OpenGL in the graphics
  worker.
- A lost GPU device is not recovered: `Present` and `Reset` answer `D3DERR_DEVICELOST`
  (`D3DERR_DEVICEREMOVED` on 9Ex) and no new frames arrive.
- DXT textures are decoded on the CPU unless `graphics.compressedTextures` is on and the GPU has
  `texture-compression-bc`.
- Shaders and pipelines are cached in memory only; every run builds them again.
- Direct3D 9 claims vertex and pixel shader model 3.0. Not offered: user clip planes
  (`MaxUserClipPlanes` is 0), the border and mirror-once address modes, a mip level-of-detail
  bias (`D3DTSS_MIPMAPLODBIAS` is read but not applied), the per-stage constant and temporary
  register of the texture stages; a draw from a stream whose offset, past its whole vertices,
  is not a multiple of four bytes is refused (WebGPU binds a vertex buffer only there).
- Direct3D 9's 32-bit float formats are kept as half floats, and A16B16G16R16/G16R16 as half
  floats of their value.
- The engine's own `d3dx9` reads BMP, DDS, TGA, PNG and JPEG images; `D3DXCreateTeapot`,
  `D3DXCreateTextA`, `D3DXSimplifyMesh`, `D3DXUVAtlasPartition` and `D3DXComputeNormalMap` answer
  `E_NOTIMPL`.
- No DirectX redistributables ship with the engine: a program brings `d3dx9_*`, XAudio2 and the rest
  itself (its installer's DirectX setup, or the DLLs beside its exe); without them the engine's own
  `d3dx9` table answers.
- `maxFps` is accepted but not applied: the presenter is given no scheduler, so frames reach the
  canvas as fast as the program presents them.

## Sound

- Without `SharedArrayBuffer` (the `compatible` mode) sound is mixed on the engine's thread and
  posted to the worklet. A DirectSound buffer is then read out on the guest's clock rather than
  by the device, and what piles up while the device runs short stays queued: the sound can lag
  the picture by up to the ring's depth, a third of a second.
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
  and keeps each installed package's copy in `C:\WINDOWS\Installer` with its embedded cabinets
  left out. It reports Windows Installer 4.5 on XP and exports what 4.5 and 5.0 added, but
  `MsiGetPatchFileList`; a transaction's rollback keeps what was installed in it.
- A package's own dialogs are never drawn: an installation runs without the internal user
  interface, as a setup that drives its own does. `MsiCollectUserInfo` and the dialog previews
  show nothing.
- JScript and VBScript custom actions run in the engine's own script engines, with the
  installer's Session, Installer, Database, View and Record objects; a script asking
  `ActiveXObject` or `CreateObject` for any other class is told it cannot be made. VBScript's
  `MsgBox` shows the installation's message box; `InputBox` fails with error 70.
- The script engines are also COM classes (`JScript`, `VBScript`) for a program that hosts
  Active Scripting itself. VBScript does not import a type library's constants
  (`AddTypeLib`), keeps English formats whatever `SetLocale` asks, has no `Escape`,
  `Unescape` or encoded scripts, and names a program's own objects `Object` in `TypeName`.
  Deep recursion fails sooner than on Windows, at a few hundred levels.
- A patch's deltas are applied (the Patch API, `mspatcha.dll`), except a delta made against a
  32-bit executable with the executable transforms -- that layout is not public -- or against an
  old file only Windows' PE normalisation would match; such a patch fails with
  `ERROR_PATCH_DECODE_FAILURE`.
- No service runs: a service a package installs is registered with the service manager and
  stays stopped. ODBC drivers and data sources, COM+ applications and side-by-side or global
  assembly cache assemblies are not installed.
- An advertise script cannot be written or read (`MsiAdvertiseScript`,
  `MsiProcessAdvertiseScript`, `MsiGetProductInfoFromScript`, `MsiAdvertiseProduct` to a file).
- `msiexec.exe`, `rundll32.exe` and `regsvr32.exe` in `C:\WINDOWS\system32` are the engine's
  own: a program that starts one gets a process that drives `msi.dll`, the named library's entry
  point or its registration exports, and exits with what Windows' program would. The volume shows
  no file at those paths, so a setup that checks for one before starting it does not find it.
- `notepad.exe` (in `C:\WINDOWS` and `C:\WINDOWS\system32`) is the engine's too: it shows a
  text file read-only and exits when its window is closed; it does not edit, save or print.
  ShellExecute opens `.txt`, `.log`, `.ini`, `.inf`, `.nfo` and `.diz` files in it; an address
  (`http`, `https`, `ftp`, `mailto`, a `.url` shortcut) becomes an `open-url` event for the page.
  Other documents have no handler (`SE_ERR_NOASSOC`).
- The libraries the engine implements answer, in `C:\WINDOWS\system32`, an existence check by
  their exact name (GetFileAttributes, FindFirstFile) as files; a wildcard search does not list
  them and they cannot be opened.
- An installation's log (`MsiEnableLog`, `msiexec /l`) has its messages, its actions and, when
  asked, its properties; the verbose trace of the engine's own decisions (`/lv`) is not written.
- Nothing is rolled back: an installation that fails leaves what it had done.

## Network

- No raw TCP or UDP. Sockets go through the relay over WebSocket; without `network` only the
  loopback adapter exists.
- The relay links tabs in one room and reaches outside hosts only from its server's allow list.
- A single TCP `send` over 64 KiB fails: the relay's frames carry at most 64 KiB and are not split.

## Files

- The bundle is read-only. What the program writes goes into the session, kept per `id`.
- A file mapping is a copy: a view reads the file when it is made and writes it back when it is
  closed, so two views of one file do not see each other's writes.
