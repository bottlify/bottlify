# Decisions

Behaviour this project chose rather than derived from a specification, plus the handful of
standing rules that came out of measuring a real title rather than reading code. Bottlify is under
no obligation to match any particular reimplementation of Windows: what a program observes is the
contract, and where no published expectation exists, or a different answer serves this engine
better, that is a choice, defended here on its merits, revisited when something argues against
it. A bug is not a decision; a bug goes in the code and gets fixed, and an open one is tracked on
the project's task board.

Each entry is dated to the commit that made the call (or, where a later commit corrected it, both).
Nothing here is rewritten to say something different than what was actually decided; a decision
later reconsidered is recorded as reconsidered.

## A. Win32, COM and the loader

**A1. DirectDraw refuses a 15- or 24-bit display mode.** `SetDisplayMode` answers
`DDERR_INVALIDMODE` for 15 and 24 bpp; there is no conformance expectation either way, and this
layer has no three-byte pixel path to create such a surface with. Revisit if a title is found that
treats the refusal as fatal. *2026-09-07, `94e7f597`.*

**A2. This build announces itself as hardware, with transform and lighting.** `GetCaps` reports a
real 3D hardware device (plus a software rasteriser and a T&L device, in that enumeration order)
because there is a real GPU underneath and programs of this era branch on the claim: an
emulation-only enumeration reads as "no accelerator" and sends them into software rendering or a
refusal. A capability bit claimed here is a promise the renderer has to honour, so this grows only
as the renderer does. *2026-09-07, `94e7f597`.*

**A3. `_allmul`/`_alldiv`/`_allrem`/`_aulldiv`/`_aullrem` pop their own 16 argument bytes
(stdcall), against a published spec that calls them cdecl.** The spec's own C implementation is
declared `WINAPI`, and real compiled call sites emit four pushes with no cleanup after: two
sources against one, so the spec is the one not believed. If this is ever wrong the symptom is a
stack skewed by 16 bytes with nothing pointing at the cause; remove all five rather than adjust
them if it is ever suspected. *2026-09-07, `94e7f597`.*

**A4. `_allshl`/`_allshr`/`_aullshr` are not exported at all**, rather than shipped as a wrong
shift: the trap stub already overwrites the operand before any handler runs, so a shift of "the
stub left behind" is worse than an unresolved import. A save-before-trap variant is the known fix,
worth building the day a program actually imports them. *2026-09-07, `94e7f597`.*

**A5. `SYSTEM_BASIC_INFORMATION`'s timer resolution is a plausible 15.625 ms, not a measured
one**: there is no periodic interrupt here to measure with. Revisit once there is one.
*2026-09-07, `94e7f597`.*

**A6. ANSI→Unicode widening in ntdll ignores the code page** (byte-for-byte, correct only below
0x80). `kernel32/locale.js` already has a real single-byte decoder that isn't threaded through yet.
*2026-09-07, `94e7f597`.*

**A7. Only `SystemBasicInformation` and `ProcessBasicInformation`/`ProcessDebugPort` are
answered**; every other information class is refused with a status rather than filled with
invented numbers. A refusal is a message; a fabricated structure is a wrong answer that propagates.
*2026-09-07, `94e7f597`.*

**A8. There is one user, called "User".** `GetUserNameA` answers a constant because there is one
account and no way to become another; it exists at all because some programs refuse to start
without a name. *2026-09-07, `94e7f597`.*

**A9. The boot ROM installs thirty-two interrupt vectors, not two hundred and fifty-six.** A full
table was tried and reverted: a vector fired during protected-mode entry and landed in a halting
stub, which reads as a hang, worse than a loud refusal. *2026-09-07, `94e7f597`.*

**A10. Direct3D 7's format and capability lists are narrower than the era's hardware, on
purpose.** `EnumTextureFormats`/`EnumZBufferFormats` name only what the renderer implements, and
`d3d7/caps.js` claims only the cull modes, compares, blends, stage ops, filters and address modes
the pipeline actually has: no fog, stencil, lighting, bump mapping, cube maps or W-buffer. A
capability bit is a promise; claiming one the renderer can't honour sends a program down a fast
path to a wrong picture instead of a slow path to a right one. Grows only when the renderer grows.
*2026-09-07, `765d7866`.*

**A11. Direct3D 8 refuses shaders, cube maps, volume textures, palettes, extra swap chains, the
hardware cursor, `GetFrontBuffer` and `ProcessVertices`, rather than pretending to support them**:
the same A10 rule. The sharpest case is shaders: the renderer skips any draw with one bound, so
accepting `CreateVertexShader` would put a program on a path where every draw silently vanishes.
Multisampling is accepted and silently dropped everywhere (aesthetic, not structural); the gamma
ramp and clip planes are stored state with no effect and report zero capability so a checking
program is told the truth. `GetDeviceCaps` still writes an almost entirely zero `D3DCAPS8`:
known and unfixed, contradicts A2 for a program that branches on it. *2026-09-07, `ea288f16`.*

**A12. Every COM interface method in this engine is stdcall, with the interface pointer first on
the stack, not thiscall.** Established against real compiled binaries: twelve call sites read
instruction-by-instruction across five images, plus a census where two COM-only libraries show 24
and 30 stack-passed call sites and zero register-passed ones, against the same binaries emitting
thousands of register-form calls for their own C++ virtual calls. This corrected an earlier wrong
assumption that no test caught, because the harness's own vtables agreed with the mistake: a
convention is not verified by a test written against the same assumption. `Convention.THISCALL`
is kept, unused, only because a `msvcp` C++ runtime on the porting list genuinely needs it one day.
*2026-09-07, `ea288f16`.*

**A13. A loaded image's whole file stays in host memory, for its resources.** Without it a
library's strings, icons, dialogs, menus and version info answer nothing, since a resource is read
from the file rather than the mapping. Known cost: a large title's twenty libraries hold tens of
megabytes host-side for the process's life. The alternative (re-reading from the volume per
resource call) costs a guest-thread wait, which this project ranks above memory. Revisit only
with a measurement that says memory matters more. *2026-09-07, `ea288f16`.*

**A15. `DllMain`'s third argument is 1 (only its non-nullness is contractual) for a program-import
load, and would be NULL for `LoadLibrary`.** A real library's archive code built its hash table
twice, once for itself and once (wrongly) for the dynamic-load path, when told the wrong thing,
silently corrupting every later lookup. `DLL_PROCESS_DETACH` carries the same distinction and will
matter once detach is implemented. *2026-09-08, `43aad592`.*

**A16. A named Win32 object (event, mutex) is destroyed, and its name released, when its last
handle closes**, checked on every named create, not cached. Needed for the create-check-close-
create-again single-instance idiom to work at all. *2026-09-08, `43aad592`.*

**A17. `VirtualAlloc` places a reservation on a 64 KiB boundary**, matching the granularity
`GetSystemInfo` reports, because an allocator that recovers its segment from the top bits of a
page-aligned base corrupts silently if handed a merely page-aligned one. Costs address space, the
resource this engine has most of. *2026-09-08, `43aad592`.*

**A18. A device's cursor advances on the run loop's own clock, not only when the guest calls
in.** A program is entitled to hand a buffer to a wave device and spin on its `WHDR_DONE` flag
without ever polling an API (measured at 80% of one real title's instructions sitting on that
spin). Generalised: anything a guest can wait on without making a call has to be driven from the
scheduler. *2026-09-08, `33c69c47`.*

**A19. A COM method receives its arguments with the `this` pointer already stripped**:
`bridge/internal/vtable.js`'s own contract. Two seams (DirectSound, DirectInput) were written as
though it hadn't been, reading every argument one slot late, and their own test fixtures agreed
with the bug instead of the bridge. Both now drive the real vtable publisher by slot number rather
than a stand-in. *2026-09-08, `33c69c47`.*

**A20. DirectShow answers, and answers that it cannot render** (`RenderFile` →
`VFW_E_CANNOT_RENDER`, `Run` queues `EC_ERRORABORT`) rather than hiding the file so the program
never asks. A program that plays a cinematic sits in a modal loop until the graph reports an
outcome; with no graph and no error, that loop never exits. *2026-09-08, `33c69c47`.*

**A21. The guest's clock is credited with the wall time a slice actually took, not just the
slices the guest ran.** Everything between two slices (the yield, the mix, the polls) used to
pass on the wall clock without moving virtual time, so a device paced by that clock (a
`DirectSound` cursor) never finished a buffer for a title that spins on it instead of waiting.
Capped at a quarter second so a genuine stall (a fetch, a hidden tab) isn't handed to the program
as time it spent. *2026-09-08, `33f251d6`.*

**A22. `WM_NCCREATE` and then `WM_CREATE` are sent when a window is made.** A window procedure
does its real setup in `WM_CREATE`; without it a window looks real and does nothing. `WM_NCCREATE`
was at first left out, because it meant running guest code twice from one host call with the
second starting while the first unwound; creation has since come to chain the CBT hook,
`WM_CREATE`, `WM_SIZE` and `WM_MOVE` each after the previous one's answer, so that no longer held,
and a procedure that keeps `lpCreateParams` from `WM_NCCREATE` (a common way to bind a window to
its object) never got it. It is sent first now, and `FALSE` from it refuses the window, as user32's
message tests pin. *2026-09-08, `33f251d6`; revised 2026-09-26, `54c1d1f`.*

**A23. `DefWindowProc` does nothing with `WM_DESTROY`**, rather than posting a quit. Windows
programs destroy windows constantly (dialogs, tooltips, splash screens) and pass `WM_DESTROY` to
the default handler with nothing to add; posting a quit there ended the whole process on every one
of those. Ending the message loop is the main window's own `PostQuitMessage` call. *2026-09-08,
`33f251d6`.*

**A24. `SetTimer` makes a real timer, due against the guest's own clock, and `WM_TIMER` is
synthesised when a program asks for a message and finds nothing else**, the way Windows does it,
so a long handler doesn't leave a backlog. Refusing outright, tried first, is indefensible once
there is a clock to be due against. *2026-09-08, `33f251d6`.*

**A25. A DirectShow graph with nothing to play finishes at once (`EC_COMPLETE`), rather than
`RenderFile` refusing outright.** A program checking `RenderFile`, releasing the graph it can't use
and arming its own caption timer unconditionally then dereferences a pointer it already freed:
refusing correctly still crashes it. An empty graph takes the same "finished" path a real film
does. *2026-09-08, `33f251d6`.*

**A26. A thread handle is waitable: `WaitForSingleObject` treats a thread as an object that
signals once and stays signalled on ending**, nothing taken from it so a second join doesn't hang
forever. *2026-09-08, `33f251d6`.*

**A27. Every field a structure declares gets written, never a partial table of "the fields anyone
fills in."** `D3DCAPS8` was tabulated as a handful of fields and every one was in the wrong offset:
the real maximum texture size landed on the repeat-limit field and read as zero, so a program
halving a texture until it fit halved it forever (97% of one measured profile on that one
instruction). A partial table is not a partial implementation; it's a wrong one. *2026-09-08,
`33f251d6`.*

**A28. A Direct3D device's per-draw state (render state, transforms, stream/index sources, the
vertex shader handle, buffer lock/unlock) lives in a guest-memory block the guest writes directly,
and the host trusts none of it.** The block is one-way (guest writes it; host only mirrors its own
state into it), untrusted (every device-method entry diffs the whole block against the host's copy
and replays each difference through the real setter, so validation stays centralised), and counted
(the block tallies what it absorbed so the saving is a measured number, not a belief). What the
fast path can't do (an unknown state, a shader handle, a held lock, a full ring) still falls to
the method's own trap. Measured on one title's menu; the block takes a dedicated memory page so
writing it never evicts compiled guest code sitting next to the routines that write it. *2026-09-10,
`109d90f6`.*

**A29. Video memory is a constant 256 MiB that creating a surface or texture never reduces.**
`GetAvailableTextureMem` (Direct3D 8 and 9) and `GetAvailableVidMem` (DirectDraw) answer the same
number however much has been created, and WMI's `Win32_VideoController.AdapterRAM` gives the
same figure, where Wine's tests (`d3d9/tests/device.c`, `ddraw/tests/ddraw7.c` and its older
siblings) see it fall as render targets are made. A program
asks to size a cache, and what it does with a falling answer is evict and reload; here nothing is
ever evicted, because a texture's storage is the guest's own memory and its GPU copy lives as long
as it does, so a shrinking figure would make a program work around a pressure that does not exist.
The figure sits well below a signed 32-bit boundary so a caller treating it as signed cannot go
negative. Revisit if a program is found that checks the figure falls, or that refuses to run when
it doesn't. *Recorded 2026-09-26; the choice predates this repository's history (`7a469c3`).*

**A30. `Present` never waits for the display, whatever presentation interval was asked for.**
The caps advertise `D3DPRESENT_INTERVAL_ONE` and `IMMEDIATE`, and the interval a program asks for
is parsed and handed back, but no path reads it: two presents in a row both return at once, where
the documented contract is at most one per refresh period. The pacer
(`webgpu/internal/pacer.js`) takes the newest frame at each display tick instead, so a frame
presented too soon is superseded rather than shown, and the guest thread is never held for a frame.
A guest thread parked for a refresh period costs more than any number of frames drawn. What this
gives up: a program that
relies on `Present` to throttle its loop runs that loop faster than the display, and burns guest
time on frames nobody sees. *Recorded 2026-09-26; the choice predates this repository's history
(`7a469c3`).*

**A31. The Windows a machine reports is a bottle's setting, one of four, and XP SP3 by default.**
Some programs refuse a Windows older than they were written for and some one newer, so no single
answer serves every title: `createApp`'s `windows` option (and a bottle manifest's `windows` field)
picks one of `win2000`, `winxp`, `win7` and `win10`, each at the last service pack its release
had, and every place a program reads the version from answers that one (`docs/core/api.md`'s
`windows` option):

| choice | version | service pack | suite | profile layout |
|--------|---------|--------------|-------|----------------|
| `win2000` | 5.0.2195 | 4 | none | `Documents and Settings` |
| `winxp` | 5.1.2600 | 3 | `VER_SUITE_SINGLEUSERTS` | `Documents and Settings` |
| `win7` | 6.1.7601 | 1 | `VER_SUITE_SINGLEUSERTS` | `Users`, `ProgramData` |
| `win10` | 10.0.19045 | none | `VER_SUITE_SINGLEUSERTS` | `Users`, `ProgramData` |

All four are workstations (`VER_NT_WORKSTATION`) on `VER_PLATFORM_WIN32_NT`, a Professional
edition rather than a Home one (no `VER_SUITE_PERSONAL`), and 32-bit: `IsWow64Process` stays
FALSE and there is no `Program Files (x86)`. The Windows directory is `C:\WINDOWS` for all four,
2000 included, whose own setup chose `C:\WINNT`: a program asks `GetWindowsDirectory` rather than
assuming either, and one directory keeps the system volume and every path under it the same.
The temporary directory (`GetTempPath`, `TEMP`, `TMP`) is `C:\WINDOWS\TEMP` for all four as well,
where Windows keeps one per user under the profile: XP's is the short
`C:\DOCUME~1\User\LOCALS~1\Temp`, and this volume has no 8.3 names, so the long path would put its
spaces into every command line an installer builds from it unquoted. Revisit once the volume
answers short names.
`win10` answers `GetVersion`, `GetVersionEx` and `VerifyVersionInfo` with the newest Windows the
program declares, 6.2 when it declares nothing newer, as Windows 8.1 and later do; the process
block, `RtlGetVersion`, the registry and a system library's file version keep the truth. A system
library's file version is `major.minor.build.0`: the service pack's own revision number is not
modelled. A hive restored from a run under another setting has its version values and shell
folders written over at start (a bottle's setting can change between runs), where every other
value a program wrote is kept.

XP SP3 is the default because the installers a title of the era carries accept it and the engine
already is it: the DirectX June 2010 redistributable's setup refuses anything below XP SP2, and
kernel32 already exports SP2's additions, such as `EncodePointer` and `IsWow64Process`; a
machine exporting SP2's interface while claiming no service pack contradicts itself. It is also
old enough that a program written for 2000 or 98 still recognises it, where a version check
written before 7 existed may not recognise 7 or 10. *2026-09-26, the commit adding
`kernel32/versions.js`.*

**A32. `CoGetDefaultContext` answers only for an apartment the caller can name.** For
`APTTYPE_CURRENT`, or the type of the apartment the calling thread is in, it hands out that
apartment's context; for `APTTYPE_MTA` it hands out the multithreaded apartment's context while
that apartment exists. Otherwise it answers `CO_E_NOTINITIALIZED`. That includes a
single-threaded apartment the caller is not in: several threads may each have one, and the type
alone does not say which is meant. An unknown type answers `E_INVALIDARG`. Wine leaves the call
a stub, and no conformance test pins down any of these answers. *2026-10-05.*

**A33. An installation's progress bar counts a file as its size in bytes, a registry value as
13200 ticks and a component as 24000, and its total is what this installation will do.** Windows
documents `INSTALLMESSAGE_PROGRESS` (a reset to a total, reports of ticks, the direction) but
not what anything is worth; the two fixed amounts are Wine's, and no published source gives
others. `InstallValidate` resets the bar to the files, values and components the
installation puts down, rather than the package's whole as Wine does, so a setup's own page
reaches its end when the installation does. A page shows the ratio of what is done to the total,
which these amounts set; revisit them if a program is found reading the ticks themselves.
*2026-10-07.*

**A34. A file's security is the descriptor Windows XP answers for a volume that keeps none.**
The volume has no ACLs, as FAT32 has none, and reports no `FILE_PERSISTENT_ACLS`: so
`GetNamedSecurityInfo` of a file answers a made-up descriptor whose owner and group are Everyone
and whose DACL is present and null, and `SetNamedSecurityInfo` succeeds and keeps nothing, so the
next read answers the same. A setup that reads a folder's DACL, merges an entry with
`SetEntriesInAcl` and writes it back goes through and changes nothing it could see. Not measured
against XP; revisit if a program is found that checks the DACL it wrote. *2026-10-07.*

*Reconsidered 2026-10-27:* the volume is NTFS and keeps security descriptors, reporting
`FILE_PERSISTENT_ACLS`, rather than a FAT32 volume that keeps none. `GetNamedSecurityInfo` and
`GetFileSecurity` answer a file the way NTFS answers one that inherited nothing and had none set
-- full control to the administrators, the system and the owner, the DACL present and not null --
and what a program sets with `SetNamedSecurityInfo`, `SetFileSecurity` or a `SECURITY_ATTRIBUTES`
at `CreateFile`/`CreateDirectory` is kept and answered back. A null DACL read back as full access
was the old call's weakness: a program that read a DACL, merged an entry and wrote it back could
not see its change take, and one that checked the DACL it wrote found the made-up one instead. The
descriptors are the run's, not a process's -- a setup writes one and a service reads it in another
process of the one run -- so they live in a store beside the hive for the run's lifetime; nothing
is written to the volume, so a later run starts fresh. The registry side of A34 (a key answered in
Windows' own shape, set accepted and kept nowhere) stands. *2026-10-27.*

**A35. kernel32 exports the Windows 95 family's own calls, and each fails as it does when what it
reaches for is absent.** XP's kernel32 is believed (not checked against an XP export table) not to
export the flat-thunk helpers (`ThunkConnect32`, `FT_Thunk`, `FT_Exit*`, `MapLS`, `MapSL`,
`SMapLS*`, `SUnMapLS*`, `UnMapLS`), `RegisterServiceProcess`, `OpenVxDHandle`,
`CreateSocketHandle`, `SetHandleContext`, `ConvertToGlobalHandle` and
`MakeCriticalSectionGlobal`. Programs written for both families import them statically all the
same, and an image with an import the loader cannot bind does not start at all; so they are
exported, and answer as Windows 95 does without the 16-bit subsystem, the selector or the VxD they
need: the thunk does not connect, a pointer past 64 KiB gets no selector, no ring-0 handle is
made. A program that probes `GetProcAddress` for one of them to tell the families apart finds it
here and is told the failure when it calls; revisit if such a program is found to take a 9x path it
cannot finish. *2026-10-07.*

**A36. A removal that takes the last key out of an INI section takes the section too, and a
file it leaves empty goes.** The IniFile and RemoveIniFile tables say which line or tag to take
out, not what becomes of a heading left with nothing under it. Leaving it would keep the file,
and with it the folder the product made, after a removal that otherwise leaves nothing; so the
empty heading goes with its last key, and a file with nothing left in it is deleted. Not measured
against Windows; revisit if a program is found reading an empty section its setup left.
*2026-10-08.*

**A37. An imported archive replaces a table whole; a merge leaves out only the tables that
conflict.** `MsiDatabaseImport` of a table the database already has replaces it, its columns
included, as the archive describes them; Wine keeps the old columns and replaces only the rows,
and no published source settles which Windows does. `MsiDatabaseMerge` checks every table's
schema before changing anything, merges each table without conflicting rows, and counts the
conflicts of the others in the error table; the two databases' code pages are not compared,
though the SDK says they should match. The summary's dates in an archive are read and written as
UTC. A session's read-only database refuses both. Not measured against Windows. *2026-10-08.*

**A38. The system folder's programs (msiexec, rundll32, regsvr32) are processes whose images
the engine makes, and the volume does not show them as files.** Installers, bootstrappers and
uninstall strings start them by name, and a bottle has no Microsoft binaries. A request for one in
`C:\WINDOWS\system32` (by full path, or by bare name through CreateProcess's documented search)
that the volume cannot answer starts a real process, whose image is a synthesised executable: its
entry point calls a routine of the engine's own library (`bottlify.dll`) and exits with the
answer. Each routine drives only the process's own exports (msi.dll's install calls,
LoadLibrary/GetProcAddress, MessageBox), so what it does is what those exports do. Such a program
starts in the directory its parent asked for, or else in the parent's current directory, as
Windows starts every child, since the paths on its command line are the parent's to mean; since
2026-10-30 every other child starts there too (a client that set its own directory and started
its helper with none had the helper look for its libraries in the wrong place). The volume reports no file at those paths
(`GetFileAttributes`, `FindFirstFile`, `SearchPath`, `GetFileVersionInfo` and `CreateFile` on
`system32\msiexec.exe` fail) because an entry would need bytes to read and a version resource
to answer, and no measured program has needed either. Revisit if a bootstrapper is found that
checks for msiexec.exe, or reads its version, before starting it; the answer then is a read-only
entry served from the synthesised image, not a file written to the volume. A file a bundle does
carry at that path always wins. *2026-10-08.*

**A39. Windows XP's Internet Explorer and Media Player are there, at Service Pack 3's versions,
without files.** Setups check them before installing what needs either: an IExpress package's
version check reads `shdocvw.dll` or `msdxm.ocx` in the system folder, others read the registry.
The XP description carries the browser's and the player's versions and the files that carry them
(`kernel32/versions.js`, `components`): GetFileVersionInfo answers those files with their own
versions, as it answers the engine's libraries with the system's, and the registry's `Internet
Explorer\Version` and `MediaPlayer\PlayerUpgrade\PlayerVersion` say the same, from the same
table. As with the system programs (A38), the volume shows no file at those paths. The numbers
are Service Pack 3's as published (IE 6.0.2900.5512, WMP 9.0.0.4503, msdxm.ocx 6.4.9.1133) and
were not read off a machine; the other Windows releases describe no components and answer as
before. *2026-10-08.*

**A40. Notepad is a system program, and the shell opens text files in it and hands addresses
to the page.** Setups show a readme by starting `C:\WINDOWS\Notepad.exe readme.txt` or by
asking ShellExecute to open the `.txt`, and a "visit our site" button by opening an address. On
the model of A38, `notepad.exe` in the Windows directory and the system folder is a synthesised
image whose routine reads the file through CreateFile/ReadFile (a UTF-16 or UTF-8 byte order
mark decides the encoding, the ANSI code page otherwise), shows it in a frame filled by a
multi-line edit control, and runs a message loop until the frame is closed; editing, saving and
printing (`/p`) are not offered. ShellExecute's open verb opens `.txt`, `.log`, `.ini`, `.inf`,
`.nfo` and `.diz` as XP's registry has them (`%SystemRoot%\system32\NOTEPAD.EXE %1`, the
file unquoted), and an `http`, `https`, `ftp` or `mailto` address, or the address a `.url`
shortcut holds, is handed to the page as an `open-url` event and answered with success, since
the machine reports a browser installed (A39). The frame is a class of the program's own, named
`Notepad` as the real one's is, whose procedure is DefWindowProcW's own address (so it is
moved, activated and closed as any window is), because the routine drives only exports a program
could call and writes no window procedure in guest code. *2026-10-08.*

**A41. The libraries the engine implements stand in the system folder as files, for the
questions asked before loading one.** A38 left the system folder empty of what the engine
supplies, to be revisited when a setup checked first; InstallShield 9's `UseDLL` does, with
FindFirstFile on `system32\Shell32.dll`, and stopped at "UseDLL failed". In the system folder a
name that is one of the engine's libraries, and is not a file on the volume, now answers
GetFileAttributes(Ex) and a FindFirstFile for that exact name as a file: archive, 64 KiB, dated
as Windows XP SP3's build (2008-04-14). A search with a wildcard lists the folder as it is, and
the name cannot be opened: what it holds is the engine's, not bytes; GetFileVersionInfo answers
such a library already (A39). The system programs stay as A38 has them. Revisit if a program
reads a system library's bytes or enumerates the folder to find one. *2026-10-08.*

Planned to change (status: plan, no code; 2026-10-27): with a file explorer, the system programs
of A38 and these libraries become read-only entries the volume serves from their synthesised
images, carrying icon resources of the project's own drawing, so a search by path finds them and
ExtractIcon, SHGetStockIconInfo and a shortcut's icon read real ones. Until then Wine's checks of
those files and icons (shell32:shelllink, about 165) are counted as divergences under A38 and A41.

**A42. A thread's stack is at least a megabyte, whatever SizeOfStackReserve says.** The first
thread and every thread created with the image's default get `max(SizeOfStackReserve, 1 MiB)`.
A program linked for 64 KiB (the Call of Duty 2 demo) was measured reaching 70 KiB down its first
thread, inside a window procedure, and faulting below the mapped stack; the title is released to
run on Windows, so the linked figure is not a limit programs are held to there. A megabyte is the
linker's default and what Wine gives every thread as a floor. Not derived from a specification:
Windows' own rounding of a small reserve was not measured. Revisit if a program is found that
depends on a small stack ending where it was linked to end. *2026-10-10.*

**A43. Table fog through a vertex shader that writes oFog runs its curve over that oFog.**
With FOGTABLEMODE set, a draw through a vertex shader below model 3 is fogged per pixel by the
table curve over the shader's oFog when the shader wrote one, and over the depth (z) when it did
not. Wine's `fog_with_shader_test` rows for a shader with fog output under table fog expect the
depth instead, as measured on a GeForce 7600GS; programs of the shader-model-1 generation were
written against earlier drivers that took the curve over oFog, and set their range for it. Far
Cry writes oFog as one minus its own visibility and sets a LINEAR table range of 0 to 1: over
the depth every terrain pixel of a level came out the fog colour (measured 2026-10-10, browser,
graphics worker, SwiftShader); over oFog the range gives back the program's own factor. A shader
without oFog has the curve run over the depth as the fixed function takes it: z under an affine
projection, w under a perspective one, by the projection set on the device. Far Cry's R300 path
writes no oFog and sets LINEAR 30 to 350 in eye units for its shader draws, the range its NV2x
path computes into oFog itself; over z, which never leaves 0..1, its world was drawn without
fog and its far forest dark (reports 2026-10-12, Chrome on macOS). A program written for later
drivers, which take the curve over the depth whatever the shader wrote (Wine's
`fog_with_shader_test`, measured on a GeForce 7600GS; `test_fog`), runs with the graphics setting
`driverRules: 'current'` (docs/core/configuration.md); `'legacy'` is the default, since the
programs that leave fog to this stage at all are of the earlier generations. Either way the depth
is z or w as the projection says, the projection set on the device even under a shader (Wine's
d3d9 `test_fog`), and the z is the vertex's own, not the depth with the device's bias in it:
Windows answers either the vertex's output z or the pixel's z with D3DRS_DEPTHBIAS in depth
units, and WebGPU's bias is in steps of a format the program did not choose. *2026-10-10,
the case without oFog 2026-10-12, the depth's z and w 2026-11-06.*

**A44. Under a vertex shader, a 1.0 to 1.3 pixel shader's projective read divides by w.**
D3DTTFF_PROJECTED on a stage a `ps_1_1` to `ps_1_3` reads divides that stage's coordinates
before the read. Without a vertex shader the divisor is the last coordinate the count names,
which is what the fixed function produced; under a vertex shader the shader writes all four,
and the drivers of the shader-model-1 era divided by w whatever count the flags named. Wine
divides by the count's last component in either case. Prince of Persia: Warrior Within's water
writes (u w, v w, w, w) from its vertex shader (z equal to w, so that a driver dividing by
either reads the same place) and sets D3DTTFF_COUNT2 | D3DTTFF_PROJECTED: divided by y, the
screen copy it refracts was read far outside itself and the water drawn in stripes; divided by
w, as by the default here, it is water (the person's run, 2026-10-13, browser, graphics worker,
Parallels GPU). Windows divides by w too, under either driver rules: Wine's later d3d9
`test_texture_transform_flags` shows the fixed vertex stage putting the count's last component in
w and every projected read dividing by w, so this is no longer a departure and `driverRules`
does not change it. *2026-10-13, both rules 2026-11-06.*

**A45. A pre-transformed vertex with a negative RHW is clipped behind the eye only where the
runtime clipped it.** A Direct3D 7 or 6 vertex buffer that ProcessVertices transformed with
D3DVOP_CLIP, made without D3DVBCAPS_DONOTCLIP, keeps its vertices' clip codes, and a draw from it
without D3DDP_DONOTCLIP, under D3DRENDERSTATE_CLIPPING, is clipped by the runtime against the
view volume. Such a draw here takes each RHW back as its clip w, a negative one included, so
the rasteriser clips the triangle at the eye: the same volume, in homogeneous space. Every
other pre-transformed draw takes an RHW of zero or less as w one: the rasterisers of that
generation took the screen position as given, and only the runtime's clipping kept a vertex
behind the eye off the screen. Wine divides the position by every non-zero RHW, so clips such
a vertex in every draw. Half-Life's Direct3D renderer (through IDirect3DDevice3) processes its
world with D3DVOP_CLIP and draws the buffer indexed: taken at w one, every wall behind the
camera was drawn as spikes across the screen (the person's run, 2026-10-13, browser, graphics
worker, Parallels GPU). `driverRules: 'current'` clips behind the eye in every pre-transformed
draw, as Wine does. *2026-10-13.*

**A46. Under Direct3D 8 a vertex format draws through the fixed function's pixel stage, whatever
1.0 to 1.3 pixel shader is bound.** A draw whose vertex shader is a vertex format (no vertex shader
handle) is drawn by the texture stage states, a bound `ps_1_1` to `ps_1_3` left aside (a
`ps_1_4`, the generation Wine's `cnd_test` runs over a vertex format, is run); the binding itself stays, and
GetPixelShader answers it. Wine runs the bound shader over the fixed vertex stage. Need for Speed:
Hot Pursuit 2 keeps the pixel shader its car's last pass set (its own state cache is cleared
each frame without SetPixelShader(0), and its menus are drawn through vertex formats), and that
shader adds the specular colour and takes its alpha from the diffuse: run over the menus, the
screen came out white, then, with the specular default corrected, its text as solid boxes; with
the pixel stage the texture stages set, the menus, the car select and the race HUD are what the
game draws (the person's run, 2026-10-16, browser, graphics worker, Parallels GPU). The same
game is listed with severe graphics issues under Wine. `driverRules: 'current'` runs the bound
shader, as Wine does. *2026-10-16.*

**A47. A thread is told of the images in load order, the program first, each image's TLS
callbacks before its entry point; its end, of the images the other way round, each still callbacks
first.** The documentation says every attached library's entry point is called with
`DLL_THREAD_ATTACH` on the new thread and with `DLL_THREAD_DETACH` on the one ending, and Wine's
loader test that a library's TLS callback hears both; neither says where the program's own TLS
callbacks fall among the libraries, nor the order within one image on the way out. The attach is
the order this loader already makes the process's attach in (`synthesiseProcessInit`), so a
thread starts from what the first thread started from. On the way out an image's TLS callbacks
still go first: a static runtime's are its `thread_local` destructors, and its entry point's
detach frees the per-thread data they may still use. *2026-10-18.*

**A48. `DisableThreadLibraryCalls` on a library with static thread-local storage answers TRUE,
and the library goes on being told of threads.** The documentation says both that the call fails
for such a library and that it "does not perform any optimizations" for it; the notifications go on
either way, since its TLS callbacks build each thread's `thread_local` objects. Of the two answers
TRUE is the one no library is broken by: one that fails its attach on FALSE would not load. Any
other loaded module is honoured, its entry point and TLS callbacks told of no thread from then on.
*2026-10-18.*

**A49. The last thread to end by `ExitThread` or by returning is not told its own detach: the
libraries hear `DLL_PROCESS_DETACH`, lpvReserved non-NULL, on that thread, as `ExitProcess` tells
them.** The documentation says the last thread's exit ends the process and that a library hears
`DLL_PROCESS_DETACH` with lpvReserved non-NULL when the process ends; it does not say whether the
last thread's own detach comes first. Two threads that end at once each find the other still
standing and are both told their own detach; the process then ends with no thread left, and the
libraries hear nothing more: the end of a process whose threads are gone, not one that called
`ExitProcess`. *2026-10-18.*

**A50. The process's end tells the images the other way round from their attach, each image's
TLS callbacks before its entry point, the program's own callbacks last.** The PE format says a TLS
callback is called with `DLL_PROCESS_DETACH` when the process ends and with the same arguments as
`DllMain`; Microsoft documents that `ExitProcess` calls each attached library's entry point, with
lpvReserved non-NULL, and Wine's loader test that a library's callback hears `DLL_PROCESS_DETACH`
from `FreeLibrary`. Nothing published says where a callback falls among the entry points on the
way out, nor where the program's, which has no entry point after it. This loader attaches the
program's callbacks first (A47), so they are told last: whatever they tear down (a static
runtime's `thread_local` objects of the first thread) outlives every library that might still use
it, and the process's end is the exact mirror of its start, as a thread's end is of its start.
Within an image the callbacks still go first, as in A47. lpvReserved is 1 at the process's end and
NULL at `FreeLibrary`, as for the entry point. *2026-10-18.*

**A51. A library loaded at run time gets its TLS whether or not it has an entry point, and is
refused when it cannot.** Since Vista Windows gives such a library a slot, every thread's block
and its callbacks, which Wine's loader test checks (`test_import_resolution`, cases 0 and 3); the
test also notes that Windows "doesn't consistently call tls init functions on dlls without entry
points". Here the callbacks are called for such a library, as the startup stub calls them for one
the program imports: the image asked for them, and a callback that runs is the case no runtime is
broken by. A library loaded with `DONT_RESOLVE_DLL_REFERENCES`, or a program loaded by name, gets no
TLS, as the test expects. Its index is the loader's own numbering, not one of `TlsAlloc`'s slots
(A65): the lowest one no loaded image holds. A library for whose block not every thread has room
is refused as one whose import is missing is (`LoadLibrary` answers NULL), as Windows fails a load
it cannot give TLS to. *2026-10-18; the index narrowed by A65, 2026-10-30.*

**A52. A dynamic buffer the guest's DISCARD moves onto another storage takes along what it held
outside the range locked.** Direct3D 9 documents a DISCARD of a vertex or index buffer as giving
up the whole buffer's contents; a driver that renames hands back other memory, one that waits for
the GPU hands back the same. The host keeps a buffer's storage at a DISCARD, and the renderer
carries the old contents over into the GPU copy it renames (`webgpu/internal/buffers.js`): a game
that draws after a DISCARD what it wrote before it, past the range it locked, draws it right on a
driver that hands the same memory back. World of Warcraft's sky does so: it fills the end of its
ring, wraps the ring with DISCARD for the next batch and then draws the end. The guest's lock
routine, which moves the buffer onto a spare storage instead (`d3d8/storages.js`), copies the
bytes before and after the range locked from the storage left (`moveCopyCode`), so that both paths
give a program the same bytes; a DISCARD of the whole buffer copies nothing. The bytes copied are
counted (`moved.copied` in the device's shadow diagnostics). The price is a copy in the guest:
Call of Duty 4 locks part of its 4.5 MB skinning buffer with DISCARD every frame, and its moves
copied 25.5 GB in a run of 326 s (27 620 moves, three executors, the fake GPU). *2026-10-24.*

**A53. Each top-level window has a surface of its own, as Windows 7's desktop composes them; only
what follows from that differs from what Windows' messages say.** The window manager keeps a
picture per top-level window and the screen is composed from them, bottom to top, the way the
Desktop Window Manager composes a Windows 7 desktop (`windows.js` `surfaceOf`, `surfaces`). The
alternative, XP's model, keeps one screen and computes every window's visible region against the
windows above it, so that a window paints only where it is seen and is told to repaint whatever
another uncovers; with a surface per window none of that crosses windows, and a window moved over
another neither damages it nor sends it WM_PAINT. The scope is exactly what follows from the
surface: what a top-level window paints, when it is invalidated and repainted, and how it is
clipped against its siblings at the top level. Everything else follows Windows and is a gap where
it does not: the messages and their order, the WinEvents, activation and focus order, the CBT
hook's sequences. A difference in those is not this decision. *2026-10-26.*

**A54. The mount manager gives each volume an MBR disk's unique ID, one disk per drive letter.**
`IOCTL_MOUNTMGR_QUERY_POINTS` lists each drive by its letter and by its volume name, and both links
carry the volume's unique ID. There is no disk under the volumes to read one from, so the ID is
what an MBR partition's is, twelve bytes: the disk signature (the volume serial `drives.js`
reports) and the partition's offset, 1 MiB times the letter's place among the drives
(`mountPointsOf`). It is the same for a volume's two links and differs between volumes, which is
all a program comparing IDs asks; a GPT ID (`DMIO:ID:` and a GUID) would serve as well. *2026-10-26,
`08e7ceb`.*

**A55. Every time an open file reports is its last write.** The volume keeps one time per file,
when it was last written, and `NtQueryInformationFile` (Basic, NetworkOpen, All) and
`FileIdBothDirectoryInfo` give it as the creation, access, write and change times alike, as
`GetFileTime` and `GetFileInformationByHandle` already did. A creation time later than the write
time would be a contradiction a program can see; one earlier would be invented. *2026-10-26,
`08e7ceb`.*

**A56. A file's number on its volume is the FNV-1a hash of its full path, case folded.**
`GetFileInformationByHandle`'s file index, `FileInternalInformation` and a directory listing's
`FileId` are that one number (`filetime.js` `fileIndex`): the same for the same file however it
was opened, which is what a program comparing two handles asks, and different for different paths
but for a hash collision. NTFS numbers files by their place in the MFT, which nothing here has; a
rename gives a file another number here where NTFS keeps it. *2026-10-26, `08e7ceb`, `33a6087`.*

*Reconsidered 2026-10-27:* a file with hard links has one number under all its names: the hash of
the path its bytes are kept at, which is always one of its names. The number changes when that
name is renamed or deleted and another of its names keeps the bytes. A file with one name is
unchanged.

**A57. The engine's side-by-side store holds the Visual C++ 8 and 9 runtimes and Common Controls
6, each found where the bottle really has it.** A bottle carries no WinSxS, so an assembly a
program's manifest names -- Microsoft.VC80/VC90 .CRT, .OpenMP, .ATL, .MFC, Common-Controls 6 --
is answered by the engine's store when neither the bottle's own store nor the program's folder
has it: its DLLs are the engine's own where it has them (msvcr80, msvcp80, comctl32) and the
bottle's copy otherwise, from system32, the Windows folder or beside the program, and the
loader maps that copy at the assembly's WinSxS directory, where the runtime's own check expects
an installed runtime to be. A runtime the bottle has nowhere is no assembly, and the program does
not start, as on a Windows without that redistributable. The store answers for the newest
version of a major and minor version, as the runtimes' publisher policies do; a private assembly
must match the version asked for exactly. *2026-10-27.*

**A58. A manifest is refused only for what breaks its structure.** CreateActCtx and the loader
refuse a manifest that is not XML, a root that is not an asm.v1, v2 or v3 `<assembly
manifestVersion="1.0">`, anything after the root, a file without a name, UTF-16 without its byte
order mark, and a run level given twice. Windows also refuses an element or attribute it does
not know; that is not done here, as a refusal stops a program from starting while accepting
costs only a check of a malformed manifest. A resource padded with NULs is read up to them.
*2026-10-27.*

**A59. A program whose activation context cannot be built does not start.** When the program's
manifest names an assembly found nowhere (A57), the run ends before the first instruction with
`the side-by-side configuration is incorrect` and the `activation-context-failed` event, as
Windows ends it. A library loaded at run time whose own manifest cannot be satisfied is refused
as one that is missing. *2026-10-27.*

**A60. DeactivateActCtx refuses a cookie it cannot take off rather than raising.** Windows raises
STATUS_SXS_EARLY_DEACTIVATION for a frame under others without
DEACTIVATE_ACTCTX_FLAG_FORCE_EARLY_DEACTIVATION, and STATUS_SXS_INVALID_DEACTIVATION for a cookie
that is no frame of the thread; here the call fails with the matching error and the stack stays
as it was, so a program that gets a cookie wrong goes on. *2026-10-27.*

**A61. A font has no file behind it.** Faces are drawn through the browser, and none comes from
a file on the volume, so GetFontFileInfo answers the empty file Windows answers for a font added
from memory -- no time, no size, an empty path -- and GetFontFileData has no byte to give; Windows
names the face's file and reads it. GetFontRealizationInfo and GdiRealizationInfo answer the DC's
font by its handle as the instance id. *2026-10-27, `90ecc574`.*
**A62. A 64-bit process's C++ frames do not call the `_set_se_translator` translator.** At 32
bits a structured exception reaching a C++ frame with try blocks is handed to the translator the
program installed, which turns it into a C++ throw; a 64-bit frame keeps the translator
`_set_se_translator` set and answers it back, but searches as though none were set, and says so
with a `divergence`. The translator is documented for code built with /EHa, and the compiler that
builds this project's fixtures emits /EHs tables, so no program here exercises it; a translator
called by the dispatcher throws from inside the walk, which the 64-bit dispatcher has no test for.
Revisit when a 64-bit program is found that needs it. *2026-10-29.*

**A63. A 64-bit process's window messages carry 32-bit WPARAM and LPARAM values.** The
message queue and every handler that sends, posts or answers a message keep its parameters as
the dwords a 32-bit process has; at 64 bits a value is widened as its type widens a 32-bit one,
a WPARAM (UINT_PTR) zero-extended and an LPARAM (LONG_PTR) sign-extended, when it reaches a
window procedure, a hook procedure (and the next one through CallNextHookEx) or a MSG, and an
LRESULT is sign-extended into RAX, a late one included. Every
pointer and handle the engine hands out lies below 2 GiB, so a pointer in either parameter
reaches the procedure whole and -1 is -1; a value that needs the high half of a quadword loses
it. Carrying quadwords through the queue would change every handler that reads a message;
revisit when a program is found that passes one. *2026-10-29.*

**A64. A run is on a 64-bit Windows when its first program is a 64-bit one.** A 64-bit process
needs a 64-bit Windows beneath it, and a 32-bit process started on that machine runs under WOW64:
it reads x86 from `GetSystemInfo` and x64 from `GetNativeSystemInfo`, `IsWow64Process` is TRUE
of it, the WOW64 directory is `C:\WINDOWS\SysWOW64`, and its environment sets
`PROCESSOR_ARCHITEW6432`. Every process of the run sees the one machine, its children in workers
too. A run whose first program is 32-bit stays on a 32-bit Windows, as every run was, unless the
caller asks for `machine: 'amd64'`: a 32-bit title that asks whether it is under WOW64 then
answers as on the machines it was written for, the ones of its era. The file system and the
registry are not redirected (no `System32` to `SysWOW64`, no `Wow6432Node`, no
`Program Files (x86)`). *2026-10-29.*

**A65. An image's thread-local index is the loader's, apart from TlsAlloc's slots, and slot 0 of
TlsAlloc's is taken before the program runs.** A thread has two arrays on Windows: the one
ThreadLocalStoragePointer names (`fs:[0x2c]`, `gs:[0x58]`), indexed by the number the loader
writes into each image's `_tls_index`, and `TlsSlots` in the thread's own block (`TEB+0xE10` at 32
bits, `TEB+0x1480` at 64), the 64 values `TlsGetValue` and `TlsSetValue` keep. Here, as there, the
program's own image is index 0 and the libraries with thread-local storage follow in the order they
are loaded, one loaded at run time taking the lowest index no loaded image holds; a compiler may
reach the program's own variables as `[fs:[0x2c]]` without reading `_tls_index`, as Call of Duty
4's executable does in its thread start. `TlsAlloc` never hands out slot 0, so `TlsGetValue(0)`
reads zero in a thread until the program writes it, as Wine's kernel32 thread test expects of
Windows, whose own libraries hold that slot. When the two arrays were one, reserving slot 0 moved
the program's block to index 1 and that executable found a null at index 0. *2026-10-30.*

**A66. A game platform's own servers are reached from the page only while the platform lets us,
and its first request to stop is honoured for everyone at once.** The GameHub extension
(`gamehub/` in the launcher, bottlify-ui) carries a page's requests to a platform -- Steam's connection managers, which
admit only their own and localhost origins, and its content servers, which send no CORS headers
-- by rewriting their headers with one ruleset a platform. Each ruleset is switched by the site's
own configuration (`config.json`'s `bridge`, `"steam": false`), read by the extension on every
page of the site, so turning one off needs no new release of the extension and reaches every
browser on its next page. On a platform's first request, by whatever channel, its ruleset is
switched off and we cooperate fully -- no workaround, no appeal first. Without GameHub (the
extension's name since) there are no stores: the launcher's server has no store path, and a store
switched off is simply absent. *2026-10-30; restated 2026-10-31.*

**A67. A Steam bottle is installed with its redistributables already applied, the app's own
prerequisite installers among them.** Steam downloads the depots an app names from other apps
(Steamworks Common Redistributables' Visual C++ and DirectX) and, on the first start, runs its
install scripts' programs silently. The download (`bottlify-ui/gamehub/tools/steam-install.mjs`) takes those depots
too -- an anonymous logon opens them -- and `@bottlify/core/steam`'s `redist.js` (run over a
directory by `bottlify-ui/gamehub/tools/steam-install.mjs`, over the bottle a page writes by an install in the browser) does
what the programs would at install time instead: it unpacks each one with the engine's cabinet and installer-database
readers and applies the packages inside by their tables -- the files of each component whose
condition holds into the bottle's system folders, its registry rows into the bottle's registry
-- rather than running a Burn bootstrapper and Windows Installer in the guest. DirectX's setup
has no package inside: its cabinets' Windows NT INFs are applied instead, each component's
libraries copied where the INF puts them for the bottle's machine, since the engine answers
DSETUP and D3DX 9 but not X3DAudio, XAPOFX, XAudio2, XACT, D3DCompiler or D3DX 10 and 11, which a
program imports and otherwise finds missing. A library the engine also answers stays the
engine's while its table covers what a program imports from it, and the COM servers are copied
but not registered. Beyond what Steam declares, every other program the app carries is read the same way, and a
package whose files all go into the Windows folder is applied too: an engine's prerequisite
installer (Unreal's `UE4PrereqSetup_x64.exe`), whose newer runtime the program's launcher checks
for and on Windows offers to install on the person's say-so; without it the bottle asks a
question the person cannot usefully answer. Packages are applied oldest product version first, so
the newest runtime's files and detection values are the bottle's. Revisit if a title's own
package installs into the Windows folder something that must not be there before it asks.
*2026-10-31.*

**A68. A GLSL program's generic attribute 0 is the vertex position, and generic attributes alias
the conventional arrays.** OpenGL 2.0 lets an implementation alias them or not (section 2.7);
here they alias as `ARB_vertex_program`'s table says (1 the weight, 2 the normal, 3 the colour, 8
to 15 the texture coordinates), so one array state serves the assembly programs, GLSL and the
fixed pipeline. An attribute the program does not bind takes the lowest location free, the first
of them 0 unless the program reads `gl_Vertex`, and skips a location whose conventional array the
program also reads. *2026-10-31.*

**A69. A shader's info log reads `ERROR: <string>:<line>: <message>`, one line per error.** The
specification leaves the log's text to the implementation; this is the form most drivers of the
2.x era print and most loaders that show a log expect. A program that compiled has an empty log.
*2026-10-31.*

**A70. A framebuffer WebGPU cannot draw into answers `GL_FRAMEBUFFER_UNSUPPORTED`.** OpenGL 2.1
with `ARB_framebuffer_object` allows attachments of different sizes, separate depth and stencil
images, and depth textures; a WebGPU pass needs one size and one depth-stencil attachment. Each
of those cases is answered as unsupported, which the extension provides for, rather than drawn
partly. *2026-10-31.*

**A71. OpenGL calls accepted but not honoured, each said as a divergence.** An occlusion query
answers the viewport's area, all of it passing. A 3D texture is accepted up to 16 texels a side
and kept nowhere; a program that samples a `sampler3D` fails to link and its log says why.
`GL_MAX_SAMPLES` is 4 and a multisampled renderbuffer is drawn single-sampled.
`glBlitFramebuffer` copies colour alone. A program that only asks for them runs; one that depends
on their result draws without it. *2026-10-31.*

**A72. A 64-bit process's system modules leave out the exports that are i386 code alone.** An
export written as i386 guest code with neither an x86-64 form nor a host handler -- `_chkesp` and
`_EH_prolog` of the C runtimes, the __fastcall `RtlInterlockedPushListSList`,
`RtlActivateActivationContextUnsafeFast` and `RtlDeactivateActivationContextUnsafeFast` -- is not
in a 64-bit process's module, so a program that imports one is refused at load by name and
`GetProcAddress` answers NULL, rather than its i386 running as x86-64. x64 Windows has the first
three nowhere; it has the two activation-context calls, whose frame is laid out for 64-bit
pointers there, which this layer does not write. The app's diagnostics list what is left out
(`leftOutAt64`); revisit the two when a 64-bit program is found that imports them. *2026-10-31.*

**A73. The processor is a family 15 of our own name, with nothing virtual about it.** CPUID
answers what the engine executes, as a processor of the one class that has exactly that set:
Intel family 15, model 6, stepping 5 (the Pentium 4 and Pentium D of 65 nm), with x87, MMX, SSE,
SSE2, SSE3, CMPXCHG16B, CLFLUSH, and in the extended leaves long mode, execute-disable and
LAHF/SAHF in 64-bit mode; its caches are that class's (a 16 KiB level 1 data cache, a 2 MiB level
2). The brand string is `Bottlify Virtual CPU @ 3.00GHz`, the rate the time-stamp counter counts,
as a virtual machine that does not pass its host's processor through names its own. No
hypervisor bit and no hypervisor leaves: copy protection of the programs' time refuses to run
where it finds one. Before this the table was another engine's (family 6 model 7, a Pentium III
signature claiming SSE2, SSE3, POPCNT and RDRAND, a VMware hypervisor, and a highest extended
leaf of 5, so no brand and no long mode): a program named the machine by its signature. POPCNT
and RDRAND still execute; they are not announced, since no processor of the class had them. When
the engine executes SSSE3 and SSE4, the class moves with it. *2026-10-31.*
The engine now executes SSSE3, SSE4.1 and SSE4.2, and the class moved with it: Intel family 6,
model 0x1A, stepping 5 (Nehalem, the first Core i7), the line with SSSE3, SSE4.1, SSE4.2 and POPCNT
and without AVX or MOVBE, its caches that class's (32 KiB level 1 data and instruction caches, a
256 KiB level 2, an 8 MiB inclusive level 3, each processor its own), leaf 2 sending a program to
leaf 4. The brand string stays. MOVBE and RDRAND execute and are not announced. *2026-11-05.*

**A74. A Direct3D 10 dynamic buffer's bytes are undefined after a WRITE_DISCARD map.** The
documentation says so, and a driver hands out renamed memory that holds whatever it held. The
guest's map (`seam/d3d10-inguest.js`, `BufferMap`) may move the buffer onto another of its
storages in guest memory, which holds what it held the last time the buffer was on it. The
pages the program writes travel whole from that storage, and the rest of the GPU copy is what it
was, as a DISCARD's rename carries it. A program that writes part of a buffer after a DISCARD and draws
from the rest reads what Windows would give it: something, not what it wrote before. A buffer is
given another storage only where the engine watches the program's writes, so an unmap sends the
pages written and not the storage. *2026-10-31.*

**A75. A geometry, hull or domain shader is made, and a draw with one bound is skipped.** WebGPU
has none of those stages and none is emulated. Hardware of the levels Direct3D 10 and 11 run at
always has them, so a program checks nothing before relying on them: refusing the create
(`E_NOTIMPL`, as Direct3D 10 here did until now) leaves it holding a null shader it goes on to
bind and release -- Wine's d3d10core and d3d11 tests crash there, hiding every check after. A
draw through the missing stage would put the program's points and triangles where the stage
expands, culls or routes them, so it is not drawn at all; the renderer counts it
(`skipped.stage`) and says so once. A geometry shader with stream output is made in the same
way, its declaration checked as Windows checks it; one made of a vertex shader's bytecode, which
only streams out, is no stage, so its draws are drawn. *2026-10-31.* Hull and domain shaders
are drawn since 2026-11-05 (the tessellator as compute, `d3d10/tessellation.js`), and geometry
shaders and stream output since the same day (`d3d10/geometry.js`): this no longer holds for any
stage.

**A76. IDirect3DDevice7 keeps the earlier interfaces' texture filter, address and border render
states and does not apply them.** D3DRENDERSTATE_TEXTUREMAG, TEXTUREMIN, TEXTUREADDRESS,
TEXTUREADDRESSU and V, and BORDERCOLOR are what Direct3D 3 to 5 set a texture's sampling by; a
seventh-generation device takes the texture stage states for it. Set on that device, they are
stored and read back, and draws go by the stage states. Wine applies them there as well; no
Windows test of either answer was found. Since the call is accepted and not acted on, it is said
as a divergence. Revisit if a Direct3D 7 program is found that samples by them. *2026-11-02.*

**A77. A draw is not refused for a state the pipeline cannot express; it is drawn as near as it
can be, or not drawn, and either is said.** A program is told D3D_OK whatever the device then
does, as a driver tells it. What is accepted and not done in full -- cylindrical wrapping, a
texture transform of three or four coordinates, a sphere map -- is a divergence, a warning said
once. What does not happen at all -- a draw, a frame, an upload, a resolve, an object the GPU
refused -- is a loss, an error said the first time and every 256th with its count, kept in
`report()` (`divergence(api, detail, 'loss')`). Nothing of either kind goes only into a
counter. *2026-11-02.*

**A78. A Direct3D 9 event query is done as soon as it is asked.** D3DQUERYTYPE_EVENT answers TRUE
to the first GetData after its Issue(END), where Windows answers S_FALSE until the GPU has caught
up. A program polls one to keep from running ahead of the GPU, and a present here already holds
it to Direct3D's maximum frame latency (`webgpu/internal/latency.js`): a second wait on the GPU
would cost a frame of round trip to the graphics worker for nothing the program can see. A program
that reads a result back after the event (a lock of a render target) waits on that read itself.
Revisit if a program is found that times its work by how long an event stays pending.
*2026-11-02.*

**A79. A read of the first 64 KiB finds zeros; a store or a fetch there faults.** Windows maps
nothing below 0x10000, so every access there is an access violation. A store through NULL is one a
program may make on purpose: PECompact2's stub makes one to reach the handler it installed, and a
packed setup goes no further unless it faults. A read through a structure pointer its owner has
not set yet is one a program may make by accident and get away with on a fast machine: FMOD's
mixer thread reads NULL+0x54 before its creator sets the pointer, and faulted here. Translated
reads do not test their page (`emit/memory.js`), so a read faulting only where an interpreter
happened to run it would answer the same instruction two ways; it reads zeros everywhere instead.
Revisit if a program is found that relies on a read of the null range faulting. *2026-11-05.*

**A80. Temporary: D3D11CreateDevice refuses D3D11_CREATE_DEVICE_VIDEO_SUPPORT with
DXGI_ERROR_UNSUPPORTED.** A game that plays its videos through Media Foundation or D3D11 video
decoding asks for this flag, so this stands only until an ID3D11VideoDevice over the engine's own
decoder exists. Windows makes a hardware device with video support, and that device answers ID3D11VideoDevice with
the decoder profiles of the GPU. Nothing here decodes video on the GPU; a device made with the flag
and no ID3D11VideoDevice behind it is a promise a program calls through (Wine's d3d11
test_video_support called a method of the null interface and the test process died). Windows
answers DXGI_ERROR_UNSUPPORTED itself for drivers without video support (reference, null, WARP
when named), and Media Foundation and the players built on it fall back to decoding on the
processor then. The one check that expects a hardware device with the flag fails, on purpose,
until then; so does the one that expects every context to answer ID3D11VideoContext, which no
context here does for the same reason. *2026-11-05.*

**A81. A device asked for with the debug layer is refused with
DXGI_ERROR_SDK_COMPONENT_MISSING.** D3D10_CREATE_DEVICE_DEBUG and D3D11_CREATE_DEVICE_DEBUG
load the SDK layers, which Windows has only with its Graphics Tools installed, and a program
asking for them on an end user's Windows gets this answer and makes its device without the flag.
Nothing here validates calls as the layer does or keeps its ID3D11InfoQueue of messages (what a
program did wrong is said in the journal instead, as a divergence), and a device made with the
flag and without the interfaces the layer adds would be one a program could not tell from a
broken one. *2026-11-05.*

**A82. Temporary: a swap chain for composition is refused with DXGI_ERROR_UNSUPPORTED, and one
for a core window with DXGI_ERROR_INVALID_CALL.** IDXGIFactory2::CreateSwapChainForComposition
makes a swap chain that DirectComposition places into a window's visual tree, which nothing here
has yet; a desktop program has no CoreWindow, and Windows answers it so too. A program that
draws through composition (a launcher, a browser engine inside a game) is told its swap chain
cannot be made and falls back to a window's, or says so; the refusal is said in the journal. It
stands until DirectComposition's visuals are drawn into the window's surface. *2026-11-06.*

**A83. Temporary: R10G10B10_XR_BIAS_A2_UNORM is kept as R10G10B10A2_UNORM, without its
bias.** Feature level 11 requires the extended-range format as a swap chain format, and a
program may make its back buffer in it. Its colour channels are 10-bit values with a bias:
a stored n means (n - 384) / 510, so 0..1 sits in the middle of the range and values past it
can be shown on a display that takes them. Here its bits are those of R10G10B10A2_UNORM: a
value v is stored as v * 1023, not v * 510 + 384, so 0..1 is drawn and shown as it is, values
outside it are clamped, and the bits a copy or a map reads are not Windows'. Each device says
so once in the journal when such a texture or buffer is made. It stands until a texture of the
format reads and writes through the bias (an affine step at sampling and at the output) and the
presenter decodes it.
*2026-11-06.*

**A84. Temporary: a draw or dispatch whose stage binds more shader resources than the GPU device
lets WebGPU bind is not made, and the loss is said.** Direct3D 11 promises 128 shader resource
views a stage; WebGPU binds as many sampled textures and storage buffers a stage as the adapter
allows, which is asked for at its most (`webgpu/features.js`) and is far fewer on some (16
textures and 10 buffers a stage on SwiftShader). A typed or raw buffer view is a storage buffer
here, so it counts against the second. The pipeline past the limit cannot be made; the draw is
skipped and said as a loss in the journal, and the program goes on (test_high_resource_count
binds 50 of each). It stands until buffer views past the limit are packed into one binding and
textures past it are bound through WebGPU's binding arrays where a browser has them.
*2026-11-06.*

**A85. Temporary: Direct3D 8 and 9 make a multisampled target with one sample a pixel.**
CheckDeviceMultiSampleType answers D3DERR_NOTAVAILABLE for every type but none, so a program
that asks first renders single-sampled as it chose to. One that asks a create for samples
anyway (CreateRenderTarget, CreateDepthStencilSurface, their Ex forms, present parameters)
is not refused, as Windows refuses a type its caps deny (Wine's test_invalid_multisample):
every card a program of the era meets draws multisampled, and a program that never asked
would stop at a refusal no real machine gave it. The target is drawn and read with one
sample, and the journal says so once. It stands until targets are drawn multisampled and resolved where a
program reads or presents them. *2026-11-06.*

**A86. Temporary: a Direct3D 9 device made for software vertex processing has the 256 vertex
shader constants of a hardware one.** Windows gives a software or mixed device 8192 float
constants (2048 integer and boolean ones), so a program may set registers past 255 and run
a shader that reads them (Wine's test_vertex_shader_constant and test_shader_constant_apply
on such devices). Here the constants live where the guest's command routines and the GPU's
uniform block keep them, 256 a device: a set past the last is D3DERR_INVALIDCALL and a shader
naming such a register is refused, both said in the journal. A program that skins on the CPU
with a large bone palette is the one that meets it. It stands until a software device's
constant file is 8192 registers wide on both sides and the translated shader indexes it.
*2026-11-06.*

**A87. A full-screen Direct3D 8 or 9 device restores its minimised device window when the
application regains the activation.** On Windows the runtime minimises the device window when
the application loses the activation and, regaining it, only sets the window's size (Wine's
test_wndproc reactivate sequences); the window comes back because the person clicked its
taskbar button, which restores it. There is no taskbar here, and the application regains the
activation only by its own calls, so the runtime restores the window itself (SW_RESTORE) where
the window is minimised, and otherwise sets its size as Windows does. What that makes on the
focus window goes to the default procedure, as the runtime's own changes do on Windows, so a
program hears the same messages. *2026-11-06.*

**A88. Temporary: bytes a program writes outside the range it locked in a static Direct3D 8 or 9
buffer of the default or system pool reach the GPU only with a later lock that covers them.**
On Windows such a buffer's lock hands out the memory the GPU reads, so a program that locks four
bytes and writes the whole buffer draws all of it (Wine's d3d9 test_map_partial_range); a
managed buffer, copied from the locked range, does not. Here an unlock sends the range it
locked, as for a managed buffer, and a dynamic buffer's draws read what they reach out of guest
memory. Doing that for static buffers too would put a write watch or a comparison of the whole
buffer on every unlock or draw of buffers that are drawn thousands of times a frame and written
almost never; a program that writes past its lock is relying on undefined behaviour. It stands
until static buffers carry the write watch dynamic ones do and a measurement shows the draws do
not pay for it. *2026-11-06.*

**A89. A cube texture is filtered across its faces' edges.** Direct3D 9 hardware picks one face
for a direction and filters inside it, clamped at its edge; WebGPU defines cube sampling as
seamless, so a linear sample at an edge or a corner blends the texels of the faces that meet
there (Wine's d3d9 test_cube_wrap samples the corner (1, 1, 1) and reads the +X face's texel
alone, where here a third of each of three faces comes back). Reproducing the face-bound filter
would mean sampling every cube as a six-layer array with the face, the coordinates and the
four taps worked out in the shader, on every draw that reads a cube; the seamless result differs
only within a texel of an edge, where it is the smoother one. *2026-11-06.*

**A90. Temporary: Direct3D 9's DEPTHBIAS is made as WebGPU's depth bias, a count of the depth
format's smallest steps, counted as 2^-24 for a 24-bit format.** WebGPU keeps depth24plus as a
24-bit integer on some GPUs and as a 32-bit float on others (SwiftShader, Vulkan on AMD), where
the step is a power of two by the polygon's largest depth: from 0.5 to 1 it is 2^-24 as counted,
and a polygon that reaches 1.0 gets twice the bias asked for (Wine's d3d9 test_depthbias draws
a quad from depth 0 to 1). The bias a program puts on a decal over a wall, at depths below 1, is
the one asked for. It stands until the constant part of the bias is added in the vertex stage,
in depth units, whatever the format. *2026-11-06.*

**A91. The screen a program is told it has is the resolution of the Direct3D device it shows.**
The page is one window: a full-screen device's mode is the screen from its creation or reset, and a
windowed device's back buffer is the screen from its first frame, so a cursor the program normalises
by the screen stays under the pointer and its windows fit what is drawn. The display's own size,
the registry mode, stays the launch's, and leaving full screen goes back to it. On Windows a
windowed device leaves the desktop alone: Wine's d3d9ex test_reset and test_reset_ex, which read
the screen after windowed 640x480 devices have presented and again after a full-screen device is
reset to a window, see 640 and then the registry's 1024 where Windows shows the same size twice.
*2026-11-06.*

**A92. A full-screen Direct3D 9 device's window the program resizes stays the size it was given.**
Windows puts such a window back to the mode's size once, after the messages of the first resize
are processed, and leaves the second resize alone (Wine's d3d9 test_window_position, which Wine
marks todo too). What sets off that one restore is not documented and is seen only by a program
that resizes its own full-screen window; a Reset puts the window back to the mode's size, as on
Windows. *2026-11-06.*

**A93. Temporary: IDirect3DDevice3::ComputeSphereVisibility measures each side by the sphere's
distance to its plane, a touch counting as crossing.** Windows answers two of the spheres in
Wine's ddraw4 test_compute_sphere_visibility otherwise (Wine marks both todo): a sphere of radius
0.04 at depth 0.05 under a projection scaling by ten crosses all six sides, and one of radius 0.25
at (-1, -1, 0.5) under identity crosses near and far as well as left and bottom, half its radius
from them. No one scale of the radius or the distance gives those answers and the test's others
together, so the rule behind them is not known; a program that culls by the answer draws, at
most, an object Windows would have culled. It stands until the rule is found. *2026-11-06.*

**A94. A surface taken out of a flip chain gives no reference to the surface after it.** On
Windows, `DeleteAttachedSurface` of a buffer in a flip chain leaves the surface that followed it
with one reference more than before, which nothing gives back: Wine's ddraw1 test_flip (the
front buffer, after a back buffer is taken from behind another) and test_surface_attachment (the
first back buffer, after the second is taken from the front) expect it, Wine itself marks both
todo, and the test's own comment calls it a DirectDraw bug. Reproducing it would keep that
surface, its memory and its GPU copy alive to the end of the process; a program that counts on it
can only be one that releases a surface once more than it holds it, which here frees the surface
early instead. *2026-11-06.*

**A95. An indexed draw of nothing from a vertex buffer succeeds every time.** Wine's ddraw7
test_draw_primitive finds Windows answering E_FAIL to the first `DrawIndexedPrimitiveVB` of no
indices from a buffer, and D3D_OK to the same call made again at once (Wine marks it todo). What
makes the first one fail is not known: the buffer, the device and the arguments are the same both
times. A draw of nothing draws nothing, and every other draw of nothing in the same test
succeeds, so here it succeeds too. *2026-11-06.*

**A96. A GLSL 1.40 shader keeps what 1.30 deprecated.** The 1.40 specification removes the
deprecated features (built-in matrices and lights, `attribute`, `varying`, `gl_FragColor`) unless
GL_ARB_compatibility is supported, and every desktop driver of the era supports it, so a 1.40
shader written against one uses them. Here 1.40 compiles as compatibility; from 1.50 on, the
`#version` line's profile decides, core by default as the specification says. *2026-11-06.*

**A97. A GLSL 1.10 shader may use the non-square matrix types.** They came with 1.20; the
front end accepted them in 1.10 before 1.30 and later were added, and a program that relies on
it compiled here then. Nothing else of 1.20 is taken into 1.10. *2026-11-06.*

**A98. A context drawing into a bitmap of another depth writes nothing past the bitmap's bits.**
A context made on a memory DC draws on the processor into the bitmap selected there, as Windows'
generic renderer does. Given a bitmap whose depth is not the pixel format's, Windows writes the
format's rows over it and past its end; here the rows are converted to the bitmap's depth and
nothing beyond its bits is written. *2026-11-06.*

**A99. A DC from D3DKMTCreateDCFromMemory is read from the context's own buffer.** Windows reads
the memory the DC was made over live, so a GL context on it sees bytes written there afterwards
(Wine's test_d3dkmt_rendering expects 0xa5a5a5 and marks it todo); here what the context drew
is read back from its buffer. *2026-11-06.*

**A100. Framebuffer objects are shared between contexts wglShareLists joins.** GL 3.0 core keeps
framebuffer objects per context; GL_EXT_framebuffer_object, which predates it, shares them with
the other objects, and Windows drivers share both kinds. Here every framebuffer object is in the
share group. A core-profile context may need the specification's rule; revisit when they exist.
*2026-11-06.*

**A101. wglChoosePixelFormatARB's best format comes first in the format list's own order.** The
extension leaves "best" to the implementation; the formats are listed accelerated before
generic, and among equals the smaller depth first, and that order is the answer's.
*2026-11-06.*

**A102. An attribute wglChoosePixelFormatARB does not know matches every format.** The
specification says the call fails with ERROR_INVALID_DATA; programs pass attributes of extensions
they found in another driver's string, and refusing them leaves such a program without a format.
The attribute is reported once as a divergence. *2026-11-06.*

**A103. An OpenGL depth or stencil texture is kept with both aspects.** It lives as
`depth24plus-stencil8`, or `depth32float-stencil8` where the device has that feature; a float
depth on a device without it keeps 24 bits. The draw pipelines carry a stencil state, which
WebGPU refuses over a depth-only format. *2026-11-06.*

**A104. glTexImage of a compressed internal format keeps an uncompressed twin.** Section 8.5
allows any format at least as precise as the one asked for; the internal-format query answers the
one asked for, and glGetCompressedTexImage the blocks. *2026-11-06.*

**A105. Temporary: a 16-bit normalised OpenGL texture on a device without
`texture-formats-tier1` lives as half floats,** 11 bits of precision instead of 16. A program
that relies on the full 16 bits (a height map, a depth stored in colour) reads it coarser.
*2026-11-06.*

**A106. A texture WebGPU does not filter is read nearest:** a 32-bit float one on a device
without `float32-filterable`, and a depth one sampled as a value. The dropped filter is reported
once as a divergence. *2026-11-06.*

**A107. Integer client values written into a narrower integer internal format are clamped to its
range.** The specification leaves the result undefined. *2026-11-06.*

**A108. Out-of-range values written into R11F_G11F_B10F follow section 2.3.4.3's rule for the
small floats:** negatives become 0, finite values past the largest become the largest finite
value (65024 for the 11-bit channels, 64512 for the 10-bit one), and +Inf stays infinite.
*2026-11-06.*

**A109. The images OpenGL 3.0 added refuse a border.** A 3D, array or sized-format image with a
border other than 0 is GL_INVALID_VALUE, as the core profile has it; borders came out of use with
the compatibility formats they are still kept for. *2026-11-06.*

**A110. Temporary: a framebuffer attachment this renderer cannot draw into answers
GL_FRAMEBUFFER_UNSUPPORTED:** RGB9_E5, compressed formats and 3D slices. The specification
allows the answer for any combination an implementation cannot draw. Integer formats are drawn
into by GLSL programs; a draw without one into an integer buffer draws nothing and says so.
*2026-11-06.*

**A111. wglGetProcAddress hands out every function implemented, whatever reports it.** A
function of a version past the context's, or of an extension the string does not name, is
obtainable once it is implemented here, as Windows drivers hand out every function they have:
the version and extension strings are the promise a program reads, the pointer is not. Wine's
opengl32 test calls 4.3 and 4.5 framebuffer queries and EXT_direct_state_access forms through
pointers it never checks. A function not implemented is still null. *2026-11-06.*

**A112. A GLSL uniform block declared shared or packed is laid out as std140.** Both leave the
layout to the implementation, which a program reads back through glGetActiveUniformsiv; std140
is one such layout, and the one the block reader already writes. *2026-11-06.*

**A113. Temporary: ten uniform blocks a stage and twenty combined,** below OpenGL 3.1's minimum
of twelve a stage. WebGPU binds twelve uniform buffers a stage and the fixed-function and program
blocks take two of them. A program that uses more blocks fails to link and says why.
*2026-11-06.*

**A114. A uniform block whose binding point holds nothing, or a range past its buffer, reads
zeros** and the draw reports it once as a divergence; the specification leaves the result
undefined. *2026-11-06.*

**A115. Temporary: a shadow lookup with an explicit level or gradients reads the base level, and
a bias is dropped.** WGSL compares depth only at the base level outside an implicit-level lookup
in a fragment stage. *2026-11-06.*

**A116. An integer texture read through texture() loads the nearest texel, clamped, whatever its
filter and wrap modes.** Integer textures are not filterable; GL makes a filtered integer texture
incomplete, while programs that sample one with the default filter expect a value. *2026-11-06.*

**A117. A fragment output narrower than its colour buffer is written as (x, y, 0, 1),** an output
of another type than its buffer's is converted to it, and a buffer no output covers is written
zero; the specification leaves the last two undefined. *2026-11-06.*

**A118. A second-source fragment output (index 1) is written and blended by** where the device
has dual-source blending; where it has not, a draw blending by it is a loss (A185).
GL_MAX_DUAL_SOURCE_DRAW_BUFFERS is 1, as 3.3 requires. *2026-11-07.*

**A119. Temporary: an OpenGL timer query reads the processor's clock.** GL_TIME_ELAPSED is the
nanoseconds of the page's clock between glBeginQuery and glEndQuery as the calls are made, and
GL_TIMESTAMP the clock at glQueryCounter; the device's own timestamps (`timestamp-query`) are not
read. A program timing its passes sees how long it took to issue them, not to draw them.
*2026-11-07.*

**A120. Temporary: wglSetPbufferAttribARB takes only the values a pbuffer already has.** A
render-texture pbuffer's mipmap level or cube face is fixed when it is made; asked to change,
the call fails. Rendering into another level or face of a bound pbuffer texture is the case it
leaves out. *2026-11-07.*

**A121. Temporary: a pbuffer's DC is a memory DC that draws nowhere.** GDI drawing into it is
accepted and not shown through GL, which reads only what a context drew there. Releasing the DC
keeps it alive until the pbuffer is destroyed, as the pbuffer's own DC is not the caller's to
end. *2026-11-07.*

**A122. A pbuffer is at most 8192 by 8192,** WebGPU's least 2D texture size, and every pixel
format but the generic renderer's draws to one. *2026-11-07.*

**A123. A context's commands are replayed on the device when it stops being current or is
deleted;** glFlush and glFinish leave them recorded until a swap or a read needs them. Another
context reading the drawable then sees what was drawn, as the specification promises after a
flush, without a replay at every glFlush a program issues each frame. *2026-11-07.*

**A124. The swap interval belongs to the window,** as Windows drivers keep it, not to the context
that set it; a window starts at 1. *2026-11-07.*

**A125. Every double-buffered pixel format exchanges its buffers on a swap**
(PFD_SWAP_EXCHANGE): after a swap the back buffer holds what the front held. *2026-11-07.*

**A126. A mapped buffer's pointer is on a 64-byte boundary,** offset by the mapped range's own
offset within one (`address % 64 == offset % 64`), as drivers give, which programs writing it
with aligned SIMD stores rely on. *2026-11-07.*

**A127. An OpenGL cube map is always filtered across its faces' edges,** as
GL_TEXTURE_CUBE_MAP_SEAMLESS asks: WebGPU's cube sampling knows no other way. A program that
leaves the switch off, as its default is, gets the seamless filtering every driver of a 3.2
card gives anyway. *2026-11-07.*

**A128. Temporary: transform feedback's buffer binding points belong to the context,** not to each
transform feedback object as OpenGL 4.0 has it: binding another object keeps the buffers bound.
A program that keeps one object a stream and switches between them mid-frame captures into the
buffers it bound last. *2026-11-07.*

**A129. Temporary: what transform feedback writes stays on the device.** A buffer it captured
into draws as captured, and a read of it on the processor (glGetBufferSubData, a map) answers
the bytes the program last gave it, said as a loss each time. *2026-11-07.*

**A130. A geometry shader that writes gl_Layer, drawing into a layered framebuffer, has its draw
recorded once for each layer,** into that face or array layer, keeping the primitives sent to it
as A140 does for viewports (the two together are a draw for each pair); the layers are the fewest
any layered attachment has. Into a framebuffer that is not layered gl_Layer is not read. A clear
of a layered framebuffer is recorded once a layer. A 3D texture attached whole stays
GL_FRAMEBUFFER_UNSUPPORTED, as its slices are. *2026-11-07.*

**A131. The last vertex provokes by turning the primitive round,** not by a pass of its own: a
draw with a flat value under GL_LAST_VERTEX_CONVENTION lists each primitive from its last
vertex, its winding kept, and a quad splits on the diagonal to its fourth vertex, which provokes
it under either convention as table 13.2 has it. A polygon keeps its first. *2026-11-07.*

**A132. GL_RASTERIZER_DISCARD is saved with the enable group,** as every capability glEnable
takes is in this renderer's attribute tables; the 4.6 compatibility table names it in no group.
*2026-11-07.*

**A133. Temporary: the named calls (4.5) and the 4.2 to 4.5 texture image calls run when they
are reached, even while a display list is compiled.** A named framebuffer call made through a
bound form a list records (glDrawBuffer(s), glReadBuffer, the clears) says so when a list is
open. A compatibility-profile program that compiles them into lists gets them made once, at
compile time. *2026-11-07.*

**A134. glCopyImageSubData asks completeness only past the base level,** as Mesa reads section
18.3.3, which asks it of the whole texture: a program that copies out of a texture whose chain
it has not finished copies what the levels hold. *2026-11-07.*

**A135. Temporary: glCreateTextures refuses the targets with no texture kind here** (rectangle,
buffer, cube map array, multisample) with GL_INVALID_ENUM, and says so. *2026-11-07.*

**A136. glInvalidateNamedFramebufferData and SubData drop nothing:** the contents stay as they
were, which is what a program may find after an invalidation anyway; the checks are made.
*2026-11-07.*

**A137. glNamedFramebufferTexture of a whole cube map or array attaches it layered** (A130): a
draw reaches the first face or layer unless a geometry shader chooses another. *2026-11-07.*

**A138. glClearTexImage reads its one pixel as it lies in the program's memory,** with no
unpack state and no unpack buffer, as glClearBufferData does by section 6.3.2. *2026-11-07.*

**A139. Temporary: an image copy the device cannot make, of pixels only the device holds, is a
loss** (a level drawn on the device copied as blocks into texels, a renderbuffer on the
processor path): said each time, the destination left as it was. *2026-11-07.*

**A140. A geometry shader that writes gl_ViewportIndex has its draw recorded once for each of
the sixteen viewports,** through that viewport's rectangle, depth range and scissor, and each
keeps the primitives sent to it: a vertex whose index is another's is put on one point outside
the clip volume. The index is read at every vertex (GL_VIEWPORT_INDEX_PROVOKING_VERTEX is
GL_UNDEFINED_VERTEX), and one past the last viewport draws nowhere. WebGPU has one viewport a
draw; the cost is fifteen draws of nothing, on the GPU. Every other draw goes through the first
viewport. *2026-11-07.*

**A141. Temporary: a 64-bit attribute (glVertexAttribLFormat) is read at single precision,** as
a double array of glVertexAttribPointer already is: no shader here takes a double input. It is
said once. *2026-11-07.*

**A142. A binding point's stride of zero reaches the device as a per-instance slot one element
wide,** read at element zero by every instance: the pixels of a stride of zero, through the
gather path every other per-instance array takes. *2026-11-07.*

**A143. Temporary: after a binding call, GL_VERTEX_ATTRIB_ARRAY_POINTER answers where the
attribute reads** (the point's offset and the relative offset), not the last
glVertexAttribPointer's argument. *2026-11-07.*

**A150. Temporary: a multisample texture is kept with one sample a texel,** as every framebuffer
here is drawn single-sampled (A85 for Direct3D): a fetch of any sample reads that texel, sample
positions answer the pixel's centre, and a sample mask without its first bit is said and still
draws. *2026-11-07.*

**A151. Temporary: a buffer texture is a 2D texture 8192 texels a row,** rebuilt from the
buffer's bytes when they change: textureSize is exact up to 8192 texels and counts whole rows
past them, and what transform feedback wrote on the device is not seen (A129). *2026-11-07.*

**A152. Temporary: an assembly program reads a swizzled texture unswizzled,** and says so each
time. *2026-11-07.*

**A153. GL_MAX_RECTANGLE_TEXTURE_SIZE is GL_MAX_TEXTURE_SIZE (2048), and
GL_TEXTURE_BUFFER_OFFSET_ALIGNMENT is 4:** nothing here needs a coarser boundary. *2026-11-07.*

**A154. glTexBuffer and glTexBufferRange run when they are reached, a list open or not,** as the
buffer object calls do. *2026-11-07.*

**A170. Every GLSL version from 1.10 to 4.60 is taken;** a feature the WGSL emitter does not
write fails the program's link with its reason rather than the shader's compile, so a shader of
the version compiles as the specification's grammar and rules say. *2026-11-07.*

**A171. Temporary: the compute limits are WebGPU's defaults,** below GL's minimums: 256
invocations a work group against 1024, 256 by 256 by 64 against 1024 by 1024 by 64, and 16 KiB of
shared memory against 32 KiB. *2026-11-07.*

**A172. The vertex, tessellation and geometry stages have no storage blocks, atomic counters or
images:** their GL_MAX_* answer 0, which the specification allows; WebGPU writes no storage from a
vertex stage. *2026-11-07.*

**A173. Temporary: a stage has at most 4 image uniforms** (WebGPU's storage textures) against
GL's 8, **storage buffer offsets are multiples of 256**, a counter range off 256 being a loss
though glBindBufferRange takes word offsets as GL does, and **a stage binds 8 storage blocks and
counter buffers together.** *2026-11-07.*

**A174. imageAtomic* is refused, a loss at the dispatch or draw:** WGSL has no atomics on
textures. The image formats WebGPU cannot store to (rg16f, r11f_g11f_b10f, the 16-bit normalised
ones and others) are taken by glBindImageTexture and refused where a shader uses them. *2026-11-07.*

**A175. Shared and packed storage blocks are laid out as std140;** a block an atomic function
touches is atomic words throughout; signed min and max on block words and every atomicCompSwap
are compare-and-swap loops; memoryBarrier*() outside a compute shader emits nothing, an
invocation's own accesses being in its order already. *2026-11-07.*

**A176. textureQueryLod is worked out from the coordinates' derivatives** (the specification's
lambda over the base level's size, a cube map's on its major axis' face), x clamped to the
texture's levels: WGSL has no query of the level the device takes, and the sampler's minimum and
maximum level and its filter are not weighed. *2026-11-07.*

**A177. interpolateAtCentroid and interpolateAtSample answer the input at the pixel's centre,
interpolateAtOffset the input moved along its derivatives:** every target here is drawn with one
sample a pixel (A85, A150), so its centroid and its samples are its centre; WGSL has no
interpolation at an offset, and a linear step along dFdx and dFdy is exact for an input linear in
window space and close for a perspective one. *2026-11-07.*

**A178. Temporary: a double is carried as an f32** (WGSL has no 64-bit float): its arithmetic,
its uniforms (glUniform*d keep what an f32 holds, and glGetUniformdv answers it), its vertex
inputs (glVertexAttribLPointer, said once), and its varyings are single precision. A double in a
uniform or storage block keeps its eight bytes and layout: it is read into the f32 rounded to
nearest, and written back as the double that f32 is; packDouble2x32 and unpackDouble2x32 go
through the same conversion. A dvec3 or dvec4 input takes its two locations. *2026-11-07.*

**A179. Temporary: an array of subroutine uniforms is refused** where a call indexes it (a
syntax error at the call): a subroutine uniform is one function's name. A draw is made with the
program's module written for the functions the program chose (glUniformSubroutinesuiv), each
choice its own module. *2026-11-07.*

**A180. Temporary: gl_CullDistance culls nothing,** said once a draw: WebGPU clips a primitive by
distances (clip_distances) and has no culling by them, which GL makes of the whole primitive when
one distance is negative at every vertex. gl_HelperInvocation is false: a helper invocation runs
no store here, so a shader that steers its writes by it does the same. *2026-11-07.*

**A181. Temporary: some limits answer below OpenGL 4.6's minimums,** the version being reported
because every entry point of it is here: textures 8192 texels a side (16384 asked), 3D textures
2048 a side and 256 layers (2048 asked), which are WebGPU's defaults every adapter gives; 16
texture units for every stage and for all of them together (80 asked together), each sampler
of a program being bound for every stage and WebGPU giving a stage 16 sampled textures and 16
samplers; 4 draw buffers and colour attachments (8 asked; WebGPU's 32 bytes of colour a sample
do not hold eight wide targets), 32 varying components; with A171 and A173 for compute and
images. A program that sizes itself by the queries works; one that takes the minimums for
granted is refused at the call that goes past them. *2026-11-07.*

**A182. Temporary: a geometry shader's vertex streams past 0 are emitted nowhere,** which is what
GL makes of them without transform feedback (stream 0 alone is rasterised); a program that
captures while its geometry shader emits to another stream does not link, and the primitive
queries of those streams count nothing. *2026-11-07.*

**A183. Every context reports the same extensions, whatever version and profile it was asked
for:** a 2.1 context names GL_ARB_compute_shader, a core 4.6 context GL_ARB_window_pos, as a
Windows driver's compatibility contexts do. An extension is reported when every command it
defines answers here and what it adds works; one that 4.x made core is reported with that
version's decisions (A178 for GL_ARB_gpu_shader_fp64, A180 for GL_ARB_cull_distance, A182 and
A195 for GL_ARB_transform_feedback3's streams), and a shader of an earlier version that enables
it compiles what the version has of it (`glsl-versions.js`). *2026-11-07.*

**A184. An extension's own spelling of a later version's GLSL name is that name:**
textureQueryLOD (GL_ARB_texture_query_lod) is 4.00's textureQueryLod, anyInvocationARB and its
kin (GL_ARB_shader_group_vote) 4.60's votes, gl_BaseVertexARB, gl_BaseInstanceARB and
gl_DrawIDARB (GL_ARB_shader_draw_parameters) 4.60's variables, as gl_InstanceIDARB is
gl_InstanceID. The extensions' wording differs from the versions' in places (the vote
functions' result where invocations are inactive); the version's behaviour is the one run.
*2026-11-07.*

**A185. Dual-source blending (3.3, GL_ARB_blend_func_extended) needs the device's
dual-source-blending;** without it, with more than one draw buffer (GL_MAX_DUAL_SOURCE_DRAW_BUFFERS
is 1), or without a GLSL fragment shader to give a second output, a draw blending by GL_SRC1_* is
a loss, said. The factors are taken by glBlendFunc* whatever the device, as the specification
has them, so the refusal is at the draw. *2026-11-07.*

**A186. Temporary: GL_CLAMP_TO_BORDER clamps to the edge,** said when such a texture is
sampled: WebGPU has no border address mode, so outside the texture its edge's texels are read
where GL reads the border colour (a shadow map whose border marks "lit" is the visible case).
Emulating it is a coordinate test in every shader that samples the texture. *2026-11-07.*

**A190. A geometry shader after tessellation runs over the most the tessellator may make:** the
evaluation shader as a compute pass over every index the tessellator's room holds and the
geometry shader's passes over as many primitives, both reading how many indices it wrote from
its arguments on the GPU, an invocation past them making nothing (Direct3D 11's way, whose
passes these are). The work is sized by the room, not by what was made. *2026-11-07.*

**A191. Temporary: transform feedback of tessellated output without a geometry shader is refused,
as a loss:** the evaluation shader is the draw's vertex stage there, and no pass keeps what it
makes. Through a geometry shader it is captured (A190). *2026-11-07.*

**A192. Default tessellation levels are kept as glPatchParameterfv gives them;** clamping and
rounding by the spacing happen in the tessellator when a draw reads them, so a query answers what
was set. *2026-11-07.*

**A193. GL_ARB_tessellation_shader is reported,** a shader of 1.50 to 3.30 enabling it compiling
both stages, `patch`, barrier() and the tessellation constants as 4.00 has them; what tessellation
draws is A190 to A192's. *2026-11-07.*

**A194. Patches reaching the immediate drawing path are a loss:** that path has no tessellator.

**A200. Temporary: pixel transfer reaches colour only, at 8 bits a component.** Scale, bias and
GL_MAP_COLOR's maps apply where an image is RGBA bytes: what glDrawPixels and the byte path of a
texture upload unpack, and what glReadPixels reads before it packs it. A luminance image is
expanded to RGBA before its transfer and each channel transferred, rather than the luminance
alone. GL_MAP_STENCIL, the index shift and offset and the depth scale and bias are kept and
answered and change nothing, which setting one says once: nothing here carries indices,
stencil or depth through a transfer. *2026-11-07.*

**A201. The imaging subset is absent:** GL_ARB_imaging is not reported, so its 1.2 getters
(glGetColorTable, glGetConvolutionFilter, glGetSeparableFilter, glGetHistogram, glGetMinmax)
are not obtainable, and 4.5's glGetn forms of them refuse every target with GL_INVALID_ENUM, as
a context without the subset does; glPixelTransfer refuses the subset's names. *2026-11-07.*

**A202. GL_MAX_PIXEL_MAP_TABLE is 256** (the minimum is 32), and GL_MAX_EVAL_ORDER stays at
the minimum, 8. *2026-11-07.*
*2026-11-07.*

**A195. Temporary: a draw of a capture (glDrawTransformFeedback) draws what its first buffer's
last capture wrote,** counted on the device by the buffer's counter as Direct3D's DrawAuto is: a
capture into the same buffer by another object since is the one drawn. Only stream 0 is ever
captured into, so a draw of another stream draws nothing. *2026-11-07.*

**A196. Temporary: a draw of a capture through a geometry shader or tessellation, or captured
again, is a loss,** as their passes are laid out on the processor for a count only the device
has; a line loop of it is drawn without its closing line, and GL_PRIMITIVES_GENERATED does not
count it. Each is said. *2026-11-07.*

**A210. GL_ARB_texture_cube_map_array is reported,** a shader of 1.30 or later enabling it naming
the cube map array samplers and taking every overload of the functions its version has over them.
*2026-11-07.*

**A211. Temporary: a texture view in another format of its original's class reads the
original's texels in the original's format on the device,** said as a loss: WebGPU views a
surface only in the format it was made in. On the processor a view reads and writes its
original's bytes where the original keeps its own format's bits (a legacy RGBA8 level's RGBA
among them); where it keeps another's (a legacy format's RGBA8 in an array) the view holds no
level, said when it is made. *2026-11-07.*

**A212. Temporary: a view gathering a cube map's faces into an array** (a 2D array or cube map
array view of a GL_TEXTURE_CUBE_MAP) **holds no levels and samples as incomplete,** said when it
is made: a cube map's faces are separate images here, which no one level reads. A view of one
face, of all six as a cube, and every view of a 2D array or cube map array's layers read their
original. *2026-11-07.*

**A213. Temporary: GL_ARB_texture_view is not reported** while A211 and A212 stand;
glTextureView is 4.3's, handed out with the version and answering. *2026-11-07.*

**A214. A layer of an array (a cube map array's layer-face among them) attached by
glFramebufferTextureLayer is drawn into as a 2D image;** a whole array or cube map is layered
(A130). A 3D texture's slice is not attached: GL_INVALID_OPERATION, as no draw here reaches one.
*2026-11-07.*

**A215. Temporary: an image kept in a sized format's own bytes and a copy the device makes skip
the pixel transfer** (A200), and say so once while the transfer changes anything: the transfer
runs on 8-bit RGBA, which these never are here. An integer format's image and a compressed one
take no transfer, as the specification says. *2026-11-07.*

**A220. Temporary: a vertex program's inputs (GL_PROGRAM_INPUT) are what glGetActiveAttrib
lists,** the conventional attributes among them with no location, and each by its name with an
array size of 1; gl_VertexID and gl_InstanceID are not listed. The two calls answer one list
(4.6 section 7.3.1.2), and both leave these out alike. *2026-11-07.*

**A221. Temporary: a stage's inputs and outputs declared in an interface block are not listed**
among a program's inputs and outputs; the stage's other variables and the built-ins it reads or
writes are. *2026-11-07.*

**A222. Every member of a shader storage block is an active buffer variable,** used or not, as
every member of a uniform block is an active uniform here, and **an input or output between
stages with no `layout(location)` answers GL_LOCATION -1:** locations between stages are matched
by name here and assigned to none. *2026-11-07.*

**A230. A SPIR-V program's resources answer the names its GLSL was written with,** not the
module's OpName strings and not the empty string: the attribute at location 0 is `_a0`, the
uniform at location 4 `_l4`, the sampler at binding 2 `_t2`, the uniform block at binding 1 `_U1`
and its members `m0`, `m1`, the storage block at binding 0 `_B0`, a fragment output `_f0i0`
(location, index). GL_ARB_gl_spirv leaves name reflection to the implementation; these names
are what the GLSL front end links by, and two stages naming one resource alike is what makes a
binding or a location one resource across them. Between stages a variable is the member `v` of
a block named by its location and component, so A221 leaves it out of the program's lists.
*2026-11-07.*

**A231. Temporary: GL_ARB_gl_spirv is not reported,** while a SPIR-V shader is written back as
GLSL and takes what the GLSL path takes and no more: a program that finds it may prefer its
SPIR-V path, and one that does not keeps its GLSL one, which is drawn right.
`glSpecializeShaderARB` is obtainable, as 4.6's `glSpecializeShader` is (A111), and
GL_SHADER_BINARY_FORMATS lists SPIR-V's format. *2026-11-07.*

**A232. A specialization that fails leaves its shader unspecialized:** glSpecializeShader may be
called on it again, with other constants or another entry point. The extension forbids
specializing a shader specialized already and says nothing of one whose specialization failed.
*2026-11-07.*

## B. From measured optimisation work

**The vendored full-system emulator is replaced by a user-mode x86 → wasm translator of this
project's own (cork), behind the unchanged `cpu` contract, migrated in a hybrid mode with the
emulator as the fallback tier and the oracle.** Measured on a 2004 OpenGL title on an Apple M4
Pro: 1–3 ns per guest instruction, 10–25× slower than the processor the title was written for,
and 58 of a 92 ms frame in the emulator on a plain view. The cost is structural to an emulator
built to boot an operating system (paging on every access, x87 as a stack in memory, one basic
block per unit, an interpreter for the rest); per-title kernels that hand-replace hot loops buy
one program a frame, not the engine a property. Graphics are on the GPU, so the processor side
is the ceiling for every title; the target is 0.5–1 ns per instruction as an engine property.
Design, scope and milestones were `roadmap/cork-x86-translator.md`, now in git history. *2026-09-20.*

**Translated code tests a page-flag table before every access instead of relying on the
wasm bounds check alone.** The design's §5.1 named the browser's bounds check as the only
check; a wasm trap, though, unwinds the region function and the registers held in its locals
with it, so a precise fault after a trap would need every dirty local written back before
every access: more stores than the test costs. The test is a shift, a byte load and a branch
per access (a second load when the access may span a page); it is also what delivers
self-modifying-code detection (a store into a page holding translated code leaves `stale`
after the instruction), the null page and, later, the memory layer's protections, none of
which the emulator gave a program. It stays measured: the plan's 2.9 reports the share the
check holds on the target title, and elision for a base register already checked in the same
block is the named follow-up if the share is material. *2026-09-20, cork 2.4.*

**A call into the bridge from translated code is the `trap` import called from inside the
region, as the design had it; a region holding x87 registers in its locals takes a `trap`
exit instead.** The exit form came first (the same crossing count on paper, no writeback and
reload machinery, no re-entrancy question), and the synthetic measurement showed why the
design wanted the call: the exit and re-entry through the host's slice loop cost about
0.6 µs per call on top of the bridge's own dispatch, and the import-calling loop ran slower
under hybrid than on the emulator. The call writes the state block back and reads it again
around the handler (the prologue and epilogue halves the region already has), so a
callback's nested slices see a complete block and the region's locals are refreshed after;
the x87 locals live in a per-block permutation those halves do not know, so a region with
x87 in it keeps the exit, which the hybrid host answers through the same handler. *2026-09-20,
cork 4.2, revised.*

**Each translated region is its own wasm module, not one module per batch.** The design's
2.6 put a batch of regions into one module to keep the module count down; the translation
cache (2.8) keeps regions, since a batch is what the sampler happened to gather and is never
the same twice, and a module per region is the record the store can hold and the unit a
page write drops. The cost is the helpers repeated per module (a few kilobytes) and an
instantiation per region rather than per batch, both measured small against the emitting a
hit saves; the module count is bounded by the regions live, which the invalidation already
bounds. *2026-09-20, cork 2.8.*


**B12. The audio pump, the DirectSound/waveOut/MSS buffer reads and the hosted MPEG provider's
decoder callbacks stay on the engine's own thread rather than moving to a second worker, for
now.** A split needs the buffer *writes* copied into a block an audio worker owns (the emulator's
wasm memory isn't shared) and cursors travelling back through an `Atomics`-readable control block:
real work, not a refactor. Measured over 60 000 scheduler turns on a real title's menu: the pump's
self time was 921 ms of a 186 s run, 0.5% of wall, 11 µs a turn; under one percent of the thread
is not what to move first. Build the seam when a measurement says the pump has become material
(many tracks, a resampler on each), not before. *2026-09-12, `30f81135`.*

**A redistributable runtime is ours to reimplement, regardless of who shipped the copy.** The
project's original rule (only Windows system libraries are reimplemented, everything a game ships
is run as real x86) is exactly right for a program's own code, but a profile of one title at its
menu found 27.3% of the machine in a bundled MP3 decoder and 10.1% in its archive library, against
0.2% in this engine's own thunks: a third of the machine decoding audio that then arrives at 60% of
real time, heard as a broken stream, unfixable anywhere in the sound path because the path measured
clean at every stage. **The decision:** a library is ours to reimplement when it is a
redistributable runtime with a stable published API, whoever's copy it is: a middleware sound
engine, a video codec, an archive library shipped in hundreds of titles is the same class of act as
reimplementing DirectSound, and helps every title on that path (rule 4's own test). Safe because a
decoder is a pure function (bytes in, samples/frames out, no state of the program's own) and the
`media` layer already crossed this line for cinematics. What stays off-limits: the program's own
code, and anything chosen by which title shipped it. A substituted runtime reports its divergence
like any other, and is picked for what the target titles actually need. *2026-09-11, `d4fe29ac`.*

**Uniform blocks live in one ring buffer, bound at a dynamic offset, rather than one buffer per
draw.** Measured before: ~140 bind groups created per frame on a title's menu, none reused over
100,000 draws, because a bind group is keyed on the buffers it names and every draw had its own.
After: 71 groups created in total against 890,000 reuses: the cache now lives for the backend's
life, not one pass. The ring wraps rather than growing; a write is ordered after every prior
submit, so a wrap can only overwrite a finished frame's blocks. *2026-09-11, `dae4d203`.*

**One hardware sampler serves every draw (linear, repeating); the Direct3D sampler state (address
modes, filtering, mip mode) is carried in the uniform block and applied in the shader.** Traced on
this project's own development adapter (Parallels' WDDM device through Dawn's D3D12 backend): a
title's main-menu sky alternated between its cloud texture and a flat wash of its corner texel for
seconds, and across dozens of controlled probes the sampler a draw *binds* on this device was
provably not the sampler it *samples with*, switching every 51 frames regardless of frame rate, in
no arrangement of bind groups. Address modes fold/hold the coordinate inside the outermost texel
centres so the one repeating sampler can't blend across an edge; point filtering snaps to texel
centres; mip level is chosen explicitly from derivatives taken beforehand. Costs a few operations
per sample and three words in the block; doesn't cover anisotropy or border colour, neither seen
in use by the target titles. *2026-09-11, `dae4d203`.*

**A sound middleware's bundled MPEG (Layer 3) decoder is hosted as the ASI provider it loads by
convention, decoding through WebCodecs, rather than run as emulated x86.** The redistributable
scans a directory for `*.asi` files and calls the registered provider directly; run as guest code
it took a fifth of the machine's retired instructions and delivered music in bursts. Three things
learned only from the running middleware: the open-time size argument is its own 4 KiB read
buffer (not the stream length); every read continues from the last stop, since a read naming an
offset outside the held window was measured copying a negative count; a seek serves fresh from the
named byte, dropping whatever was already held. Measured over 60s at the main menu: starved audio
frames 0 vs 9091 (189 ms of invented silence) and engine frames 2007 vs 1232, with the shipped
decoder gone from the guest's instruction share. *2026-09-11, `6717fb63`.*

**The guest's clock is credited with all real time between two turns (not only slices the guest
ran), and a DirectSound buffer is read out to its write cursor rather than only as far as its play
cursor.** Measured: about a tenth of every block asked for came back empty (a constant crackle)
while the ring never held more than a few hundred frames. The clock omission made a DirectSound
buffer's play cursor fall behind the real device by the loop's own uncredited share; reading only
to the play cursor meant a turn longer than one device block was a click. After both: no starved
block once music started, ring holding 50–100 ms throughout. *2026-09-11, `0d2ad55b`.*

**A zero-timeout wait is its own primitive (it takes what is ready and never queues the thread),
rather than a wait with no time in it.** A stale queue entry from treating a poll as a real wait
handed a later signal to a thread that had moved on to waiting on something else entirely; measured
on a title whose sound-loader thread polled a completion event every loop pass and then waited on
its own quit/data pair: the stale entry woke it with the wrong index, it read that as quit and
exited, and every sound effect after that was requested and never loaded. *2026-09-11, `f54a8136`.*

**A program's registry writes and its own file-based profile travel inside the session (packed
under a name no real path can have), laid onto the mounted volume after the bundle is mounted, not
before.** A title's options and profile name are registry values while its save profile is a file;
carrying only files lost the registry half, and laying session files on *before* the bundle mount
put a fresh writable layer over them, erasing a restored profile before the program's first
instruction (which then cleared the registry value naming the now-missing file). Pinned by an
integration test mounting a bundle over a session. *2026-09-11, `603384a1`.*

**The package carries its own vendored emulator artifacts and ships built minified, without a
source map.** `createApp` finds the module and its binary beside the built package unless a part
is named to override it; the audio worklet ships as its own export since an audio thread loads it
by URL rather than importing it. *2026-09-11, `603384a1`.*

**Every COM interface gets one shared table of stubs, keyed by the method list's identity, with
the object found from the interface pointer the call arrived on, not a table of stub slots per
published object.** A title in a match published 1,216 objects into a table of 16,384 slots and
exhausted it; every later publish was refused as "out of video memory," and the program's own
retry-without-picture behaviour (white textures, remade every frame) ran the guest heap out too.
After: 5,079 objects on 210 stubs, 1,606 slots in use, textures stable near 1,600, heap steady at
168 MB. An object now costs two words (table pointer, state word). *2026-09-11, `17ef05ad`.*

**A picture codec (JPEG) a program ships (`ijl15.dll`) is hosted by its export contract (six
functions over one structure), the same rule as the MPEG provider.** The title's own inner loops
(Huffman, inverse transform, colour planes) cost 5.7% of the guest's time in a match on top of the
title's own code, with each texture arriving mid-fight on the frame's critical path. Two facts
learned from the program's own memory rather than a header: the DIB pointer is the structure's
second word with channel count before colour space on both sides, and rows deliver in the picture's
own order for a positive height (an inverted delivery showed as upside-down atlas tiles). Checked
byte-for-byte against the shipped textures decoded a second way. Measured: the library gone from
the guest's share, 1,877 decodes of a map load costing 1.9 s of host time total. *2026-09-11,
`79276f0a`.*

**A ready thread's turn is chosen by priority the way Windows composes it for a normal-class
process** (base 8, moved by the seven values a normal process may set, `IDLE`→1, `TIME_CRITICAL`→
15; equal-priority threads round-robin as before), **with starvation control (four seconds of
guest time unserved outranks everything for one turn) and no wake boost.** `SetThreadPriority` had
been accepted and silently ignored. Measured: a title's own streaming thread raises itself to
`TIME_CRITICAL` when its sound library comes up; with priority honoured, the burst of stale
(re-played) audio bytes right at the menu's first draws fell from 158–168 KB to 8.5–24 KB per cold
start. No wake boost because the measurement never asked for one: a scheduling rule nobody can
read back from a run is not worth having. *2026-09-12, `06603a5d`.*

**A downloaded bundle block is never fetched again (cached under a bare filename the origin's
file system actually accepts), and a demand miss brings in its whole 2 MiB-aligned window, not
just the missed block.** The cache had been naming its files with a path separator, which the
origin private file system refuses; the refusal was swallowed and it silently fell back to an
in-memory store that nothing survives between starts, and the field reporting this (`backed:
false`) was never read anywhere. After the fix plus the window-on-miss change: a warm second start
issued zero range requests; across four cold starts, requests fell 38% for 60% more bytes fetched,
because misses stopped being served one block at a time. A block-fetch order recorded per bundle
(bounded to 4096 entries) lets the next start's background filler bring in what was actually
demanded last time, first. *2026-09-12, `9683fc51`.*

**The emulator is an optional layer, and `cork` is the default engine.** What was a hard
dependency of the package (the emulator's artifacts in `dist/vendor/`, fetched and packed
whether or not a launch used them) is now selectable: a build with `vendor/prebuilt/` empty and
the `vendor/v86` submodule absent builds, tests and runs the library's demos under `cork`, which
loads none of it; the package still exports `./libv86.mjs` and `./v86.wasm` for a build that
carries them, `check-package` accepts either and holds a present binary to a size floor, and a
launch that selects `emulator` or `hybrid` without the layer is refused with
`cpu: the emulator is not available in this build (engine "…" needs it)` rather than a fetch's
error. `cpu.decompressZstd` left the api: the project's own decoder (step 5.0) replaced its one
caller, and the emulator's decoder is reached directly by the differential test alone. The `jit`
option and the `jit.*` counters stay (the schema is the same on every engine) and report `-1`
under `cork`, which has no emulator compiler; the launcher's per-bundle engine selector is the
owner's. The paired browser table (`--engine emulator` as the control) that would confirm the
target ns per instruction is the owner's to run. *2026-09-22, cork 5.5.*

*Removed 2026-10-31:* the emulator is gone (no submodule, no package exports, no `engine`
option): cork is the only engine. The `jit.*` counters, the `jit` and `engine` metrics and the
boot ROM went with it.

**Direct3D 8's and 9's setters and draws are made in the guest and played by the host at its
next entry; the program is told D3D_OK at the call.** Render, stage and sampler states, transforms,
the material, textures, streams, indices, the declaration and format, shaders and their
constants, the viewport, lights, clip planes, the scissor rectangle, software vertex processing,
`DrawPrimitive` and `DrawIndexedPrimitive` each have a guest routine that writes the call, and a
copy of what it points at, into a command ring in the device's guest memory
(`seam/shadow.js`, `commandCode`); the host hands the run of records to the device in one call
(`d3d9/commands.js`): with the graphics worker, one recorded call the played device makes in
full. One ordered ring, rather than the shadow block's latest values, is what lets a draw wait:
each draw meets the state set just before it. Measured on a node harness of the real engine
path (cork, bridge, seam, recording, a worker thread), a loop of ten calls per draw: the engine
thread's host time fell from 730–825 ms to 450–470 ms per 100 000 draws, its crossings from
500 000 to 100 000. A call the device refuses was answered D3D_OK in the guest, so the refusal
is a divergence once per method, the terms on which the shadow block already took render
states. A null pointer, a count past the most a device of this version has, a recording state
block or a full ring take the host's path, which answers as the device does; while a draw waits
in the ring, a buffer lock other than NOOVERWRITE does too, since the bytes that draw reads are
the buffer's until it is made. Space in the ring is taken with `lock cmpxchg` and a record counts
once its length, written last, is there; and no scheduler slice ends inside a routine the seams
placed (`kernel.atomicCode`), so a thread switched away mid-record never leaves another thread's
entry stopped short of its own calls: a device shared between threads keeps the ring. Direct3D
8's ring carries the same calls in its own shapes (`d3d8/commands.js`). *2026-10-03, 1.8.*
Later in 1.8 the ring took Clear, BeginScene, EndScene, SetRenderTarget, SetDepthStencilSurface,
DrawPrimitiveUP (its vertices copied) and a Direct3D 9 state block's Capture and Apply, on the
same terms: a nested BeginScene or a draw outside a scene is answered D3D_OK and reported once.
While an Apply or a new target waits in the ring the guest's getters go to the host, which plays
the ring before it answers; the setters and draws do not wait. *2026-10-04, 1.8.*

**A reference count is kept in guest memory, and the guest answers every AddRef and Release
that does not cross zero.** The count of a Direct3D resource lives in a word the bridge's
IUnknown routines change with `lock cmpxchg`; the first reference and the last come to the host,
which is where an object's life is decided. Each answer is the count the object holds, so a
program reading counts back (Wine's `get_refcount`) sees what it would on Windows. The played
copy behind the graphics worker never sees the references the guest moved, so the host sends
it the count each host-side AddRef or Release left, not the call: a last Release ends both.
Measured on a node harness of the real engine path: 400 000 AddRef and Release calls took the
engine thread's host time from 293-311 ms to 38-48 ms. *2026-10-04, 1.8.*

**OpenGL's state calls go through a command ring in the guest too, and every other entry plays
it first.** The calls that answer nothing (states, bindings, array pointers, matrices, program
parameters, texture environment and generation, immediate-mode vertices, in `opengl/commands.js`)
are routines in OPENGL32 that write the call and what it points at into the ring of the
calling thread's current context, found through a slot of its TEB the way the system's
`opengl32` keeps its own context there; wglMakeCurrent writes the slot and deleting the context
clears it. With no current context or no room, the routine falls through to the same handler.
OpenGL reports errors only to `glGetError`, which is an entry like any other and plays the ring
before it answers, so unlike Direct3D nothing here is told an answer the context did not give.
Measured on a node harness of a GL title's per-draw pattern (sixteen ring calls per draw), the
engine thread's host time fell from 1091–1144 ms to 627–650 ms per 80 000 draws.
*2026-10-04, 1.8.*

**Where guest memory is shared, what a Direct3D 8 or 9 program unlocks is lent to the graphics
worker, not copied to it.** The record says only where the bytes lie (`remote/lending.js`), and
the worker copies them out of guest memory when it plays the record. Until then the bytes must
stay as they were, so everything on the engine's side that lets the range be written (a lock,
a `GetDC`, a copy the device or its caller makes, the block given back) claims it first: a lend
the worker has not begun is copied into a stash both threads see and pointed there, one it is
reading waits out the copy, one it has read costs nothing. Each lend's room in the stash is taken
when it is lent, so a claim never waits for room or for a record still unsent; a range with no
slot or room left is copied into the batch as before. What the program writes through a pointer
it kept past the unlock now reaches the played device up to when the worker reads the bytes,
not up to the next call that reads them: the same kind of latitude a driver's own deferred
upload takes, and still nothing after a lock that claimed them. A batch holding a lend is sent at
the end of the record that follows it rather than at the end of the turn, at most every quarter
of a millisecond, and any batch goes once a turn has kept it past the batch gap, so a long turn
does not leave the worker idle. Measured on a node harness of a Direct3D 8 program that locks a
256x256 texture once a frame and runs guest code after its present, none of 50 lends needed the
stash and the engine thread's host time fell from 41 ms to 31–38 ms for 13 MB lent; where the
program locks the same texture again before the worker has played the last draw, the claim
copies what the batch would have, and nothing is gained. `graphics.lendMemory: false` turns it
off. *2026-10-04, 1.9.*

**On an arm64 host a process on several executors keeps x86's order between plain memory
accesses only when the page asks for it (`cork.config.ordered: true`).** x86 shows one thread's
plain stores to another in the order they were made, and arm64 does not; cork keeps that order in
its ordered variant, where every integer load and store not through esp is a wasm atomic. Counted
on the arm64 model, that is 13% more machine instructions on a game's main-thread code (7.93 to
8.97 an executed guest instruction), and the flicker it was first turned on for came from a
thread with no thread-local block, not from the order. Locked instructions, `xchg`, the kernel's
objects and the engine's own routines are ordered either way. A program that hands data to
another thread through plain stores alone (a flag after its payload) can see the flag first on
such a host without the variant; `ordered: true` is the switch for it. *2026-10-23.*

**At a fault, the status flags may be those from before a write the code after the fault overwrites.**
Both translators drop a flag record that nothing reads before the next write of the same flags
(`deadFlagPass` over the region, `liveFlagsOut` across its blocks), and the analysis follows the
code a block's early exits go on into, not the exception: a page fault, a misaligned SSE access or
a string instruction finished by the interpreter that faults shows the context an `EFLAGS` whose
arithmetic flags may be older than the interpreter's. The handler that resumes the faulting
instruction, as a guard page or a lazily committed buffer does, runs the same code, which writes
those flags again before it reads them. A division counts as reading every flag in the long-mode
translator, since a divide error's handler usually goes on elsewhere. Keeping every record alive
up to every access that may fault would undo most of what the analysis saves. The long-mode gate
compares the arithmetic flags at a divide error only. *2026-10-26.*

**An SSE operation on a NaN gives the NaN the host's engine gives.** Both translators compute
float lanes in wasm and do not put the processor's choice of NaN back by hand: on an x86 host the
engine's instruction is the processor's, which keeps the destination's NaN quietened, else the
source's; only an invalid operation's NaN (0/0, inf - inf, the root of a negative) is made the
processor's default one, sign set, and only on a host whose own default NaN is positive, an arm64
one. There a NaN operand's payload may come out as that host's rule chooses it. Modelling the
processor's choice after every float operation cost the long-mode translator three vector
operations an operand: a float loop ran 2.3 times slower. *2026-10-26.*

**A NaN an x87 or SSE operation makes carries the host's sign.** An invalid operation (0/0,
inf - inf, the root of a negative) gives x86's default NaN its sign bit set; an arm64 host's
default NaN has it clear. Setting x86's took a compare and a branch after every float operation
on such a host, a quarter of the machine code of an x87 matrix-vector loop (134 instructions of
arm64 for 37 of x86, 97 without it; V8 14.6). Programs compare a NaN, they do not read its sign,
so the translator no longer sets it unless asked (`exactNaN`). Everything else that differs
between the hosts' code, which SSE form a scalar operation takes among it, still follows the host
itself. *2026-10-27.* The scalar forms now hold their low lane in a local on either host; only a
scalar load still differs, loading the vector on x64 and owing it on arm64. *2026-10-28.*

**A read past RAM by a small displacement reads the engine's tables.** An untested read wraps
its address into RAM; where a block reads several fields off the same registers and writes none
through them, the registers' sum is wrapped and the displacement (positive, under 64 KiB) added
after, so the host's compiler wraps once for all the fields where it wrapped every address before
(an x87 matrix-vector loop on arm64: 97 machine instructions to 89; x64 fmath 5 % faster). Such a
read off a pointer within 64 KiB of RAM's end now reads the tables that follow RAM, where it read
RAM's start before; the processor would have raised #GP either way. *2026-10-27.*
A negative displacement, and one of 64 KiB or more, now shares a wrapped sum too: the fields
within 64 KiB of each other wrap the registers' sum plus the lowest of their displacements, and
each load takes the rest as its own offset, as the positive ones now do too (a frame's locals
below its pointer, an array's fields at an absolute displacement off a scaled index). The address
is the processor's wherever it lies 64 KiB or more into RAM. Below that, where Windows maps
nothing, a read whose address is smaller than the offset its load takes past the wrapped sum
reads the tables past RAM at the same offset, where it read RAM's first 64 KiB: a field read
through a null pointer in a block that also reads below that pointer finds the page flags there,
not the zeroes a null page holds. *2026-10-28.*

**A process's threads spread over its executors, and its own executor keeps itself for the host's
answers; nothing is moved on reckoned gains.** Each thread runs on an executor of its own, the
host-bound and called-back threads kept on the process's executor; while a thread is pinned to the
processor that executor plays (a game's main thread, pinned to the first), another executor plays
it. The scheduler used to move threads onto the process's executor and off it, and trade a pinned
thread's processor with it, each time its reckoning of the threads' waits said the move gained: a
Call of Duty 4 run on an M4 with the trade made and held had frames of 34 ms at the median and
130 ms at the 95th percentile, and spread with no trade ran without freezes at about 45 frames a
second in its heaviest scene (the owner's observation, not a controlled A/B). The free host has
been the default since 2026-10-21; the placement on gains, the trade and `cpu.freeHost: false`,
the one way into them, are gone. `cpu.placement: 'concentrate'`, every thread taking turns on the
process's executor, stays as a debugging switch. *2026-10-31.*

**Visual C++ 7.1's to 10's x87 transcendentals are the host's functions, not the runtime's SSE2
code.** A call to `_CIsin`, `_CIcos`, `_CItan`, `_CIatan`, `_CIasin`, `_CIacos`, `_CIlog`,
`_CIlog10`, `_CIexp` or `_CIpow` in a program linked with one of those runtimes (PhysX 2.7-2.8,
3DMark06's PhysX, Call of Duty 4's executable, 3DMark 11's workloads) is formed as the host's own
function for it (JavaScript's `Math.sin` and the rest), its result put on the x87 stack in the
argument's place, where the runtime takes its SSE2 routines, as it does on every processor with SSE2
and so on the one cork reports. Against the runtime's own code (`msvcr71.dll`, `msvcr80.dll`
8.0.50727.42 and `msvcr100.dll`, `tools/generators/crt-dictionary.mjs --verify`, 400 seeded arguments from
2^-70 to 2^70 a function, its SSE2 path at full and at single precision) the results lie at most a
unit in the last place apart, and agree in everything else the caller sees. The x87's own
instructions were not taken: they round to the precision control, which the SSE2 code ignores, and
their way to `exp` and `pow`, `f2xm1` and `fscale` after a product by a logarithm, lost hundreds of
units in the last place. An argument where the runtime reports an error through `errno` or its
result would overflow or underflow (a logarithm of zero or less, an arcsine past 1, a power of a
base of zero or less, `exp` past 709 or below -708, a power whose result's exponent passes 1000, a
sine of 2^63 or more, a NaN or an infinity) is left to the function's own code, and so is an
arctangent of a magnitude past 2^50 or, unless zero, below 2^-20, which the runtime's SSE2 code
answers with the x87's arithmetic at its precision control. *2026-11-12.*

## C. Process model and porting

**Process replacement, not two processes in one address space or two machines.** `CreateProcess`
records a request; the parent keeps running; when it exits or waits on the child's handle, the
engine tears the app down and rebuilds it on the child's image. The alternatives cost real things
this project doesn't have a use for yet: two processes in one realm needs per-process handles,
heap, module table, message queue and registry plus region release and image relocation (weeks,
and still blocked behind "cpu: already booted"); two machines needs a second emulator and a
cross-machine channel to model a launcher that often exits within milliseconds of spawning.
Replacement gets the common case right at near-zero cost and, crucially, makes the classic
`0x400000`-collision impossible rather than solving it, because there is only ever one image at
that address. What it gives up: a parent that must run genuinely alongside its child (Battlefield
2's installer is the concrete case, tracked as work, not solved by this design).
`CREATE_SUSPENDED`+`WriteProcessMemory`+`ResumeThread` is handled as deferral: writes into a
suspended child are recorded as patches against an image that doesn't exist yet, and replayed once
it is mapped: no cross-process memory needed. *2026-09-07, `c3e8db9b`; built `2026-09-08`,
`6bb72c18`.*
A parent that waits on its child now goes on after it: the child runs on a second machine built
beside the parent's, which stays paused where it blocked, and the parent's wait is answered with
the child's exit code once it exits, the files and registry the child wrote copied back. Only one
of the two machines runs at a time, so this is still not two processes executing at once; the
Battlefield 2 installer's shape (run a stage, wait, go on) is what it covers. *2026-09-24.*
`roadmap/v2/` plans processes side by side, each in a worker with its own memory (stage 2); until
that lands, this decision stands. On the `cork2` branch the copying is gone: the run's processes
share one registry hive, one volume (the drives, their writable layers and the bundle mount) and
one numbering of process and thread ids, so a child's writes are its parent's as they are made.
*2026-10-05.*
Reconsidered: **a child runs beside its parent from `CreateProcess` on, at every concurrency.**
At concurrency 1 a child used to have no machine until its parent waited on it or exited, when it
was run in the parent's place; a parent could therefore never reach into it (`VirtualAllocEx`,
`ReadProcessMemory`, `WriteProcessMemory`, `SuspendThread` on its thread, `GetThreadContext`), and
a parent that spun on `GetExitCodeProcess` or its message loop had to be detected as waiting. Now
the child's machine is built when `CreateProcess` returns and takes turns with its parent on the
same thread (in a worker of its own at concurrency 2 and 4, as before); `CREATE_SUSPENDED` builds
it with its first thread suspended until `ResumeThread`; a wait on its handle is a wait on the
manual-reset event its exit sets; a launcher that exits leaves its child running, and the run's
code is the last process's. A call a parent makes in its child is sent there and made with the
child's own kernel32 (`kernel32/cross-process.js`), whichever way the child runs; a seeded gate
(`cross-process.itest.js`) compares what the parent sees down the three ways. Rejected: (B), a
child left lazy until its parent first reaches into it, then started beside it. It changed less,
but kept two ways for a child to run at the default concurrency, chosen by whether the parent
happened to touch it, the second without a gate; and a program cannot tell why its child had not
started. *2026-10-26.*

**Only Windows system libraries are reimplemented; a redistributable middleware runtime is ours to
reimplement too (§B above); anything else a game ships in its own directory is loaded and run as
real x86.** `mss32`, `bass`, `openal`, `a3d`, `binkw32`, `smackw32`, `glide2x`, `galaxy` are
therefore read only for knowledge, never implemented. `d3dx9` is the one case with a third option:
the engine ships the June 2010 DirectX End-User Runtime as a read-only system volume and the
loader runs the real `d3dx9_24…43.dll` from it whenever a program doesn't bring its own; the
engine's own `d3dx9_25`/`26`/`27` stub tables (`layers/win32/d3dx9/`) still answer a program that
ships neither: the fallback now, not the primary path. *2026-09-07, `42e8e9bc`.*
Reconsidered: the engine no longer carries the DirectX End-User Runtime. It was Microsoft's binary
fetched into every build to stand in for a setup the engine answered as already run, so a title's
installer never ran the `DXSETUP` it brought, and whatever that setup could not do here stayed
hidden behind a runtime nobody installed. The setup a title brings now runs as the child it is
and puts the `d3dx`/`d3dcompiler` libraries in `system32`, where the loader already looks; the
engine's `d3dx9_*` stub tables answer a program whose installer never ran. The Visual C++ and
.NET redistributables are still answered as already run, since the engine carries the C runtime
itself. *2026-09-26.*
Reconsidered for Visual C++: the engine carries only the older C runtimes (`msvcrt`, `MSVCR71`,
`MSVCR80`, `ucrtbase`), so an installer that started `vcredist_x86.exe` for the 2010 runtime got
an answer of "installed" and left a program whose `MSVCR100`/`MSVCP100` imports nothing could
bind. The Visual C++ redistributable now runs as the child it is and installs its libraries into
`system32`; .NET and OpenAL's installer are still answered as already run. *2026-11-07.*

**A constant table entry whose name another entry in a different register set shares is set
with it.** fxc compiles a model 3 loop over an `int` uniform to `rep i#` and lists the uniform
twice in the CTAB, once in the float registers arithmetic reads and once in the integer register
`rep` reads; Wine's conformance tests cover each register set's layout but never such a pair. A
setter given the name (`SetInt`, `SetValue`, ...) writes both, each in its own set's layout,
so the loop counts what the program set rather than what the integer register happened to hold.
*2026-10-08.*

**FindActCtxSectionStringA/W are not exported until activation contexts are built from
manifests.** No context exists here, so the only answer the lookup can give is "not found",
and the Visual C++ 2005 runtime (msvcr80, vcomp, reached through GetProcAddress) takes that
answer for a load without its manifest and stops the program with R6034 before the program's
first instruction. Absent, the runtime treats the system as one without side-by-side support
and runs. Removed on 2026-09-09 (16110a45), added back by an export audit on 2026-10-08
(884102c9) and Gothic 3 met R6034 at vcomp.dll that day; kernel32's system.test.js now fails
if the names come back. *2026-10-08.*

**Reconsidered: FindActCtxSectionStringA/W are exported, activation contexts being built from
manifests.** The condition the entry above names is met: a context is built from the program's
manifest (its RT_MANIFEST 1 or `<program>.manifest`), a library's RT_MANIFEST 2 and CreateActCtx,
its dependencies found as Windows finds them (A57), and the loader takes a DLL a context names
from where the context puts it. The runtimes' check was read from Microsoft's binaries rather
than guessed: msvcr80.dll and vcomp.dll (8.0.50727.6195) look themselves up as a DLL redirection
of the active context, refuse a load from the system directory, and accept one from WinSxS or
beside their assembly's manifest; msvcr90.dll makes the same check. `tools/run/vcredist-matrix.mjs`
runs Microsoft's own vcomp.dll and msvcr90.dll in the engine through seven layouts each --
the runtime and its manifest beside the program, in its assembly's folder, named by an embedded
or an external manifest, loaded with LoadLibrary, installed (only in system32, presented by the
store), and named by no manifest -- and each runs or stops with R6034 exactly where Windows does
(2026-10-27, all 14 rows agree). msvcr80.dll is the engine's own (`runtimes()`), so a program
importing it runs even with no manifest, where Windows stops it. kernel32's system.test.js now
runs the check's logic over each layout instead of guarding the names. A Visual C++ 2005 title
(Gothic 3, R6034 at vcomp.dll on 2026-10-08) must be checked before this reaches main.
*2026-10-27.*

**A periodic multimedia timer that has fallen more than a period behind fires once, not once per
tick missed.** Its next due time moves to the first tick of the same grid still to come, and the
ticks passed over are counted (`multimediaTimers.skipped`). Re-armed from its due time alone, a
callback slower than its period owed more ticks with every one, and the time-critical timer
thread took the processor at every turn: Delta Force's 33 ms timer was measured 2.3 s behind
and still falling, the main thread getting what was left. What Windows does with ticks a late
callback missed was not measured. *2026-10-11.*

**A run-time LoadLibrary of a name the engine's table answers does not load the system
directory's copy beside it.** Static imports and a loaded library's own dependencies already
took the table's module, which is mapped from the start; only LoadLibrary searched the system
directory first, so a process could hold an installer's d3dx9_24.dll beside ours: the
installed effect compiler then made fx_2_0 bytecode our D3DXCreateEffect was asked to read
(Battlefield 2). A copy beside the program still wins. This narrows the 2026-09-26 entry above
(the installed runtime in `system32` is what loads): for a name the table answers, it is not,
whichever way the library is reached. *2026-10-11.*

**The video adapter is shown with a profile: a known card of a shader model, by its PCI ids and
with its shader versions; the launcher shows model 2 (a Radeon 9800 Pro) unless a bottle
chooses another.** The adapter keeps its own name. A program that picks its render path from a
card database knows the cards of its years and takes its weakest path on one it does not: shown
the browser's vendor (Apple, or none) with device id zero, Far Cry took a GeForce 4 path with
pixel shaders 1.1; shown a GeForce 6800 it took a TNT2 one with no pixel shaders; shown a Radeon
9800 with model 3 beside it, its 2004 Cg compiler, asked for the newest profile, knew none and
failed. Model 2 is the card most games of DirectX 9's years know; a title that wants another
gets it from the bottle's "Shader profile" (`gpuProfile` sm1-sm4, or `host` for the browser's
vendor and model 3, the engine's own default). Which card real Windows reports is the card's;
none was measured against hardware. *2026-10-12.*

**On XP the DirectX libraries carry the system's build, not the DirectX version.** DirectX 9.0c is
part of Windows XP, and its files there are at the system's build: Service Pack 3's 5.3.2600.5512
for `ddraw`, `dsound`, `dinput`, `dinput8`, `d3d8`, `d3d9`, `dplayx`, `dpnet`, `dpnhpast`,
`dpnhupnp`, `dmusic` and `dmime` (`kernel32/versions.js`, `components.files`, beside A39's).
GetFileVersionInfo answered them with the registry's DirectX, 4.9.0.904 (what the files are where
a redistributable put DirectX 9.0c on Windows 2000 or 98), and a DirectX 9 setup comparing its own
5.3.1.904 found the system's older, failed to back it up and asked for a restart. The registry still
says 4.09.00.0904; a library XP does not ship (the D3DX DLLs, XInput) and every DirectX library under
Windows 2000 still name the bottle's DirectX. The numbers are Service Pack 3's as published and were
not read off a machine. *2026-10-15.*

**A41 revisited: a library standing in the system folder gives way to a setup that writes it.** A
DirectX setup opened `system32\d3dx9_26.dll` for writing to see whether it was in use, was refused,
and put its copy off to a restart. Opened to be written, a stand-in now becomes a file on the volume
that the program writes; read, it is still nothing but the engine's. What a setup puts in the
system folder is never in its way, and a program that loads the name still gets the engine's own
library (the loader's `ours` rule). A setup that only opens one to look leaves an empty file there,
which is no library the loader takes. *2026-10-15.*

**A41 revisited again: a library standing in its folder reads as its image, and stands where it
is installed.** A DRM wrapper around a 64-bit Steam game (SteamStub) loads the Steam client from
the folder the registry names, asks GetModuleFileName where it is and opens that file to read it;
the module said `system32\steamclient64.dll` and the open was refused, and the game stopped at
"Application load error". A library this build implements now stands in the folder it is
installed in -- the system folder, or Steam's for the Steam client while one runs -- and
GetModuleFileName answers that folder; opened to be read, the file holds the library's image as
it lies in the process's memory, its size what GetFileSize answers. Opened to be written it is
still the setup's file, as above. *2026-10-31.*

**DirectX's setup is the engine's: a title's `dsetup.dll` and `DXSETUP.exe` answer that DirectX is
in place.** DirectX 9.0c is part of XP, and on XP SP3 its redistributable finds every file of it in
the system folder at a newer build and installs only the D3DX helpers. Here the system folder holds
only the libraries the engine implements, so a redistributable copied XP's DirectX over it (305
files into system32, `DLLCache`, `drivers`, `inf`) and, as it does for any file it copies on XP
outside `RegisteredPackages`, answered "succeeded, restart needed"; a game's installer then stopped
at a restart nothing here makes. Now `DSETUP.dll` is answered from the engine's table whoever's copy
a program loads (a runtime, as the sound layer's MPEG provider is): `DirectXSetup` installs nothing
and succeeds without a restart, `DirectXSetupGetVersion` names the bottle's DirectX, and
`DirectXSetupGetEULA` reads the licence the program's own redistributable carries (`dsetup32.dll`,
`DATA/SETUP_AGREEMENT_<language>`, beside the copy it asked for). A `DXSETUP.exe` a title brings
(known by its version block, Microsoft's `dxsetup.exe`, not by its file name) is run as a program
of the engine's that exits with 0 and shows nothing. The D3DX helpers are not put in the system
folder; the engine answers them whether or not a file is there. Revisit if a title is found that
reads a D3DX helper's bytes from system32 rather than loading it. *2026-10-15.*
Reconsidered: the engine answers D3DX 9, but not D3DX 10 and 11, the shader compilers, XAudio2 or
XACT, and its D3DX 10 table refuses to compile HLSL. A setup that installed nothing left a program
importing `d3dx10_43.dll` with the engine's table and no compiler behind it. The `DXSETUP.exe` run
in a title's setup's place now installs the optional components' cabinets beside it
(`Jun2010_d3dx10_43_x86.cab` and the like) by their Windows NT INFs, as a Steam bottle's install
already did (A67); the system's own DirectX cabinets are still left alone, and still no restart
is asked. A library whose imports the engine's table covers stays the engine's (the loader's rule
for a system copy). *2026-11-07.*

**The screen is composed as Windows 7's desktop window manager composes it, not drawn into as XP's
is.** On XP every window draws straight onto one screen, clipped by the windows over it, and a
window that goes, moves or is raised leaves the windows and the desktop beneath to repaint what it
uncovered; a program that does not (a wizard busy copying files, a skin that paints in a
different window than the one uncovered) leaves a dead dialog's pixels on the screen. Here each
top-level window has a surface of its own, its whole rectangle; its contexts draw on it unclipped by
other top-level windows; and the screen is the desktop's background with the shown windows copied
over it, bottom to top, where their regions keep them (`graphics/gdi/screen.js`). A top-level window
moved, raised, hidden or destroyed paints nothing and asks nothing of anyone: the screen is composed
again. Inside one top-level window the XP rules stay (siblings, WS_CLIPCHILDREN, a child moved
copies its bits and its parent paints the strip). A screen context (`GetDC(NULL)`) draws over the
screen as shown, which stays until the screen is composed again, as with the window manager. The
cost is a surface per top-level window, a few megabytes each. *2026-10-15.*

**The Visual C++ C runtimes are the engine's; the C++ libraries are the program's own copy when it
brings one.** MSVCR80 is answered by the engine even beside a copy the program carries: it is
msvcrt's functions with the names Visual C++ 2005 added, the calls a program makes per character
or per pointer run as guest code, and one runtime serves every module instead of a second for the
translator to carry. MSVCP71/80 are not: their exports are counted in thousands, the iostreams and
locales among them are objects whose layout and virtual tables a program's own inlined header code
reads, and a partial table in front of a program's copy left F.E.A.R.'s imports unbound. The
engine's `std::string` (MSVCP80/71) answers only a program that brought no copy (PhysX in
Mafia II) and grows by what the bundles import. MSVCR71 likewise, until its exports are
checked against the real list. *2026-10-15.*

**The machine has a page file, as large as its memory.** `GlobalMemoryStatus(Ex)` answers a
commit limit of memory and a system-managed page file the size of memory, as Windows 7 is set up
by default; a program refuses a machine whose limit is no more than its memory (paging turned
off). Physical memory stays the arena, as WMI reports it. *2026-10-15.*

**A full-screen Direct3D 9 device is one of the display's modes.** `CreateDevice` and `Reset` with
`Windowed = FALSE` and a back buffer of no display mode's size (0x0 among them) answer
`D3DERR_INVALIDCALL`, as Wine's test_reset sees Windows do; only a windowed device measures its
window for a size of zero. Making such a device at the display's size instead left a program
laying out a screen of 0x0. *2026-10-15.*

**A graphics resource's memory starts on a 16-byte boundary.** Every surface, texture chain and
vertex or index buffer storage, the spares a DISCARD moves a dynamic buffer onto among them, comes
from the guest heap aligned to 16 bytes (`RESOURCE_ALIGNMENT` in `app.js`), where the heap's own
boundary is 8. Direct3D's documentation promises no boundary; Wine keeps every resource on 16 and
gives up a GL mapping a driver hands back off it, because programs write what they locked with SSE
stores. One checks the pointer a DISCARD hands back and, given one off the boundary, unlocks and
draws nothing it would have written there that frame: Call of Duty 4 skins its animated models into
such a buffer, and with the buffer's storages taken in turn they showed in two frames of four.
Levels inside a texture's chain stay packed, as in Wine, so only a chain's first level is on the
boundary. *2026-10-21.*

**An element past its stream's stride is read from the vertex's last bytes.** A vertex declaration
may name elements beyond the stride its stream is bound with: one declaration naming four
coordinate sets and a lightmap's set at offset 24 is bound over meshes of one, two and three sets
(strides 12, 16 and 20), and the program's shaders read the lightmap's set through it. WebGPU
refuses such an attribute, and reading the next vertex's bytes there put the lightmap coordinates
of one vertex at another's diffuse ones: the lightmaps landed off their atlas tiles in streaks. The
vertex's own last bytes are its last coordinate set, which is where the mesh holds its lightmap
coordinates, and what a set the mesh lacks repeats. An element wider than the stride is refused
still. *2026-11-01.*

**A233. The engine's range is cut out of a 32-bit process's heap at 0x14000000 when nowhere lower
holds it.** A memory that grows keeps the engine's tables and the other executors' pages in the
guest's own space, about 20 MiB an executor and 8 more: at the top of the libraries' space under
the thread stacks, or at the heap's start where it ends short of 0x10000000. Four executors or more
fit neither, and without a range every process committed its whole RAM at its start (2.1 GiB a
process on eight). Past 0x10000000 and the few megabytes above it, the bases a library is most
often linked for, the heap gives the range up as it gives a library that cannot move its span. A
library linked to load inside the range cannot be loaded; one that can move is moved. *2026-11-07.*
Since 2026-11-13 only the other executors' pages are cut out there, the first executor's tables
and their shared record staying at the top of the libraries' space: the memory starts as it does
on one executor and reaches the cut range when another executor opens, where every process on
eight executors started at 512 MiB.

**A234. D3DX 10 asked for a size its file holds as a level takes that level, where the format
has no codec here.** D3DX 10 and 11 filter the first level down to a size asked; this loader does
so for every format it reads and writes (texels of whole-byte, packed, signed and float channels,
BC1 to BC5). For one it does not (BC6H, BC7, signed BC4 and BC5, pairs, R1), a size the file holds
as one of its levels takes that level and the ones below as the file has them, the file's own
levels being the same picture made by its author's tool; any other size is refused with
`E_FAIL` and said. *2026-11-08.*

**A235. A managed program runs under the bottle's Mono at `C:\Windows\Mono`, told to check for
null references itself.** `mscoree.dll` is ours and does not carry a CLR: `_CorExeMain` loads Mono's
own Windows build (`bin\libmono-2.0-x86.dll`) from that directory as an ordinary library and runs
the process's assembly through Mono's embedding API (`mono_set_dirs`, `mono_jit_init_version` with
v4.0.30319 whatever runtime the assembly names, `mono_domain_assembly_open`, `mono_jit_exec`),
then ends the process with what Main returned; `_CorDllMain` answers TRUE for the managed libraries
Mono maps. Before it starts, `explicit-null-checks` is added to the process's `MONO_DEBUG`: a read
through a null pointer finds zeros here (A79), and Mono's JIT otherwise finds a null reference only
by the fault such a read raises on Windows. A bottle without the runtime runs no managed program,
as a machine without .NET runs none, and the loss is said. *2026-11-08.*
*Withdrawn 2026-11-11: the engine has no .NET runtime, mscoree or fusion of its own; a bottle
runs the .NET Framework its setup installed.*

**A236. D3DX 10's TRIANGLE filter is a tent, and its blocks are made by our own BC encoder.**
Wine's d3dx11 tests measured D3DX's filters on Windows: POINT (a 16.16 fixed-point step), BOX
(two by two, half rounding up) and LINEAR (the four texels around each centre, wrapping at the
edges) are reproduced, LINEAR to within one in the last bit where a texel falls exactly half way.
TRIANGLE is a tent as wide as the scale: Windows' own filter weighs its neighbours otherwise, and
its numbers are not derived from a published algorithm. A level of blocks that is not whole
blocks, and any level made or converted into BC1 to BC5, is encoded by this loader's encoder,
whose endpoints and indices differ from Windows' where several encodings come equally close. The
sRGB curve is the power 2.2 the tests show, held to 0 to 1; Windows reads a float above 1 past
the end of its table. *2026-11-08.*

**A237. A .NET runtime's folder holds the engine's `fusion.dll`, and `WineFakeDlls` is answered
by what stands there.** Wine's fusion tests reach the library as programs do, through mscoree's
`LoadLibraryShim("fusion.dll", "v4.0.30319")`, which loads it from the runtime's folder; a bottle
with Mono has those folders but not the library, and wine-mono's support installer asks for it
there with Wine's own INF directive, `WineFakeDlls`, which Windows' setupapi does not know. A
library the engine implements as a runtime's own (`fusion.dll`) now stands in each runtime's
folder (`Microsoft.NET\Framework\v2.0.50727`, `v4.0.30319`) while the folder is there, as A41
stands the engine's libraries in the system folder, and loads as the engine's table. `WineFakeDlls`
is carried out with an install section's files: the folder each line names is made, and a library
that does not stand there afterwards - `ngen.exe`, `mscorwks.dll` and the other runtime parts
wine-mono places as Wine's fake images - is said as not provided. The global assembly cache is
the Windows folders and nothing beside them; Mono's own cache is not listed in it. *2026-11-08.*
*Withdrawn 2026-11-11: the engine has no .NET runtime, mscoree or fusion of its own; a bottle
runs the .NET Framework its setup installed.*

**A238. Media Foundation describes media and plays none.** `mfplat`'s objects (attributes, media
types, memory buffers, samples, events) are whole, but there is no pipeline behind them: no
source resolver, decoder, transform or work queue. `MFTRegister` is refused with E_ACCESSDENIED,
what Windows answers a user who may not write the machine's registration; a source reader is
refused for a file that is there with MF_E_UNSUPPORTED_BYTESTREAM_TYPE, what Windows answers for
a container it has no source for, and the loss is said with the file's name; a sink writer is
E_NOTIMPL, also said. A video media type has no MFVIDEOFORMAT (`GetVideoFormat` answers NULL)
and no AM_MEDIA_TYPE (MF_E_UNSUPPORTED_REPRESENTATION); an audio type's is its WAVEFORMATEX, or
WAVEFORMATEXTENSIBLE past two channels or with a channel mask. *2026-11-08.*

**A239. DirectWrite's system fonts are gdi32's outline faces, written as TrueType tables, and a
glyph is a character.** No font file ships, so the system collection holds the faces gdi32 draws
(its table without the bitmap faces and the substitutes), each family with the faces Windows
ships of it (Tahoma regular and bold, so an italic Tahoma is an oblique simulation), at
`C:\WINDOWS\Fonts\<name>.ttf` through the local file loader. Each face's file is made from what
the font engine measures of it at 128 pixels, in 2048 units to the em: 'cmap' (every character of
the Basic Multilingual Plane but the surrogates to the glyph of its own number), 'head', 'hhea',
'hmtx' (a long metric for each glyph up to U+024F; DirectWrite's own advances are measured for
every glyph), 'maxp', 'name', 'OS/2' and 'post', so metrics, glyph indices and TryGetFontTable
read tables like any file's; there is no 'glyf', no 'GSUB' and no 'GPOS'. Without an engine
(node) the measurements are estimates of Arial's and Courier New's proportions. Shaping is a
glyph a character, mirrored in right to left runs: no ligatures, no reordering, no OpenType
features. Bidi levels follow the Unicode algorithm's strong, number and explicit embedding rules
without isolates or bracket pairs; line breaks follow UAX #14 for spaces, hyphens and
break-after characters, brackets, mandatory breaks and ideographs. A run is drawn from the
browser's glyphs, as GDI's text is; a face a program loads from a file is measured from its own
tables but has no rasteriser, and its texture is empty, said as a loss. Text formats, text
layouts, typography, trimming signs and glyph outlines are refused with `E_NOTIMPL`, and said.
*2026-11-08.*

**A240. The WebBrowser control navigates and draws nothing.** Internet Explorer's control
(`CLSID_WebBrowser` and its version 1 class, in ieframe.dll and shdocvw.dll) is made, takes its
client site, reads the site's ambient properties, makes the three windows IE makes in the site's
window ("Shell Embedding", "Shell DocObject View", "Internet Explorer_Server"), activates in
place and UI-activates through the site, frame and document window, is moved and deactivated. A
navigation runs as IE's does: the ready state goes to loading, BeforeNavigate2 is fired (a sink
may cancel), the download begins and ends at once (to the container's command target when it has
one, else DownloadComplete), then from the control window's message loop NavigateComplete2,
TitleChange and DocumentComplete come, with the location, title (the address), history and ready
state kept. There is no HTML engine: the page is not drawn (the server window shows the white of
an empty page) and there is no document, so `get_Document` answers NULL and the document's
commands (`QueryStatusWB`, `ExecWB`) E_UNEXPECTED, as IE answers before a document is there. The
page not drawn is said as a loss once for each address. The class's type information is its
coclass attributes alone; the InternetExplorer application object is not there. *2026-11-09.*

**A241. A GOG build is installed as Galaxy lays it out, without Galaxy's install script.** A
generation-2 build is installed in one language - the browser's, else English, else the first the
build has - with the depots for that language or every one (`*`) and for a 64-bit machine, of the
products the account owns; its dependencies' files beside the game's, a game's file over a
dependency's of the same path, and the redistributables among them applied by their packages as
Steam's are (A67), the program each names taken as named. A file GOG flags `support` (settings,
icons, the script interpreter's own) goes under `__support\` by its path, not over the game's
tree. The build's `goggame-<id>.script`, which Galaxy's script interpreter runs on a person's
machine (registry values, copies of support files), is not run: the install says so. The program
started is the primary play task of `goggame-<id>.info`, with its arguments; its working folder
is not carried, the program starting in its own folder. Generation-1 builds are refused with what
they are. *2026-11-12.*

**A242. In a memory a gone process handed on, a reserved page reads that process's bytes until it
is committed.** A process the run starts takes the memory of one gone before it (a parent starting
child after child, ngen a worker per assembly) and zeroes at its start only what it finds in place
before anything hands it out: the thunk table and the first thread's stack. The heap zeroes a block
as it hands it out and the stack pool a stack as it is taken, so what a program is given reads as
in a new memory; zeroing everything the gone process wrote made all of it resident at the start, a
quarter of a gigabyte for the smallest program. A reservation's pages are zeroed as each is
committed, as pages given back already were: until then a read of one finds the gone process's
bytes where a read of an uncommitted page does not fault, where Windows faults and a new memory
reads zero. A program reading memory it never committed or was never handed is the only one to
see the difference. *2026-11-13.*

**A243. The tab's memory is one budget, counted by kind, each process holding its part apart.**
A browser ends a tab past a line of its own (Safari on iOS near 1.7 GB), and a person who sets a
memory of two gigabytes expects the tab to hold no more; so in a browser the run's memory
(`machineMemory`, by default `memorySize`) bounds everything the run holds, not each process's
address space. Windows' processes share the machine's RAM page by page and page what does not fit;
here nothing can be paged (a touched wasm page is the tab's for good), so the budget counts what
can be held and refuses what would pass it. The guest's memories count as the engine holds them:
at their whole length in JavaScriptCore, where a grow made every grown page resident; by what the
guest was given elsewhere (its heap's reach, its commits, its images, its stacks), as Windows
counts commit and not address space, a memory kept for the next process at what its process left
in it. The engine's own counts as measured costs: the tab
before any program, each process, each executor's worker, the executors' shared arena. The
translator's modules count by their wasm bytes weighed for what holding them costs (compiled code,
the engine's state beside them), and its shared translations at a ceiling sized to the tab. A guest
allocation past the budget is refused, as an out-of-memory machine's is; translations past it let
their coldest modules go, as a cache; an executor past it is not opened; a process with no room to
start waits for another to end (`machineWaitMs`) and fails to start with STATUS_NO_MEMORY past
that, where Windows would page. Each process holds its part on a holder of its own, given back
whole by whoever started it once it is gone, however it ended, as Windows takes back a process's
memory at its exit. Outside a browser there is no tab, and no budget unless one is named; the
tab's own cost is not counted there. *2026-11-13.*

**A244. GL_CLAMP clamps to the edge, as GL_CLAMP_TO_EDGE does,** said when a texture or a
sampler is given it: GL_CLAMP clamps a coordinate to [0, 1], so a linear filter at the edge takes
half its weight from the border (the border colour, for an image without border texels). WebGPU
has no border to address, and the device and the processor both sample GL_CLAMP as
GL_CLAMP_TO_EDGE, so the two paths agree; the difference from GL is the outer half texel of a
linearly filtered texture, which keeps the edge texel here where GL fades it toward the border
colour. Emulating it is the coordinate test in every shader that A186 would need. *2026-11-13.*

**A245. What the tab's budget counts for the engine's own parts, and from what.** The costs the
budget charges for what it cannot measure from inside (`machineMemory`, A243), and where each
comes from. The tab before any program (`RUN_ENGINE_BYTES`, 384 MiB): Chrome 156's renderer with
an idle program, one executor, a fake GPU, 357 MiB (8 executors: 425 MiB, so about 10 MiB an
idle executor's worker: `EXECUTOR_BYTES`, 12 MiB). A process's own state (`PROCESS_ENGINE_BYTES`,
32 MiB), its first executor's tables (`PROCESS_TABLES_BYTES`, 64 MiB, their size, not what is
touched of them) and a translated module's weight (`TRANSLATION_WEIGHT`, 4: its compiled code, the
engine's metadata and the translator's records beside its wasm bytes) are not measured apart: on
the .NET Framework 4 setup in Chrome with a budget of 2 GiB they held the renderer at 1.5 GB
steady, with one sample of 2.1 GB (garbage the JavaScript heaps had not collected). The tab's own
cost is counted only in a browser. *2026-11-13.*

**A246. lodctr and unlodctr succeed and register nothing.** Windows keeps performance counters in
Perflib, which `lodctr.exe` fills from a program's counter definitions and `unlodctr.exe` empties;
the engine answers no Perflib data, so there is nothing to register them with. Setups call them
from custom actions (the .NET Framework 4.8's for a dozen counter sets); a missing program failed
each with 0x80070002, the setup ended with code 2 though all it installs was in place, and its
self-extractor left the folder it unpacked into. Both programs are the engine's own and answer 0.
*2026-11-14.*

**A247. Windows 7 and 10 carry the engine's `mscoree.dll`, which forwards to the installed
`mscoreei.dll`; XP carries none.** On Windows 7 and later the .NET shim is part of the system, and
the .NET Framework 4's setup installs only the shim's implementation, `mscoreei.dll`, beside its
runtime: the 4.8 setup found no `system32\mscoree.dll`, and its `ngen` stopped on an unanswered
`mscoree.dll!CorGetSvc`. There the engine provides the shim, with no runtime in it: each export
Windows' mscoree has and mscoreei has too is that export of
`<InstallRoot>v4.0.30319\mscoreei.dll` (InstallRoot from `HKLM\SOFTWARE\Microsoft\.NETFramework`,
which these machines now furnish as `C:\WINDOWS\Microsoft.NET\Framework\`), loaded on the first call
that needs it and jumped to with the caller's frame as it came; after that first call none crosses
into the host. Its file version is the system's (A31), past the 4.0.31106.0 the 4.8 setup asks for.
Without mscoreei, each export answers what it documents for a runtime that cannot be loaded
(`CLR_E_SHIM_RUNTIMELOAD`, `CLASS_E_CLASSNOTAVAILABLE` from `DllGetClassObject`, FALSE from the
strong-name calls and `_CorDllMain`); `_CorExeMain` and `_CorExeMain2` end the process with
`STATUS_DLL_NOT_FOUND` and say it as a loss, with no box, where Windows asks in one for the
Framework to be installed. The exports with no published signature (`InitErrors`, the `ND_*`
helpers, `CorGetSvc` and the like) cannot be answered without knowing what to take off the stack,
so without mscoreei they end the process the same way; `GetCLRMetaHost`, the one name mscoreei
lacks with no published signature, is left out. `_CorValidateImage` answers S_OK and changes no
entry point, which this engine's loader does not ask for. A 64-bit process gets none of these
exports yet: Framework64's shim is not forwarded to. XP has no shim of its own, and a Framework's
setup there installs its own `mscoree.dll` (The Swapper's bottle runs on 4.0's), which the engine
leaves alone; a shim of the engine's there would also stand in front of a CLR 2-only install's
file, which mscoreei cannot serve. *2026-11-14.*
