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
| `device` | `{ device, queue, presentTo, adapter?, dumpDraws?, maxDraws?, skipTexture?, probeTexture?, fog?, mips? }` or absent | absent | The GPU. `device` and `queue` are the WebGPU objects; `presentTo(frame)` receives every finished frame. Absent, `available()` is false, `backend()` throws on first use, and every API still answers state questions. |
| `device.adapter` | `{ vendor?, architecture?, description? }` | absent | What `GetAdapterIdentifier` and `vkGetPhysicalDeviceProperties` describe. |
| `screen` | `{ width, height, bitsPerPixel }` | `{ 640, 480, 32 }` | The display a program is told about until `resolution` changes it. |
| `maxFps` | number | `60` | Frame-delivery cap for the pacer; `0` means whatever the scheduler offers. |
| `schedule`, `now` | `(tick) => void`, `() => number` | absent | A display-rate scheduler and a clock. Both present enables the pacer; a headless build delivers on a microtask. |
| `allocate` | `(bytes) => address` | absent | Guest memory for locked surfaces and buffers, and for the shadow state block. Without it a lock hands back an address this layer invented and every state setter stays a trap. |
| `free` | `(address) => void` | absent | Returns guest memory a texture or map is finished with, so a program that sizes its cache from free heap sees textures released. |
| `divergence` | `(api, detail) => void` | absent | Where "this call succeeded and did not do all of what it promises" is reported. See *Limitations*. |
| `cursor` | `(notice: CursorNotice) => void` | absent | Receives a Direct3D program's cursor bitmap (`width`, `height`, `hotSpot`, `bgra`, `shown`). Without it `SetCursorProperties` is refused with `D3DERR_INVALIDCALL`, which tells the program to draw its own. |
| `resolution` | `(width, height, where?) => void` | absent | Told the back-buffer size a device is created or reset at, and for Direct3D 8 which window it presents into; the reported screen follows it. |
| `publishInterface` | `(object, iid) => address` | `() => 0` | The bridge's vtable publisher. The default publishes nothing, so a build without a bridge gets tables that refuse rather than pointers into nowhere. |
| `exportAddress` | `(name) => address` | absent | The guest address of one of `OPENGL32.dll`'s own exports, which `wglGetProcAddress` needs to answer honestly for core names. |

The six `device.*` diagnostic knobs reach the Direct3D 8 renderer
(`src/layers/graphics/d3d8/render.js`) and are read only there:

| knob | default | effect |
|---|---|---|
| `dumpDraws` | `false` | Records where every draw of the last frame landed and under what state, transforming every vertex a second time on the processor. `diagnostics().seam.device.lastDump` holds the result. |
| `maxDraws` | `-1` (all) | Keeps only this many draws per frame and drops the rest, so a region's painter can be found by bisection. |
| `skipTexture` | `null` | Comma-separated dump ids; every draw sampling one of those textures is dropped and counted under `skipped.texture`. |
| `probeTexture` | `null` | Copies the colour target out after each dumped draw that samples this texture and puts a few of its pixels on the draw's dump line. |
| `fog` | `true` | `false` runs every draw as if `D3DRS_FOGENABLE` were clear. |
| `mips` | `true` | `false` samples every texture at its top level. |

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
| `opengl()` | The pixel-format negotiation (`size`, `count`, `choose`, `describe`) and `swapBuffers(hdc)` whose entry points `gdi32` exports; the assembling caller hands these down to `win32`. |

### Published libraries

Counted by instantiating `createGraphicsLibraries` (`src/layers/graphics/seam/exports.js`) and
reading each table:

| library | entry points | what they are |
|---|---|---|
| `OPENGL32.dll` | 444 | The whole of OpenGL 1.1, all of WGL, and every extension function this implementation answers. Every name is bound, implemented or not, because a stdcall stub that pops the wrong number of bytes loses the process far from the call. Unimplemented names answer zero and are counted. |
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
| `seam.device` | The most recent Direct3D 8 device's counters, or the Direct3D 9 one's: `frames`, `draws`, `clears`, `programmable`, `programs`, `skipped.*`, `cascade.*`, `failures`, `lighting.*`, `recording`, `recentFrames`, `lastFrame`, `lastDump`, `textureRecords`, `textures`, `redundantTransforms`. |
| `seam.vulkan` | `placed` traps, `objects` by kind, `unimplemented` by command name. |
| `shadow` | The Direct3D 8 guest-side state block: `placed`, `slowPath`, `renderStateCalls`, `transformCalls`, `bindingCalls`, `lockCalls`, `unlockCalls`, `buffers`, `synced`, `skipped`, `refused`. |
| `backend` | Profiler snapshot (`frames`, `counters`, `uploadsByLabel`, `recentFrames` with phases), `shaders` (`builds`, `errors`, `warnings`, `dropped`, `distinct`), `shaderMessages`, `pipelines` (`built`, `reused`, `resident`), `uniforms`, `buffers` per dynamic buffer (`renames`, `pooled`, `dirty`), `frameOpen`, `pendingTextureCopies`, `surfaceWrites`, `presents`. |
| `presenter` | `presents`, `uploads`, `bytes`, `shownByOwner`, `pending`, `claimed`, `failures`. |
| `pacing` | `requests`, `delivered`, `coalesced`, `idleTicks`, `heldTicks`, `waiting`, and interval statistics (`count`, `minMs`, `maxMs`, `meanMs`, `deviationMs`, `p50Ms`, `p95Ms`, `p99Ms`, `fps`, `periods`). Null in a build with no scheduler. |

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
  and each texture stage individually, with "no stages" distinct from "one default stage". Building
  is asynchronous because shader compilation is; two draws with the same state in one frame share
  the promise.
- **Bindings and uniforms** (`internal/bindings.js`). Bind-group layouts are explicit and shared
  per stage count; `createRenderPipeline` refuses `layout: 'auto'` by name, because an automatic
  layout drops a binding the generated shader did not use and every textured draw then silently
  disappears. Uniform blocks come out of one ring buffer bound at a dynamic offset, so a bind group
  names a texture, a sampler and the ring and nothing that changes per draw; the group cache is
  keyed on those identities and lives as long as the backend.
- **Dynamic buffers** (`internal/buffers.js`). A lock's flags are a promise: `DISCARD` renames the
  backing and only bytes written since travel; `NOOVERWRITE` renames nothing and sends the newly
  written ranges; neither flag renames (a write into a buffer this frame's draws already read is a
  hazard) and resends the whole buffer, because the old contents stay observable. Uploaded ranges
  align outward to four bytes and are sent from their own offset. A retired backing returns to the
  pool only after the frames that read it have been presented (`markPresent`).
- **Textures** (`internal/textures.js`). Block-compressed formats (`bc1`, `bc2`, `bc3`) always go
  through a staging buffer plus a buffer-to-texture copy with rows repacked to the copy alignment;
  a direct `writeTexture` is used for uncompressed formats and either path can be forced. Row
  geometry is counted in blocks, never pixels. A copy issued between frames waits for the next
  encoder rather than opening a second one.
- **Viewport** (`internal/viewport.js`). Setting a viewport does two things that travel as one
  value: the hardware rectangle and scissor, and the vertex stage's inverse offset and scale, which
  is what puts a pre-transformed vertex on the pixel it names.
- **Shaders** (`internal/shaders.js`). Every built module is asked for its compilation info; an
  error-severity message fails the build, and messages are kept in a de-duplicating ring.
- **Fixed function** (`internal/fixedfunction.js`) generates WGSL per state combination: the
  vertex path transforms or, for XYZRHW, applies only the viewport constants; a `D3DCOLOR` vertex
  colour is swizzled from the B,G,R,A byte order; the texture-stage cascade emits one block per
  enabled stage (`SELECTARG1/2`, `MODULATE`, `MODULATE2X/4X`, `ADD`, `ADDSIGNED`, `SUBTRACT`, with
  `COMPLEMENT` and `ALPHAREPLICATE` modifiers, arguments from `DIFFUSE`, `CURRENT`, `TEXTURE`,
  `TFACTOR`, `SPECULAR`) and nothing at all for an empty list; a two-coordinate texture transform is
  applied per stage; per-vertex lighting is unrolled per enabled light (point, spot, directional,
  with range, attenuation and cone in uniforms), the material sources honour `D3DRS_COLORVERTEX`,
  the specular sum is added after the cascade, and alpha comes from the diffuse source alone; fog
  (`LINEAR`, `EXP`, `EXP2`) is a per-vertex factor from eye depth, or the specular alpha for
  pre-transformed vertices; the alpha test `discard`s. Texture-coordinate generation (`D3DTSS_TCI_*`)
  and three- or four-coordinate or projected texture transforms are not computed (see
  *Limitations*).
- **Programmable** (`internal/programmable.js`) builds a pipeline from a translated vertex and
  pixel shader pair, a vertex layout taken from a declaration (`D3DDECLTYPE` to WebGPU format; the
  packed ten-bit types have no counterpart and refuse the declaration), the stream's stride rather
  than the declaration's, and the fixed bind groups the translation promises.
- **Presenter and pacer** (`internal/presenter.js`, `internal/pacer.js`). A DirectDraw or GDI
  program draws into guest memory; the presenter keeps one `bgra8unorm` texture the size of the
  primary, converts 8-, 16- and 32-bit surfaces into it, coalesces a burst of blits onto one
  upload and presents inside a backend frame. A surface a GPU drew has no bytes worth reading, so a
  Direct3D 7 device claims its target's address and the presenter shows the texture instead. The
  pacer remembers the newest request, arms one scheduler tick, delivers at most once per
  `1000 / maxFps` ms, and never makes the caller wait.
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
`SetIndices`, `SetVertexShader`, `Lock` and `Unlock` are placed as x86 code that writes a block of
guest memory the device owns and returns without trapping; on every entry into the host the block
is compared whole against the host's copy and each difference goes through the real setter, where
validation lives. The block is one-way and untrusted; a value the device would refuse is refused at
the next entry and reported once as a divergence. The block counts the calls it absorbed.

Per API:

- **`ddraw.js`** publishes four generations of `IDirectDraw` and five of `IDirectDrawSurface`,
  plus the clipper and palette, with the interface version threaded through every method: a
  `CreateSurface` through the second generation takes no reference on the object, a `Lock` through
  the fourth reads the longer descriptor. Reference counts are per generation, as the API does it.
  The three enumerations call into guest code through the bridge and answer with a promise; without
  `callGuest` they succeed having named nothing. `GetDC` is answered by `win32.gdi().createSurfaceDc`
  over the surface's own bytes. Display modes: 640x480, 800x600, 1024x768, 1280x1024 at 8, 16 and
  32 bits, plus the configured screen size if it is not in the list.
- **`d3d7.js`** publishes no root; it hands the DirectDraw seam the `IDirect3D7` descriptor to put
  beside its own, and keeps one Direct3D 7 object per DirectDraw object. A draw takes its vertex
  format as an argument and its indices by pointer.
- **`d3d8.js`** publishes `IDirect3D8`, `IDirect3DDevice8`, surfaces, textures, vertex and index
  buffers. Modes are offered in `D3DFMT_X8R8G8B8` only. Present parameters use Direct3D 8's own
  layout, which differs from 9's.
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
owns whom, when it dies. Generations do not share a reference count; `IDirectDrawX` and
`IDirect3DX` do; a palette is owned by the surface it is set on; a flip chain is a forward link
per surface with no closing link. `caps.js` is two tables over a parsed descriptor: which surface
descriptions are accepted (a flip chain is a three-part request, checked before exclusive mode)
and which surfaces can back a 3D device. `blit.js` reads the whole source rectangle before writing
a destination pixel, so overlapping and stretched blits are right; stretching floors, the same rule
GDI uses; a blit between depths is refused.

**Direct3D 7** (`src/layers/graphics/d3d7/`). Keeps its state in the shape the shared renderer
reads. A render target is a DirectDraw surface by address, so a flip presents the texture that was
drawn without copying; a texture is a DirectDraw surface too, and its uniqueness value is how the
GPU copy is known to be stale. Three devices are enumerated (RGB, HAL, T&L HAL) over one renderer;
`caps.js` claims only what the shader generator implements.

**Direct3D 8** (`src/layers/graphics/d3d8/`). `device.js` models what a program observes between
draws and decides whether a call is legal; `render.js` is what happens underneath when there is a
backend. Draws are recorded, not encoded: a pipeline compiles asynchronously and a guest call
returns synchronously, so the frame is a command list replayed onto one backend frame once every
pipeline exists, and each recorded draw captures the buffer generation it was issued against.
Guest memory is the boundary -- bytes are read back at unlock under the lock's flags and nowhere
else. Every texture format is expanded to `bgra8unorm` on upload in integer arithmetic, except
`DXT1`-`DXT5`, which are uploaded as `bc1`-`bc3` blocks when the adapter has
`texture-compression-bc`. The renderer serves Direct3D 7 and 9 too: one fixed-function pipeline
with one set of numbers.

**Direct3D 9** (`src/layers/graphics/d3d9/`). The device advertises vertex and pixel shader model
2.0 -- the version the translator builds a pipeline from whole -- and refuses a create for a higher
version. `shader.js` parses the bytecode (operand counts from a table before model 2, relative
addressing tokens from model 2 on, literal definitions read as raw dwords) and holds the constant
files; `wgsl.js` translates one instruction at a time into a literal WGSL body: inputs by location
typed as the declaration lays them, varyings at fixed locations per usage so the two stages agree,
constants in three uniform arrays per stage, samplers as texture and sampler pairs. `stateblock.js`
records what is set between `BeginStateBlock` and `EndStateBlock` -- and in this version a state set
while recording goes into the block, not the device. `declaration.js` converts between vertex
declarations and FVF codes; a fixed-function draw through a declaration is drawn when it describes
an FVF and reported once when it does not.

**Direct3D 10 and DXGI** (`src/layers/graphics/d3d10/`). `dxbc.js` opens the container (`ISGN`,
`OSGN`, `SHDR`; older token streams answer `E_INVALIDARG`); `sm4.js` decodes the token stream with
untyped operands; `wgsl.js` keeps the register model literally -- every register a `vec4<u32>` of
bit patterns, each instruction reinterpreting -- and links a vertex and pixel shader by semantic
name when a pair is bound, writing the `@location` interface then. An instruction with no
translation makes the whole shader untranslatable and the draw is refused by name. `states.js`
normalises the four immutable state descriptions before creating them, so identical descriptions
are one object; `resources.js` separates resources from views (a view takes a reference on the
device, none on the resource); `validity.js` is the usage-by-bind-flag table; `dxgi.js` is the
ownership graph (a swap chain's parent is the factory; `ResizeBuffers` fails while a back buffer is
held and leaves the description untouched). `render.js` keeps a host copy of every resource's bytes
and replays a record onto one backend frame at present.

**OpenGL** (`src/layers/graphics/opengl/`). Reports `GL_VERSION` 1.1, vendor `Bottlify Project`,
renderer `Bottlify OpenGL`, 22 GL extensions and 4 WGL extensions (`extensions.js`; a name in the
string is a promise that every function it defines is obtainable, and the test checks the list,
the context and the marshalling agree). It draws on the processor: `pipeline.js` runs the
fixed-function stages in the specification's order (per-vertex lighting, fog, texture generation
and matrix; near, far and user-plane clipping in clip space; division and viewport; assembly with
culling and polygon mode; rasterisation with texture environment, colour sum, fog and alpha test),
`raster.js` owns the fill rule (pixel centres, top-left tie-break, perspective-correct
interpolation) and the framebuffer operations, `texture.js` keeps every image as RGBA and honours
the pixel-store state. `wgl.js` is the seam with GDI, every rule of it measured: a pixel format
belongs to the drawable, can be set once, a DC without one cannot make a context, a context is
current on one thread, `wglGetProcAddress` returns null for core names. `SwapBuffers` hands the
frame to the presenter through guest scratch memory, so this is the one API a headless build can
run to a finished frame.

**Vulkan** (`src/layers/graphics/vulkan/`). One physical device, described from what WebGPU
guarantees of every adapter (`physical.js`). Instances, devices, queues, surfaces and swapchains
are made; command buffers record into a host list, `vkQueueSubmit` replays each into the open
backend frame (a render pass becomes a backend pass, a clear its load operation), `vkQueuePresentKHR`
ends the frame; fences and semaphores signal at submit. `spirv.js` decodes a module's header,
capabilities and entry points and refuses `Geometry` and `Tessellation` by name. There is no
SPIR-V-to-WGSL translation in the tree: `vkCreateGraphicsPipelines` and every `vkCmdDraw*` are
among the 84 unimplemented commands, so a Vulkan program can clear and present but not draw.

**GDI drawing** (`src/layers/graphics/gdi/`). The pixel half of gdi32, over the bookkeeping half in
`win32`: a surface is 32-bit BGRX (`0x00RRGGBB` little-endian) and nothing else; DIB rows pad to
four bytes and device bitmaps to two; raster operations are decoded from the ROP3 truth table
rather than enumerated; filling is Windows' half-open convention; clipping is one rectangle;
`BitBlt` shifts the source with the clip and uses memmove order on overlap, `StretchBlt` copies
first; text draws a solid block per cell at the correct alignment and advance because there is no
font engine. `createGdiDrawing` (`gdi/context.js`) is the entry; no assembly in the tree passes it
to `win32`'s `graphics.createDrawing` slot (`src/app.js` hands `win32` only the pixel-format
service and `swapBuffers`), so through `createApp()` gdi32's pixel-moving entry points fail
truthfully rather than draw.

### Adapter and display

`GetAdapterIdentifier` (Direct3D 8 and 9) and `vkGetPhysicalDeviceProperties` describe
`config.device.adapter`. Modes come from `win32`'s display table; Direct3D 8 lists each in
`X8R8G8B8` only. A device created or reset at a size calls `config.resolution`, and `screen()` then
reports that size. Direct3D 8's `GetDeviceCaps` (`seam/d3d8.js`, `writeCaps`) claims a HAL
device with hardware transform and lighting, eight blend stages and simultaneous textures,
4096-texel textures, eight active lights, six user clip planes, every compare, blend, filter and
stencil bit, cube-map and projected texture caps, `TEXGEN`, and leaves both shader versions at
zero. Some of those claims exceed what the renderer does (cube textures are refused, coordinate
generation is not computed, clip planes are not applied), which is the opposite of the rule
`d3d7/caps.js` states for itself. Direct3D 9's `DEFAULT_CAPS` (`d3d9/device.js`) claims shader
model 2.0 for both stages, eight lights, no user clip planes, and no anisotropy.

### The divergence rule

A call is answered one of three ways, and which one is decided where the call lives:

- **Refused.** A create the renderer cannot honour answers a failure code and clears the caller's
  out-pointer, because a success it cannot see through leaves a program drawing nothing and looking
  elsewhere for the reason. Refusals are documented at the slot.
- **Accepted and reported.** A state the device stores but does not act on -- a texture
  transform of more than two coordinates, coordinate generation, a wireframe fill -- succeeds,
  because refusing `SetTransform` would change what the program does, and is reported once per
  distinct detail through `config.divergence` with the API name and a sentence saying what was not
  done. Every reporter de-duplicates.
- **Absent.** A slot with no implementation answers `E_NOTIMPL` from the right index.

### What has drawn a real title

Only Direct3D 8 has. This project's own CDP runs (`tools/cdp_test/game.mjs`, `npm run cdp:game`)
bring a real title up to its main menu on a real GPU, and `tools/cdp_test/triangle.mjs` runs a
committed Direct3D 8 fixture (`modules/core/test/fixtures/triangle.exe`) on a real GPU and checks
four named pixels byte for byte. DirectDraw, Direct3D 7, 9 and 10, OpenGL, Vulkan and the GDI
drawing half are verified by the tests below and by nothing else.

## Limitations and divergences

Refused (the program is told no):

- Direct3D 8: `CreateVertexShader` and `CreatePixelShader` are absent from the table on purpose,
  so a program takes the fixed-function path the renderer draws; `CreateCubeTexture`,
  `CreateVolumeTexture` and `CreateAdditionalSwapChain` answer `D3DERR_NOTAVAILABLE`; the four
  palette calls, `ProcessVertices` and `GetFrontBuffer` answer `D3DERR_INVALIDCALL`;
  `SetCursorProperties` answers `D3DERR_INVALIDCALL` unless a `cursor` receiver is configured;
  `GetInfo` answers `S_FALSE`. A texture in a format the device does not offer is refused and
  reported once per format.
- Direct3D 9: `CreateCubeTexture`, `CreateVolumeTexture`, `CreateAdditionalSwapChain` answer
  `D3DERR_NOTAVAILABLE`; a shader above model 2.0 is refused at create; `maxUserClipPlanes` is
  zero. `GetNPatchMode` returns a float in `ST(0)`, which the bridge cannot set, and is reported.
- Direct3D 10: a shader using an untranslated instruction is refused by name; a geometry shader
  with stream output is refused; `CreateDXGIFactory1` refuses.
- Vulkan: 84 of 149 commands, including every draw and pipeline creation; a SPIR-V module
  declaring `Geometry` or `Tessellation`; secondary command buffers; an instance whose
  `apiVersion` is out of range; features the device lacks.
- DirectDraw: a blit between different pixel depths; a descriptor whose `dwSize` is not exactly the
  layout's own.
- GDI: 4- and 1-bit DIBs.

Accepted and reported through `divergence`:

- Direct3D 8 (shared renderer): texture coordinate generation (`D3DTSS_TCI_*`) -- the set in the
  low bits is sampled as the vertex carries it; a texture transform of three or four coordinates
  or a projected one; a texture-stage cascade cut short because a stage reads `TEXTURE` with
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
- OpenGL: selection and feedback modes record nothing; the stencil test is enabled with no stencil
  buffer; two-sided lighting lights back faces as front; `glDrawPixels`, `glBitmap` and
  `glCopyPixels` of depth or stencil are accepted and draw nothing; the accumulation buffer is
  empty; a `glTexImage2D` format or type outside the supported set is accepted and uploads nothing;
  `glReadPixels` with an unsupported type and `glGetCompressedTexImage` are refused; a vertex-array
  or index draw with no way to read guest memory draws nothing. Every unimplemented entry point is
  counted by name.

Counted rather than reported (`seam.device.skipped`): Direct3D 8 draws skipped for `vertexShader`,
`pixelShader`, `stride` (the stream's stride disagrees with the FVF), `indexFormat`, `stencilRect`
(a stencil-only clear of part of the target), `texture` (the `skipTexture` knob) and `program`;
Direct3D 10 draws skipped for `noViewport`, `noTarget`, `noShader`, `untranslatable` and
`pipeline`.

Known ceilings the code names: the OpenGL rasteriser's depth buffer is a float per pixel and a
mipmapped minification filter samples the base level; Direct3D 7's capability lists claim no
stencil, bump mapping, cube maps or W-buffer; Direct3D 8 fog is per vertex, an approximation of
`D3DRS_FOGTABLEMODE`; the D3D 9 translator does not translate 1.x texture-addressing instructions,
predication, subroutines or vertex-shader texture reads.

## Tests

1,098 `test()` cases across the layer's `*.test.js` files, all run by `npm test` from
`modules/core` (`node --test "src/**/*.test.js"`); one integration file runs under
`npm run test:integration`. By kind:

| kind | files |
|---|---|
| Layer assembly | `graphics.test.js` -- a build with no GPU comes up; the backend is built once; APIs are made by name; diagnostics report what was asked for; the pacer honours `maxFps`. |
| Byte-exact against the reference rasteriser or a stored image (base64 of the raw BGRX buffer beside the code, no tolerance) | `webgpu/internal/reference.test.js`, `d3d8/render.test.js`, `d3d9/render.test.js`, `d3d9/program.test.js`, `opengl/raster.test.js`, `opengl/pipeline.test.js`, `gdi/*.test.js`, `ddraw/blit.test.js`. A triangle is asserted at named pixels rather than as a whole image, so no rasterisation rule is pinned. |
| Recorded commands through the fake device (what the GPU was asked to do, never what a frame looks like) | `webgpu/backend.test.js`, `webgpu/internal/*.test.js`, `d3d7/device.test.js`, `d3d8/render.test.js`, `d3d10/render.test.js`. |
| Contract, against documented behaviour and conformance expectations of the real runtime | `d3d9/contract.test.js`, `d3d9/validity.test.js`, `d3d8/validity.test.js`, `d3d10/validity.test.js`, `d3d10/device.test.js`, `d3d10/dxgi.test.js`, `d3d10/structs.test.js`, `ddraw/objects.test.js`, `ddraw/caps.test.js`, `ddraw/structs.test.js`, `opengl/wgl.test.js`, `opengl/pixelformat.test.js`, `opengl/context.test.js`, `vulkan/*.test.js`, `d3d7/caps.test.js`, `d3d9/caps.test.js`. |
| Observed behaviour, pinned | `d3d9/observed.test.js` -- lock-flag traffic, matrix order, render-target alpha, viewport placement. |
| Translators | `d3d9/shader.test.js`, `d3d9/wgsl.test.js`, `d3d10/dxbc.test.js`, `d3d10/sm4.test.js`, `d3d10/wgsl.test.js`, `vulkan/spirv.test.js`. |
| Seam and ABI | `seam/*.test.js` drive the bridge's real vtable publisher over a flat buffer and read the same words a guest would; `seam/shadow.test.js` pins the guest-side code's bytes and layout; `seam/shadow.itest.js` runs that code on the real emulated processor. |

Real-GPU acceptance lives outside the unit suite in `tools/cdp_test/`: `triangle.mjs` (a
Direct3D 8 fixture, four named pixels) and `game.mjs` (a title's bring-up), both driving a headless
or headed Chromium over CDP. Only the browser probe runs in CI.
