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
  child ends. In the `workers` mode a child starts at `CreateProcess` and runs beside its parent,
  both taking turns on the engine thread.
- Only the process of an out-of-process COM server runs alongside the program that uses it, outside
  the `workers` mode.
- With `processWorkers`, a child in a worker of its own shares the run's registry, files, window
  directory -- its windows found, read, posted and sent to by every other process, and theirs by
  it -- ids, the run's bundle (a block it misses is fetched for it) and named events, semaphores
  and mutexes; a wait on a set of objects one of which
  another process across a worker named is refused. It has no COM server, graphics or sound; a
  redirected standard output is written there, but the parent's position does not move with it.
- Windows are the run's: a process finds another's window (`FindWindow`), reads who made it, its
  caption and class, and posts to it. A message sent to another process's window is answered in the
  `workers` mode; its pointers cross only for `WM_COPYDATA`, `WM_SETTEXT` and `WM_GETTEXT`. Where
  a parent waits while its child runs, a message the child sends to the parent's window is refused
  at once, as one that timed out.

## Graphics

- A picture needs WebGPU. A canvas that gives no WebGPU context fails the start (`reason: 'gpu'`).
- No Direct3D 11 or 12.
- Direct3D 10 and Vulkan draw on the engine thread; Direct3D 7, 8, 9 and OpenGL in the graphics
  worker.
- A lost GPU device is not recovered: `Present` and `Reset` answer `D3DERR_DEVICELOST`
  (`D3DERR_DEVICEREMOVED` on 9Ex) and no new frames arrive.
- DXT textures are decoded on the CPU unless `graphics.compressedTextures` is on and the GPU has
  `texture-compression-bc`.
- Shaders and pipelines are cached in memory only; every run builds them again.
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

## Network

- No raw TCP or UDP. Sockets go through the relay over WebSocket; without `network` only the
  loopback adapter exists.
- The relay links tabs in one room and reaches outside hosts only from its server's allow list.
- A single TCP `send` over 64 KiB fails: the relay's frames carry at most 64 KiB and are not split.

## Files

- The bundle is read-only. What the program writes goes into the session, kept per `id`.
- A file mapping is a copy: a view reads the file when it is made and writes it back when it is
  closed, so two views of one file do not see each other's writes.
