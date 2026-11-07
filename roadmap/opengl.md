# OpenGL 2.0 to 4.6

Status 2026-11-07: OpenGL 4.6 in code, compatibility and core profiles.

## How it is built

- **The version is what is here.** The context reports the highest version whose every entry
  point exists, checked against Khronos' registry (`opengl/registry.js`); `glGetString`,
  `wglCreateContextAttribsARB` and `wglGetProcAddress` answer from it. Wine's `opengl32` tests
  pass in a browser.
- **GLSL 1.10 to 4.60** (`opengl/glsl-*.js`): our own preprocessor, parser, checker and linker,
  then one typed WGSL module per stage. A feature WGSL cannot express fails the program's link
  with its reason, never silently.
- **Geometry and tessellation shaders** run as compute passes before the draw, the passes
  Direct3D 11 uses: the vertex shader over the inputs, the geometry shader a primitive an
  invocation (instanced, `gl_ViewportIndex` and `gl_Layer` routed by repeating the draw for each
  viewport and layer), the fixed tessellator; what they make is drawn indirectly. Transform
  feedback is written from the same passes, the qualifiers of 4.40 included.
- **Compute, storage blocks, images and atomic counters** are WebGPU compute and storage.
- **SPIR-V shaders** (4.6) are written back as GLSL 4.60 and compiled as source is.
- **Doubles** are carried as 32-bit floats: WGSL has none.

## Left

The `Temporary` entries of [`decisions.md`](decisions.md) from A105 on that name OpenGL: limits
below 4.6's minimums (A181: 4 draw buffers, 32 varying components, WebGPU's compute limits),
doubles (A178), arrays of subroutine uniforms (A179), cull distances (A180), geometry streams
past 0 (A182), a geometry shader after tessellation and transform feedback of tessellated
output (A190, A191), draws of captures through further passes (A195, A196), pixel transfer
past 8-bit colour (A200), texture views in another format (A211 to A213).
