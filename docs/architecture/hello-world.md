# How a program runs: hello world

This page follows one small Windows program from the page's first call to the program's end:

```c
#include <windows.h>

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR line, int show)
{
    MessageBoxA(NULL, "Hello, world!", "Hello", MB_OK);
    return 0;
}
```

Each step names the parts that take part in it; on the site a diagram of those parts follows
the text as it scrolls. The pages linked from each step say the same thing in full. This is the
default run, one process on the engine's thread; what changes with several is in
[Threads](threads.md).

<!-- nodes
page               0 0 Page
worker/engine      1 0 Engine thread
opfs               2 0 OPFS
server             3 0 Server
core/kernel        0 1 kernel: scheduler
core/loader        1 1 loader
core/filesystem    2 1 filesystem: C:
core/cpu           0 2 cpu: cork
program            1 2 hello.exe in memory
core/bridge        2 2 bridge
presenter          3 2 presenter
worker/translator  0 3 translation worker
core/input         1 3 input
core/win32/user32  2 3 win32: user32
core/graphics/gdi  3 3 graphics: windows
-->

### 1. The page starts the engine
<!-- step: page>worker/engine -->

The page calls `createApp({ executable })` ([API](../core/api.md)). That starts the engine's
worker and hands it the page's canvas as an `OffscreenCanvas`. Everything below happens in that
worker: the page passes input in and the engine draws ([Threads](threads.md)).

### 2. The engine builds its layers
<!-- step: worker/engine>core/kernel, worker/engine>core/loader, worker/engine>core/filesystem, worker/engine>core/cpu -->

The engine builds its layers in the order of their `requires`: the log, the processor (which
loads cork by URL), memory, the kernel, the loader, the bridge, the files, Win32, graphics, sound
and input ([What it is made of](README.md#what-it-is-made-of)).

### 3. The program's files
<!-- step: core/filesystem>server, core/filesystem>opfs -->

The program sees a `C:` drive. A program given as bytes is placed in `C:\App`; a bundle is read
from the server a block at a time with HTTP Range requests, and every block fetched is kept in
OPFS. The files the program wrote on an earlier run are laid over it before its first
instruction ([Storage](storage.md)).

### 4. The loader maps the program
<!-- step: core/filesystem>core/loader, core/loader>program -->

The loader reads `hello.exe`'s headers, maps its sections into the program's memory and binds
its imports. `user32.dll` and `kernel32.dll` are not files: the engine builds them, each export a
few bytes of stub in the program's memory with its handler in JavaScript
([Which DLL the program gets](win32.md#which-dll-the-program-gets)).

### 5. The main thread waits for `run`
<!-- step: core/loader>core/kernel, page>worker/engine -->

The program's main thread goes into the scheduler. Once the page has attached the log, input and
sound, it sends `run`. The libraries' `DllMain` and TLS callbacks are the program's code too: a
stub at the start of the main thread calls them ([Startup](startup.md)).

### 6. cork runs the program's code
<!-- step: core/kernel>core/cpu, core/cpu>program, core/cpu>worker/translator, worker/translator>opfs -->

The scheduler gives the main thread a time slice on cork. New code runs in the interpreter, which
counts the jumps to each address; code jumped to often enough goes to the translation worker,
which makes a WebAssembly module of it. The translations are kept in OPFS, so the program's second
run starts fast ([How cork works](../cork/how-it-works.md)).

### 7. The call leaves the program
<!-- step: program>core/bridge, core/cpu>core/bridge -->

`MessageBoxA` is called through the import table, into user32's stub. The stub's `out dx, eax`
stops cork, and the bridge takes the call with the registers as cork left them
([One call, from the program to JS and back](win32.md#one-call-from-the-program-to-js-and-back)).

### 8. The bridge calls user32
<!-- step: core/bridge>core/win32/user32 -->

The bridge reads the arguments where the calling convention puts them: from the stack in a 32-bit
process, from RCX, RDX, R8 and R9 in a 64-bit one. user32's handler for `MessageBoxA` gets four
numbers and reads the text from the program's memory
([`user32/msgbox.js`](../../modules/core/src/layers/win32/user32/msgbox.js)).

### 9. The message box is drawn
<!-- step: core/win32/user32>core/graphics/gdi, core/graphics/gdi>presenter, presenter>page -->

user32 makes the message box: a window with the text and an OK button. Each top-level window
draws on a surface of its own, and the window manager composes the desktop from them; the
presenter puts the frame into the `OffscreenCanvas` the page shows ([Graphics](graphics.md)).

### 10. The thread waits
<!-- step: core/bridge>core/kernel -->

`MessageBoxA` does not return until the box is closed. Its handler answers with a promise: the
program's thread parks in the scheduler, and every other thread goes on running
([One call](win32.md#one-call-from-the-program-to-js-and-back)).

### 11. A click
<!-- step: page>core/input, core/input>core/win32/user32 -->

The page sends the mouse to the engine. The input layer puts the button's messages into the
message queue of the window under the pointer, and the OK button closes the box
([Threads](threads.md)).

### 12. The answer goes back
<!-- step: core/win32/user32>core/bridge, core/bridge>core/cpu, core/cpu>program -->

The promise settles with `IDOK`. The bridge puts it in EAX (RAX at 64 bits), and the thread
resumes at the return address as if the call had been an ordinary one.

### 13. The program ends
<!-- step: program>core/kernel, core/kernel>opfs -->

`WinMain` returns and the C runtime calls `ExitProcess`. The process ends, and the files it wrote
stay in its session in OPFS for the next run ([Storage](storage.md)).
