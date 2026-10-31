# OpenGL 2.0 to 4.x

Status 2026-10-31: 2.1 and framebuffer objects in code; 3.x and 4.x a plan, no code.

## Done: OpenGL 2.1

`glGetString(GL_VERSION)` answers 2.1, `GL_SHADING_LANGUAGE_VERSION` 1.20. Every entry point of
1.2 to 2.1 is exported and reachable through `wglGetProcAddress`, ARB and EXT names beside the
core ones. Added to the extension string: `GL_ARB_framebuffer_object`, `GL_EXT_framebuffer_object`,
`_blit`, `_multisample`, `GL_EXT_blend_color`, `_minmax`, `_subtract`, `_func_separate`,
`GL_ARB_texture_non_power_of_two`. The handle-based `GL_ARB_shader_objects` family is not
advertised: GLSL is reached through the 2.0 names.

- **GLSL 1.10 and 1.20 to WGSL** (`graphics/opengl/glsl-*.js`): preprocessor, parser, checker
  with the specification's diagnostics, linker (varyings, attribute and uniform locations, the
  samplers), and an emitter that writes one WGSL module per stage. The built-in state
  (`gl_ModelViewMatrix`, lights, fog, texture matrices) is packed from the context's state into the
  same uniform block as the program's own uniforms. A program draws with either stage from the
  fixed pipeline.
- **Framebuffer objects**: texture and renderbuffer attachments, four colour attachments,
  `glDrawBuffers`, `glBlitFramebuffer`, `glGenerateMipmap`. A framebuffer is drawn upside down so
  that its texture reads the way GL lays it out.
- **The ring**: `glUseProgram`, `glUniform*` (the vector forms of one, two and four elements, the
  2x2, 4x4, 2x4 and 4x2 matrices), the program's attribute arrays, `glBindFramebuffer`, separate
  blending and stencil go into the command ring under their core names, in 32-bit processes;
  `gl-ring-contract.itest.js` checks each one against the host path.
- 32- and 64-bit processes: pointer arrays (`glShaderSource`) are read at the process's width.

Where 2.1 diverges (`decisions.md` A68 to A71): generic attribute 0 and the conventional
arrays alias as in `ARB_vertex_program`; an info log line reads `ERROR: <string>:<line>: ...`;
a framebuffer with attachments of different sizes, separate depth and stencil images or a depth
texture answers `GL_FRAMEBUFFER_UNSUPPORTED`; `GL_MAX_SAMPLES` is 4 and a multisampled
renderbuffer is drawn single-sampled; a blit copies colour alone; an occlusion query answers the
viewport's area; a 3D texture is accepted up to 16 texels a side and kept nowhere, and a
program that samples one does not link.

## Next

- **3.x:** vertex array and uniform buffer objects; the core profile;
  `wglCreateContextAttribsARB`; GLSL 1.30 to 1.50 (`in`/`out`, integer attributes, `texture()`).
- **4.x:** WebGPU has no geometry or tessellation shaders; they will have to be emulated in compute.
