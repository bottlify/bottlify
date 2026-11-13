# Limits: processes

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
  `VirtualQueryEx`, `ReadProcessMemory`, `WriteProcessMemory` and ntdll's forms), its first
  thread (`SuspendThread`, `ResumeThread`, `GetThreadContext`), and a thread it makes there with
  `CreateRemoteThread`, which it waits on and reads the exit code of. A wait on a
  child's thread is answered within a few milliseconds of its end, asked of the child until
  then. `NtQueryInformationProcess` on a child's handle is answered by the child; once it has
  ended, its id, parent and exit status remain and its PEB address does not. Not yet:
  `SetThreadContext` (refused for every thread: one stopped inside a call into the system would
  have the registers put in its place overwritten as the call returns), `OpenThread` of a child's
  thread the parent was not told of, and reading another process's TEB or PEB. Any process of the
  run opens another by its id (`OpenProcess`) wherever each of them runs: a wait on that handle
  ends with the other's exit and `GetExitCodeProcess` reads its code; nothing else of it is asked
  across a link. A call made in a
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
  number. A process in a worker of its own makes and opens none (`CreateNamedPipe` is refused, as
  Windows 9x refuses it), but the ends a parent on the engine's thread hands it (its standard
  handles redirected to pipes, or any inherited end) it reads, writes, peeks and closes as its
  own: they are served where the parent holds them, and a wait on such a handle itself fails
  (`ERROR_INVALID_HANDLE`, said as a divergence). Writes are never held back by a full buffer, and `GetOverlappedResult` on a pipe
  operation whose OVERLAPPED has no event waits on nothing.
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
