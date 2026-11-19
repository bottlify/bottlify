# Limits: processes

- With several executors (`cpu.cores`), the others see what one thread does in the order the host
  keeps. The locked instructions, `xchg` and the kernel's own objects are atomic and ordered
  everywhere; a plain store is ordered after the stores before it only on a host that keeps that
  order itself (x86 does). On a host that does not (an ARM machine), a program passing a message
  through plain stores alone (a flag after its payload, a spinlock released with `mov`) may see
  the flag before the payload.
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
- A thread's environment block, its thread-local array and its copies of the images'
  thread-local blocks come from the arena the heap is carved from, and go back to it once the
  thread has ended and runs on no executor (checked when the next thread is made). With no room
  left there, CreateThread stops the run with an error, where Windows answers
  ERROR_NOT_ENOUGH_MEMORY.
- A program is told it has one processor for each of its executors
  ([`cpu.cores`](../configuration.md#cpu)), and a thread's affinity mask keeps it to those executors.
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
  thread; with 2 or 4 they run at once (`concurrency` in [api.md](../api.md)). Either way a parent
  reaches into its child: its memory (`VirtualAllocEx`, `VirtualFreeEx`, `VirtualProtectEx`,
  `VirtualQueryEx`, `ReadProcessMemory`, `WriteProcessMemory` and ntdll's forms, each copy going
  through the pages' protection on both sides as Windows' does), its first
  thread (`SuspendThread`, `ResumeThread`, `GetThreadContext`, `SetThreadContext`), and a thread it makes there with
  `CreateRemoteThread`, which it waits on and reads the exit code of. A wait on a
  child's thread is answered within a few milliseconds of its end, asked of the child until
  then. `NtQueryInformationProcess` on a child's handle is answered by the child; once it has
  ended, its id, parent and exit status remain and its PEB address does not. `SetThreadContext` replaces
  another thread's registers where it next runs, after the wait it may be in, as Windows does at its
  return to user mode; the calling thread's own and the x87 state of a 32-bit context are not
  replaced. `NtUnmapViewOfSection` on a child's handle unmaps the view there, named by any address
  inside it. Not yet: `OpenThread` of a child's thread the parent was not told of, mapping a view
  into a child (`NtMapViewOfSection` on its handle is refused, said once), and unmapping a child's
  image. Any process of the
  run opens another by its id (`OpenProcess`) wherever each of them runs: a wait on that handle
  ends with the other's exit and `GetExitCodeProcess` reads its code; nothing else of it is asked
  across a link. A call made in a
  child in a worker of its own takes about 1.4 ms when the child is busy or suspended and about
  15 ms when every thread of the child waits, measured in Node.
- A mutex, event, semaphore or waitable timer opened by name carries the rights it was granted: no
  rights at all, or rights the kind does not have, are refused, and a handle without SYNCHRONIZE
  cannot be waited on, nor one without the modify right set, reset or released. A keyed event
  carries the rights asked for when it is made as well. A process opened by id (`OpenProcess`)
  carries the rights asked for: its memory calls need `PROCESS_VM_OPERATION`, `PROCESS_VM_READ`,
  `PROCESS_VM_WRITE` or `PROCESS_QUERY_INFORMATION` as on Windows, and a handle it opens to its own
  id is this process to them. A file opened by `CreateFile` or `NtCreateFile` carries what was
  asked, generic rights mapped to `FILE_GENERIC_*`: reads need `FILE_READ_DATA`, writes
  `FILE_WRITE_DATA` or `FILE_APPEND_DATA`, and its duplicate cannot be granted a right it lacks
  (`ERROR_ACCESS_DENIED`). Other handles a process creates, and every other kind, have every
  right. A job and a completion port made by name share the one namespace
  of named objects. `TerminateJobObject` ends every process of the job with its code, as
  `TerminateProcess` does, and leaves the job signalled for good; a process that has ended joins
  no job, and a job's accounting counts the processes ever assigned and those still running. A
  job associated with a completion port tells it of each process it takes (those it already runs
  as it is associated), of each child that exits (an exception's code as an abnormal exit) and of
  its last running process gone; with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` its last handle closed
  ends its processes. A child of a process in a job is in the job too, unless the job lets it
  break away (`JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, or `JOB_OBJECT_LIMIT_BREAKAWAY_OK` and a
  `CREATE_BREAKAWAY_FROM_JOB` child), and `CREATE_BREAKAWAY_FROM_JOB` from a job that allows
  neither is refused (`ERROR_ACCESS_DENIED`). Jobs nest: a job of no hierarchy and no process
  of its own that a process in a job is assigned to becomes its innermost job's child, a process
  in a job is in every job above it, and a job of another hierarchy refuses it
  (`ERROR_ACCESS_DENIED`). `PROC_THREAD_ATTRIBUTE_JOB_LIST` makes a child in the jobs it names,
  each nested under the one before; a handle that names no job fails `CreateProcess`
  (`ERROR_INVALID_HANDLE`), a job of another hierarchy refuses the child (`ERROR_ACCESS_DENIED`)
  after the jobs before it heard it come and go. The job's other limits are kept and read back, not
  enforced, and this
  process's own exit is told to no port. Not exported, as on Windows 7: the
  synchronization barrier, `GetProcessInformation` and job objects.
- In `compatible` mode a child's sound is mixed into its parent's output (the engine's mixer has
  no arena to lend it a table on), and goes on after a parent that exits first.
- With `concurrency` 2 or 4 a process's own journal (its calls, phase profile and frames) stays in
  its worker: the run's log holds the events every process reports and what the engine's thread
  writes. Where the run traces calls (a `trace` level in `log.categories`), a process in a worker
  hands its journal back as it ends, as the run's `process-journal` event (`{ image, id, entries }`). A process in a worker takes its translations from the run's one store, which the
  engine's thread keeps open, and puts what it makes there; a batch's lookups cross the link
  together, one wait per batch. It places no hooks (`hooks`, `watchImport`) and reaches no network
  transport the page handed in (`win32.network`). The run's diagnostics are the program's tables as
  it last answered (its `log` with phases and frames, and `audio`, as with one process), with the
  engine thread's own journal and sound output beside them as `system-log` and `system-audio`.
- The run's translation workers are a pool: each process and each of its executors is lent one,
  and more join one whose translation lags only while the run holds fewer than the host's cores
  less two, as Windows shares its processors. A process that rested (its workers idle 5 s)
  translates on its own thread until it emits there and is lent one again. On a machine
  whose cores a loading game already keeps busy (four cores, measured), a second worker makes
  loading slower, and the pool gives it back after its trial; the gain is for machines with cores
  to spare and has not been measured on one yet. Only translation runs in the pool so far: bundle
  blocks are still decoded on the thread that mounted the bundle.
- With `concurrency` 1 the process of an out-of-process COM server runs beside the program that
  uses it, on the engine thread, not counted in `concurrency`. With 2 or 4 the class table is the
  run's, kept on the engine thread: a server COM starts runs in a worker of its own while the run
  has room for one, and otherwise beside the process that asked, in its worker; a call from one
  worker to another goes through the engine thread and back.
- A process gone leaves its memory to the run, which keeps as many as ran at once and four more:
  the next process it starts takes one rather than a memory of its own, on the engine's thread or
  in a worker of its own (a worker's goes back to the engine's thread as it ends). What it is
  handed there reads as in a new memory (`roadmap/decisions.md` A242).
- With `concurrency` 2 or 4 a child of a process in a worker runs in a worker of its own while
  the run has room, and otherwise beside its parent in the parent's worker, sharing its link to
  the engine thread: each process there waits on the run's named objects, answers for its own
  windows and is lent translation workers by the run's pool as one in a worker of its own does.
- Views of one page-file section (a named or inherited `CreateFileMapping` of no file) agree
  across the processes on the engine's thread at the edges of their turns: what one writes the
  other reads from its next turn on, and two views in one process agree from one turn to the next,
  not within one. Each turn compares the views of every section with two views or more, so its
  cost grows with the bytes shared. A view of a file, and a process in a worker of its own, keep a
  copy of their own.
- Named pipes are the run's, between the processes on the engine's thread: byte and message
  pipes, overlapped reads and connects completed through their event and completion port, and a
  pipe end a child inherits (`bInheritHandles`, or a STARTUPINFOEX handle list) under its parent's
  number. A child on the engine's thread inherits its parent's inheritable events, mutexes,
  semaphores, waitable timers, processes and threads the same way, and its open files: the
  child opens the file as its own on the terms the parent's open agreed, sharing the parent's file
  pointer, and the file stays open until the last of their handles closes, as it does for a file
  `DuplicateHandle` puts into another process of the run. A child in a worker of its own
  inherits pipe ends and open files: a file there is opened on the same terms, its pointer the
  parent's open's, read and moved across the link on each read and write, and the parent's hold
  on it lasts until that child ends. A file handed as a standard handle is one of these, so it
  must be inheritable, as on Windows. A child's standard handles are the ones its STARTUPINFO names with
  `STARTF_USESTDHANDLES`, or else its parent's own, of those it inherits; a console child that
  inherits nothing is not handed its parent's standard handles, as Windows hands them. A process in a worker of its own makes and opens none (`CreateNamedPipe` is refused, as
  Windows 9x refuses it), but the ends a parent on the engine's thread hands it (its standard
  handles redirected to pipes, or any inherited end) it reads, writes, peeks and closes as its
  own: they are served where the parent holds them, and a wait on such a handle itself fails
  (`ERROR_INVALID_HANDLE`, said as a divergence); so does a `ReadFileEx` or `WriteFileEx` on one,
  which works on a pipe of the engine's thread. A write waits, as on Windows, until what is
  queued up to its end fits the buffer the pipe was made with (the server's output size one way,
  its input size the other) and `FlushFileBuffers` until the reader has taken everything; a write
  from a process in a worker of its own is the exception and finishes at once, said as a
  divergence. `GetOverlappedResult` on a pipe operation whose OVERLAPPED has no event waits on
  nothing. The pipe device opens by its own names (`\Device\NamedPipe` and its root
  `\Device\NamedPipe\`): pipes are made under the root, one made there with no name is a pipe
  only its server's handle opens, and `FSCTL_PIPE_WAIT` through the root waits for an instance
  to listen, its thread waiting whatever the handle's mode; a wait given an absolute time-out
  answers `STATUS_IO_TIMEOUT` at once, said as a divergence.
  `ImpersonateNamedPipeClient` takes on the client once the server has read from it, as the
  process's own account at SecurityImpersonation: every process is the one user, and a client's
  security quality of service and impersonated token are not carried.
- A child in a worker of its own shares the run's registry, files, window directory (it finds,
  reads, posts and sends to every other process's windows, and they to its), ids, bundle (a block
  it misses is fetched for it), named events, semaphores and mutexes, and the position of a file
  its parent handed it as its output; a named file mapping or waitable timer is its own. A set of
  objects of which one was named by a process in another worker is waited on for any of them as
  any set is: whichever comes first ends the wait with its index, and an object of another
  process handed over after that is given back (an event set again, a count or a mutex
  returned), so its other waiters see it a moment later. A wait for all of such a set is
  refused. Its
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
- A child started with `DEBUG_PROCESS` or `DEBUG_ONLY_THIS_PROCESS` reports its debug events to
  its parent, each stopping the whole child until `ContinueDebugEvent`. `DebugActiveProcess`
  attaches to a running child the parent hears - one run beside it, as every child is at
  concurrency 1: it is told the process, ntdll, its threads and its libraries, the child stopped
  until each is continued, then breaks in on a thread of its own running `DbgUiRemoteBreakin`,
  as `DebugBreakProcess` breaks into a debuggee: its `DbgBreakPoint` is what the debugger hears,
  and a breakpoint the debugger declines ends that thread, not the process (a 64-bit process's
  thread runs `DbgBreakPoint` alone, with no such frame). A debuggee belongs to a debug object - the
  debugging thread's, made at its first `DEBUG_PROCESS` or attach (`DbgUiConnectToDbg`), or one
  made by `NtCreateDebugObject` and attached through (`NtDebugActiveProcess`); when its last
  handle closes, or its process ends, the debuggees end (`STATUS_DEBUGGER_INACTIVE`) where it
  says `DEBUG_KILL_ON_CLOSE` (`DebugSetProcessKillOnExit`, `NtSetInformationDebugObject`) and
  go on otherwise. A child in a worker of its own cannot be attached to (refused). A breakpoint
  shows its debugger the thread past the `int3`. A wait hears only the debuggees of the debug
  object it waits on - `WaitForDebugEvent` and `ContinueDebugEvent` the calling thread's, as
  `DbgUiWaitStateChange` and `DbgUiContinue`, `NtWaitForDebugEvent` and `NtDebugContinue` the one
  named - and hands out the state change `DbgUiConvertStateChangeStructure` converts. Not done:
  an alertable native wait is not ended by an APC; a debuggee's own children are not debugged
  under `DEBUG_PROCESS`;
  hardware breakpoints and the trap flag raise nothing; a 64-bit debuggee reports neither its
  start nor its exceptions; `hFile` and `lpImageName` are always null.
