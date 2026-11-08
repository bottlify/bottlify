# The project in 3D

Every part of Bottlify as a point: the packages, the engine's layers, the libraries and APIs inside
each layer, cork's parts and the threads the engine starts. A line joins a part to what it holds
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

route hello-world.md
-->
