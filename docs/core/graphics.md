# graphics

The drawing APIs a Win32 program may have been written against -- DirectDraw, Direct3D 7, 8, 9
and 10 with DXGI, OpenGL 1.1 with WGL, and Vulkan -- over one WebGPU backend. See
[README.md](README.md) for the layer map, [system.md](system.md) for the module contract this
layer implements and [host.md](host.md) for how a build is assembled.

## Purpose

A program does not construct a renderer; it links against `d3d8.dll`, calls `Direct3DCreate8`,
and drives what it is handed through a COM vtable. This layer publishes those libraries into the
guest, answers every slot of every interface a program can reach, models what a program can
observe about a device between draws (reference counts, state read-back, lost-device rules,
capability bits), and turns the draws that pass validation into WebGPU commands. Every API lives in
its own directory and knows nothing of the others; `src/layers/graphics/module.js` is only the
place they are handed what they share -- the GPU device, guest memory, and the bridge's way of
publishing an interface. The backend is built lazily, so a build with no GPU still assembles and
answers every state question; only a draw needs a device.

## Contract

| field | value |
|---|---|
| `name` | `graphics` |
| `version` | `0.1.0` |
| `requires` | `win32`, `bridge`, `memory` |

Source: `src/layers/graphics/module.js`. The layer also imports one `win32` file directly
(`src/layers/win32/user32/display.js`, for the display-mode list), which the boundary check
allows because `win32` is declared.

### Configuration

| option | type | default | meaning |
|---|---|---|---|
| `device` | `{ device, queue, adapter?, canvas?, screen?, presentTo?, onFrame?, onPresented?, onPresentFailed?, dumpDraws?, maxDraws?, skipTexture?, probeTexture?, fog?, mips? }` or absent | absent | The GPU. `device` and `queue` are the WebGPU objects; `presentTo(frame)` receives a finished frame in a build that did not supply a presenter; `canvas`/`screen` and the three frame callbacks are what the run's presenter is made from. Absent, `available()` is false, `backend()` throws on first use, and every API still answers state questions. The layer watches `device.lost`: once the GPU device is lost for any reason but its own destruction, every Direct3D 8 and 9 device made on it is lost, and one made afterwards starts lost (see *Limitations*). |
| `presenter` | a presenter made by the run, or absent | made from `device` | The canvas, its configured format, the pacer and the texture the primary is copied into. It is a service of the run rather than of a machine, so the assembling caller makes one and hands the same object to every machine the run is rebuilt on; the layer attaches its own backend and address space to it, presents and claims through what the attachment answers, and at `dispose()` detaches rather than disposing it. The last frame one process presented stays on the canvas until the next presents. |
| `device.adapter` | `{ vendor?, architecture?, description? }` | absent | What `GetAdapterIdentifier` and `vkGetPhysicalDeviceProperties` describe. |
| `compressedTextures` | boolean | `false` | Whether a kept S3TC texture travels to the device as BC blocks instead of decoded `rgba8unorm`, once the format is legal to create at all -- `CheckDeviceFormat` and `glCompressedTexImage2D` answer a DXT format creatable either way, whatever this flag says. Applies to OpenGL and Direct3D 8/9 alike; DirectDraw has no DXT/FOURCC surface path for it to apply to, and Vulkan's flag instead gates whether `textureCompressionBC` is *advertised* as a supported feature -- a legality signal, not an upload choice, pre-existing before this flag and exercised by no title. The device's own `texture-compression-bc` feature still gates it either way: `true` here without the feature is `false`. Off by default: measured to stall the GPU process on the one machine this project has run it on; a build turns it on once it is checked clean on its own hardware. Set through `createApp`'s `graphics` option, which is forwarded to this layer as given. |
| `raster` | boolean | `true` | `false` leaves every primitive OpenGL draws on the processor (the build without a device) unrasterised: each call still does its state work and each draw still reads its scene, a clear still clears, but no primitive reaches the framebuffer -- so a long run in Node measures the program and the layers rather than the software rasteriser. A diagnostic; with a device nothing is rasterised on the processor either way, so it changes nothing there. `tools/launch-probe.mjs --no-raster` sets it. |
| `screen` | `{ width, height, bitsPerPixel }` | `{ 640, 480, 32 }` | The display a program is told about until `resolution` changes it. |
| `maxFps` | number | `60` | Frame-delivery cap for the pacer; `0` means whatever the scheduler offers. |
| `maxFrameLatency` | number | `3` | How many presented frames the device may still be working on when a presenting call answers -- Direct3D's default maximum frame latency. A `Present`, `SwapBuffers`, `Flip` or DXGI `Present` that queues a frame past it waits, parked through the bridge, for the oldest to finish (see *Frames in flight*). `0` holds nothing and still counts. The run presenter keeps it, one count for every machine, so `createApp` reads it from its own `graphics` option; a presenter this layer makes for itself reads it from here. |
| `guestNow` | `() => ms` | the host's `performance.now` | The clock the display's raster runs on -- DirectDraw's vertical-blank status and scan line, Direct3D's raster status. The assembling caller hands the kernel's virtual time, because a program that spins on the blank times the spin with its own timers; the presenter's pacing, a property of the canvas, keeps its own. |
| `schedule`, `now` | `(tick) => void`, `() => number` | absent | A display-rate scheduler and a clock. Both present enables the pacer; a headless build delivers on a microtask. |
| `allocate` | `(bytes) => address` | absent | Guest memory for locked surfaces and buffers, and for the shadow state block. Without it a lock hands back an address this layer invented and every state setter stays a trap. |
| `free` | `(address) => void` | absent | Returns guest memory a texture or map is finished with, so a program that sizes its cache from free heap sees textures released. |
| `divergence` | `(api, detail) => void` | absent | Where "this call succeeded and did not do all of what it promises" is reported. See *Limitations*. |
| `cursor` | `(notice: CursorNotice) => void` | absent | Receives a Direct3D program's cursor bitmap (`width`, `height`, `hotSpot`, `bgra`, `shown`) -- once per change, not per `SetCursorProperties`/`ShowCursor` call, since a program sets the same cursor every frame. Without it `SetCursorProperties` is refused with `D3DERR_INVALIDCALL`, which tells the program to draw its own. |
| `resolution` | `(width, height, where?: { window?, fullscreen? }) => void` | absent | Told the back-buffer size a device is created or reset at, and which window it presents into; the reported screen follows it. `where.window` is the device's `HWND` and `where.fullscreen` says whether it is exclusive; a fullscreen device's window is placed at the mode's size, so a program clipping its cursor to that window reaches the picture's corners, and a reset back to windowed reports the window at its own size again. |
| `publishInterface` | `(object, iid) => address` | `() => 0` | The bridge's vtable publisher. The default publishes nothing, so a build without a bridge gets tables that refuse rather than pointers into nowhere. |
| `unpublishInterface` | `(object, iid) => boolean` | none | The bridge's way to give back an interface with no `Release` (a table without `IUnknown`) when what handed it out ends. Without it such a table's words stay in the guest for the run; the way back from its pointer still goes. |
| `exportAddress` | `(name) => address` | absent | The guest address of one of `OPENGL32.dll`'s own exports, which `wglGetProcAddress` needs to answer honestly for core names. |

The six `device.*` diagnostic knobs reach the shared Direct3D renderer
(`src/layers/graphics/d3d8/render.js`) through the Direct3D 8 and 9 devices -- a Direct3D 7 device
builds its renderer without them; the first four also reach the OpenGL device renderer
(`src/layers/graphics/opengl/gpu.js`), which reads them the same way:

| knob | default | effect |
|---|---|---|
| `dumpDraws` | `false` | Records where every draw of the last frame landed and under what state -- on the Direct3D 8 renderer transforming every vertex a second time on the processor, on the OpenGL one printing the draw's state, its sampled textures, its programs' texts and its uniform blocks. `diagnostics().seam.device.lastDump` holds the result. |
| `maxDraws` | `-1` (all) | Keeps only this many draws per frame and drops the rest, so a region's painter can be found by bisection. |
| `skipTexture` | `null` | Comma-separated dump ids; every draw sampling one of those textures is dropped and counted under `skipped.texture`. |
| `probeTexture` | `null` | Copies the colour target out around each dumped draw that samples this texture -- after it on the Direct3D 8 renderer, before and after on the OpenGL one, which reads the first four such draws of a frame and no more -- and puts a few of its pixels on the draw's dump line. |
| `fog` | `true` | `false` runs every draw as if `D3DRS_FOGENABLE` were clear. Direct3D 8 and 9 only. |
| `mips` | `true` | `false` samples every texture at its top level. Direct3D 8 and 9 only. |

### Provided API

`create()` returns:

| member | what it is |
|---|---|
| `backend()` | The WebGPU backend, built on first call; throws when no `device` was configured. |
| `available()` | Whether this build has a GPU. |
| `adapter()` | `config.device.adapter` or null. |
| `present(surface, window?, exclusive?)` | Shows a surface that lives in guest memory through the presenter, for anything outside the drawing libraries (a film, an overlay), the way a DirectDraw primary is shown: as the picture of `window` (0, or a handle that names no window, for the program's topmost; a child stands for its top-level window), copied into the desktop over that window's client area -- the whole screen when `exclusive` -- less every shown top-level window above it, and the desktop shown. A surface the GPU owns, one of another size than the screen, one with no window to own it, or one whose region is the whole screen is shown as it is, with nothing over it seen. |
| `screen()` | The current `{ width, height, bitsPerPixel }`. |
| `create(name, options?)` | Makes one API object by name: `ddraw`, `d3d8`, `d3d9`, `opengl`, `d3d10`, `vulkan`. Direct3D 7 has no factory of its own; it is reached from a DirectDraw object. |
| `apis()` | The six names above. |
| `libraries()` | `{ 'OPENGL32.dll', 'D3D8.dll', 'D3D9.dll', 'D3D10.dll', 'DXGI.dll', 'vulkan-1.dll', 'DDRAW.dll' }`, each a `{ Name: { argBytes, handler } }` table shaped like a `win32` library's, for the loader. |
| `opengl()` | The pixel-format negotiation (`size`, `count`, `choose`, `describe`) and `swapBuffers(hdc)` whose entry points `gdi32` exports -- a swap answers a promise when it waits for the device (see *Frames in flight*); the assembling caller hands these down to `win32`; and `entry(name)`, one named `OPENGL32.dll` handler with its raw-dword convention, for a caller already on this side of the boundary -- every one but the two WGL swaps, which may wait. |
| `gdiDrawing()` | GDI's own drawing for the device contexts `win32` keeps (`create`, `fontMetrics`, `textWidth`, `surfaceFor`, `desktop`, `presentDesktop`), and the display's gamma ramp for `gdi32`'s `SetDeviceGammaRamp`, `GetDeviceGammaRamp` and `GetDeviceCaps(COLORMGMTCAPS)`, which `app.js` hands down as `setGammaRamp`, `gammaRamp` and `appliesGamma`: `setDisplayGamma(ramp)` sets it (`{ red, green, blue }`, 256 sixteen-bit entries each; `null` takes it back), `displayGamma()` answers the ramp the display shows through, whoever set it, or `null` when none was (the identity), and `appliesGamma()` whether a ramp reaches the picture at all. A ramp a full-screen Direct3D 8 or 9 device or a DirectDraw primary sets afterwards is shown instead until that one is taken back; the display's own outlives the process, and a machine's devices take theirs with them when it is disposed. |

An instance owns its GPU work. `create()` may run more than once in the same realm (a process
replacement runs it again; the plan for two machines in one worker needs two at once), so the
backend, the factories, the published interfaces and the api's own record of what was created live
in the instance the api closes over, and a second `create()` cannot hand the first one's backend to
an api that was never given a device; `diagnostics()` answers for its own graph's
instance. The presenter is in that state too, but its lifetime is unchanged: a presenter handed in
is the run's, attached and never disposed here, and only one this layer made itself goes with the
machine (see *The backend*). After `dispose()`, a call that was in flight is answered the way a
build with `graphics: null` answers it — the stub's `NOT_IMPLEMENTED: graphics.<method>` — because
there is no value that stands in for a drawing API, and a program that reaches the layer after it
is gone should fail where it can see it rather than dereference what disposal took away.

### Published libraries

Counted by instantiating `createGraphicsLibraries` (`src/layers/graphics/seam/exports.js`) and
reading each table:

| library | entry points | what they are |
|---|---|---|
| `OPENGL32.dll` | 507 | The whole of OpenGL 1.1, all of WGL, and every extension function this implementation answers. Every name is bound, implemented or not, because a stdcall stub that pops the wrong number of bytes loses the process far from the call. Unimplemented names answer zero and are counted. |
| `vulkan-1.dll` | 149 | Every command with its 32-bit argument size (`src/layers/graphics/vulkan/commands.js`). 65 are implemented (20 instance-level, 45 device-level); the rest answer `VK_ERROR_FEATURE_NOT_PRESENT` and are counted by name. |
| `DDRAW.dll` | 7 | `DirectDrawCreate`, `DirectDrawCreateEx` and `DirectDrawCreateClipper`; `DirectDrawEnumerateA` and `DirectDrawEnumerateExA`, which call the program's callback once, for the primary display driver (a null GUID, `"Primary Display Driver"`, `"display"`, and a null monitor in the Ex form); and `DirectDrawEnumerateW` and `DirectDrawEnumerateExW`, which the runtime never implemented and which answer `DDERR_UNSUPPORTED` having called nothing. A null callback is `DDERR_INVALIDPARAMS` in every form but `DirectDrawEnumerateExW`. |
| `D3D10.dll` | 27 | `D3D10CreateDevice` and `D3D10CreateDeviceAndSwapChain`; blobs and reflection (`D3D10CreateBlob`, the three signature-blob functions, `D3D10GetShaderDebugInfo`, `D3D10ReflectShader`); the three profile names; the state block (`D3D10CreateStateBlock` and the eight `D3D10StateBlockMask*` functions); the effect framework's `D3D10CreateEffectFromMemory`; and six that refuse by name, each reporting why: the two compilers answer `E_FAIL` with the reason in the error blob, the two disassemblers, `D3D10PreprocessShader` and `D3D10CreateEffectPoolFromMemory` `E_NOTIMPL`. |
| `D3D10_1.dll` | 27 | `D3D10CreateDevice1` and `D3D10CreateDeviceAndSwapChain1`, which make an `ID3D10Device1` at feature level 10.0 and answer `DXGI_ERROR_UNSUPPORTED` for 10.1 and the 9.x levels, and the other 25 of `D3D10.dll`. |
| `DXGI.dll` | 2 | `CreateDXGIFactory`, and `CreateDXGIFactory1`, whose factory and adapters answer as DXGI 1.1's. |
| `D3D8.dll` | 1 | `Direct3DCreate8`. |
| `D3D9.dll` | 2 | `Direct3DCreate9`, and `Direct3DCreate9Ex`, whose root answers as both `IDirect3D9Ex` and `IDirect3D9`. |

The COM entry points are thin on purpose: each makes one object and publishes one interface, and
everything a program does afterwards goes through the vtable. The vtable slot lists are in
`src/layers/graphics/seam/vtables.js` (DirectDraw, Direct3D 7 and 8, and `IDirect3D9`: 27 lists,
582 slots), `src/layers/graphics/seam/vtables-ddraw.js` (the Direct3D of DirectX 3, 5 and 6 and
`IDirectDrawGammaControl`: 18 lists, 192 slots), `src/layers/graphics/d3d9/interfaces.js` (18
lists, three of them 9Ex's), `src/layers/graphics/seam/d3d10.js` (29 lists for DXGI and Direct3D
10, three of them the shader reflection's tables without `IUnknown`) and
`src/layers/graphics/seam/d3d10-effect.js` (18 lists: `ID3D10Effect`'s, and the technique's,
pass's, type's and variable's tables without `IUnknown` with those of the thirteen interfaces that
extend the variable's).

### `diagnostics()`

| metric | meaning |
|---|---|
| `apis` | The factory names on offer. |
| `libraries` | The library names published. |
| `created` | Which APIs a program actually asked for, in order. |
| `seam.created`, `seam.interfaces` | Objects made through the entry points; interfaces published. |
| `seam.device` | The most recent Direct3D 8 device's counters, or the Direct3D 9 one's: `frames`, `draws`, `clears`, `programmable`, `mipsGenerated`, `prepared` (`built`, `reused`), `programs`, `skipped.*`, `cascade.*`, `failures`, `lighting.*`, `recording`, `recentFrames`, `lastFrame`, `lastDump`, `textureRecords`, `textures`, `redundantTransforms`. Each `recentFrames` entry (the last 240 presents) carries `draws`, `offscreenDraws` and `offscreenTargets` (draws into a target other than the back buffer, and how many such targets), `clears` and `clearColor` (the last whole clear of the back buffer as `#aarrggbb`, empty when there was none), `viewport` (`x,y wxh` at the present) and `target` (the back buffer's size), plus `placeholder`, `truncated`, `uploads`, `textures`, fog and light summaries -- so a frame that only cleared, or drew only offscreen, or drew into a viewport that is not the picture, is read off the record rather than guessed from a screenshot. When neither made a device and the OpenGL runtime drew, its renderer's counters instead: `frames`, `pipelines`, `draws`, `clears`, `fallbacks`, `uploads`, `renames`, `refused`, `skipped`, `cut`, `resident`, `samplers`, `unflushed`, `failures`, `lastDump`. |
| `seam.vulkan` | `placed` traps, `objects` by kind, `unimplemented` by command name. |
| `shadow` | The Direct3D 8 guest-side state block: `placed`, `slowPath`, `renderStateCalls`, `transformCalls`, `bindingCalls`, `lockCalls`, `unlockCalls`, `textureCalls`, `stageStateCalls`, `materialCalls`, `buffers`, `synced`, `skipped`, `compared` (words of the block compared with the host's copy, over every entry), `refused`. |
| `backend` | Profiler snapshot (`frames`, `counters`, `uploadsByLabel`, `recentFrames` with phases), `shaders` (`builds`, `errors`, `warnings`, `dropped`, `distinct`), `shaderMessages`, `pipelines` (`built`, `reused`, `resident`), `uniforms`, `buffers` per dynamic buffer (`renames`, `pooled`, `dirty`), `frameOpen`, `pendingTextureCopies`, `surfaceWrites`, `presents`. |
| `presenter` | `presents`, `uploads`, `bytes`, `shownByOwner`, `shown` (frames copied to the canvas), `shownBy` (those copies by the label of what was shown -- a Direct3D device's `target`, OpenGL's `gl-shown[0]`/`gl-shown[1]`, the `desktop`'s bytes, a primary's `guest bytes` -- so a picture one device draws and another path paints over shows as two labels rising together), `gammaShown` (those copies drawn through a gamma ramp rather than copied), `gamma` (whether a ramp other than the identity is in effect), `dropped` (surfaces a machine presented and went before they were shown, never read), `lastBuffer`, `pending`, `claimed` (addresses a GPU owns, across the machines attached), `attached` (machines attached now), `failures`, `latency` (the frames in flight: `limit`, `counting` -- false with no device, or one that cannot say when work is done, or once it is lost -- `inFlight`, `peak`, the most counted at once with the frame just queued among them, `frames`, `held` presenting calls that waited, `heldMs` spent waiting, `waiting` now), `disposed`. The same label is on every record of `presented().history`. The counters are cumulative across a process replacement, because the presenter is. |
| `backend` | The WebGPU backend's counters, among them `surfacesCreated` and `surfacesDestroyed`: a device reset gives its previous back buffer and depth back to the GPU at once, since the collector does not watch GPU memory. |
| `pacing` | `requests`, `delivered`, `coalesced`, `idleTicks`, `heldTicks`, `waiting`, and interval statistics (`count`, `minMs`, `maxMs`, `meanMs`, `deviationMs`, `p50Ms`, `p95Ms`, `p99Ms`, `fps`, `periods`). Null in a build with no scheduler. The pacer belongs to the presenter, so the rhythm is read from it. |

The OpenGL runtime keeps its own `{ contexts, unimplemented }` (`src/layers/graphics/opengl/exports.js`)
but the seam's `diagnostics()` does not include it; it is reachable only through the runtime
object. Direct3D 10 renderer counters are likewise not surfaced by the seam.

## How it works

### The backend

`src/layers/graphics/webgpu/backend.js` is what every API draws on. The device and queue arrive
injected; nothing reads a global, so the whole backend runs in a test against the recording double
in `src/layers/graphics/webgpu/internal/fake-device.js`. The contract is stated once in
`src/layers/graphics/webgpu/contract.js` and the facades above do not relitigate it:

- **One encoder, one submit per frame.** `beginFrame()` returns the only object that owns a
  command encoder; `frame.end()` is the only path to `queue.submit`, and it can run once. A change
  of render target opens a new pass on the same encoder. `frame.present(surface)` names what the
  frame shows; at `end()` that object goes to `presentTo`, and `lastPresented()` hands back exactly
  it, so a diagnostic read-back cannot bypass the composition a viewer sees.
- **Pipelines** (`internal/pipeline.js`). WebGPU wants every piece of state baked into an immutable
  pipeline, so each draw asks `pipelineFor(state)` for the one its state describes. The cache key
  folds every field the descriptor reads -- blend, depth, cull, target and depth formats, the FVF,
  and each texture stage individually, with "no stages" distinct from "one default stage"; the parts
  only some draws have -- flat shading, renormalised normals, the fog source, range fog, a stage's
  colour key, the further streams' strides -- are optional and appear only when set. With the depth
  test off a draw writes no depth, whatever the write enable says, as Direct3D and OpenGL both tie
  the write to the test and WebGPU's `always` compare would not; each API's state is translated that
  way, a partial clear's own quad excepted. Building is asynchronous because shader compilation is;
  two draws with the same state in one frame share the promise.
- **Bindings and uniforms** (`internal/bindings.js`). Bind-group layouts are explicit and shared
  per stage count; `createRenderPipeline` refuses `layout: 'auto'` by name, because an automatic
  layout drops a binding the generated shader did not use and every textured draw then silently
  disappears. Uniform blocks come out of one ring buffer bound at a dynamic offset, so a bind group
  names a texture, a sampler and the ring and nothing that changes per draw; the group cache is
  keyed on those identities and lives as long as the backend. The blocks are laid into a copy of the
  ring on this side and reach the GPU in one `writeBuffer` per frame, just before its submit (and
  once more before a wrap or a new ring), not in one per block: a shader draw hands out six blocks,
  and each write is a trip to the GPU process. A frame whose blocks would outgrow the ring is handed
  one twice the size rather than wrapping onto its own first blocks, since every write of a frame
  lands before its submit and those first draws would read the last ones' uniforms -- a frame of
  fixed-function OpenGL draws, a kilobyte of uniforms each, reached that at about four thousand.
- **Dynamic buffers** (`internal/buffers.js`). A lock's flags are a promise: `DISCARD` renames the
  backing and only bytes written since travel; `NOOVERWRITE` renames nothing and sends the newly
  written ranges, and the Direct3D renderer reads `DISCARD` and `NOOVERWRITE` together as
  `NOOVERWRITE`, contents kept; neither flag leaves the decision to whether a draw of a frame not
  yet submitted has read the live backing (`markRead`) -- if none has, the write goes into the
  backing in place and only the locked range travels, the ordinary case of a program that fills a
  buffer and then draws from it; if one has, overwriting those bytes is a hazard, so the backing is
  renamed and the whole buffer is resent, because the old contents stay observable through the new
  one. `LockFlags.RENAME` is the same rename forced by a caller that tracks the hazard itself rather
  than through `markRead`. Uploaded ranges align outward to four bytes and are sent from their own
  offset. A retired backing returns to the pool only after the frames that read it have been
  presented (`markPresent`).
- **Textures** (`internal/textures.js`). Block-compressed formats (`bc1`, `bc2`, `bc3`) always go
  through a staging buffer plus a buffer-to-texture copy with rows repacked to the copy alignment;
  a direct `writeTexture` is used for uncompressed formats and either path can be forced. Row
  geometry is counted in blocks, never pixels; the copy's extent is rounded up to the block too,
  because WebGPU's texture-copy validation compares it against the subresource's physical size, not
  a tail mip's own (possibly sub-block) width and height. A copy issued between frames waits for
  the next encoder rather than opening a second one. Each staging buffer is destroyed once the
  frame whose encoder recorded its copy has been submitted (`backend.js`'s `end()`), never reused
  and never left to leak: it is tracked on that frame, not the caller.
- **Viewport** (`internal/viewport.js`). Setting a viewport does two things that travel as one
  value: the hardware rectangle and scissor, and the vertex stage's inverse offset and scale, which
  is what puts a pre-transformed vertex on the pixel it names. The viewport goes to WebGPU as set,
  keeping its mapping, even where it reaches past the target (Direct3D 9 and 10 set such
  viewports); the scissor, from it or from `setScissor`, is clamped to the attachment, since one
  past it invalidates the pass.
- **Shaders** (`internal/shaders.js`). Every built module is asked for its compilation info; an
  error-severity message fails the build, and messages are kept in a de-duplicating ring.
- **Fixed function** (`internal/fixedfunction.js`) generates WGSL per state combination: the vertex
  path transforms or, for XYZRHW, applies the viewport constants and gives the RHW back as the clip
  w (an RHW of zero or less taken as one), so a quad a program projected itself is interpolated in
  perspective; every position then moves by half a pixel -- half the viewport's scale in clip space,
  times w -- because Direct3D 9 and before put a pixel's centre on its integer coordinate and WebGPU
  half a pixel further on; and the position is `@invariant`, so two passes over one mesh through
  different modules land on the same depth. A `D3DCOLOR` vertex colour is swizzled from the B,G,R,A
  byte order; the texture-stage cascade emits one block per enabled stage (`SELECTARG1/2`,
  `MODULATE`, `MODULATE2X/4X`, `ADD`, `ADDSIGNED`, `ADDSIGNED2X`, `SUBTRACT`, `ADDSMOOTH`, the
  `BLEND*ALPHA` five, with `COMPLEMENT` and `ALPHAREPLICATE` modifiers, arguments from `DIFFUSE`,
  `CURRENT`, `TEXTURE`, `TFACTOR`, `SPECULAR`), each stage's result saturated before the next reads
  it, and nothing at all for an empty list; a texture transform of two to four coordinates is
  applied per stage, for every one of the eight (the block carries a matrix per stage); a stage set
  to `D3DTSS_TCI_CAMERASPACEPOSITION`, `_CAMERASPACENORMAL` or `_CAMERASPACEREFLECTIONVECTOR` takes
  its coordinate from the vertex through world and view -- the normal by the inverse transpose of
  the two (`cameraNormalMatrix` in the block, computed only when a stage generates from the
  normal) -- through the stage's whole transform, in the vertex stage, whatever set the vertex
  carries, and under `D3DTTFF_PROJECTED` is divided per pixel by the count's last component (a
  pixel shader over fixed-function vertices is handed the same four components undivided);
  per-vertex lighting is unrolled per enabled light (point, spot, directional, with range,
  attenuation and cone in uniforms), the normal carried into world space by the inverse transpose
  of the world matrix (`normalMatrix` in the block, so a non-affine world leaves a surface unlit as
  Direct3D does) and renormalised -- there and for a generated coordinate
  -- only under `D3DRS_NORMALIZENORMALS`, the material sources honour `D3DRS_COLORVERTEX`, the
  specular sum is added after the cascade, and alpha comes from the diffuse source alone. Fog
  (`LINEAR`, `EXP`, `EXP2`) takes its factor where Direct3D does: table fog per pixel, the curve
  over its z under an affine projection and its w otherwise (the choice a uniform, so a projection
  change compiles nothing); vertex fog over the magnitude of the camera-space z, or with
  `D3DRS_RANGEFOGENABLE` the distance from the eye; `D3DRS_FOGENABLE` with both modes `NONE`, and
  vertex fog on a pre-transformed vertex, is the interpolated specular alpha. `D3DRS_SHADEMODE`
  `FLAT` makes both colours flat from Direct3D's provoking vertex, the specular alpha still
  interpolated; `D3DRS_FILLMODE` `WIREFRAME` and `POINT` draw a triangle as its three edges or its
  three vertices, rewritten as a line or point list; and Direct3D 7's
  `D3DRENDERSTATE_COLORKEYENABLE` has a stage sampling a keyed texture compare its nearest top-level
  texel's colour with the key and the fragment discarded after the cascade. The alpha test
  `discard`s. Sphere-map coordinate generation, a one-coordinate transform and a projected transform
  over a carried set are not computed (see *Limitations*).
- **Programmable** (`internal/programmable.js`) builds a pipeline from a translated vertex and
  pixel shader pair, a vertex layout taken from a declaration (`D3DDECLTYPE` to WebGPU format; the
  packed ten-bit types have no counterpart and refuse the declaration) with each member read from
  its own stream -- a vertex buffer per stream, at the stride that stream is bound with rather than
  the declaration's -- and the fixed bind groups the translation promises.
- **Presenter and pacer** (`internal/presenter.js`, `internal/pacer.js`). A DirectDraw or GDI
  program draws into guest memory; the presenter keeps one `bgra8unorm` texture the size of the
  primary, converts 8-, 16- and 32-bit surfaces into it, coalesces a burst of blits onto one
  upload and presents inside a backend frame. A surface a GPU drew has no bytes worth reading, so a
  Direct3D 7 device claims its target's address and the presenter shows the texture instead. The
  pacer remembers the newest request, arms one scheduler tick, delivers at most once per
  `1000 / maxFps` ms, and never makes the caller wait. **The presenter is a service of the run,
  not of a machine.** The canvas, the format it was configured in, the pacer, the `bgra8unorm`
  texture and the upload staging are made once, above the machines, and every machine attaches its
  own backend and address space to them; what a machine owns -- its pipelines, its buffers and
  every texture its program created -- is the backend's and dies with it. A process replacement
  therefore draws into the same canvas and the same texture, and the frame the parent last
  presented stays until the child presents its first: no reconfigure, which would clear the
  canvas, and no black frame at the swap. Each attachment stays apart: a surface is read through
  the machine that presented it and an address is claimed for that machine's GPU alone, and a
  machine that goes -- a child started beside its parent, a process replaced -- detaches, so what
  the one left presents is read from its own address space and shown through its own backend, and
  a surface the gone machine presented but that was not shown yet is dropped rather than read.
  The presenter's third job is the canvas copy the backend
  calls `presentTo`: every frame, whatever API produced it, is copied into the canvas in the
  frame's own format, configured once. **Gamma** is applied there, the one place every frame
  passes: `setGammaRamp(owner, ramp)` takes a ramp (256 sixteen-bit entries a channel) by owner --
  the display's own through `gdiDrawing()`, a DirectDraw primary, a full-screen Direct3D 8 or 9
  device -- and the latest set is in effect; `null` takes an owner's back, and the one set before
  it is in effect again. While a ramp other than the identity is in effect, a frame is drawn onto
  the canvas by a one-triangle pass that loads each texel and looks its channels up in a 256-row
  uniform table, written when the ramp changes, instead of copied. An entry counts by its high
  byte, so both identities programs write (index times 257, index shifted up by eight) keep the
  plain copy. A frame texture the pass cannot read is copied as it is, and a presenter with no
  canvas says it applies no ramp (`appliesGamma()`), which is what the gamma capabilities follow.
- **Frames in flight** (`internal/latency.js`). Nothing a present does waits for the GPU: the
  frame is recorded, replayed onto the queue once its pipelines exist, and the call answers. A
  device slower than the program would fall further behind for as long as it runs, so, as a
  Windows driver holds a presenting call once a few frames are queued, every call that ends a
  frame tells the run presenter it queued one -- Direct3D 8 and 9's `Present` on the device, on
  an additional chain (a picture kept rather than shown included) and 9Ex's `PresentEx`, DXGI's
  `Present`, `wglSwapBuffers`, `wglSwapLayerBuffers` and gdi32's `SwapBuffers`, and a DirectDraw
  `Flip`, whose frame is the burst the presenter flushes, a Direct3D 7 target's replay among
  them. A frame counts from the call until the device has finished the work submitted with it:
  `queue.onSubmittedWorkDone()` asked once the frame's replay is on the queue, never before, since
  it answers for the work submitted ahead of the asking. A call that queues a frame past
  `maxFrameLatency` answers with a promise, its thread parks on it through the bridge as any
  waiting host call does and the scheduler runs the others; the oldest frame finishing lets it
  go, and it answers what it would have. Calls waiting at once, from two threads or two chains,
  go oldest first as the frames ahead of each finish. The frame is recorded and queued before the
  call waits, so what reaches the device and in what order is the same with any bound. One count
  for the run, since every machine draws on one queue. A queue without `onSubmittedWorkDone` --
  no device, the recording double -- counts nothing and holds nothing, and a lost device lets
  every waiting call go and holds nothing after. `entry(name)` does not hand out the two WGL swaps,
  since a caller on this side has no thread to park.
- **Profiler** (`internal/profiler.js`) keeps per-frame phase timings (`uploads`, `passes`,
  `submit`, `present`), counters, and a per-label upload breakdown rather than a top-N.
- **Reference rasteriser** (`internal/reference.js`). The fixed-function formula written a second
  time on the processor in integer arithmetic (lighting stays in floats, as Direct3D computes it),
  so byte-exact tests have something reproducible to compare against. It proves the formula and
  the bytes put on the queue, not what a driver does with them.

### The seam

`src/layers/graphics/seam/` is translation and nothing else: a slot reads the words the guest
pushed, turns pointers into structures (`structs.js`, every offset spelled out) and interface
pointers into objects, calls the method the API object already has, and writes back whatever the
caller left room for -- taking a reference when an interface is handed back, writing a number only
when the caller passed somewhere to put it.

`com.js` adapts an API object for the bridge's vtable publisher: it supplies `interfaceFor`,
`addRef` and `release` from the object's own lifetime model and memoises one adapter per object,
so one surface is one identity. Its `destroyed` says whether the latest release ended the object --
a count of zero on an object that does not report `destroyed: false`, as a DirectDraw object does
while another generation is held -- and the bridge then forgets every interface pointer of it, not
only the one released through. Every slot of every interface is declared in `vtables.js`; a slot
nothing implements answers `E_NOTIMPL` from the index the program compiled against rather than
shifting the ones after it, and `argBytes` counts the interface pointer and every argument because
the callee pops the stack.

What a slot reads and writes costs no more than the bytes it moves. A vector argument -- a matrix,
a clip plane, shader constants -- is decoded by `structs.js`'s `floatsOf` / `intsOf` / `dwordsOf`
through one staging buffer into an array of its own for the caller to keep, rather than by a byte
view over a fresh array's buffer, which moves a small array's elements off V8's heap and costs
several times the copy; a dword out-parameter goes through the memory layer's `writeU32` where the
services offer it (`createFields`), not through a four-byte array made to carry it. An answer of
more than a dword -- a matrix, a material, a light, a viewport, a clip plane or status, shader
constants, a caps block or a description -- is put together in the fields' own buffer and written
as one block (`writeFloats`, `writeDwords`, `writeStruct`, and `putMaterial` / `putLight` for the
two structures every version shares): a write into guest memory costs the same checks and
bookkeeping whether it carries four bytes or sixty-four. `writeStruct` writes one block per run of
the fields it is given that follow one another, leaving a field it is not given as it was. The
Direct3D 8 and 9 devices copy a transform they are set with `new Float32Array(matrix)` rather than
`Float32Array.from`, which walks an iterator; what the seam and the shadow hand them is a
Float32Array already.

`shadow.js` is Direct3D 8's fast path. `SetRenderState`, `SetTransform`, `SetStreamSource`,
`SetIndices`, `SetVertexShader`, `SetTexture`, `SetTextureStageState`, `SetMaterial`, `Lock` and
`Unlock` are placed as x86 code that writes a block of guest memory the device owns and returns
without trapping. Each routine counts its call twice, in its group's counter and in one count of
every call, and an entry into the host reads that one word first: an entry after no setter costs a
dword read. After some, it takes one view of the block. The three small groups whose counter moved
-- the bindings, the eight textures, the material -- are compared whole; the three large ones -- 256
render states, 28 matrices, eight stages of 32 stage states -- are compared only where the routines
marked them: a routine sets a bit for the word or matrix it wrote (`bts` into a string of bits, after
the write and before the count), the entry takes every marked word in the order a scan of the group
took them and clears all the marks with one write. Each difference goes through the real setter,
where validation lives, in the order the whole-block comparison used: render states, transforms,
bindings, textures, stage states, material. A routine another thread interrupts between its write
and its count is adopted by an entry that finds its mark, or by the next one after its count. The
block is one-way and untrusted: a mark says only where to look, and a word written by other means
than the routines is not looked at until one of them marks it. A value the device would refuse is
refused at the next entry and reported once as a divergence. A value the block holds that the host
sets through the trap -- a vertex shader handle, which the routine leaves to it, the unbinding a
deleted bound shader makes, a transform `MultiplyTransform` changed -- is written back into the
block and the copy, so that the guest's next write of the value before is seen as the change it
is. A stage past the last is refused in the guest with `D3DERR_INVALIDCALL`; a stage state type
this version has not got, and a null material, are left to the trap. A texture is bound by the pointer the guest wrote and resolved to its object when the
host next looks; when the program releases its last reference the pending binding is adopted first
and every slot still naming the pointer is marked stale, so the device keeps the texture bound and
the pointer's next use -- possibly for a new object -- is seen as a change. The block counts the
calls it absorbed, per group.

Per API:

- **`ddraw.js`** publishes four generations of `IDirectDraw` and five of `IDirectDrawSurface`, plus
  the clipper and palette, with the interface version threaded through every method: a
  `CreateSurface` through the second generation takes no reference on the object, a `Lock` through
  the fourth reads the longer descriptor. Reference counts are per generation, as the API does it.
  The three enumerations call into guest code through the bridge and answer with a promise; without
  `callGuest` they succeed having named nothing. `GetDC` is answered by
  `win32.gdi().createSurfaceDc` over the surface's own bytes, and an indexed surface's DC is given
  its palette's live table, so a palette changed while the DC is held is the one it draws in; a
  surface with no palette of its own draws in the primary's. Display modes: 640x480, 800x600,
  1024x768, 1280x1024 at 8, 16 and 32 bits, plus the configured screen size if it is not in the
  list. `GetVerticalBlankStatus` and `GetScanLine` read a beam that goes round once a refresh at the
  60 Hz the display reports, the last 45/525 of each frame -- VGA's 640x480 share, kept for every
  height -- being the blank (`seam/raster.js`), and `WaitForVerticalBlank` parks its caller until
  the blank begins or ends; Direct3D 8 and 9's `GetRasterStatus` read the same raster and both claim
  `D3DCAPS_READ_SCANLINE`. Surfaces here and Direct3D 8 and 9 resources keep private data
  (`seam/privatedata.js`): an interface entry holds a reference until it is replaced, freed or its
  object goes, Direct3D's read of one takes a reference and DirectDraw's does not, and a
  `DDSPD_VOLATILE` entry expires with the surface's contents. `TestCooperativeLevel`
  (`IDirectDraw4` and `7`) follows `win32.applicationDeactivated()`: an object in exclusive mode
  answers `DDERR_NOEXCLUSIVEMODE` from the application's `WM_ACTIVATEAPP(0)` until its
  `WM_ACTIVATEAPP(1)`, as ddraw's `test_lost_device` has it, and `DD_OK` otherwise; an object in
  normal mode answers `DD_OK` wherever the foreground is, and `DDERR_EXCLUSIVEMODEALREADYSET`
  while another object of the process holds exclusive mode, as the method is documented to.
  Every deactivation while an object holds exclusive mode -- counted by
  `win32.applicationDeactivations()`, so one that came and went between two calls is not missed
  -- loses its video memory: every surface but a system-memory one or a managed texture reads
  `DDERR_SURFACELOST` from `IsLost`, `Lock` (leaving the descriptor as it was), `GetDC`, `Flip`,
  `GetAttachedSurface` and a blit into or out of it, until `Restore` or `RestoreAllSurfaces`,
  which answer `DDERR_WRONGMODE` while the application is still in the background. `Restore`
  brings back the surfaces created with the one restored (a flip chain's buffers, a texture's
  levels), not one attached later; taking exclusive mode loses video memory the same way, and so
  does a change of display mode -- `SetDisplayMode` to another size or depth, or
  `RestoreDisplayMode` back from one -- at any cooperative level. A primary and its buffers are
  the screen in the mode they were made in: in another, `Restore` answers `DDERR_WRONGMODE`
  (ddraw7's `test_coop_level_mode_set` and `test_primary_palette`). `RestoreAllSurfaces` restores
  every surface that can come back and answers the first refusal.
  `GetDeviceIdentifier` describes the adapter exactly as Direct3D 8 and 9's `GetAdapterIdentifier`
  do -- one vendor table, description rule and GUID, in `seam/adapter.js` -- because a program
  asking through two of them compares the answers.
- **`d3d7.js`** publishes no root; it hands the DirectDraw seam the `IDirect3D7` descriptor to put
  beside its own, and keeps one Direct3D 7 object per DirectDraw object. A draw takes its vertex
  format as an argument and its indices by pointer.
- **`d3dlegacy.js`** publishes no root either: `IDirect3D`, `IDirect3D2` and `IDirect3D3` are
  more tables on the DirectDraw object, and `IDirect3DTexture`, `IDirect3DTexture2` and DirectX 3's
  `IDirect3DDevice` more tables on a surface. Most structures carry a size and the size is the
  version, so a device description is read and written only as far as the caller's size; a
  viewport answers its three generations with one count, as a material does; and a call whose
  arguments did not change since is the Direct3D 7 seam's own translation, handed the device
  underneath.
- **`d3d8.js`** publishes `IDirect3D8`, `IDirect3DDevice8`, additional swap chains, surfaces,
  textures, cube and volume textures and their volumes, vertex and index buffers; a vertex or pixel
  shader is a handle, as Direct3D 8 has it, not an interface. Modes are offered in
  `D3DFMT_X8R8G8B8` only. Present parameters use Direct3D 8's own layout, which differs from 9's.
  `Clear` takes the rectangle count at its word, as 9's does: a count of zero clears nothing
  whatever the pointer, and a null array the whole target.
- **`d3d9.js`** publishes the interfaces of `d3d9/interfaces.js`, including cube and volume
  textures, vertex declarations, shaders, state blocks, swap chains and queries, and -- for a root
  `Direct3DCreate9Ex` made -- the root's, device's and swap chain's 9Ex interfaces beside the plain
  ones. Nearly every create ends in a shared-handle pointer that must be null; a handful of methods
  return a count, a boolean or a float rather than an `HRESULT`.
- **`d3d10.js`** publishes the DXGI factory, adapter, output, swap chain and device interfaces and
  the Direct3D 10 and 10.1 device, resources, views, state objects, shaders, queries, state
  blocks, blobs and the shader reflection. The reflection's constant buffers, variables and types
  derive from no interface: their descriptors are marked `bare`, so `com.js` lays their tables out
  from their own first method. Nothing the program calls can Release one, so each is given back
  through the bridge's `unpublishInterface` with the reflection's last Release, as the runtime
  frees them with it; the invalid object of each kind belongs to no reflection and stays. Arrays of
  interfaces arrive as pointer and count; a map allocates a guest block of the subresource's size,
  shows it the current bytes, and the unmap reads it back.
- **`d3d10-effect.js`** publishes what `D3D10CreateEffectFromMemory` makes: `ID3D10Effect`, which
  counts references, and its techniques, passes, types and variables, which derive from no
  interface and are marked `bare` like the reflection's. A variable is published once, as the
  interface its type makes it (`ID3D10EffectScalarVariable` for a float), which extends
  `ID3D10EffectVariable`, so `AsScalar` answers the pointer `GetVariableByName` did. Every name,
  string, bytecode and input signature an effect hands out points into a copy of its image kept in
  guest memory; the effect's last Release gives back, through `unpublishInterface`, every table it
  published, and frees the copy. The invalid objects belong to no effect and stay.
- **`vulkan.js`** is a C ABI rather than COM. Every command is placed as a trap once through the
  loader's `guest` builder, so an export's address and the address `vkGetInstanceProcAddr` answers
  are the same one, minted before the program's first instruction. The runtime decides whether a
  name is visible from an instance or a device; the seam turns that into an address.
- **OpenGL** has no COM; the `OPENGL32.dll` table is generated from `ARGUMENT_WORDS` in
  `src/layers/graphics/opengl/exports.js`, and the GDI half of the negotiation (pixel formats,
  `SwapBuffers`) goes through the same memoised runtime so a program gets its format and its
  context from one list.

### The APIs

**DirectDraw** (`src/layers/graphics/ddraw/`). `objects.js` is the object model: what exists, who
owns whom, when it dies. Generations do not share a reference count; `IDirectDrawX` and `IDirect3DX`
do; a palette is owned by the surface it is set on; a flip chain is a forward link per surface with
no closing link. `caps.js` is two tables over a parsed descriptor: which surface descriptions are
accepted (a flip chain is a three-part request, checked before exclusive mode) and which surfaces
can back a 3D device. A complex mip-mapped texture is a chain: it halves until both sides are one
through `IDirectDraw7` and until the shorter is one before it, every level reports
`DDSD_MIPMAPCOUNT` from itself down, the levels below the top carry `DDSCAPS2_MIPMAPSUBLEVEL` and
refuse a palette or a colour key, and each holds the one below so the chain goes with its top.
`GetAttachedSurface` answers the attached surface that has every capability asked for, in both words
of a `DDSCAPS2`; `DeleteAttachedSurface(NULL)` detaches everything the caller attached; `GetCaps`
names the surfaces `CreateSurface` builds in `ddsOldCaps` and, in a structure large enough,
`ddsCaps`. `CreateSurface` refuses an out-pointer the program cannot write through with
`E_INVALIDARG` before making anything, from the memory layer's regions. A colour key is one colour,
set at creation or after and reported by `GetSurfaceDesc`; a
range collapses to its low value, a colour-space key is `DDERR_NOCOLORKEYHW`, and a blit compares
the colour bits alone, so an X8R8G8B8 pixel's unused byte does not defeat the key. `blit.js` reads
the whole source rectangle before writing a destination pixel, so overlapping and stretched blits
are right; stretching floors, the same rule GDI uses; a blit between depths is refused. A colour
fill on a Z-buffer is refused, and `DDBLT_DEPTHFILL` fills its depth bits, keeping any stencil
beside them, and tells whoever watches the DirectDraw object -- a Direct3D 7 device whose target has
that buffer attached clears its own GPU depth to match. `GetGDISurface` and `FlipToGDISurface`
answer `DDERR_NOTFOUND` without a primary, and `FlipToGDISurface` `DDERR_NOTFLIPPABLE` for a primary
with no flip chain.

**Direct3D 7** (`src/layers/graphics/d3d7/`). Keeps its state in the shape the shared renderer
reads. A render target is a DirectDraw surface by address, so a flip presents the texture that was
drawn without copying; a texture is a DirectDraw surface too, and its uniqueness value is how the
GPU copy is known to be stale -- each level of a mip chain goes up when its own value moves, and the
chain is sampled level by level. `D3DTSS_MAGFILTER` and `D3DTSS_MIPFILTER` are kept in Direct3D 8's
numbering and read back in this version's, which counts `D3DTFP_*` from one and puts the two cubic
filters before anisotropic. `Load` copies part of one texture into another down both mip chains with
the source's palette entries and colour key; `ProcessVertices` and `ProcessVerticesStrided`
(`process.js`) transform, blend and light vertices into a vertex buffer as a lock would write it;
`ComputeSphereVisibility` answers each sphere against the view volume and the enabled user clip
planes. Three devices are enumerated (RGB, HAL, T&L HAL) over one renderer; `caps.js` claims only
what the shader generator implements.

**Direct3D of DirectX 3, 5 and 6** (`src/layers/graphics/d3d7/legacy.js`, `execute.js`). The
older versions draw what the seventh draws, through objects the seventh folded into its device, so
each of their devices -- `IDirect3DDevice3`, `IDirect3DDevice2` and DirectX 3's `IDirect3DDevice`
-- wraps one Direct3D 7 device (RGB or HAL; the transform-and-lighting device is Direct3D 7's
alone) and translates. A viewport is an object the device keeps a list of: the current one sets
the viewport rectangle, and its clip volume -- these versions let a viewport show any part of the
unit cube -- rides on the projection, kept as the program set it and handed on multiplied by the
volume's map. A light belongs to a viewport, and a draw is lit by the current viewport's active
lights. Lighting has no render state: a draw is lit when a material handle is set, its vertices
carry normals and no transformed position, and it did not pass `D3DDP_DONOTLIGHT`. Materials and
textures are named by handles; the legacy render states that name texturing -- the texture
handle, the map blend, the filters, the address modes -- become the stage states that do the same
on stage zero. `IDirect3DDevice2` draws `D3DVERTEXTYPE` vertices and swaps texture handles, and
`IDirect3D2` describes its devices at DirectX 5's size. DirectX 3's device is part of its surface,
as Windows makes it -- asked of a render target for `IID_IDirect3DHALDevice` or
`IID_IDirect3DRGBDevice`, it answers the surface's interfaces with the surface's count -- and
draws through execute buffers: a block of guest memory holding vertices and then a stream of
`D3DINSTRUCTION`s that set render, light and transform states, load and multiply matrices by
handle, process vertices into the device's transformed-vertex array (the Direct3D 7
`ProcessVertices`, lighting and all), and draw points, lines and triangles indexed into it.

**Direct3D 8** (`src/layers/graphics/d3d8/`). `device.js` models what a program observes between
draws and decides whether a call is legal; `render.js` is what happens underneath when there is a
backend, and without one the device is still made and answers. A device holds a reference on the
`IDirect3D8` that made it, let go with the device's last; the back buffers of an additional swap
chain are the device's own resources as the implicit chain's are, their first reference one on the
device; a render target, depth-stencil or image surface and a vertex or index buffer made on their
own give their guest memory back when their last reference goes, and a device reset gives back the
surfaces it replaces. `GetTexture`, `GetIndices` and `GetStreamSource` hand back the bound resource
with a reference; one the program released to nothing while it stayed bound is answered as NULL and
reported once as a divergence, where Windows keeps it until it is unbound. Direct3D 9's device keeps
the same lifetimes. A state block (`stateblock.js`) holds the half its type names -- the vertex half's render
states, lights, material and vertex shader, the pixel half's render states, texture-stage states and
pixel shader, transforms, textures, streams and indices only in a block of everything -- and a state
set while recording goes into the block, not the device. `ValidateDevice` answers for the texture
stages as they stand, as Direct3D 7's and 9's do: the stages are walked to the first disabled one,
only the arguments an operation reads are looked at, and the first operation, argument or filter the
combiner cannot draw is named by its code. Draws are recorded, not encoded: a pipeline compiles
asynchronously and a guest call returns synchronously, so the frame is a command list replayed onto
one backend frame once every pipeline exists, and each recorded draw captures the buffer generation
it was issued against. Guest memory is the boundary -- bytes are read back at unlock under the
lock's flags and nowhere else. Every texture format is expanded to `bgra8unorm` on upload in integer
arithmetic, except `DXT1`-`DXT5`, which are uploaded as `bc1`-`bc3` blocks when the configuration
asks for it, the adapter has `texture-compression-bc`, and the surface's base level is a whole
number of blocks (WebGPU validates a compressed texture's own size against the block width and
height; a base level narrower or shorter than one block decodes instead, through the layer's shared
S3TC decoder). The luminance formats expand the same way: `L8` replicates its one byte across the
three colour channels and reads opaque, `A8L8` pairs a replicated luminance byte with its own alpha
byte, and `A4L4` widens each 4-bit nibble to 8 bits before doing the same -- so a font atlas stored
in one of them draws as glyphs, because the grey and the coverage each land in the channel the blend
and the shader read. The renderer serves Direct3D 7 and 9 too: one fixed-function pipeline with one
set of numbers.

One backend texture per Direct3D resource, whichever way the program reaches it: the surface
`GetSurfaceLevel` hands out is a view of a level of the texture's own backend texture, so a
render-target texture that is drawn into and then sampled reads what was drawn. A level's pixels
are the guest's until a draw, a clear or a copy on the GPU writes them, and the guest's again after
an unlock or a move in guest memory; before any use on the GPU the guest bytes that are newer go
up. Uploads into a texture only the guest writes go straight to the queue; an upload into a texture
the GPU also writes is a frame command, replayed in order through the staged path, as are the
copies between GPU surfaces (`StretchRect`, `CopyRects`, both from a render target or a texture
level into another). `GetRenderTargetData`, and a lock of a lockable render target or back buffer,
read the GPU back into the guest's bytes first: the frame recorded so far is submitted without a
present, the surface is copied out, and the caller is suspended on the promise. The read-back is
owed to every such lock, `D3DLOCK_READONLY` or not: the flag is the program's promise not to
write, and nothing tells the runtime whether the program reads, so the bytes are there before it
has the pointer. A lock write to a render target uploads at the unlock; a read-only lock's unlock
uploads nothing, whatever the program put in the bytes. A `StretchRect` from a plain surface still
moves guest bytes and marks the destination for upload. Two limits of the rule: a move in guest memory into a level
the GPU has drawn (`UpdateSurface`, `UpdateTexture`, a `StretchRect` or `CopyRects` from a plain
surface) replaces the whole level with the guest bytes, which the draw was never read back into,
so a partial blit onto a drawn target reverts the rest of it; and a mip-chained render-target
texture is drawn into one level at a time, with nothing generating the smaller levels from the
drawn one unless it was made with Direct3D 9's `D3DUSAGE_AUTOGENMIPMAP`, so a sample that reaches
those levels reads what the guest put there.

A draw is prepared once per state change rather than once per draw. The device raises one counter,
`drawStateVersion`, for every state change a preparation depends on -- a render state, a stage
state, a texture binding, a material, a light, the viewport, a transform other than the world one,
the vertex or pixel shader, a state block applied, a reset -- and raises it for a change of value,
not for a call that sets the value already there. While that counter and the draw's stride and
topology are what the last preparation was built from, the next draw reuses its vertex layout, its
stage cascade, its texture and sampler bindings, its pipeline state and the pipeline itself, and the
block of uniforms all but the fields the world transform reaches -- the world, world-view and
world-view-projection matrices, and a lit draw's normal matrix -- and the lights' own values. The
world transform is the one state the counter deliberately ignores, because it moves between most
draws of a frame; whoever reads the counter therefore owes the world matrix a fresh read on every
draw. The renderer compares it, the view and the projection with the matrices its products were last
formed from, bit for bit, and forms world-view, world-view-projection and the two normal matrices
again only when one differs, into arrays of its own. A texture whose bytes the program rewrites raises a counter of its own, so the upload
owed to it still happens inside the next draw that samples it. When the counter has moved, the
preparation is looked up by the state's values among those the frame has built. That name is made in
two parts so that the common changes stay cheap: the device also publishes
`stateVersionBesideTextures`, which a texture binding does not raise, and while it holds still the
state beside the textures keeps the number it was given -- a program that binds a new texture before
every draw pays for a lookup of that number and the bindings, not for the whole state. The render
and stage states are named as words by their hash (compared in full on a hit) -- written into a
scratch sized for them before the first, each map walked with `forEach` rather than `for...of`,
which makes an array of every entry, and a state has some hundreds -- and the targets,
transforms, material, the types of the enabled lights and the viewport are laid out as doubles and
named by their bits the same way, once per change of the objects the device holds, which it replaces
rather than writes into. What a light holds -- its colours, place, direction, range, attenuation and
cone -- is not in the name, because a program may move its lights between draws and the shader is
shaped by their types alone: a draw whose lights are not the ones its preparation's block was packed
with packs them into it. The whole key, with the stride, the topology and each stage's texture, is a
number, and none of this builds a string or an array on a draw. The lighting tallies of
`diagnostics()` sample a light, the world, the material and the ambient only when they differ from
what was sampled last. The Direct3D 9 device publishes both counters the same
way: every setter goes through its one `setState`, and a state block applied, a reset and a new
target or depth surface raise them as well; a value set again that is already there changes nothing.
The Direct3D 7 device does not publish them yet and is prepared for on every draw.
`diagnostics().prepared` counts what was built and what was reused. A draw through shaders keeps its
translations, vertex layout, pipeline state and samplers while `stateVersionBesideTextures`, the
shaders, the declaration, the stride and the topology hold still -- setting constants raises no
version, so a frame that sets its constants and binds a texture before every draw prepares once --
and copies only the constant blocks and takes the texture views per draw.

A texture the program releases for the last time gives its guest storage back at once, and its GPU
texture at the first present that finds it bound on no stage, after that frame's replay: a binding
holds its texture without a public reference (binding changes no count, as the API reports it), so a
program may release its own reference and go on drawing with it. `diagnostics().textureRecords`
lists the textures still held.

Both versions make cube and volume textures. A cube is six array layers of one backend texture
sampled through a cube view, each face locked, uploaded and drawn into as its own layer; a volume is
one 3D texture, each level uploaded with all its slices and its third coordinate addressed by
`D3DTSS_ADDRESSW`. A fixed-function cube stage samples the direction its coordinate set carries, or
a generated vector; a shader's `dcl_cube` or `dcl_volume` sampler binds a texture of that kind. A
texture keeps a dirty region -- it starts dirty, a lock adds its rectangle or box unless it is
`D3DLOCK_READONLY` or `D3DLOCK_NO_DIRTY_UPDATE`, and `AddDirtyRect` and `AddDirtyBox` add one -- and
`UpdateTexture` carries only that region into each level, then clears it. Texture palettes are kept,
though no palettised format is made. `CreateAdditionalSwapChain` makes a windowed chain with back
buffers of its own, presenting into the device's window when it names none. `GetFrontBuffer` (8) and
`GetFrontBufferData` (9, on the device and on a chain) read back the picture the chain last
presented, after that frame and before the next, into a system-memory `A8R8G8B8` surface, the caller
waiting on the read. `ProcessVertices` transforms and lights the bound streams into a vertex buffer
with the arithmetic Direct3D 7's vertex buffers use (`d3d7/process.js`); `d3d8/process.js` supplies
what a draw would read and the destination's layout.

Direct3D 8 makes vertex shaders to `vs_1_1` and pixel shaders to `ps_1_4`. `d3d8/declaration.js`
reads a vertex shader's declaration token by token -- streams, registers at the running offset,
skips, `D3DVSD_CONST` values -- into Direct3D 9 elements of the usage each `D3DVSDE_*` register
names; the function is translated as Direct3D 9's `vs_1_1` is, with each of `v0`-`v15` declared as
that usage, and draws over the fixed-function pixel stage or a pixel shader. A declaration made
without a function drives the fixed-function stage, several streams included, for draws and for
`ProcessVertices`. Setting a shader loads the constants its declaration carries. A pixel shader
draws through the same translation, over a vertex shader or over the fixed vertex stage made from
the declaration or the vertex format, with its eight constants and the stage states its 1.x reads
take. The shader constants are recorded into a state block as the other states are, and the
`Get*Declaration` and `Get*Function` calls hand the tokens back as given.

**Direct3D 9** (`src/layers/graphics/d3d9/`). The device advertises vertex and pixel shader model
2.0 -- the version the translator builds a pipeline from whole -- and refuses a create for a higher
version; a vertex shader below model 3 hands its `oD0` and `oD1` on held to [0, 1]. A draw under
`D3DRS_SCISSORTESTENABLE` is cut to the scissor rectangle within the viewport, recorded once per
change. `SetViewport` takes a viewport that reaches past its target and draws its mapping cut to the
target. `IDirect3DSurface9::GetDC` hands out a context over the surface's pixels for the formats GDI
draws into (`A8R8G8B8`, `X8R8G8B8`, `R5G6B5`, `X1R5G5B5`, `A1R5G5B5`), a render target's read back
first and the release an unlock after a write; while one is held, a lock of any surface of its
resource, a second `GetDC` and a release by the wrong surface are refused. A translated vertex
shader's position moves by the same half pixel as the fixed-function stage's, from the viewport
scale carried in a float register past the ones the shader reads. `shader.js` parses the bytecode
(operand counts from a table before model 2, relative addressing tokens from model 2 on, literal
definitions read as raw dwords) and holds the constant files; `wgsl.js` translates one instruction
at a time into a literal WGSL body: inputs by location typed as the declaration lays them, varyings
at fixed locations per usage so the two stages agree, constants in three uniform arrays per stage,
samplers as texture and sampler pairs. A draw binds any of the three combinations: a shader pair; a
pixel shader over fixed-function vertices, which gets a vertex stage made from the declaration
(`fixedVertexStage`); or a vertex shader over the fixed-function pixel stage, which gets a fragment
stage made from the stage cascade, fog and alpha test in force (`fixedFragmentStage`), reading the
colours, coordinate sets and fog the shader wrote and the fixed function's own defaults for what it
did not -- the shader-model-1 era's ordinary draw, transform in a program and texturing in the
stages. In every combination the vertex stage writes each varying the pixel stage reads, since a
fragment input with no vertex output fails the pipeline: a shader writes zero for what it never
wrote, the made stage white for a colour the declaration lacks and zero for a coordinate set. A
pipeline the GPU still refuses is built asynchronously and rejects, so its draw alone is skipped and
the reason is in the device's `failures`; the frame around it is submitted. A target bound with a
larger depth surface, which Direct3D allows and WebGPU does not, is drawn with a depth of its own
size standing in (`depth-stand-in`), kept per depth surface and size. `stateblock.js` records what
is set between `BeginStateBlock` and `EndStateBlock` -- and, as in Direct3D 8, a state set while
recording goes into the block, not the device. `declaration.js` converts between vertex declarations
and FVF codes. A fixed-function draw through a declaration that no FVF spells -- its members in
another order, at other offsets, or beside ones only a shader reads (tangents, binormals and the
like are ignored, as Direct3D ignores them) -- is read through a layout made from the declaration's
own offsets (`fixedFunctionLayoutOf`), carried in the pipeline state and its key, each member from
its own stream: the further streams are bound at their offsets and strides, and a stream with
nothing bound reads as zero. A declaration this stage cannot read -- a tessellator method, blend
weights, a colour that is not a `D3DCOLOR`, a position of another type, coordinate sets with a gap,
or a member past its stream's stride -- is dropped, counted in `skipped.layout` and reported once,
rather than raised into the program's thread.

A 1.x pixel shader draws its whole texture machine: a stage's read samples the texture bound there,
of its dimension, and below 1.4 at its coordinate set divided as `D3DTTFF_PROJECTED` asks; `texbem`,
`texbeml` and `bem` move coordinates by the stage's `D3DTSS_BUMPENVMAT` (carried in pixel constants
past the shader's own, filled from the stage states at each draw); the `texm3x2` and `texm3x3` rows,
`texreg2ar`, `texreg2gb`, `texreg2rgb`, `texdp3tex`, `texdp3`, `texdepth` and `texm3x2depth` compute
what the reference describes; a destination's shift is applied, `texcoord` holds its coordinates to
[0, 1], and a 1.x shader's constants read held to [-1, 1]. A 1.x translation is kept per dimension
bound at each stage and per projection. An indexed draw is instanced by `SetStreamSourceFreq`: it
draws as many instances as stream zero's frequency counts when that stream is marked
`D3DSTREAMSOURCE_INDEXEDDATA` or another is marked `D3DSTREAMSOURCE_INSTANCEDATA`, and such a stream
is a vertex buffer stepping once an instance, bound at its own offset. An occlusion query counts
through the backend's per-frame query set, the one Direct3D 10 counts through: each draw between its
`BEGIN` and `END` counts in a slot of its own, and a frame's counts are read after it is submitted,
so one count spans targets, passes and frames. `GetData` answers `S_FALSE` until every frame the
count took in has come back, `D3DGETDATA_FLUSH` sends the recorded draws and has the caller wait,
and the count is written in as many of its four bytes as the caller has room for. A texture made
with `D3DUSAGE_AUTOGENMIPMAP` shows the program one level and has the rest drawn from it on the GPU
whenever its top level changes or `GenerateMipSubLevels` is called, ahead of the next draw that
samples it.

**Direct3D 9Ex** is the same device behind more interfaces. `Direct3DCreate9Ex` hands back a root
answering `IDirect3D9Ex` and `IDirect3D9` with one count; its `CreateDevice` and `CreateDeviceEx`
make a device that answers `IDirect3DDevice9Ex`, whose chains answer `IDirect3DSwapChain9Ex`, where
a root, device or chain from `Direct3DCreate9` answers none of the three. Such a device keeps 9Ex's
rules: it is never lost -- `TestCooperativeLevel` succeeds, and once the GPU is gone `Present`,
`PresentEx` and `CheckDeviceState` answer `D3DERR_DEVICEREMOVED` -- it has no managed pool, takes
`D3DSWAPEFFECT_FLIPEX` and up to thirty back buffers, and resets without waiting for default-pool
resources, keeping its state but for the targets, the viewport's rectangle and the scissor. The mode
calls take a `D3DDISPLAYMODEFILTER` and fill a `D3DDISPLAYMODEEX`; the Ex slots answer the frame
latency, the GPU thread priority, residency, `GetLastPresentCount` and the vertical blank of the
chain there is.

**Direct3D 10 and DXGI** (`src/layers/graphics/d3d10/`). `dxbc.js` opens the container (`ISGN`,
`OSGN`, `SHDR`; older token streams answer `E_INVALIDARG`); `sm4.js` decodes the token stream with
untyped operands; `wgsl.js` keeps the register model literally -- every register a `vec4<u32>` of
bit patterns, each instruction reinterpreting -- and links a vertex and pixel shader by semantic
name when a pair is bound, writing the `@location` interface then. An instruction with no
translation makes the whole shader untranslatable and the draw is refused by name. `states.js`
normalises the four immutable state descriptions before creating them, so identical descriptions are
one object; `resources.js` separates resources from views (a view takes a reference on the device,
none on the resource); `validity.js` is the usage-by-bind-flag table; `dxgi.js` is the ownership
graph (a swap chain's parent is the factory; `ResizeBuffers` fails while a back buffer is held and
leaves the description untouched). `RSSetViewports` with more viewports than the sixteen slots is
ignored whole, and `RSGetViewports`/`RSGetScissorRects` write back the number bound and zero the
slots past it. `render.js` keeps a host copy of every resource's bytes and replays a record onto one
backend frame at present. A draw opens a pass over every bound render target at its slot, or over
the depth target alone, a clear still pending on any of them made by the pass's load; the blend
factor and the stencil reference are set on the pass when they change; an occlusion query or
predicate is a counter that every draw recorded while it is open adds its own GPU occlusion
query's count to, since a WebGPU query can neither span passes nor nest. The module hands the
device the configuration-and-adapter answer on block compression that Direct3D 8 and 9 get, the
guest's clock for timestamps, and whether the GPU device was made with `depth-clip-control`.
`reflection.js` reads a container's `RDEF` and `STAT` chunks for `D3D10ReflectShader`: the
constant buffers with their variables, types and structure members (in either Shader Model 4's
layout or the longer one a Shader Model 5 compiler announces in its `RD11` header), the bound
resources, the signatures and the compiler's counts; a lookup that finds nothing answers one
invalid object of its kind rather than null, as the runtime does.

The effect framework reads a compiled `fx_4_0` or `fx_4_1` effect (`effect.js`: the `FX10`
chunk's nineteen counts, the unstructured block of names, types, values and bytecode, then the
constant buffers, object variables and techniques in order) and builds its objects over it
(`effect-object.js`), each made when first asked for and the same object ever after; a lookup that
finds nothing answers the one invalid object of its kind, as the reflection's do. Numeric
variables live in their constant buffer's bytes, laid out in its registers with any default value
spread into them, and every typed call converts as the framework does (`effect-values.js`: `TRUE`
given to a number is -1, a number read as a bool is -1, and only a bool keeps what a bool gave it;
a scalar array's offset goes unused, a vector's and a matrix's are honoured); a raw value runs on
past its variable into the next. Shader, blend, depth-stencil, rasterizer and sampler variables
count an index on through every object of their kind from their own first element -- the global
ones in order, then the shaders the passes compile in place; `NULL` is one `$Anonymous` variable
per stage and is not counted. The effect makes its device objects when it is made: a default-usage
constant buffer per buffer, every shader, and a state object for each element of each state block,
from a backing store that starts at the framework's own defaults (`effect-states.js`:
point-filtered, wrapping samplers of sixteen-times anisotropy, blend states blending by source
alpha) and takes the constants the block assigns. A pass's `Apply` sets what the pass assigns, in
its order -- the rasterizer state, the depth-stencil state with the pass's stencil reference, the
blend state with its factor and sample mask, each shader -- and binds what each shader's resource
definitions say it reads, by the effect's names: the constant buffer of that name, uploaded first
when its bytes changed (or the program's own, given with `SetConstantBuffer`), and the views and
samplers of the variables of those names. What a pass does not assign stays as it is.
`ComputeStateBlockMask` marks what `Apply` would set. A shader's input signature, which a pass's
and a shader's descriptions hand out, is cut into a container of its own, laid after the
unstructured block in the effect's image.

**OpenGL** (`src/layers/graphics/opengl/`). Reports `GL_VERSION` 1.1, vendor `Bottlify Project`,
renderer `Bottlify OpenGL`, 25 GL extensions and 4 WGL extensions (`extensions.js`; a name in the
string is a promise that every function it defines is obtainable, and the test checks the list, the
context and the marshalling agree). The context records state (`context*.js`, `state.js`) and reads
it into one `Scene` per draw (`context-scene.js`); where that scene is drawn depends on the build.
The vertices a draw assembles are that draw's own: the context keeps no record of what it drew
unless it was made with `keepPrimitives` (a test's option, which `submittedPrimitives` then
answers), because such a record grows by every draw's vertices for as long as the program runs.
It takes every sized internal format GL 1.1 names, and texture 0 is one object per target shared by
every texture unit. A handler is reachable without the trap through `entry(name)` -- the same
function, the same dwords, the same current-context rule -- which is how a bundle's kernel issues GL
work the guest's own function would have issued (`host.md`'s `frame.gl`).

Everything a typed entry point's name decides -- the decoder of each argument type, the reader of
its `*v` form, whether an integer form normalises, how many components it has and what the missing
ones default to -- is decided when the table is built, so a call pays for its own work rather than
for the marshalling around it, and with no context current answers zero before it reads anything.
A typed call (`glColor4f`, `glVertex3fv`, `glMultiTexCoord2fARB`, `glVertexAttrib4NubvARB`)
decodes its components straight into the context's arguments: a float vector through the memory
layer's `readF32sInto`, any other into scratch bytes out of a window, never a view or an array of
its own. A query's answer is encoded into a scratch buffer and handed to guest memory as a slice. On
the context's side, a matrix is still a new `Float64Array` on every push, load and multiply -- the
renderer's caches compare matrices by identity -- but carved out of a shared block (`matrix.js`
`matrix()`): sixteen doubles alone are past the size V8 keeps a typed array's elements on its own
heap, and each such array would be a backing store allocated and finalised of its own, several times
the arithmetic that fills it. The texture environment's combiner slots and the client arrays' names
and enables are tables of the module, not rebuilt per call.

With a device, every draw goes to the GPU through the one backend (`gpu.js`): the frame is recorded
as the program draws and replayed at `SwapBuffers`, once every pipeline it needs has compiled. Each
recorded draw's fixed uniform block and, under a program, each stage's own block are handed back the
previous draw's identical array rather than a fresh one when nothing they read has moved since --
the model-view-projection product (recomputed only when the modelview or projection matrix has
actually changed, which its own recorded reference already tells), every active unit's texture
matrix and environment colour, the current vertex attributes, the fog and alpha-test state for the
fixed block, and a program's environment and local parameter files for a program stage's, each
tracked by a version raised only when a write actually changes a value, not by one that repeats it
-- because a title sets a light's whole parameter cast before every interaction draw whether or not
any value moved. A buffer object is a dynamic backend buffer whose writes pick their own lock flag
from the byte ranges the unflushed frames' draws read -- a write over a read range renames the
buffer, any other travels as a range. Vertex arrays are bound as they lie (one slot per buffer and
stride, an attribute per array; `gpu-layout.js` decides which shapes the GPU can read) and only the
index list is read on the processor, for its range and to widen it -- an index list bound from an
`ELEMENT_ARRAY_BUFFER` keeps that scan (its `(min, max)` and its widened copy) against the buffer
object's own `version` (raised on every `glBufferDataARB`, `glBufferSubDataARB` or write-back
unmap), so a static mesh drawn again at the same offset and count under a different light is scanned
once, not once per light; a list read from client memory, or one a seam call already dereferenced
into its own scratch bytes, has no such identity and is scanned fresh every draw, as before. Arrays
in client memory are copied by that range into a ring, and a vertex assembled on the processor --
immediate mode, a lit draw, a type the GPU has no format for -- is packed into one canonical layout.
`wgsl.js` writes the fixed-function formula as a shader per draw state (texture environment per base
format, combine with dot3, texture generation, projective coordinates, fog, colour sum, alpha test
as a discard, GL's clip depth remapped -- and turned round for a `glDepthRange` run backwards, which
the viewport takes in order -- and an `@invariant` position) and the pipeline descriptor (blend,
depth, two-sided stencil, cull, colour mask, polygon offset); every field either reads is in the
cache key. Two indexed draws recorded back to back, under state that has not moved (the same
pipeline, bindings and uniform blocks -- the state-version cache above already makes an unchanged
block the identical array, so this compares by reference -- vertex slots and base vertex) whose
index bytes in the scratch ring are exactly what the earlier one's own are immediately followed by,
with no alignment gap, are joined into the one draw call their combined range reads exactly as: the
earlier one's own count grows and the later one is dropped, which touches every pixel exactly as
many times as the two draws together would have and so holds under any blend, stencil or logic-op
state. Off while `dumpDraws` is on, so a dump or a probe still addresses every draw the guest issued
by its own number. `GL_EXT_stencil_two_side` (`glActiveStencilFaceEXT` selects `GL_FRONT` or
`GL_BACK`, a plain selector with no dependence on `GL_STENCIL_TEST_TWO_SIDE_EXT`:
`glStencilFunc`/`Op`/`Mask` always write only the active face's record, front by default, which is
the byte-identical single-state behaviour every earlier title still gets) maps directly onto the
pipeline descriptor's independent `stencilFront` and `stencilBack`, with the back record folded into
the cache key so a two-sided draw and a one-sided draw sharing a front state get different
pipelines; `glGet` of the unsuffixed stencil queries answers the active face's record -- the
front's, unless the selector points at the back -- and `GL_STENCIL_BACK_*` always answers the
back's. WebGPU has one stencil reference and one read and write mask shared by both faces, so a
program whose two faces disagree on those has the front's applied to the back's test too, reported
once as a divergence (see *Limitations*). A translator for `GL_ARB_vertex_program` and
`GL_ARB_fragment_program` exists, is tested, and both names are advertised -- `arb-program.js`
parses program text into an IR with byte-exact error positions, `arb-wgsl.js` emits one literal WGSL
stage per program with its parameters materialised into one uniform block per draw, state matrices
computed from the stacks at draw time, and the varyings widened to the eight coordinate sets a
program may address. The vertex program's block is bound beside the fixed block in group zero, the
group whose binding the vertex stage already reads, because on the one headless adapter this was
measured on the device hands a stage zero for a dynamic uniform block outside the first group the
stage reads -- a device rule observed there, not one the WebGPU specification makes, so it is worth
re-checking on a hardware adapter before it is relied on; the fragment program's block gets a bind
group of its own, which the fragment stage reads alone. `HIDDEN_GL_EXTENSIONS` is empty: a name
added back there stays sized, implemented and obtainable through `wglGetProcAddress`, as a driver's
unannounced entry points would be, and only the string omits it. Two windows onto a program need a
translation of their own: a program's `result.position` is depth-remapped once after the whole
program, so a position written one DP4 component at a time remaps against the w the program wrote
rather than the z instruction's own value, and `fragment.position` is emitted against the render
target's height, because GL measures it from the window's lower-left corner and WGSL's
`@builtin(position)` from the upper-left. The context holds eight texture units -- the image units
and coordinate sets a program addresses -- of which the conventional pipeline combines the first
four (`GL_MAX_TEXTURE_UNITS`). A binding the GPU path cannot answer (a non-matrix state parameter, a
3D texture target) refuses the stage by name as a divergence rather than drawing something wrong. A
clear is a triangle over the viewport under the scissor and the masks, which a pass's load operation
would ignore. The frame is shown through an opaque copy that alternates between two surfaces,
because a program's destination alpha is its own scratch and a page composites a presented texture
by its alpha. Textures are uploaded from the texels the context decoded, in `rgba8unorm`, only the
rectangle a `glTexSubImage2D` rewrote (the union of every rectangle since the last upload; a full
redefine is the whole level), level by level as the context marks them written; a cube map is six
layers with a cube view. An S3TC texture whose every level still holds the blocks it arrived in
uploads them as `bc1`/`bc2`/`bc3` blocks instead, when the configuration asks for it, the device has
`texture-compression-bc`, and the base level's own width and height are each a multiple of the block
size (WebGPU validates a compressed texture's own size against the block, and refuses to create one
otherwise; a base level narrower or shorter than one block -- legal in GL, whose data is one block
wide -- falls the whole texture back to `rgba8unorm` instead); one level rewritten decoded
(`glTexSubImage2D` into it) falls the whole texture back to `rgba8unorm` too. A level smaller than
one block (a tail mip) still copies the whole block its data physically occupies -- WebGPU's
texture-copy validation compares a compressed copy's extent against the subresource's *physical*
size, the logical size rounded up to the block, not against the level's own width and height (that
rounding is for a copy alone; the base level's own size is never rounded up). A copy from the
framebuffer into a texture level is a render pass into a view of that level, sampling the back
buffer with the row order GL's bottom-up framebuffer implies -- never into a BC surface, which
WebGPU refuses a render-attachment usage on.

Without a device, the same scene is drawn on the processor: `pipeline.js` runs the fixed-function
stages in the specification's order (per-vertex lighting, fog, texture generation and matrix;
near, far and user-plane clipping in clip space; division and viewport; assembly with culling and
polygon mode; rasterisation with texture environment, colour sum, fog and alpha test),
`raster.js` owns the fill rule (pixel centres, top-left tie-break, perspective-correct
interpolation) and the framebuffer operations, `texture.js` keeps every image as RGBA and honours
the pixel-store state. An enabled, loaded program is beyond this path: the draw reports a
divergence and draws nothing. That path is the formula the byte-exact tests hold to, the way
`reference.js` is for Direct3D; what the compiled shader computes only a device can show.

`wgl.js` is the seam with GDI, every rule of it measured: a pixel format belongs to the drawable,
can be set once, a DC without one cannot make a context, a context is current on one thread,
`wglGetProcAddress` returns null for core names. `SwapBuffers` replays the recorded frame on a
device, and waits past the bound as a present does, and on the processor hands the frame to the
presenter through guest scratch memory -- so this is the one API a headless build can run to a
finished frame.

**Vulkan** (`src/layers/graphics/vulkan/`). One physical device, described from what WebGPU
guarantees of every adapter (`physical.js`). Instances, devices, queues, surfaces and swapchains
are made; command buffers record into a host list, `vkQueueSubmit` replays each into the open
backend frame (a render pass becomes a backend pass, a clear its load operation), `vkQueuePresentKHR`
ends the frame; fences and semaphores signal at submit. `spirv.js` decodes a module's header,
capabilities and entry points and refuses `Geometry` and `Tessellation` by name. There is no
SPIR-V-to-WGSL translation in the tree: `vkCreateGraphicsPipelines` and every `vkCmdDraw*` are
among the 84 unimplemented commands, so a Vulkan program can clear and present but not draw.

**GDI drawing** (`src/layers/graphics/gdi/`). The pixel half of gdi32, over the bookkeeping half in
`win32`: the raster operations see 32-bit BGRX (`0x00RRGGBB` little-endian), and a surface of 1, 4,
8, 16 or 24 bits converts at each read and write -- 1 bit top bit leftmost, 4 bits high nibble
first, 24 bits BGR, the indexed depths through their colour table; DIB rows pad to four bytes and
device bitmaps to two; a blit to or from a monochrome device bitmap converts by the DC's colours,
its 0 bits becoming the destination's text colour and its 1 bits the background colour, and a colour
source being 1 exactly where it equals the source's background colour; raster operations are decoded
from the ROP3 truth table rather than enumerated; filling is Windows' half-open convention; clipping
is one rectangle; `BitBlt` shifts the source with the clip and uses memmove order on overlap,
`StretchBlt` copies first; text is composited from the **font engine**'s glyph coverage
(`gdi/fonts.js`) in the text colour, at the alignment and advances the program set. The engine
rasterises with the browser's own fonts through an `OffscreenCanvas` 2D context — no font file ships
— mapping the classic Windows face names to a CSS stack with the named family first and a generic
family (`sans-serif`, `serif`, `monospace`) behind it, one glyph per (font, byte) cached, the
program's bytes read as Windows-1252; a negative LOGFONT height is the em, a positive one the cell
the em is fitted to. A font asked for with `NONANTIALIASED_QUALITY` is a glyph set of its own, each
pixel inked when at least half covered and untouched otherwise. Where there is no canvas (Node, the
unit tests) the engine reports `available: false` and text falls back to one five-by-seven face
(`gdi/glyphs.js`), scaled by whole numbers into the cell, with a block for any character the face
has no picture of; every byte-exact test runs on that face. `createGdiDrawing` (`gdi/context.js`) is
the entry; `src/app.js` hands it to `win32` as `graphics.createDrawing`, with `surfaceFor`,
`presentDesktop`, and the engine's `fontMetrics` and `textWidth`, so the metrics a program lays out
against (`GetTextMetricsA`, `GetTextExtentPoint32A`, `GetCharWidth32A`, `DrawText`, the dialog base
units) are the engine's measurements when there is one and the bookkeeping half's estimate
otherwise. A memory context draws into the bytes of the bitmap selected into it -- a DIB section's
own bytes in guest memory, or a device-dependent bitmap's rows, which it keeps outside guest memory
(1-bit monochrome, 16-bit 5-6-5, 24 or 32 bits); a `BI_BITFIELDS` section or DIB pattern is drawn
and read by its masks whatever they are, each channel written as its mask's top bits and read back
widened by repeating them (`gdi/channels.js`, which the DIB codec shares), with 8-8-8, 5-6-5 and
5-5-5 on their direct paths. A DIB pattern brush whose table was palette indices takes its colours
from the palette the DC has when it paints. `setDIBitsToDevice` draws only the scan lines it is
handed, counted from the DIB's bottom as `ySrc` is; a run-length encoded DIB (`decodeRle`) is drawn
whole, by it and by `stretchDIBits`, and only the pixels its runs reach are put down. A window context draws into a view (`viewOf`) of
the **desktop** — one 32-bit surface the size of the display, allocated from the guest heap so the
presenter can show it the way it shows a DirectDraw primary — at the rectangle `win32` names for the
window. `gdi32` calls `presentDesktop` after every drawing entry point (`BitBlt`, `TextOutA`,
`LineTo`, ...) that binds a window- or display-kind context, not only when `win32`'s own paint pass
ends: a program that fetches its window's DC once and blits into it every frame, never through
`BeginPaint`/`EndPaint` and never releasing it between frames, still changes what is on screen on
every one of those blits, and the presenter's own coalescing (one flush per burst) is what keeps
that cheap.

### Adapter and display

`GetAdapterIdentifier` (Direct3D 8 and 9) and `vkGetPhysicalDeviceProperties` describe
`config.device.adapter`. Modes come from `win32`'s display table; Direct3D 8 lists each in
`X8R8G8B8` only. A device created or reset at a size calls `config.resolution`, and `screen()` then
reports that size. Each version's caps claim what its renderer honours. Direct3D 8's `GetDeviceCaps`
(`seam/d3d8.js`, `writeCaps`) claims a HAL device with hardware transform and lighting, eight blend
stages and simultaneous textures, 4096-texel textures, eight active lights, every compare and blend,
point and linear filtering with no anisotropy, wrap, mirror and clamp addressing, projected
textures, the texture operations the combiner draws (derived from its own list, so the two cannot
part), vertex, table, range, Z-based and W-based fog, a readable scan line, `TEXGEN`, cube and
volume maps, vertex shader 1.1 with 256 constants and pixel shader 1.4 with a `MaxPixelShaderValue`
of 1, `D3DCAPS2_FULLSCREENGAMMA` only where the presenter applies a ramp (a canvas to draw it on),
and no stencil operations, user clip planes, blend matrices or alpha in a palette; what is left beyond the renderer -- `TEXGEN`'s sphere map, a projected transform over a
carried coordinate set -- is accepted and reported (see *Limitations*). Direct3D 9's
`DEFAULT_CAPS` (`d3d9/device.js`) and `capabilityWords` (`d3d9/caps.js`) claim shader model 2.0 for
both stages, cube and volume maps, generated mipmaps (`D3DCAPS2_CANAUTOGENMIPMAP`), full-screen gamma on
the same condition as Direct3D 8's, eight lights, no
user clip planes, no anisotropy, no stencil operations, the same combiner-derived texture
operations, the same fog, the scissor test and a readable scan line. Direct3D 7's (`d3d7/caps.js`)
claim range fog and point and linear mip filtering among the rest. DirectDraw's `GetCaps` claims
`DDCAPS2_PRIMARYGAMMA` only where the presenter applies a ramp: a primary surface's
`IDirectDrawGammaControl` ramp is then the display's, set through the presenter and taken back when
the primary goes, and another surface's gamma control keeps its ramp and reads it back.

### The divergence rule

A call is answered one of three ways, and which one is decided where the call lives:

- **Refused.** A create the renderer cannot honour answers a failure code and clears the caller's
  out-pointer, because a success it cannot see through leaves a program drawing nothing and looking
  elsewhere for the reason. Refusals are documented at the slot.
- **Accepted and reported.** A state the device stores but does not act on -- a projected
  texture transform, sphere-map coordinate generation, a Direct3D 10 wireframe fill -- succeeds,
  because refusing `SetTransform` would change what the program does, and is reported once per
  distinct detail through `config.divergence` with the API name and a sentence saying what was not
  done. Every reporter de-duplicates.
- **Absent.** A slot with no implementation answers `E_NOTIMPL` from the right index.

### What the browser harness exercises

`tools/cdp_test/triangle.mjs` runs a committed Direct3D 8 fixture
(`modules/core/test/fixtures/triangle.exe`) on a real GPU and checks four named pixels byte for
byte; `tools/cdp_test/game.mjs` (`npm run cdp:game`) drives a program bundle through the same page
and reports what the run cost. Direct3D 8 is the only API with a real-GPU fixture; DirectDraw,
Direct3D 7, 9 and 10, OpenGL, Vulkan and the GDI drawing half are verified by the tests below and
by nothing else.

## Limitations and divergences

Refused (the program is told no):

- Direct3D 8: a vertex shader declaration with a tessellator stream; `ProcessVertices` with a vertex
  shader bound (nothing runs one on the processor), which is reported; a volume texture in a
  block-compressed or depth format, the first reported; `SetCursorProperties` answers
  `D3DERR_INVALIDCALL` unless a `cursor` receiver is configured; `GetInfo` answers `S_FALSE`;
  `SetViewport` past the target answers `D3DERR_INVALIDCALL`, as Direct3D 8 does; `DrawRectPatch`,
  `DrawTriPatch` and `DeletePatch` are absent. A texture in a format the device does not offer is
  refused and reported once per format.
- Direct3D 9: a shader above model 2.0 is refused at create; `maxUserClipPlanes` is zero;
  `ProcessVertices` through a vertex shader and a volume texture in a block-compressed or depth
  format are refused as in Direct3D 8; `DrawRectPatch`, `DrawTriPatch` and `DeletePatch` answer
  `D3DERR_INVALIDCALL`. `GetNPatchMode` returns a float in `ST(0)`, which the bridge cannot set, and
  is reported. `IDirect3DSurface9::GetDC` on a surface of any other format answers
  `D3DERR_INVALIDCALL` with the handle untouched.
- Direct3D 9Ex: a shared handle, as the plain interfaces refuse it; `GetPresentStats`, nothing here
  seeing the display's refreshes; `SetConvolutionMonoKernel` and `ComposeRects` are absent.
  `PresentEx` presents as `Present` does, its flags not honoured, and `S_PRESENT_OCCLUDED` is never
  answered.
- Direct3D 10: a shader using an untranslated instruction has its draws refused by name (counted in
  `skipped.untranslatable`); a geometry shader with stream output answers `E_NOTIMPL`; a
  multisampled resource (`CheckMultisampleQualityLevels` offers one sample only); a 10.1 device at
  feature level 10.1 or 9.x; effect pools (`D3D10CreateEffectPoolFromMemory`, and an effect made
  as a pool's child) and an effect of another version than `fx_4_0` and `fx_4_1`; a texture
  buffer's view through an effect (`SetTextureBuffer`, `GetTextureBuffer`); the compilers, the
  disassemblers (`D3D10DisassembleEffect` among them) and the preprocessor.
- Vulkan: 84 of 149 commands, including every draw and pipeline creation; a SPIR-V module
  declaring `Geometry` or `Tessellation`; secondary command buffers; an instance whose
  `apiVersion` is out of range; features the device lacks.
- DirectDraw: a blit between different pixel depths; a descriptor whose `dwSize` is not exactly the
  layout's own; a colour-space colour key (`DDERR_NOCOLORKEYHW`); a colour fill on a Z-buffer; a
  palette or a colour key on a mip sublevel; the event form of `WaitForVerticalBlank`
  (`DDERR_UNSUPPORTED`); an overlay surface (`DDERR_NOOVERLAYHW`), the overlay calls then
  answering `DDERR_NOTAOVERLAYSURFACE`. `TestCooperativeLevel` never answers `DDERR_WRONGMODE`,
  nothing here changing the display mode under a normal-mode object; leaving exclusive mode does
  not lose surfaces, where the runtime does, and a normal-mode object's surfaces are not lost when
  another object's exclusive mode is.
- Direct3D of DirectX 3, 5 and 6: the ramp and MMX devices are not made (only RGB and HAL);
  `Pick`, `GetPickRecords`, `TransformVertices` and `LightElements` are absent.
- GDI: a run-length encoded DIB written back by `GetDIBits`, or top-down (`ERROR_INVALID_PARAMETER`,
  as Windows answers); a DIB section backed by a file mapping. `StretchDIBits` draws 1- and
  4-bit DIBs, and `GetDIBits` writes 1-, 4- and 8-bit ones with their colour table: a section's own at
  its own depth, otherwise black and white, the sixteen VGA colours, or the twenty default-palette
  colours around a 3-3-2 cube, each pixel given its nearest.

Accepted and reported through `divergence`:

- Direct3D 8 (shared renderer): sphere-map coordinate generation (`D3DTSS_TCI_SPHEREMAP`) -- the
  set in the low bits is sampled as the vertex carries it; a texture transform of one coordinate,
  or a projected one over a set the vertex carries; a texture-stage cascade cut short because a stage reads `TEXTURE` with
  nothing bound or names a coordinate set the vertex lacks (the draw runs untextured from that
  stage on, counted under `cascade.noTexture` / `cascade.noCoordSet`); a shader the translator
  refuses or a declaration it cannot lay out, whose draws are not drawn (`skipped.program`); a
  sampler declared of one dimension with a texture of another bound there, which samples nothing; a
  render state or transform set in the guest shadow that the device refuses.
- Direct3D 8 and 9: a swap chain presenting into a window the display does not show -- its own, or a
  `Present` override -- has its frame drawn and submitted, not shown, the display showing the device
  window's picture; a windowed device's `GetFrontBuffer` or `GetFrontBufferData` puts the picture at
  the surface's corner, not where the window stands; an instanced draw with a stream stepping once
  every several instances is not drawn (`skipped.instancing`), a WebGPU vertex buffer stepping every
  instance; a frame with more draws inside occlusion queries than WebGPU's 4096 a frame leaves the
  draws past them uncounted.
- Direct3D 10: wireframe fill drawn solid; depth clipping left on by a GPU device made without
  `depth-clip-control`; a render target of another size than the first is not drawn into; a
  32-bit float target is drawn unblended; a bound geometry shader is ignored; per-instance data
  stepping once every several instances steps every instance; `DrawAuto` draws nothing;
  predication is recorded and never consulted; a stream-output target is bound and never written;
  an occlusion query with no GPU count behind it (no device, a frame past WebGPU's 4096 queries, a
  frame that failed) answers the samples its draws' viewports cover; a timestamp is the clock the
  device was given, not the GPU's, and its disjoint query says `Disjoint`; `GenerateMips` without a
  GPU filters only eight-bit four-channel formats, and it and a copy out of a render target the
  GPU cannot copy read the bytes the program last wrote, not what the GPU drew;
  `ResolveSubresource` does nothing; `UpdateSubresource` on a non-default resource; a copy between
  resources of different kinds, extents or format families, into an immutable resource, or with
  itself; bytes given to a depth texture are kept but not uploaded; a buffer view in a format with
  no decoding, or a texture view bound where the shader reads a buffer, reads zeros; a texture of
  another sample type than the shader reads reads as empty; a sampler of the other kind,
  comparison or not, is replaced by a point sampler of the kind declared; a text-filtering sampler
  used as a point sampler; a view of a typeless texture in a format WebGPU cannot cast it to reads
  it in one it can; a view into a slice of a 3D texture draws into its first slice; a texture
  format the device cannot back.
- Direct3D 10 effects: nothing the effect's expression machine computes is evaluated -- a shader a
  pass picks by an index expression is none, a pass value or state object given by an expression
  is left as it is, and a state block's field given by a variable or an expression keeps its
  starting value; a geometry shader with stream output is made without it; a texture buffer a
  shader reads is not bound; a pass state other than the shaders, the three state objects and
  their three values is not applied.
- Vulkan: more than one subpass, more than one colour attachment, a render area smaller than the
  framebuffer (the whole attachment is cleared), a viewport or scissor other than the first, a
  present of more than one swapchain, and every unimplemented command on first call.
- OpenGL: selection and feedback modes record nothing; on the processor the stencil test is
  enabled with no stencil buffer; two-sided lighting lights back faces as front; an enabled,
  loaded program draws nothing; `glDrawPixels`,
  `glBitmap` and `glCopyPixels` of depth or stencil are accepted and draw nothing; the accumulation
  buffer is empty; a `glTexImage2D` format or type outside the supported set is accepted and
  uploads nothing; `glReadPixels` with an unsupported type and `glGetCompressedTexImage` are
  refused; a vertex-array or index draw with no way to read guest memory draws nothing. Every
  unimplemented entry point is counted by name. On a device, the framebuffer's pixels are not
  brought back to the processor: `glReadPixels` answers black, `glDrawPixels`, `glBitmap` and
  `glCopyPixels` draw nothing; a colour logic operation writes the fragment as it is; a border
  clamp clamps to the edge; flat shading takes a primitive's first vertex rather than its last;
  points and lines are one pixel wide; the fixed pipeline combines the first four texture units,
  and a fifth is only what a program samples it as; a program stage binding a value the GPU path
  cannot answer (a non-matrix state parameter, a 3D texture target) is refused by name and its
  draw does not run; a texture rewritten
  between two draws of one frame is seen by both as rewritten; `GL_EXT_stencil_two_side` with a
  reference or a read or write mask that differs between the two faces has the front face's value
  applied to the back face's test and write as well, because WebGPU's stencil reference and masks
  are not per-face.

Counted rather than reported (`seam.device.skipped`): Direct3D 8 and 9 draws skipped for
`vertexShader` and `pixelShader` (a handle naming no live shader), `stride` (the stream's stride
disagrees with the FVF), `indexFormat`, `stencilRect` (a stencil-only clear of part of the target),
`texture` (the `skipTexture` knob), `layout`, `stream` (a further stream bound at an offset its
buffer cannot start at) and `program`; Direct3D 10 draws skipped for `noViewport`, `noTarget`,
`noShader`, `untranslatable` and `pipeline`.

Known ceilings the code names: the OpenGL rasteriser's depth buffer is a float per pixel and a
mipmapped minification filter samples the base level; Direct3D 7's capability lists claim no
stencil, bump mapping, cube maps or W-buffer; an execute buffer's `D3DOP_SPAN` (a software
rasteriser's run of pixels) is skipped, and the extents `D3DPROCESSVERTICES_UPDATEEXTENTS` asks for
are not accumulated into its status, neither reported; WebGPU cannot cull a line or a point, so a
culled wireframe also draws its back faces' edges, where Direct3D culls the triangle first; the
D3D 9 translator does not translate predication, subroutines or vertex-shader texture reads, holds a 1.x
shader's constants but not its arithmetic to the range of its registers, and carries a register's
alpha across a `ps_1_4` phase marker, which Direct3D does not promise; no signed texture format
(`D3DFMT_V8U8` and the like) is offered for a bump map. WebGPU lets an implementation report any
non-zero occlusion count as one, which a Direct3D 9 query then answers. A lost WebGPU device loses
every Direct3D 8 and 9 device made on it -- `TestCooperativeLevel` and `Present` answer
`D3DERR_DEVICELOST` -- and nothing recovers it: `Reset` still answers `D3DERR_DEVICELOST`, there
being no second GPU device to rebuild on; a 9Ex device, which is never lost, answers
`D3DERR_DEVICEREMOVED` from `Present`, `PresentEx` and `CheckDeviceState` instead. The raster's
position is read from the guest's clock, but `WaitForVerticalBlank` waits the time to the edge on a
host timer, the layer having no hook into the kernel's scheduler. A GDI `StretchDIBits` whose
destination alone is mirrored places its pixels as a mirror would, where Wine's tests find Windows
placing one that no mirroring gives, though it answers as Windows does; and a 32-bit DIB's top byte,
which Windows carries through `StretchDIBits`, is not kept. A Direct3D 10 effect's
`Optimize` keeps what the runtime would drop, which only the effect's own reflection reads.
Only a call that ends a frame waits for the device (see *Frames in flight*): a DirectDraw blit,
unlock or released device context onto the primary counts no frame -- a flip does -- so a
windowed program that shows its frames by blitting is not held, though a blit out of a Direct3D 7
target reads the target back first and waits for the device that way; nor is Vulkan's
`vkQueuePresentKHR`, its runtime drawing no geometry. A program's own `SetMaximumFrameLatency`
(9Ex, DXGI) is kept and read back, not applied: the configured bound holds whatever it sets. With
the bound a device slower than the program sets the program's pace, as it does on Windows.
Measured with SwiftShader, the engine in a worker and the browser on the same two cores, Doom 3's
timed demo (213 frames): with the bound, 2.2 to 3.1 frames a second by the wall clock and 2.1 to
2.9 by the demo's own, the device finishing 2.2 to 3.2, at most four frames unfinished at any
present -- the one just made among them -- and the page's report answering 1.0 to 2.7 s after the
run; with no bound, 15.4 to 16.4 a second by the wall clock and 12.6 to 13.1 by the demo's own
while the device finished 1.7 to 3.3, up to 183 frames unfinished, the last finishing 52 to 117 s
after it was made and the report answering 53 to 118 s after the run.

## Tests

1,828 `test()` cases across the layer's `*.test.js` files, all run by `npm test` from
`modules/core` (`node --test "src/**/*.test.js"`); one integration file runs under
`npm run test:integration`. By kind:

| kind | files |
|---|---|
| Layer assembly | `graphics.test.js` -- a build with no GPU comes up; the backend is built once; APIs are made by name; diagnostics report what was asked for; the pacer honours `maxFps`; a second instance in one realm does not take the first one's backend; a disposed machine answers as a build with graphics disabled (the stub's refusal); `dispose()` releases this machine's backend and leaves a presenter handed to the run untouched; a child's machine that goes leaves its parent drawing from its own memory; the raster reads the clock handed over as `guestNow`; a lost device loses the Direct3D devices made on it. `frame-latency.test.js` -- over a device that finishes its work only when told: a Direct3D 8 `Present` past three frames in flight is held until the oldest finishes and then answers `D3D_OK`, frames reach the queue in the order presented and as drawn with the bound as without it, a bound of zero holds nothing, a Direct3D 9 device and a swap chain beside it count against one bound, `SwapBuffers` through GDI and through WGL is held the same way, and a device that cannot say when work is done holds nothing. | `bitmaps.test.js` -- gdi32's bookkeeping over this layer's drawing, wired as `app.js` wires them: a double buffer, a monochrome mask made from the program's bits. |
| Byte-exact against the reference rasteriser or a stored image (base64 of the raw BGRX buffer beside the code, no tolerance) | `webgpu/internal/reference.test.js`, `d3d8/render.test.js`, `d3d9/render.test.js`, `d3d9/program.test.js`, `opengl/raster.test.js`, `opengl/pipeline.test.js`, `gdi/*.test.js`, `ddraw/blit.test.js`. A triangle is asserted at named pixels rather than as a whole image, so no rasterisation rule is pinned. |
| Recorded commands through the fake device (what the GPU was asked to do, never what a frame looks like) | `webgpu/backend.test.js`, `webgpu/internal/*.test.js` (including `presenter.test.js`: one presenter serves two machine lifetimes, configures the canvas once, and shows the second lifetime's frame rather than a cleared target; a machine that goes takes its pending frame and its claims with it; a flip's frame is the burst it is in, on the queue once an owner's replay is; every machine counts against one bound -- and `latency.test.js`: the fourth frame waits for the oldest, a frame counts until the work submitted with it is finished and not before it is submitted, waiting calls go oldest first, a failed replay and a lost device let a call go), `d3d7/device.test.js`, `d3d8/render.test.js`, `d3d8/program.test.js`, `d3d10/render.test.js`, `opengl/gpu.test.js` (a context on the renderer: buffer objects bound as they lie, the rename-or-range rule, client copies by index range, the canonical packing, uniform contents, uploads per written level, the clear's masks, the opaque shown copies, program draws and their blocks, the draw dump with its cut, skip and probe). |
| Contract, against documented behaviour and conformance expectations of the real runtime | `d3d7/load.test.js`, `d3d7/process.test.js`, `seam/raster.test.js`, `d3d9/contract.test.js`, `d3d9/ex.test.js`, `d3d9/validity.test.js`, `d3d8/validity.test.js`, `d3d8/declaration.test.js`, `d3d8/process.test.js`, `d3d10/validity.test.js`, `d3d10/device.test.js`, `d3d10/dxgi.test.js`, `d3d10/structs.test.js`, `d3d10/effect.test.js`, `d3d10/effect-object.test.js` (the effect framework, after Wine's d3d10 effect tests, over effects a fixture lays out), `ddraw/objects.test.js`, `ddraw/caps.test.js`, `ddraw/structs.test.js`, `opengl/wgl.test.js`, `opengl/pixelformat.test.js`, `opengl/context.test.js`, `opengl/context-calls.test.js`, `opengl/context-programs.test.js`, `vulkan/*.test.js`, `d3d7/caps.test.js`, `d3d9/caps.test.js`. |
| Observed behaviour, pinned | `d3d9/observed.test.js` -- lock-flag traffic, matrix order, render-target alpha, viewport placement. |
| Translators | `d3d9/shader.test.js`, `d3d9/wgsl.test.js`, `d3d10/dxbc.test.js`, `d3d10/sm4.test.js`, `d3d10/wgsl.test.js`, `vulkan/spirv.test.js`, `opengl/wgsl.test.js` (the GL formula as WGSL and the descriptor, and that every field the key must fold changes it), `opengl/arb-program.test.js` (the ARB program grammar, its error positions and limits), `opengl/arb-wgsl.test.js` (one stage at a time: every instruction, the parameters as one materialised block, the attribute aliasing, a real program's coordinate sets and image units), `opengl/gpu-layout.test.js` (array shapes to vertex formats and slots, mode expansion, index scanning), `opengl/buffer-reads.test.js` (the byte ranges unflushed draws read: overlap, forgotten once their frame flushed, a write past a frame's hull compared against none). |
| Seam and ABI | `seam/*.test.js` drive the bridge's real vtable publisher over a flat buffer and read the same words a guest would (among them a `Flip` answering once the bound lets it, and not counted when refused); `seam/shadow.test.js` pins the guest-side code's bytes and layout, holds an entry to the words the routines marked, and holds entries after random runs of guest writes -- forty seeds of four hundred -- to the calls, their order and the refusals of a comparison of the whole block; `seam/shadow.itest.js` runs that code on the emulator's processor and on cork's, and reads the marks and counts it leaves; `seam/structs.test.js` holds `floatsOf`, `intsOf` and `dwordsOf` to what a copy through a fresh array's own buffer answered and each answer to an array of its own, a dword field to the same four bytes written in place or as bytes, and a structure to one write per run of the fields named; `seam/d3d8.test.js` and `seam/d3d9.test.js` hold each structure getter to one write of the bytes its setter took; `opengl/exports.test.js` holds the `OPENGL32.dll` argument words and every typed form of a family -- immediate and `*v`, each component count, each type -- to the specification's decoding, through the memory layer's float reader and through a window, with no `DataView` made on a call. |
| A whole program | `src/frame-latency.itest.js` (`npm run test:integration`) -- a program with a Direct3D 8 device and a second thread that only counts presents twelve frames through `createApp` over a device finishing one submit every few milliseconds of the host's timers, under cork and under the emulator: with the default bound presents wait, the device is never more than one frame past the bound behind and the counting thread runs while a present waits; with no bound none waits and the program runs ahead. `src/d3d8-shadow.itest.js` -- a Direct3D 8 program whose two threads set render states in three rows of the marks, stage states on two stages and two transforms through the guest routines, three thousand times each, and read every one back through the host after each round, under cork and under the emulator: every value reads back as set, every call is counted, and an entry that found something compared at most what one round of each thread set. |

Real-GPU acceptance lives outside the unit suite in `tools/cdp_test/`: `triangle.mjs` (a
Direct3D 8 fixture, four named pixels) and `game.mjs` (drives a program bundle), both driving a headless
or headed Chromium over CDP. Only the browser probe runs in CI.
