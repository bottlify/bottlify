# The project in 3D

Every part of Bottlify as a point: the packages, the engine's layers, cork's parts, the threads the
engine starts, and the Windows libraries and APIs each layer reproduces. The colours tell what is
the project's own from what is Windows reproduced: a Windows library is described by Windows' own
documentation, so its card only says which layer answers for it. A line joins a part to what it holds
and a layer to the layers it `requires`. The graph is read from the code when the site is built,
so a library added to a layer is a new point the next time.

Press **Play** to send the [hello world](hello-world.md) program through it: the call runs from
point to point, step by step, and the caption says what each step does. Drag to turn the graph,
scroll or pinch to zoom, and click a point to fly to it and read what it is.

The graph is drawn on the site; on GitHub this page is only its text.

<!-- graph3d
node page | Page | The browser page: the launcher, createApp, input and the canvas.
node server | Server | Serves the engine, the bundles a block at a time, and the relay.
node opfs | OPFS | The browser's file system: the block cache, the translations, the session.
node program | hello.exe | The program, mapped into its memory.
node presenter | presenter | modules/core/src/host/serve.js | Puts each frame into the page's OffscreenCanvas.
link page > worker/engine
link worker/engine > core
link core/graphics > worker/graphics
link core/cpu > cork
link core/filesystem > server
link core/filesystem > opfs
link core/loader > program
link worker/engine > presenter
link core/win32/wsock32 > networking

ours core/graphics/webgpu | The WebGPU backend every device draws through: pipelines, shaders, textures, and the desktop the windows are composed into.
ours core/graphics/seam | Where a program reaches the graphics layer: the exports of d3d8.dll, ddraw.dll, opengl32.dll and the rest, and the objects they hand out.
ours core/graphics/remote | The road to the graphics thread: each device call written into a batch, played by the device's twin there, and the frame sent back.
ours core/audio/output | Several programs' sound made into one stream for the AudioWorklet.
ours cork/decode | Turns bytes into instructions, from opcode tables written by hand.
ours cork/emit | Turns a region of x86 into one WebAssembly function.
ours cork/wasm | Writes the WebAssembly bytes, and finds out what the browser supports.
ours cork/runtime | Everything around translation: the queue, the translation workers, the memory finished code is kept in, the translation store.
route hello-world.md
-->
