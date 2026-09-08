# Phase 8 — Installers

> **Status:** partly built. The prefix — the shape this plan settled on in "the shape the install
> takes" below — exists as `@bottlify/installer` and is wired into the launcher behind `allowInstall`.
> What is missing is the Win32 surface an installer's own wizard needs, so no distribution finishes
> yet. See "Where this stands" immediately below; the plan itself is unchanged.
>
> A working plan for teaching the bundler to accept a distribution rather than a directory. Every
> claim about a particular installer came from reading that file's own bytes — PE header, section
> table, overlay magic, embedded archive directories, import table — with the scanners in the
> scratchpad; every claim about what the engine has or has not got came from grepping
> `modules/core/src/layers/`. Where something is inferred rather than read, it says so.
>
> The corpus this was written against is ten period Windows demos in `.to_install/`, catalogued in
> `.to_install/INDEX.md`. Ten distributions, five container families, and — usefully — no family
> represented only once.

## Where this stands

This is the input half of the master plan's Phase 8. A bundler that can only be fed a directory
somebody installed on a real Windows machine is not a way of acquiring a game, so the format and the
packer are only half of that phase; this document is the other half.

**Built** — `modules/installer`, as `@bottlify/installer`:

- `prefix.js` — `prefixOptions()` seeds the distribution at `C:\Install`, and `collect()` subtracts
  it again by path, picks the installation root by rule rather than by name, and writes the registry
  into the tree as `.bottlify\registry.json`. This is the "prefix, not a capture step" shape below,
  taken as decided.
- `pack.js` — the browser packer this plan said did not exist. It takes the container's layout
  constants and `crc32` from the reader in `filesystem/internal/bundle/`, so the format is still
  described in one place, with the two departures the README names: deflate only, and the
  whole-bundle digest computed by the server because `crypto.subtle` cannot hash incrementally.
- `upload.js` and `src/server/` — packing streams into the request rather than into a file, which is
  the "pack into the upload, not after it" section. The endpoint refuses to start without a token.
- `install.itest.js` runs a real distribution headless against the engine and reports how far the
  program got, so the wall is a measurement rather than a guess.

The launcher drives it behind `allowInstall`, so this is a developer feature and appears nowhere by
default.

**Not built, and what it blocks:**

- **I1, I2 and I6 — the host-side container readers.** `tools/make-btl.mjs` still takes a directory
  and nothing else. Families A and B are therefore still acquired by hand.
- **Every Win32 gap in "what the engine is missing" below is still missing**, checked against
  `modules/core/src/layers/win32/` at the time of writing: msvcrt's C startup set (`__getmainargs`,
  `_initterm`, `_controlfp` and the rest — none of it is in the tree, and `fopen` is not either),
  kernel32's `_l*` family, `WinExec`, `GetTempFileNameA`, the profile (INI) functions,
  `GetShortPathNameA` and `MoveFileExA`, advapi32's token half, shell32's special folders, and
  user32's modal dialog with the system control classes an installer's wizard is made of. This is
  what stops family C finishing, and it is the whole of I3 except its last item.
- **`CreateProcess`** was refusing when this was written, and was being implemented as it was being
  written (`kernel/internal/processes.js`, `kernel32/spawn.js`). Check it before believing I4's
  premise; families D and E are gated on it and on nothing else in kernel32.
- **The engine does not read `.bottlify\registry.json` back on mount.** Writing it is done; the
  other side of that contract is not, so a bottle made this way loses its registry when it is played.
- **I4 and I5** are untouched, and the open questions at the end of this document are all still open.

## The goal

**The bundler must be able to swallow an `.exe`, install it, and hand back a finished bundle.**

A bundle is what the engine mounts at `C:\App` in the guest, with the game's files directly in that
directory (`app.js`'s `BUNDLE_DIRECTORY`). Today `tools/make-btl.mjs pack <game-directory> <id>`
takes a directory that somebody has already installed on a real Windows machine and turns it into
`bundle.btl` plus a `manifest.json`. The input is the problem: acquiring a game means finding a
Windows box, running its installer, and copying the result out. Everything below is about deleting
that step.

Two ways to do it, and the plan uses both:

- **Unpack it on the host.** Read the container ourselves and write the files out. Cheap, exact,
  and completely blind to anything the installer *decides* — registry values, generated
  configuration, chosen paths, files assembled from more than one source.
- **Run it in the engine.** An installer is a Win32 program. Boot it against a writable volume, let
  it do whatever it does, and keep the filesystem it produced. Expensive up front, generic
  afterwards, and the only path that captures decisions rather than bytes.

Rule 4 governs the choice: neither path may branch on a title. "This is a Wise self-extractor" is a
statement about a container format, and acting on it is no more a per-game crutch than reading a
PE header is. "This is Doom 3, so skip the second dialog" is the thing that is forbidden.

## The shape the install takes: a prefix, not a capture step

Decided after the audit above, and it changes I3 onwards.

The engine already has the two halves this needs. A bundle is read-only, and the OPFS store is a
writable layer over it -- that is an overlay in everything but name. So an install is:

1. **A temp prefix.** A fresh OPFS scope with *no* bundle beneath it, and the installer's media
   mounted read-only beside it. Wine's model, and it removes the hardest part of the alternative:
   nothing has to diff the result against a baseline, because everything in the writable layer is,
   by construction, what the installer produced.
2. **The user drives it.** Windows, dialogs, whatever processes the installer starts. This is the
   part that cannot be replaced by unpacking, and it is why the engine path exists at all.
3. **On the last process exiting, the prefix is the answer.** Files come out of OPFS, and the
   registry comes out of advapi32's store alongside them.

**The output need not be packed.** `.btl` exists so a bundle can be range-fetched over a network; a
bundle produced by a local install never travels -- it is already in OPFS. So the finished prefix
mounts at `C:\App` as it stands, and packing is an export step for sharing a bundle, not a step in
installing one. That halves peak storage: packing means reading the installed tree and writing a
second copy of it, so a 4 GB game would want 8 GB of quota at the moment of packing.

The registry has to travel with the files either way. `.btl`'s index is JSON and could carry it, but
a file in the tree that the engine imports on mount is the better shape, because then an unpacked
prefix is self-describing and the packed form has nothing the unpacked form lacks.

### Two kinds of bottle, and only one of them is capped

A bottle made here and a bottle sent somewhere are not the same object, and only the second one has
a size problem.

- **A local bottle** is the prefix above: pull an installer from wherever it lives, run it, keep what
  it produced, mount it. It never leaves this machine and never gets packed, so its size is bounded
  by the origin's storage quota and nothing else.
- **A shareable bottle** is the packed form -- `bundle.btl` plus its manifest -- handed to the user's
  own disk or uploaded. This is where a limit belongs.

**Export refuses above 4 GiB; making a bottle does not.** The limit is a policy value, not something
the format requires: `.btl` is 64-bit throughout, and `showSaveFilePicker()` with
`createWritable()` streams past 4 GiB without complaint. Three things make the line worth drawing
anyway:

- The File System Access API is Chromium's. Everywhere else the export falls back to a blob, and a
  blob of this size genuinely does break -- so the cap is real on the browsers that need it most.
- Packing reads the installed tree and writes a second copy of it, so the moment of export wants
  twice the tree in quota.
- A bottle that big has to be hosted and range-fetched by whoever receives it. Past a few gigabytes
  that is a hosting decision, and it should be made deliberately rather than by whatever the browser
  happened to tolerate.

Enforced **before** packing starts, from the sum of the tree's file sizes, so nothing burns
gigabytes of quota to then be refused. The refusal names the size, the limit, and the way past it:
`tools/btl.mjs` has no cap -- it streams over `node:fs` and is bounded by disk -- so a bottle too
big to share from the browser is still a bottle somebody can pack locally and host themselves.

**The browser packer now exists**, as `installer/src/pack.js`. It was written the way this paragraph
warned against — a second writer rather than one writer with its byte sink injected — with
`CompressionStream('deflate-raw')` and `crypto.subtle` standing in for `node:zlib` and
`node:crypto`. What holds the two together is that both take the format constants and `crc32` from
the reader in `filesystem/internal/bundle/` rather than restating them, so the layout is still
described in one place. The paragraph's original point stands as the debt it named: two writers for
one container format is how the two drift, and nothing but a shared test asserts they agree today.

### Sharing a bottle: pack into the upload, not after it

Packing on a server is right, but the order matters. Uploading the prefix raw and packing it there
sends the whole installed tree uncompressed; packing first and uploading the blocks sends less. The
4 GiB wall was never on the upload -- a request body streamed a block at a time materialises nothing
-- so the browser packer is needed either way, and the only question is where its bytes go. Into the
request rather than into a file: that removes the doubled quota as well, because nothing is written
locally at all.

So the split is not "small bottles export, large ones do not". It is:

- **Export to the user's own disk** -- browser, streaming, Chromium only. Elsewhere the fallback is a
  blob and the cap above is real.
- **Export to share** -- an upload, at every size. A shared bottle has to be hosted for whoever
  receives it, so the bytes travel regardless; assembling the container on the far end is then
  simply where it is cheapest.

What makes the server worth building rather than merely tolerable is **block deduplication**.
Bottles overlap heavily -- redistributables, runtimes, engine files shared between titles -- so a
round trip asking which block hashes the server already holds can cut what a multi-gigabyte upload
actually transfers. That wants a real content hash per block: the `crc32` in the index is an
integrity check and is far too collision-prone to address content by.

The endpoint is private from the start -- an upload belongs to whoever owns the bottle, and
publishing is a separate act. An open endpoint accepting arbitrary game data is both a storage bill
and a legal surface, and neither is a thing to discover later.

### Sizes, and the 4 GiB question

Nothing on this path has a 32-bit ceiling, as long as the bundle is never materialised as one
object:

- `.btl` carries the index offset and length as 64-bit header fields and the index itself is JSON
  with ordinary numbers, so the format is good to 2^53 bytes.
- OPFS takes `at` as a number on both read and write, and `getSize()` returns one. The limit there
  is the origin's storage quota.
- Inside the guest, `SetFilePointer` already assembles the distance from both halves, so a file over
  4 GiB seeks correctly.

What does bite:

- **A single `ArrayBuffer`** is capped near 4 GiB and is a contiguous allocation that will fail long
  before that. The bundler must stream block by block into a sync access handle and never
  concatenate.
- **A `Blob` assembled in memory** has the same problem. Handing the finished bundle to the user's
  own disk goes through `showSaveFilePicker()` and `createWritable()`, which stream; a download
  link over a blob URL does not survive this size.
- **The quota is the real wall.** Ask `navigator.storage.estimate()` before starting and refuse an
  install that will not fit, rather than failing at ninety percent, and ask for `persist()` so the
  prefix is not evicted mid-install.

## Taxonomy: what these ten actually are

Five families. The offsets and import lists below are measured.

### A — No installer at all

**Quake III Arena Demo.** A zip of an already-installed directory: `quake3.exe`, `demoq3/pak0.pk3`,
642 entries, no setup program anywhere in it. (It has one oddity, a duplicated inner
`Quake 3 Arena Demo/` subtree, so the bundler cannot assume the archive root is the game root.)

Nothing to install. The whole job is choosing which directory inside the archive is `C:\App`.

### B — A plain archive of the installed tree, behind a wrapper

Three titles, three different wrappers, one shape underneath.

| Title | Wrapper | Payload |
|---|---|---|
| Need for Speed: Underground 2 | WinZip SFX; payload lives in a `_winzip_` **PE section**, not an overlay | 43 entries; `compressed.zip` (359 MB, **stored**, 1048 entries) holds `speed2demo.exe` and the whole game tree |
| Need for Speed: Most Wanted | ISO 9660 with a Joliet supplementary descriptor | `0compressed.zip` at the disc root (899 MB uncompressed, 552 entries) is the data tree; `speedDemo.exe` and `server.dll` sit beside it in the clear |
| Mafia: The City of Lost Heaven | UPX-packed PE stub with a `Rar!` overlay (RAR3) | `Game.exe`, `a0.dta`…`ab.dta`, `LS3D.dll`, `vorbis.dll` — the installed tree, plus a `MafiaDemoSetup.exe` |

For these three the installer is a delivery mechanism and nothing more. The files that end up on
disk are already sitting in an archive, whole. Host-side unpacking gets a bundle without the engine
executing a single guest instruction — the cheapest real result in the corpus, and the reason this
family comes first.

What it does not get: whatever the wrapped `setup.exe` writes to the registry, and any file the
installer generates rather than copies. Both are unmeasured for these titles, and both are the sort
of thing the game only misses on its second run.

### C — The publisher's own single-process installer

**Warcraft III: Reign of Chaos Demo.** A 290 KB Win32 GUI program with an MPQ archive appended at
byte 290 816 (`MPQ\x1a`), which it reads with its own code. Its import table is an ordinary
application's: `CreateWindowExA`, `DialogBoxParamA`, `RegCreateKeyExA`, `SHGetSpecialFolderLocation`
+ `SHGetDesktopFolder` + `SHGetPathFromIDListA` (a browse-for-folder), `CoCreateInstance` (almost
certainly the shell link for the Start Menu shortcut), `WritePrivateProfileStringA`, `MoveFileExA`,
`GetTempFileNameA`, `CreateProcessA` + `WaitForSingleObject` + `WaitForInputIdle`.

This is the family the engine should be able to run, and the one worth running first, because it
exercises the general path — a real UI, a real registry write, a real file copy — inside one
process. There is no second process for the extraction itself; `CreateProcessA` appears once and is
most plausibly the DirectX redistributable or the game at the end, which we do not need to succeed.

Nothing about this is Blizzard-specific in a way we can exploit and nothing about it should be. It
is simply a Win32 program that writes files.

### D — Self-extract to `%TEMP%`, then `WinExec` the real installer

**Doom 3 Demo** and **Half-Life 2 Demo** (the latter inside a one-entry zip). Both are Wise
Installation System stubs, and both appear to be the same stub build: identical import sets, 8.7 KB
of `.text`, and a `WiseMain` marker. 8.7 KB cannot be a whole installer, so the stub extracts a
larger payload to a temporary directory and starts it. The import table says how:

```
_lopen _lcreat _lread _lwrite _llseek _lclose OpenFile      the 16-bit-era file family
GetTempPathA GetTempFileNameA GetWindowsDirectoryA          where to put it
GlobalAlloc GlobalLock GlobalUnlock GlobalFree              its decompression buffers
WinExec                                                     starting the real installer
StretchDIBits PatBlt CreateSolidBrush DrawTextA             a splash window
OpenProcessToken AdjustTokenPrivileges ExitWindowsEx        the "reboot now?" path
```

Note what is *absent*: no `CreateProcessA`, no registry writes, no COM. The second stage does all of
that, and the second stage has not been observed — it is inside the payload. **This is the largest
unknown in the taxonomy**: the shape of stage two for the Wise family is inferred from the stub's
imports, not read.

Two processes, but strictly sequential: the stub extracts, spawns, and (via `WinExec`, which does
not wait) exits. That sequence is compatible with the replacement design in `../registers/process-creation.md`
— which is the point of raising it here.

### E — InstallShield 6/7, with an out-of-process engine

**Splinter Cell Demo**, **Max Payne 2 Demo** (inside a zip), and **Battlefield 2 Demo** at its second
stage. The first two are byte-for-byte the same `setup.exe` stub build; all three carry `data1.cab`
and `engine32.cab`, and their string tables name `ikernel.dll`, `isrt.dll`, `iscript.dll`,
`iuser.dll`, `_isres.dll`, `_setup.dll`.

Battlefield 2 gets there through one extra layer of its own: a 113 KB stub whose overlay is a flat
record stream (`Autorun.bmp\0autorun\Autorun.bmp\0 0.0.0.0\0 293516\0` then the raw bytes, repeating)
holding a complete disc image — an InstallShield `setup.exe`, `engine32.cab`, DirectX `MSCF`
cabinets and an MSI, at 493 MB, 515 MB and 533 MB into the file.

What makes this family expensive is not the cabinets. It is these seven ole32 imports, present in
all three:

```
CoRegisterClassObject  CoRevokeClassObject  GetRunningObjectTable
CoMarshalInterThreadInterfaceInStream  CoGetInterfaceAndReleaseStream
CoReleaseMarshalData   StringFromCLSID
```

That is a cross-apartment COM handshake, and InstallShield uses it to talk to `IKernel.exe`, which is
a **separate process that must be alive at the same time as `setup.exe`**. Plus nine `OLEAUT32`
imports by ordinal (the `SysAllocString`/`Variant` range — there is no oleaut32 in this tree at all),
`LZ32.dll`'s `LZOpenFileA`/`LZCopy`/`LZClose`, `VerInstallFileA`, and a token check
(`OpenProcessToken`, `GetTokenInformation`, `AllocateAndInitializeSid`, `EqualSid`) that is how a
2003 installer asks whether it is running as an administrator.

Concurrent processes are exactly what `../registers/process-creation.md` decided **not** to build. This family
is therefore the one that either waits for a different decision or is served another way.

### Not represented

No demo in this corpus is a bare MSI, an NSIS installer, or an Inno Setup installer. MSI appears
only as a DirectX redistributable inside two payloads, never as the game's own installer. That is a
property of the 1999–2005 window, and it means MSI support buys nothing here; it is listed under
what is out of scope rather than deferred.

## What the engine is missing

Checked against `modules/core/src/layers/win32/` as it stands, by taking each installer's import
table and subtracting what the tree exports. Only the misses are listed.

### The one that blocks three families

**`CreateProcessA`/`CreateProcessW` refuse.** `kernel32/system.js` sets
`ERROR_CALL_NOT_IMPLEMENTED` and returns zero, deliberately and with its reasoning written down.
`WinExec` does not exist at all. `../registers/process-creation.md` holds a finished design for this
(replacement: the parent is torn down and the app rebuilt on the child image) and it is not
implemented. Families D and E cannot start without it; family C imports `CreateProcessA` but plausibly
does not need it to succeed.

Family E needs more than that design offers — a parent and child *alive together*. Recording it here
so the choice is not re-litigated in the middle of a bring-up: replacement is the right call for
D, and E needs its own answer.

### kernel32

| Missing | Wanted by |
|---|---|
| `_lopen` `_lcreat` `_lread` `_lwrite` `_llseek` `_lclose` | D, and the WinZip SFX in B |
| `WinExec` | D, and the WinZip SFX in B |
| `GetTempFileNameA` | C, D, E |
| `GetPrivateProfileStringA` `GetPrivateProfileIntA` `WritePrivateProfileStringA` | C, E |
| `GetShortPathNameA` | C, E |
| `MoveFileExA` | C |
| `SearchPathA` | E |
| `FindResourceExA` | E |
| `LocalAlloc` (`LocalFree` is present) | the WinZip SFX in B |
| `DosDateTimeToFileTime` | the WinZip SFX in B |
| `SetVolumeLabelA` | C |

`OpenFile` exists. `CopyFileA`, `MoveFileA`, `CreateDirectoryA`, `SetFileAttributesA`,
`DeleteFileA`, `FindFirstFileA`, `GetFileAttributesA`, `GetDiskFreeSpaceA`, `GetTempPathA`,
`CreateFileMappingA`/`MapViewOfFile` are all present. The file surface is in good shape; it is the
16-bit-era spellings and the profile (INI) family that are absent, and both are unglamorous.

### advapi32

The registry is real and complete enough: `RegCreateKeyExA`, `RegOpenKeyExA`, `RegSetValueExA`,
`RegQueryValueExA`, `RegEnumKeyExA`, `RegDeleteKeyA` and the 16-bit ancestors are all there, over a
hive in `advapi32/registry.js`. **This is the part that was expected to be the problem and is not.**

Missing is the security half, which every installer in families C, D and E touches:
`OpenProcessToken`, `OpenThreadToken`, `GetTokenInformation`, `AllocateAndInitializeSid`, `FreeSid`,
`EqualSid`, `LookupPrivilegeValueA`, `AdjustTokenPrivileges`. All of it exists to answer one
question — "am I an administrator?" — to which the honest answer in a single-user emulated machine
is yes.

### user32

- `DialogBoxParamA` (C) and `DialogBoxIndirectParamA` (B, D, E) — **not implemented, and
  deliberately so.** `user32/dialogs.js` states the ceiling in its own header: the template is walked
  for real and dialog units are converted correctly, but "there is no modal loop and no keyboard
  navigation", a control "has no window procedure, because its class is a system one this build does
  not implement", and `WM_INITDIALOG` is posted rather than sent. An installer *is* a stack of modal
  dialogs full of system controls. This, not the file APIs, is the real user32 work.
- `MsgWaitForMultipleObjects` (E) — how the InstallShield stub waits on its engine while pumping.
- `CharNextA` `CharUpperA` `CharLowerA` `CharLowerBuffA` `OemToCharBuffA` — trivial, and everywhere.
- `PostThreadMessageA`, `SetWindowRgn`, `RegisterWindowMessageA`, `FindWindowA`,
  `GetLastActivePopup`, `WaitMessage`, `WaitForInputIdle`, `ExitWindowsEx`, `wvsprintfA`,
  `GetWindowWord`/`SetWindowWord`, `SetRect`.

### shell32

Six functions exist. Missing: `SHGetSpecialFolderLocation`, `SHGetDesktopFolder`, `SHGetFileInfoA`
(C), and — not imported by anything here but implied by `CoCreateInstance` in family C — the
`CLSID_ShellLink` class with `IShellLink` and `IPersistFile`, which is how a `.lnk` gets written.
`SHGetSpecialFolderPathA`/`SHGetFolderPathA` are absent too; nothing in this corpus imports them, but
they are the modern spelling of the same question and cost nothing beside the IDL-based one.

Note the shape of the answer: `SHGetSpecialFolderLocation` returns a PIDL that `SHGetPathFromIDListA`
(which does exist) turns back into a path. The pair has to agree, and where those folders *are* is a
policy decision this project has not yet made — see the open questions.

### ole32 and oleaut32

`CoInitialize`, `CoCreateInstance`, `CoTaskMemAlloc` and a real in-process class registry exist.
Missing for family E: `CoRegisterClassObject`, `CoRevokeClassObject`, `GetRunningObjectTable`,
`CoMarshalInterThreadInterfaceInStream`, `CoGetInterfaceAndReleaseStream`, `CoReleaseMarshalData`,
`StringFromCLSID`. **There is no `OLEAUT32.dll` in this tree at all**, and family E imports nine of
its ordinals (`SysAllocString` and the `Variant` helpers). Family C wants `OleInitialize`, also
absent.

### Libraries with no presence at all

`OLEAUT32.dll`, `LZ32.dll` (`LZOpenFileA`/`LZCopy`/`LZClose` — families E), `CABINET.dll` (FDI),
`SETUPAPI.dll`, `SHLWAPI.dll`, `MSI.dll`. Of these only oleaut32 and lz32 are actually imported by
anything in the corpus; the cabinet APIs matter only if we choose to let a guest installer unpack
`MSCF` cabinets through the system rather than through the code it ships.

### msvcrt

Family C links the system `MSVCRT.dll` directly and needs the C startup, none of which is here:
`__getmainargs`, `_initterm`, `_controlfp`, `__set_app_type`, `__p__commode`, `__p__fmode`,
`_adjust_fdiv`, `__setusermatherr`, `_acmdln`, `_XcptFilter`, `__CxxFrameHandler`, `__dllonexit`,
`_onexit`, `exit`, `_exit`, `_beginthread`, `_vsnprintf`, `srand`, and `fopen`/`fclose`.
`_except_handler3` exists; `__CxxFrameHandler` does not.

This is a generic gap, not an installer one — any program linked against the system CRT rather than
shipping its own hits it at startup, before `main`. It happens to be an installer that found it.

### Below Win32

- **UPX.** Family B's Mafia stub is UPX-packed: `UPX0` has zero raw size, the entry point decompresses
  into it, and the import table is three names. Whether the loader and the memory layer are happy with
  a section that is all virtual and then written to is **unverified**. It is a generic loader
  question and it will recur.
- **A writable volume that can be handed back.** `filesystem/internal/tree.js` already has
  `createOverlay({ source, writable, onChanged })` — a read-only source under a writable layer, with
  a change callback. That is precisely the mechanism for "run the installer, keep what it wrote", and
  it exists. What does not exist is a way to serialise the writable half into a bundle.

## The plan

Ordered by cost. Each stage is worth having on its own; none of the later ones is a prerequisite for
shipping the earlier ones.

### I1 — The bundler accepts an archive

Host-side only, no engine involvement. `tools/make-btl.mjs` learns to take a file instead of a
directory: sniff the container, enumerate it, pick the game root, pack.

Containers for this stage: **zip** (Node's `zlib` handles deflate; the corpus also uses *stored*
entries, and one nested zip is stored inside another, so streaming through without materialising
900 MB is worth getting right), **ISO 9660 + Joliet**, and **a zip carried in a PE section or
overlay** — which is the same zip reader given the right base offset, found by the standard
"EOCD minus central-directory size minus offset" prefix computation rather than by guessing.

Picking the game root is the one judgement call, and it must be a rule, not a list: descend while a
directory holds exactly one entry and that entry is a directory; among the candidates prefer the
shallowest directory containing a PE executable. Print what it chose and let `--root` override it.
The duplicated subtree in the Quake III archive is the case that breaks a naive rule, and it is in
the corpus precisely so the rule gets tested against it.

**Done when** `make-btl.mjs pack` produces a bundle directly from `quake-iii-arena`,
`nfs-underground-2` and `nfs-most-wanted`, and `make-btl.mjs verify` passes on each. Tests are
byte-level: a fixture archive of each container shape, asserting the file list, the chosen root, and
the bytes of one file inside.

### I2 — RAR3, and the same treatment for family B's third member

A RAR3 reader (headers first — filenames and sizes are in the clear, which is how the Mafia payload
was catalogued — then the decompressor). This is a real piece of work and it is separated from I1 so
that I1 is not held up by it.

**Done when** `mafia-city-of-lost-heaven` packs into a verified bundle, and a round-trip test
decompresses a fixture archive to known bytes.

### I3 — Make the engine able to *finish* an installer that only writes files

Everything up to here avoided the engine. This stage is where the general path starts, and family C
is the one to aim at because it is a single process.

In order:

1. The msvcrt startup set, so a program linked against the system CRT reaches `main`. Generic; owed
   regardless.
2. The kernel32 gaps in the table above — the `_l*` family, `GetTempFileNameA`, the profile (INI)
   functions, `GetShortPathNameA`, `MoveFileExA`.
3. advapi32's token functions, answering "yes, administrator".
4. shell32's special folders and `SHGetDesktopFolder`, plus a decision about where those folders
   live in the guest.
5. `user32`'s modal dialog: `DialogBoxParamA`/`DialogBoxIndirectParamA` with a real modal loop, and
   window procedures for the system control classes an installer uses (button, static, edit,
   progress). This is the largest single item in the stage and it is not installer-specific — every
   application with a settings dialog needs it.
6. A capture path: mount the installer file read-only, run it against a writable overlay with no
   bundle beneath it, and serialise the overlay into a bundle when the guest exits. **Done**, though
   not as a flag on the bundler — it is `@bottlify/installer`, driven by the launcher, and it packs
   into the upload rather than into a local file. Items 1 to 5 are what remains, and they are the
   reason no distribution finishes.

**Done when** the Warcraft III demo installer runs to completion under the harness without a host
call reporting `NOT_IMPLEMENTED`, and the captured overlay contains the game's data files and the
registry values the installer wrote. A regression test asserts a named file exists in the capture
with the right size — the same shape of assertion the graphics tests use, and for the same reason.

### I4 — Process replacement, and family D

Implement `../registers/process-creation.md` as written, plus `WinExec` (which is `CreateProcess` with a
`SW_` argument and no wait). Family D's stub extracts to a temporary directory and starts stage two
without waiting, so replacement loses nothing: there is nothing the parent still had to do.

The risk to name in advance: the capture must span the replacement. The writable overlay has to
survive the app being torn down and rebuilt on the child image, or the capture is of stage two's
work alone and the extracted payload has vanished. That is a constraint on where the overlay lives,
and it is cheaper to decide now than to discover.

**Done when** the Doom 3 and Half-Life 2 demo installers reach their second stage, and the capture
contains what both stages wrote. Whether stage two then *completes* is a separate question — its
requirements are unread, and this stage's acceptance stops at reaching it.

### I5 — Family E, and the decision it forces

InstallShield 6/7 needs `setup.exe` and `IKernel.exe` alive together, which replacement cannot give.
Three options, and the measurement that should decide between them has not been taken:

- **Two machines.** A second emulator instance with a channel for the handful of facts that cross.
  Honest, expensive, and the answer `../registers/process-creation.md` names for exactly this case.
- **Fold the engine in.** `IKernel.exe` is registered as a local server and reached through the
  running-object table; a `CoRegisterClassObject` that keeps the object in-process and a marshalling
  pair that hands back the same pointer would let one process play both parts. Whether InstallShield
  tolerates that is unknown, and finding out is a day of measurement, not a design.
- **Unpack `data1.cab` on the host.** Well-documented, and it sidesteps the COM problem entirely —
  at the cost of every decision the InstallScript makes, which for a game demo is usually a path and
  a registry key.

Take the measurement first: run `setup.exe` under the harness with the ole32 and oleaut32 gaps filled
and see how far it gets before it needs the second process. That answer costs a day and rules out at
least one option.

**Done when** the corpus's three InstallShield titles produce bundles by *some* route, and the route
chosen is written down here with what it cost.

### I6 — Battlefield 2's outer wrapper

A flat record stream (name, relative path, version, decimal size, then raw bytes) with no
compression. Once family E works, this is an afternoon: parse the records, write the disc image out,
hand the `setup.exe` inside it to the same pipeline.

Sequenced last because on its own it produces an installer we cannot yet run.

## Where a human is needed

Two places, and only two.

**A single click-through capture per installer that gates on a licence agreement.** Every installer
in families C, D and E shows a EULA and refuses to proceed until someone accepts it. The engine can
click that button once the modal dialog of I3 exists — but until then, and as a fallback afterwards,
the fastest way to unblock a title is for a person to run its installer once on a real Windows
machine and hand back the installed directory, which `make-btl.mjs pack` already accepts unchanged.

Concretely, what would help most, in order:

1. **Splinter Cell, Max Payne 2 and Battlefield 2 installed once each, as directories.** These are
   family E, the most expensive to automate, and having the expected output makes I5's options
   comparable instead of theoretical — we could diff what our route produces against what the real
   installer produced, which is the only way to know whether a host-side unpack lost anything.
2. **A registry export (`.reg`) taken after each of those installs**, covering the keys under
   `HKLM\SOFTWARE` and `HKCU\Software` that the installer created. The captured filesystem is only
   half of what a game reads on first launch, and this is the other half. Cheap to produce, and it
   turns "the installer probably wrote a path here" into a fact.

**Confirming an ambiguous archive root.** I1's rule will be wrong for some layouts. `--root` exists
for that, and being told "it picked the wrong directory for this one" is more useful than another
heuristic.

Nothing else needs a person. In particular, nobody needs to sit through an install for family A or
B: those three titles are unpacked entirely on the host.

## Open questions

- **Where do the special folders live in the guest?** `SHGetSpecialFolderLocation` for
  `CSIDL_PROGRAM_FILES`, `CSIDL_PERSONAL`, `CSIDL_APPDATA` and `CSIDL_STARTMENU` has to answer
  something, and the answer decides where an installer puts the game — which then has to match where
  `C:\App` is when the bundle is mounted. If an installer writes an absolute path into the registry
  and the game reads it back at a different location, nothing works and the failure looks like a
  missing file. This is a policy decision the project has not taken, and I3 cannot be finished
  without it.
- **What does stage two of the Wise family look like?** Inferred from the stub's imports and nothing
  else. Whoever starts I4 should extract one payload first and read it, rather than discovering its
  requirements one `NOT_IMPLEMENTED` at a time.
- **Does the loader handle a UPX-packed image?** `UPX0` has zero raw bytes and is written by the
  entry stub. Unverified against the memory layer's region rules, and it is a generic question that
  a game will ask eventually whether or not an installer does.
- **Does the writable overlay survive a process replacement?** Named under I4. Unmeasured.
- **Is `data1.cab` worth reading ourselves?** It is InstallShield's own container, not `MSCF`, and
  its layout differs between engine versions. Only worth answering if I5 takes the host-side route.

## Deliberately out of scope

- **MSI.** Nothing in this corpus installs through it. It appears only as a DirectX redistributable
  inside two payloads, and the redistributables themselves are out of scope: the engine implements
  the DirectX surfaces natively, so installing Microsoft's copies of them into the guest would
  achieve nothing.
- **NSIS and Inno Setup.** Neither appears in the corpus. Both are common enough in other eras that
  they will arrive, and both are well-documented containers — but a plan written against samples we
  do not have would be a guess.
- **Uninstallation, patching, and multi-disc media.** A bundle is built once.
- **Anything that branches on a title.** Container sniffing is a statement about a file format.
  A rule that names a game is not, and does not belong in any of the above.
