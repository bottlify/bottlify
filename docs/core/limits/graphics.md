# Limits: graphics

- A picture needs WebGPU. A canvas that gives no WebGPU context fails the start (`reason: 'gpu'`).
- While windows of more than one process are showing, the run's top-level windows compose the
  screen from each process's newest picture, the topmost last; the canvas takes the size of the
  foreground window's process's picture. A process's picture is what it presented last, whole: a
  windowed Direct3D device's back buffer is placed at the screen's corner rather than in its
  window, and the windows of a process that has presented nothing show what is under them. A
  DXGI swap chain's window that is full screen, or windowed with its client area over the whole
  screen and no window over it, keeps the swap chain's frames on the screen when GDI paints the
  desktop; a smaller windowed swap chain's frames are replaced by the desktop at each paint.
- No Direct3D 12. Direct3D 11 makes devices at feature levels 11.0, 10.1 and 10.0; a program
  that asks only for 11.1 or the 9.x levels is refused. Its deferred contexts record calls that
  the immediate context plays (`DriverCommandLists` is false). A context state
  (`CreateDeviceContextState`) swaps the whole pipeline; one made for Direct3D 10 makes Direct3D
  11's calls on the context do nothing. Compute shaders run as WebGPU compute passes; a view a
  shader writes through over a texture of a format WebGPU stores into (32-bit channels, four 16-
  or 8-bit ones) is a storage texture, and reads back only those of one 32-bit channel. A view of
  a packed format WebGPU does not store into (11-11-10 and 10-10-10-2, the 16- and 8-bit formats
  of one and two channels) is written as its texture's bytes in a buffer, copied there before the
  pass and back after it: slower, and a texel narrower than four bytes is set by two atomics. An indirect draw whose
  arguments a shader wrote draws nothing if its first instance is not zero, unless the device
  has `indirect-first-instance`. A constant
  buffer offset (`*SetConstantBuffers1`) is ignored and the whole buffer bound
  (`ConstantBufferOffsetting` is false); a logic operation in a blend state and a forced sample
  count in a rasterizer state are refused; `ClearView` of rectangles is not made. A texture past
  the GPU device's own limits (texels a side, array layers: from 8192 and 256 on WebGPU, 16384
  and 2048 in Direct3D 11) is made and kept in memory but never drawn with or into, and said
  once as a loss.
- Vulkan draws on the engine thread; Direct3D 7, 8, 9, 10, 11 and OpenGL in the graphics worker.
- Direct3D 10's command ring, which Direct3D 11's immediate context shares, is i386 code: a
  64-bit process traps every device and context call. A deferred context's calls trap.
- Shader model 5's doubles are exact (rounded to nearest, denormals kept) but worked out in
  integers, so much slower than floats. A shader's interfaces are translated for the class
  instances bound with it, but none can be made yet: `CreateClassInstance` answers `E_NOTIMPL`.
  Direct3D 11.1's `msad` (masked sum of absolute differences) is not translated: a shader with it
  is not drawn, and said.
- `D3DX10CompileFromMemory` and `D3DX11CompileFromMemory` (and `...FromFile`) compile through
  the program's own `d3dcompiler_43.dll`; without one they answer `E_FAIL` with an error blob
  saying so. A program that ships its shaders compiled asks only for what its cache lacks.
  `D3DX10SaveTextureToFile`, `D3DX11SaveTextureToFile`, `D3DX11SaveTextureToMemory` and
  `D3DX11LoadTextureFromTexture` answer `E_NOTIMPL`.
- D3DX 10 and 11 read DDS (classic and DX10), BMP, PNG, JPEG, GIF and TIFF (strips, plain,
  LZW or PackBits); a JPEG XR file is refused with `E_FAIL`, as some Windows installs refuse it.
  BC6H and BC7 files are loaded as they are: a size or format asked of them that their file does
  not hold is refused. Filtered sizes and re-made blocks can differ from Windows' in the last bit
  (decision A236). `D3DX10CreateThreadPump` and `D3DX11CreateThreadPump` make one IO thread and
  two processing threads when the program leaves the counts to D3DX.
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
  indexed and indirect, after the tessellator too. An indirect draw through a geometry shader
  is sized by the most its count may be - the capacity of the append or counter view whose count
  `CopyStructureCount` copied there, else 16384 primitives an instance, said once - and the
  shader runs for the count and instances the GPU holds; the arguments' first vertex and first
  instance are as the program last wrote them. A draw whose passes would take more than 128 MB
  in one buffer between them is drawn in pieces that fit, one after the other: its instances
  apart, and a list's primitives in runs (primitive ids numbered on). Not drawn, and said:
  `DrawAuto` and an indirect draw of patches through a geometry shader, a triangle strip with
  adjacency through one, and a strip, an indirect draw or a draw after the tessellator past
  those 128 MB.
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
- On a GPU without WebGPU's `texture-formats-tier1`, Direct3D 10 and 11 keep the 16-bit normalised
  textures (R16_UNORM to R16G16B16A16_SNORM) in 32-bit floats of their channels, which hold every
  code exactly: they are sampled, drawn into and read back as the program's codes, but what a draw
  or a shader writes into one is held to its range and rounded to sixteen bits only when it is read
  back, and they are filtered and blended only where the GPU filters and blends 32-bit floats.
  Such a GPU draws into no 8-bit snorm texture, and without `rg11b10ufloat-renderable` into no
  R11G11B10_FLOAT one, though feature level 10.0 asks for them: `CheckFormatSupport` says so, and
  a draw into such a target is lost alone.
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
- DirectWrite's system fonts are gdi32's outline faces, each a TrueType file made from the font
  engine's measurements with a glyph for each character (`roadmap/decisions.md` A239). Text
  formats and layouts (`CreateTextFormat`, `CreateTextLayout`, typography, trimming signs) and
  glyph outlines (`GetGlyphRunOutline`) answer `E_NOTIMPL`. Shaping makes a glyph a character, with
  no OpenType features; a face loaded from a file is measured but not drawn. A font a program adds
  from memory through gdi32 is no DirectWrite face, and only `IDWriteFactory` (no
  `IDWriteFactory1` and later) is there.
