# Limits: the installer

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
- A service a package installs is registered with the service manager and stays stopped until
  `StartService` starts it, or COM for a class it serves as its `LocalService`: its process on
  the service's own command line, once for the run whoever asks (a second start is
  `ERROR_SERVICE_ALREADY_RUNNING`). Another process's `QueryServiceStatus` finds it running from
  the moment its process stands, before its `ServiceMain` reports so, and stopped once the
  process is gone. It runs until the program the run started ends, and is ended with it without
  being told `SERVICE_CONTROL_SHUTDOWN`; a service set to start with the machine is not started
  when a run begins. ODBC drivers and data sources, COM+ applications and side-by-side or global assembly
  cache assemblies are not installed.
- An advertise script cannot be written or read (`MsiAdvertiseScript`,
  `MsiProcessAdvertiseScript`, `MsiGetProductInfoFromScript`, `MsiAdvertiseProduct` to a file).
- `msiexec.exe`, `rundll32.exe`, `regsvr32.exe` and `reg.exe` in `C:\WINDOWS\system32` are the
  engine's own: a program that starts one gets a process that drives `msi.dll`, the named
  library's entry point, its registration exports or the registry, and exits with what Windows'
  program would. `reg` takes `add`, `delete` and `query` (with `/s` alone of the query's filters)
  on this machine's keys. The volume shows no file at those paths, so a setup that checks for one
  before starting it does not find it.
- A program custom action run asynchronously is waited for where its sequence ends, unless its
  answer is ignored, and its exit code is then the action's.
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
