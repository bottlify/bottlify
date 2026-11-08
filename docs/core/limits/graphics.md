# Limits: graphics

- A picture needs WebGPU. A canvas that gives no WebGPU context fails the start (`reason: 'gpu'`).
- While windows of more than one process are showing, the run's top-level windows compose the
  screen from each process's newest picture, the topmost last; the canvas takes the size of the
  foreground window's process's picture. A process's picture is what it presented last, whole: a
  windowed Direct3D device's back buffer is placed at the screen's corner rather than in its
  window, and the windows of a process that has presented nothing show what is under them.
- No Direct3D 12. Direct3D 11 makes devices at feature levels 11.0, 10.1 and 10.0; a program
  that asks only for 11.1 or the 9.x levels is refused. Its deferred contexts record calls that
  the immediate context plays (`DriverCommandLists` is false). A context state
  (`CreateDeviceContextState`) swaps the whole pipeline; one made for Direct3D 10 makes Direct3D
  11's calls on the context do nothing. Compute shaders run as WebGPU compute passes; a view a
  shader writes through over a texture takes the formats WebGPU stores into (32-bit channels, four
  16- or 8-bit ones), and reads back only those of one 32-bit channel. An indirect draw whose
  arguments a shader wrote draws nothing if its first instance is not zero, unless the device
  has `indirect-first-instance`. A constant
  buffer offset (`*SetConstantBuffers1`) is ignored and the whole buffer bound
  (`ConstantBufferOffsetting` is false); a logic operation in a blend state and a forced sample
  count in a rasterizer state are refused; `ClearView` of rectangles is not made.
- Vulkan draws on the engine thread; Direct3D 7, 8, 9, 10, 11 and OpenGL in the graphics worker.
- Direct3D 10's command ring, which Direct3D 11's immediate context shares, is i386 code: a
  64-bit process traps every device and context call. A deferred context's calls trap.
- `D3DX10CompileFromMemory` has no shader model 4 compiler: it answers `E_FAIL` with an error
  blob saying so. A program that ships its shaders compiled asks only for what its cache lacks.
  `D3DX10SaveTextureToFile` answers `E_NOTIMPL`.
- OpenGL keeps a texture's data only where it draws, in the graphics worker, and lets a level's
  texels go once the device holds them (a compressed level keeps its blocks). `glGetTexImage`
  reads black, as `glReadPixels` on a device does, and says so as a divergence.
- OpenGL goes up to 4.6, compatibility and core profiles (`wglCreateContextAttribsARB`), with
  GLSL 1.10 to 4.60. A feature the shader translator does not write fails the program's link
  with its reason. Doubles are single precision; a geometry shader's streams past 0 are not
  captured (such a program does not link); arrays of subroutine uniforms are refused. Every
  target draws with one sample a pixel. A framebuffer whose attachments differ in size, has
  separate depth and stencil images, or a slice of a 3D texture is
  `GL_FRAMEBUFFER_UNSUPPORTED`; `glBlitFramebuffer` copies colour only. Some limits are below
  4.6's minimums: 8192 texels a side (2048 for 3D, 256 layers), 16 texture units, 4 draw
  buffers, 32 varying components, 4 image uniforms a stage, WebGPU's compute limits.
- OpenGL SPIR-V shaders (`glShaderBinary` with `GL_SHADER_BINARY_FORMAT_SPIR_V`,
  `glSpecializeShader`) are written back as GLSL and compiled as a source shader is, so they take
  what GLSL takes here and no more. Refused at specialization, with the reason in the shader's log:
  64-bit integers, 16- and 8-bit types, any SPIR-V extension (`GL_NUM_SPIR_V_EXTENSIONS` is zero),
  a read of an image without a format, a minimum level of detail, and outputs captured by the
  shader's own `Xfb` decorations. `GL_ARB_gl_spirv` is not in the extension string;
  `glSpecializeShaderARB` is obtainable. Name queries answer the names the GLSL was written with
  (`_a0` for the attribute at location 0, `_U1` for the uniform block at binding 1, and so on).
- Direct3D 11 tessellation runs as compute passes before the draw: the vertex shader over the
  control points, the hull shader a patch an invocation, the fixed-function tessellator (Microsoft's
  reference, bit for bit), and the domain shader as the vertex stage of an indirect draw. An
  indirect draw through the tessellator reads its arguments on the GPU, in a pass before the
  others; its buffers are sized for a room in patches (1 K, grown up to 64 K after the first frame
  that asks for more). Patches past the room the buffers have (grown, up to 8 M points and 16 M
  indices, after the first frame that needs more) are not drawn and said.
- Direct3D 10 and 11 geometry shaders and stream output run as compute passes before the draw:
  the vertex shader over the draw's vertices, the geometry shader a primitive and instance an
  invocation, the strips it builds made lists, stream output into the bound buffers (whole
  primitives, stopping at the first that does not fit; each buffer's filled size kept on the GPU
  for the next draw, `DrawAuto` and the stream-output queries), and the rasterized stream drawn
  indexed and indirect, after the tessellator too. Not drawn, and said: an indirect draw or
  `DrawAuto` through a geometry shader (their counts are on the GPU, and the passes are sized by
  them), a triangle strip with adjacency through one, and a draw whose output could pass 128 MB
  between the passes.
- HLSL compiled at run time (`D3DCompile` of D3DCompiler_43 and D3DCOMPILER_47,
  `D3D10CompileShader`): vertex and pixel shaders of models 4.0, 4.1 and 5.0, and the model 2
  and 3 profiles as `D3DXCompileShader` compiles them. Geometry, hull, domain and compute
  shaders, unordered access views, interfaces and classes are refused with fxc's X3506 or the
  error of the construct. The standard file include (`D3D_COMPILE_STANDARD_FILE_INCLUDE`) reads
  no files: an `#include` through it is a file not found. `D3DDisassemble` answers `E_NOTIMPL`.
- Direct3D 10 effects compiled at run time (`D3D10CompileEffectFromMemory`, `D3DCompile` with
  fx_4_0 or fx_4_1): constant buffers, numeric, texture, sampler, string and shader variables,
  state blocks, annotations, techniques and passes. Refused with a message: a state or index
  computed when the effect runs (fxc writes the effect's expression code for those, this compiler
  does not), a numeric variable with another count of values than its state takes, a geometry
  shader and stream output, `shared` variables of an effect pool, and fx_5_0. Object variables
  carry no register (`register(t0)` on an effect's texture is not kept), as fxc's own blobs in
  Wine's tests carry none.
- Direct3D 10 multisamples at four samples only, the count WebGPU has:
  `CheckMultisampleQualityLevels` answers one quality level at four for the colour and depth
  formats WebGPU multisamples, and none at two, eight or any other count. A multisampled texture
  array is refused. A resolve, and the present of a multisampled swap chain, average the four
  samples equally.
- On a GPU without WebGPU's `texture-formats-tier1`, Direct3D 10 and 11 have no 16-bit normalised
  texture (R16_UNORM to R16G16B16A16_SNORM) and draw into no snorm one, and without
  `rg11b10ufloat-renderable` into no R11G11B10_FLOAT one, though feature level 10.0 asks for
  them: `CheckFormatSupport` says so, and a draw into such a target is lost alone.
- A DXGI swap chain goes fullscreen as a Direct3D 9 device does: the reported display takes its
  mode and its window covers the whole of it. Going windowed again gives the display its mode back
  but leaves the window where fullscreen put it, and `ResizeTarget` on a windowed swap chain does
  not resize the window.
- A lost GPU device is not recovered: `Present` and `Reset` answer `D3DERR_DEVICELOST`
  (`D3DERR_DEVICEREMOVED` on 9Ex) and no new frames arrive.
- DXT textures are decoded on the CPU unless `graphics.compressedTextures` is on and the GPU has
  `texture-compression-bc`.
- Shaders and pipelines are cached in memory only; every run builds them again.
- Direct3D 9 claims vertex and pixel shader model 3.0. A draw from a stream whose offset, past
  its whole vertices, is not a multiple of four bytes is refused (WebGPU binds a vertex buffer
  only at such offsets). What WebGPU lacks, the shader makes up, at a cost only to the draws that
  ask:
  - six user clip planes (Direct3D 8 and 9), clipped by the GPU where the device has WebGPU's
    `clip-distances` and otherwise by a discard in the fragment stage; vertices already in
    screen space are not clipped by them;
  - a mip level-of-detail bias (`D3DSAMP_MIPMAPLODBIAS`, Direct3D 8's `D3DTSS_MIPMAPLODBIAS`),
    held to ±16;
  - the border and mirror-once address modes, over a clamping sampler: the border colour is
    selected where the coordinate lies outside [0, 1], so a filtered read does not blend the
    edge texels into it over the last half texel, and a cube map's faces take neither.
- Direct3D 9's 32-bit float formats are kept as half floats, and A16B16G16R16/G16R16 as half
  floats of their value.
- The engine's own `d3dx9` reads BMP, DDS, TGA, PNG and JPEG images; `D3DXCreateTeapot`,
  `D3DXCreateTextA`, `D3DXSimplifyMesh`, `D3DXUVAtlasPartition` and `D3DXComputeNormalMap` answer
  `E_NOTIMPL`.
- No DirectX redistributables ship with the engine: a program brings `d3dx9_*`, XAudio2 and the
  rest itself (through its installer's DirectX setup, or as DLLs beside its exe); without them the
  engine's own `d3dx9` table answers.
- `maxFps` is the display rate a program's vertical sync keeps to; the presenter is given no
  scheduler of its own, so a program presenting without vertical sync reaches the canvas as fast
  as it presents.
