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
| `presenter` | a presenter made by the run, or absent | made from `device` | The canvas, its configured format, the pacer and the texture the primary is copied into. It is a service of the run rather than of a machine, so the assembling caller makes one and hands the same object to every machine the run is rebuilt on; the layer attaches its own backend to it and never disposes it. The last frame one process presented stays on the canvas until the next presents. |
| `device.adapter` | `{ vendor?, architecture?, description? }` | absent | What `GetAdapterIdentifier` and `vkGetPhysicalDeviceProperties` describe. |
| `compressedTextures` | boolean | `false` | Whether a kept S3TC texture travels to the device as BC blocks instead of decoded `rgba8unorm`, once the format is legal to create at all -- `CheckDeviceFormat` and `glCompressedTexImage2D` answer a DXT format creatable either way, whatever this flag says. Applies to OpenGL and Direct3D 8/9 alike; DirectDraw has no DXT/FOURCC surface path for it to apply to, and Vulkan's flag instead gates whether `textureCompressionBC` is *advertised* as a supported feature -- a legality signal, not an upload choice, pre-existing before this flag and exercised by no title. The device's own `texture-compression-bc` feature still gates it either way: `true` here without the feature is `false`. Off by default: measured to stall the GPU process on the one machine this project has run it on; a build turns it on once it is checked clean on its own hardware. Set through `createApp`'s `graphics` option, which is forwarded to this layer as given. |
| `screen` | `{ width, height, bitsPerPixel }` | `{ 640, 480, 32 }` | The display a program is told about until `resolution` changes it. |
| `maxFps` | number | `60` | Frame-delivery cap for the pacer; `0` means whatever the scheduler offers. |
| `guestNow` | `() => ms` | the host's `performance.now` | The clock the display's raster runs on -- DirectDraw's vertical-blank status and scan line, Direct3D's raster status. The assembling caller hands the kernel's virtual time, because a program that spins on the blank times the spin with its own timers; the presenter's pacing, a property of the canvas, keeps its own. |
| `schedule`, `now` | `(tick) => void`, `() => number` | absent | A display-rate scheduler and a clock. Both present enables the pacer; a headless build delivers on a microtask. |
| `allocate` | `(bytes) => address` | absent | Guest memory for locked surfaces and buffers, and for the shadow state block. Without it a lock hands back an address this layer invented and every state setter stays a trap. |
| `free` | `(address) => void` | absent | Returns guest memory a texture or map is finished with, so a program that sizes its cache from free heap sees textures released. |
| `divergence` | `(api, detail) => void` | absent | Where "this call succeeded and did not do all of what it promises" is reported. See *Limitations*. |
| `cursor` | `(notice: CursorNotice) => void` | absent | Receives a Direct3D program's cursor bitmap (`width`, `height`, `hotSpot`, `bgra`, `shown`) -- once per change, not per `SetCursorProperties`/`ShowCursor` call, since a program sets the same cursor every frame. Without it `SetCursorProperties` is refused with `D3DERR_INVALIDCALL`, which tells the program to draw its own. |
| `resolution` | `(width, height, where?: { window?, fullscreen? }) => void` | absent | Told the back-buffer size a device is created or reset at, and which window it presents into; the reported screen follows it. `where.window` is the device's `HWND` and `where.fullscreen` says whether it is exclusive; a fullscreen device's window is placed at the mode's size, so a program clipping its cursor to that window reaches the picture's corners, and a reset back to windowed reports the window at its own size again. |
| `publishInterface` | `(object, iid) => address` | `() => 0` | The bridge's vtable publisher. The default publishes nothing, so a build without a bridge gets tables that refuse rather than pointers into nowhere. |
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
| `present(surface)` | Shows a surface that lives in guest memory through the presenter, for anything outside the drawing libraries (a film, an overlay). |
| `screen()` | The current `{ width, height, bitsPerPixel }`. |
| `create(name, options?)` | Makes one API object by name: `ddraw`, `d3d8`, `d3d9`, `opengl`, `d3d10`, `vulkan`. Direct3D 7 has no factory of its own; it is reached from a DirectDraw object. |
| `apis()` | The six names above. |
| `libraries()` | `{ 'OPENGL32.dll', 'D3D8.dll', 'D3D9.dll', 'D3D10.dll', 'DXGI.dll', 'vulkan-1.dll', 'DDRAW.dll' }`, each a `{ Name: { argBytes, handler } }` table shaped like a `win32` library's, for the loader. |
| `opengl()` | The pixel-format negotiation (`size`, `count`, `choose`, `describe`) and `swapBuffers(hdc)` whose entry points `gdi32` exports; the assembling caller hands these down to `win32`; and `entry(name)`, one named `OPENGL32.dll` handler with its raw-dword convention, for a caller already on this side of the boundary. |

An instance owns its GPU work. `create()` may run more than once in the same realm (a process
replacement runs it again; the plan for two machines in one worker needs two at once), so the
backend, the factories, the published interfaces and the api's own record of what was created live
in the instance the api closes over, and a second `create()` cannot hand the first one's backend to
an api that was never given a device; `diagnostics()` answers for the most recently created
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
| `DDRAW.dll` | 4 | `DirectDrawCreate`, `DirectDrawCreateEx`, `DirectDrawEnumerateA`, `DirectDrawCreateClipper`. |
| `D3D10.dll` | 2 | `D3D10CreateDevice`, `D3D10CreateDeviceAndSwapChain`. |
| `DXGI.dll` | 2 | `CreateDXGIFactory`, `CreateDXGIFactory1` (the latter refuses; a program uses that to learn which DXGI it has). |
| `D3D8.dll` | 1 | `Direct3DCreate8`. |
| `D3D9.dll` | 1 | `Direct3DCreate9`. |

The COM entry points are thin on purpose: each makes one object and publishes one interface, and
everything a program does afterwards goes through the vtable. The vtable slot lists are in
`src/layers/graphics/seam/vtables.js` (DirectDraw, Direct3D 7 and 8: 22 lists, 288 slots),
`src/layers/graphics/d3d9/interfaces.js` (11 lists) and `src/layers/graphics/seam/d3d10.js`
(15 lists for DXGI and Direct3D 10).

### `diagnostics()`

| metric | meaning |
|---|---|
| `apis` | The factory names on offer. |
| `libraries` | The library names published. |
| `created` | Which APIs a program actually asked for, in order. |
| `seam.created`, `seam.interfaces` | Objects made through the entry points; interfaces published. |
| `seam.device` | The most recent Direct3D 8 device's counters, or the Direct3D 9 one's: `frames`, `draws`, `clears`, `programmable`, `prepared` (`built`, `reused`), `programs`, `skipped.*`, `cascade.*`, `failures`, `lighting.*`, `recording`, `recentFrames`, `lastFrame`, `lastDump`, `textureRecords`, `textures`, `redundantTransforms`. Each `recentFrames` entry (the last 240 presents) carries `draws`, `offscreenDraws` and `offscreenTargets` (draws into a target other than the back buffer, and how many such targets), `clears` and `clearColor` (the last whole clear of the back buffer as `#aarrggbb`, empty when there was none), `viewport` (`x,y wxh` at the present) and `target` (the back buffer's size), plus `placeholder`, `truncated`, `uploads`, `textures`, fog and light summaries -- so a frame that only cleared, or drew only offscreen, or drew into a viewport that is not the picture, is read off the record rather than guessed from a screenshot. When neither made a device and the OpenGL runtime drew, its renderer's counters instead: `frames`, `pipelines`, `draws`, `clears`, `fallbacks`, `uploads`, `renames`, `refused`, `skipped`, `cut`, `resident`, `samplers`, `unflushed`, `failures`, `lastDump`. |
| `seam.vulkan` | `placed` traps, `objects` by kind, `unimplemented` by command name. |
| `shadow` | The Direct3D 8 guest-side state block: `placed`, `slowPath`, `renderStateCalls`, `transformCalls`, `bindingCalls`, `lockCalls`, `unlockCalls`, `textureCalls`, `stageStateCalls`, `materialCalls`, `buffers`, `synced`, `skipped`, `refused`. |
| `backend` | Profiler snapshot (`frames`, `counters`, `uploadsByLabel`, `recentFrames` with phases), `shaders` (`builds`, `errors`, `warnings`, `dropped`, `distinct`), `shaderMessages`, `pipelines` (`built`, `reused`, `resident`), `uniforms`, `buffers` per dynamic buffer (`renames`, `pooled`, `dirty`), `frameOpen`, `pendingTextureCopies`, `surfaceWrites`, `presents`. |
| `presenter` | `presents`, `uploads`, `bytes`, `shownByOwner`, `shown` (frames copied to the canvas), `shownBy` (those copies by the label of what was shown -- a Direct3D device's `target`, OpenGL's `gl-shown[0]`/`gl-shown[1]`, the `desktop`'s bytes, a primary's `guest bytes` -- so a picture one device draws and another path paints over shows as two labels rising together), `lastBuffer`, `pending`, `claimed`, `failures`, `disposed`. The same label is on every record of `presented().history`. The counters are cumulative across a process replacement, because the presenter is. |
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
  and each write is a trip to the GPU process.
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
  its coordinate from the vertex through world and view, through the stage's whole transform, in the
  vertex stage, whatever set the vertex carries, and under `D3DTTFF_PROJECTED` is divided per pixel
  by the count's last component (a pixel shader over fixed-function vertices is handed the same four
  components undivided); per-vertex lighting is unrolled per enabled light (point, spot,
  directional, with range, attenuation and cone in uniforms), the normal carried into world space by
  the inverse transpose of the world matrix (`normalMatrix` in the block, so a non-affine world
  leaves a surface unlit as Direct3D does) and renormalised -- there and for a generated coordinate
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
  canvas, and no black frame at the swap. The presenter's third job is the canvas copy the backend
  calls `presentTo`: every frame, whatever API produced it, is copied into the canvas in the
  frame's own format, configured once.
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
so one surface is one identity. Every slot of every interface is declared in `vtables.js`; a slot
nothing implements answers `E_NOTIMPL` from the index the program compiled against rather than
shifting the ones after it, and `argBytes` counts the interface pointer and every argument because
the callee pops the stack.

`shadow.js` is Direct3D 8's fast path. `SetRenderState`, `SetTransform`, `SetStreamSource`,
`SetIndices`, `SetVertexShader`, `SetTexture`, `SetTextureStageState`, `SetMaterial`, `Lock` and
`Unlock` are placed as x86 code that writes a block of guest memory the device owns and returns
without trapping; on every entry into the host the groups of the block whose call counter moved are
compared against the host's copy and each difference goes through the real setter, where validation
lives. The block is one-way and untrusted; a value the device would refuse is refused at the next
entry and reported once as a divergence. A stage past the last is refused in the guest with
`D3DERR_INVALIDCALL`; a stage state type this version has not got, and a null material, are left
to the trap. A texture is bound by the pointer the guest wrote and resolved to its object when the
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
  `DDSPD_VOLATILE` entry expires with the surface's contents.
- **`d3d7.js`** publishes no root; it hands the DirectDraw seam the `IDirect3D7` descriptor to put
  beside its own, and keeps one Direct3D 7 object per DirectDraw object. A draw takes its vertex
  format as an argument and its indices by pointer.
- **`d3d8.js`** publishes `IDirect3D8`, `IDirect3DDevice8`, surfaces, textures, vertex and index
  buffers. Modes are offered in `D3DFMT_X8R8G8B8` only. Present parameters use Direct3D 8's own
  layout, which differs from 9's. `Clear` takes the rectangle count at its word, as 9's does: a
  count of zero clears nothing whatever the pointer, and a null array the whole target.
- **`d3d9.js`** publishes the eleven interfaces of `d3d9/interfaces.js`, including vertex
  declarations, shaders, state blocks, swap chains and queries. Nearly every create ends in a
  shared-handle pointer that must be null; a handful of methods return a count, a boolean or a
  float rather than an `HRESULT`.
- **`d3d10.js`** publishes the DXGI factory, adapter, output, swap chain and device interfaces and
  the Direct3D 10 device, resources, views, state objects, shaders and queries. Arrays of
  interfaces arrive as pointer and count; a map allocates a guest block of the subresource's size,
  shows it the current bytes, and the unmap reads it back.
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
`ddsCaps`. A colour key is one colour, set at creation or after and reported by `GetSurfaceDesc`; a
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

**Direct3D 8** (`src/layers/graphics/d3d8/`). `device.js` models what a program observes between
draws and decides whether a call is legal; `render.js` is what happens underneath when there is a
backend. A state block (`stateblock.js`) holds the half its type names -- the vertex half's render
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
drawn one (`D3DUSAGE_AUTOGENMIPMAP` and `GenerateMipSubLevels` do nothing), so a sample that
reaches those levels reads what the guest put there.

A draw is prepared once per state change rather than once per draw. The device raises one counter,
`drawStateVersion`, for every state change a preparation depends on -- a render state, a stage
state, a texture binding, a material, a light, the viewport, a transform other than the world one,
the vertex or pixel shader, a state block applied, a reset -- and raises it for a change of value,
not for a call that sets the value already there. While that counter and the draw's stride and
topology are what the last preparation was built from, the next draw reuses its vertex layout, its
stage cascade, its texture and sampler bindings, its pipeline state and the pipeline itself, and the
block of uniforms all but the fields the world transform reaches -- the world, world-view and
world-view-projection matrices, and a lit draw's normal matrix. The world transform is the one state
the counter deliberately ignores, because it moves between most draws of a frame; whoever reads the
counter therefore owes the world matrix a fresh read on every draw, and nothing else derived from it
may be kept. A texture whose bytes the program rewrites raises a counter of its own, so the upload
owed to it still happens inside the next draw that samples it. When the counter has moved, the
preparation is looked up by the state's values among those the frame has built. That name is made in
two parts so that the common changes stay cheap: the device also publishes
`stateVersionBesideTextures`, which a texture binding does not raise, and while it holds still the
state beside the textures keeps the number it was given -- a program that binds a new texture before
every draw pays for a lookup of that number and the bindings, not for the whole state. The render
and stage states are named as words by their hash (compared in full on a hit), and the targets,
transforms, material, lights and viewport are named once per change of the objects the device holds,
which it replaces rather than writes into. The Direct3D 9 device publishes both counters the same
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
backend frame at present.

**OpenGL** (`src/layers/graphics/opengl/`). Reports `GL_VERSION` 1.1, vendor `Bottlify Project`,
renderer `Bottlify OpenGL`, 25 GL extensions and 4 WGL extensions (`extensions.js`; a name in the
string is a promise that every function it defines is obtainable, and the test checks the list, the
context and the marshalling agree). The context records state (`context*.js`, `state.js`) and reads
it into one `Scene` per draw (`context-scene.js`); where that scene is drawn depends on the build.
It takes every sized internal format GL 1.1 names, and texture 0 is one object per target shared by
every texture unit. A handler is reachable without the trap through `entry(name)` -- the same
function, the same dwords, the same current-context rule -- which is how a bundle's kernel issues GL
work the guest's own function would have issued (`host.md`'s `frame.gl`).

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
device, and on the processor hands the frame to the presenter through guest scratch memory -- so
this is the one API a headless build can run to a finished frame.

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
handed, counted from the DIB's bottom as `ySrc` is. A window context draws into a view (`viewOf`) of
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
part), vertex, table, range, Z-based and W-based fog, a readable scan line, `TEXGEN`, and no cube
maps, stencil operations, user clip planes or blend matrices, with both shader versions at zero;
what is left beyond the renderer -- `TEXGEN`'s sphere map, a projected transform over a carried
coordinate set -- is accepted and reported (see *Limitations*). Direct3D 9's `DEFAULT_CAPS`
(`d3d9/device.js`) and `capabilityWords` (`d3d9/caps.js`) claim shader model 2.0 for both stages,
eight lights, no user clip planes, no anisotropy, no stencil operations, the same combiner-derived
texture operations, the same fog, the scissor test and a readable scan line. Direct3D 7's
(`d3d7/caps.js`) claim range fog and point and linear mip filtering among the rest.

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

- Direct3D 8: `CreateVertexShader` and `CreatePixelShader` are absent from the table on purpose,
  so a program takes the fixed-function path the renderer draws; `CreateCubeTexture`,
  `CreateVolumeTexture` and `CreateAdditionalSwapChain` answer `D3DERR_NOTAVAILABLE`; the four
  palette calls, `ProcessVertices` and `GetFrontBuffer` answer `D3DERR_INVALIDCALL`;
  `SetCursorProperties` answers `D3DERR_INVALIDCALL` unless a `cursor` receiver is configured;
  `GetInfo` answers `S_FALSE`; `SetViewport` past the target answers `D3DERR_INVALIDCALL`, as
  Direct3D 8 does. A texture in a format the device does not offer is refused and reported once per
  format.
- Direct3D 9: `CreateCubeTexture`, `CreateVolumeTexture`, `CreateAdditionalSwapChain` answer
  `D3DERR_NOTAVAILABLE`; a shader above model 2.0 is refused at create; `maxUserClipPlanes` is
  zero. `GetNPatchMode` returns a float in `ST(0)`, which the bridge cannot set, and is reported.
  `IDirect3DSurface9::GetDC` on a surface of any other format answers `D3DERR_INVALIDCALL` with the
  handle untouched.
- Direct3D 10: a shader using an untranslated instruction is refused by name; a geometry shader
  with stream output is refused; `CreateDXGIFactory1` refuses.
- Vulkan: 84 of 149 commands, including every draw and pipeline creation; a SPIR-V module
  declaring `Geometry` or `Tessellation`; secondary command buffers; an instance whose
  `apiVersion` is out of range; features the device lacks.
- DirectDraw: a blit between different pixel depths; a descriptor whose `dwSize` is not exactly the
  layout's own; a colour-space colour key (`DDERR_NOCOLORKEYHW`); a colour fill on a Z-buffer; a
  palette or a colour key on a mip sublevel; the event form of `WaitForVerticalBlank`
  (`DDERR_UNSUPPORTED`).
- GDI: a run-length encoded DIB (`BI_RLE8`, `BI_RLE4`) to `StretchDIBits`, `SetDIBitsToDevice`,
  `SetDIBits` or `GetDIBits`; a DIB section backed by a file mapping. `StretchDIBits` draws 1- and
  4-bit DIBs, and `GetDIBits` writes 1-, 4- and 8-bit ones with their colour table: a section's own at
  its own depth, otherwise black and white, the sixteen VGA colours, or the twenty default-palette
  colours around a 3-3-2 cube, each pixel given its nearest.

Accepted and reported through `divergence`:

- Direct3D 8 (shared renderer): sphere-map coordinate generation (`D3DTSS_TCI_SPHEREMAP`) -- the
  set in the low bits is sampled as the vertex carries it; a texture transform of one coordinate,
  or a projected one over a set the vertex carries; a texture-stage cascade cut short because a stage reads `TEXTURE` with
  nothing bound or names a coordinate set the vertex lacks (the draw runs untextured from that
  stage on, counted under `cascade.noTexture` / `cascade.noCoordSet`); a draw with a vertex shader
  feeding the fixed-function pixel stage, or a shader pair the renderer could not build a pipeline
  for; a render state or transform set in the guest shadow that the device refuses.
- Direct3D 10: wireframe fill drawn solid; depth clipping cannot be turned off; only the first of
  several render targets is drawn into; a bound geometry shader is ignored; a blend factor other
  than white and a stencil reference other than zero are not applied; instanced draws start at
  instance zero; `DrawAuto` draws nothing; predication is recorded and never consulted; a
  stream-output target is bound and never written; a query never answers; `GenerateMips` and a
  copy out of a render target read the bytes the program last wrote, not what the GPU drew;
  `ResolveSubresource` does nothing; `UpdateSubresource` on a non-default resource; a copy between
  resources of different kinds, into an immutable resource, or with itself; a shader resource view
  over a buffer; a text-filtering sampler used as a point sampler; a texture format the device
  cannot back.
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

Counted rather than reported (`seam.device.skipped`): Direct3D 8 draws skipped for `vertexShader`,
`pixelShader`, `stride` (the stream's stride disagrees with the FVF), `indexFormat`, `stencilRect`
(a stencil-only clear of part of the target), `texture` (the `skipTexture` knob) and `program`;
Direct3D 10 draws skipped for `noViewport`, `noTarget`, `noShader`, `untranslatable` and
`pipeline`.

Known ceilings the code names: the OpenGL rasteriser's depth buffer is a float per pixel and a
mipmapped minification filter samples the base level; Direct3D 7's capability lists claim no
stencil, bump mapping, cube maps or W-buffer; WebGPU cannot cull a line or a point, so a culled
wireframe also draws its back faces' edges, where Direct3D culls the triangle first; the D3D 9
translator does not translate 1.x texture-addressing instructions, predication, subroutines or
vertex-shader texture reads. A lost WebGPU device loses every Direct3D 8 and 9 device made on it --
`TestCooperativeLevel` and `Present` answer `D3DERR_DEVICELOST` -- and nothing recovers it: `Reset`
still answers `D3DERR_DEVICELOST`, there being no second GPU device to rebuild on. The raster's
position is read from the guest's clock, but `WaitForVerticalBlank` waits the time to the edge on a
host timer, the layer having no hook into the kernel's scheduler.

## Tests

1,498 `test()` cases across the layer's `*.test.js` files, all run by `npm test` from
`modules/core` (`node --test "src/**/*.test.js"`); one integration file runs under
`npm run test:integration`. By kind:

| kind | files |
|---|---|
| Layer assembly | `graphics.test.js` -- a build with no GPU comes up; the backend is built once; APIs are made by name; diagnostics report what was asked for; the pacer honours `maxFps`; a second instance in one realm does not take the first one's backend; a disposed machine answers as a build with graphics disabled (the stub's refusal); `dispose()` releases this machine's backend and leaves a presenter handed to the run untouched; the raster reads the clock handed over as `guestNow`; a lost device loses the Direct3D devices made on it. `bitmaps.test.js` -- gdi32's bookkeeping over this layer's drawing, wired as `app.js` wires them: a double buffer, a monochrome mask made from the program's bits. |
| Byte-exact against the reference rasteriser or a stored image (base64 of the raw BGRX buffer beside the code, no tolerance) | `webgpu/internal/reference.test.js`, `d3d8/render.test.js`, `d3d9/render.test.js`, `d3d9/program.test.js`, `opengl/raster.test.js`, `opengl/pipeline.test.js`, `gdi/*.test.js`, `ddraw/blit.test.js`. A triangle is asserted at named pixels rather than as a whole image, so no rasterisation rule is pinned. |
| Recorded commands through the fake device (what the GPU was asked to do, never what a frame looks like) | `webgpu/backend.test.js`, `webgpu/internal/*.test.js` (including `presenter.test.js`: one presenter serves two machine lifetimes, configures the canvas once, and shows the second lifetime's frame rather than a cleared target), `d3d7/device.test.js`, `d3d8/render.test.js`, `d3d10/render.test.js`, `opengl/gpu.test.js` (a context on the renderer: buffer objects bound as they lie, the rename-or-range rule, client copies by index range, the canonical packing, uniform contents, uploads per written level, the clear's masks, the opaque shown copies, program draws and their blocks, the draw dump with its cut, skip and probe). |
| Contract, against documented behaviour and conformance expectations of the real runtime | `d3d7/load.test.js`, `d3d7/process.test.js`, `seam/raster.test.js`, `d3d9/contract.test.js`, `d3d9/validity.test.js`, `d3d8/validity.test.js`, `d3d10/validity.test.js`, `d3d10/device.test.js`, `d3d10/dxgi.test.js`, `d3d10/structs.test.js`, `ddraw/objects.test.js`, `ddraw/caps.test.js`, `ddraw/structs.test.js`, `opengl/wgl.test.js`, `opengl/pixelformat.test.js`, `opengl/context.test.js`, `opengl/context-calls.test.js`, `opengl/context-programs.test.js`, `vulkan/*.test.js`, `d3d7/caps.test.js`, `d3d9/caps.test.js`. |
| Observed behaviour, pinned | `d3d9/observed.test.js` -- lock-flag traffic, matrix order, render-target alpha, viewport placement. |
| Translators | `d3d9/shader.test.js`, `d3d9/wgsl.test.js`, `d3d10/dxbc.test.js`, `d3d10/sm4.test.js`, `d3d10/wgsl.test.js`, `vulkan/spirv.test.js`, `opengl/wgsl.test.js` (the GL formula as WGSL and the descriptor, and that every field the key must fold changes it), `opengl/arb-program.test.js` (the ARB program grammar, its error positions and limits), `opengl/arb-wgsl.test.js` (one stage at a time: every instruction, the parameters as one materialised block, the attribute aliasing, a real program's coordinate sets and image units), `opengl/gpu-layout.test.js` (array shapes to vertex formats and slots, mode expansion, index scanning). |
| Seam and ABI | `seam/*.test.js` drive the bridge's real vtable publisher over a flat buffer and read the same words a guest would; `seam/shadow.test.js` pins the guest-side code's bytes and layout; `seam/shadow.itest.js` runs that code on the real emulated processor. |

Real-GPU acceptance lives outside the unit suite in `tools/cdp_test/`: `triangle.mjs` (a
Direct3D 8 fixture, four named pixels) and `game.mjs` (drives a program bundle), both driving a headless
or headed Chromium over CDP. Only the browser probe runs in CI.
