# The HLSL compiler of d3dx9

`D3DXCompileShader` compiles HLSL source for a program that builds its shaders
at run time: the source, an entry point and a profile in; that entry point's
bytecode, its constant table and the compiler's messages out.

## Pipeline

| Step | File | What it does |
| --- | --- | --- |
| Preprocess | `preprocess.js` | `#define`, `#if`, `#include` (through the program's `ID3DXInclude`); keeps where each line came from. |
| Parse | `hlsl-lexer.js`, `hlsl-parser.js` | The Direct3D 9 dialect to a tree. Effect syntax (`technique`, `pass`, `sampler_state`, `compile`) is parsed and read past. |
| Check | `hlsl-types.js`, `hlsl-intrinsics.js`, `hlsl-check.js` | Types, overloads, conversions made explicit, fxc's error codes and texts. |
| Lower | `hlsl-lower.js`, `hlsl-lower-intrinsics.js`, `hlsl-build.js` | The entry point, run symbolically, to straight-line code over virtual registers. |
| Back end | `hlsl-backend.js`, `hlsl-encode.js`, `hlsl-ctab.js` | Registers, literals, peepholes, limits, tokens, the CTAB comment. |
| Driver | `hlsl-compile.js` | The whole pipeline; `functions.js` is the export. |

`hlsl-eval.js` interprets the checked tree: it is the reference the differential
gate holds the compiled code to.

## What the lowering does

The output has no control flow. The entry point is run with every value a handle
on an operand:

- functions are inlined; `out` and `inout` copy back;
- loops are unrolled, so their tests have to be known at compile time (at most
  1024 iterations); `break` and `continue` need a known condition;
- `if` runs both arms on forks of the variables and joins them with a select
  (`cmp` where the target has it, a product and a multiply-add where not);
- a `return` inside a branch moves the rest of the function into the other arm;
- `discard` and `clip` become `texkill`, conditioned on the path;
- a uniform array indexed by a value that is not known is read through the
  address register (vertex shaders);
- literals are folded; an identical instruction is built once.

Uniforms take registers in the order they were declared, a `register(cN)` first;
`bool` and `int` live in float registers too, as the register sets of ps_2_0 and
vs_1_1 have no others. Matrices are packed by column unless
the `row_major` modifier, `#pragma pack_matrix(row_major)` or
`D3DXSHADER_PACKMATRIX_ROWMAJOR` says otherwise. Only the constants a shader
reads are in its table.

## Targets

vs_1_1, vs_2_0, vs_2_a (vs_2_x), vs_3_0, ps_1_1 to ps_1_4 (with their own limits: two
temporaries, a few texture reads, constants in [-1, 1]; `hlsl-backend-legacy.js`), ps_2_0,
ps_2_a, ps_2_b, ps_3_0. A program that does not fit its target is refused with fxc's
numbers: arithmetic and texture slots, temporaries, constants.

## What is checked, and how

- `hlsl-parser.test.js`, `hlsl-check.test.js`, `hlsl-eval.test.js`,
  `hlsl-intrinsics.test.js`: the front end against hand-computed values.
- `d3d9-machine.test.js`: the reference machine (`d3d9-machine.fixture.js`), an
  independent decoder, assembler and interpreter of shader bytecode that throws
  on a temporary component read before it is written.
- `hlsl-build.test.js`: each operation, on six targets, through the machine.
- `hlsl-gate.test.js`: about eighty shaders through the gate
  (`hlsl-gate.fixture.js`). The tree interpreter and the machine get the same
  inputs, uniforms (laid out through the constant table the compiler wrote, by the
  routine D3DX's setters use), texture stand-in and derivative stand-in, and every
  component is compared in units in the last place. The bytecode-to-WGSL
  translator also takes each compiled shader.
- `hlsl-fuzz.test.js`: random shaders through the same gate, a family that must
  agree bit for bit and one with a tolerance. `HLSL_FUZZ=12 npm test ...` makes
  twelve times as many.
- `compileshader.test.js`: the export, with a guest that has a heap, COM objects
  and an include.

## Limits

- A loop whose bound is not known when the shader is compiled (a `uniform int`
  count) is not compiled: the target's `loop` and `rep` are not generated.
  fxc compiles these for the targets that have flow control.
- `switch`, `noise`, `isnan`/`isinf`/`isfinite`, `frexp`/`ldexp`, texture
  methods (`tex.Sample`) are not compiled. Bitwise operators on integers are not
  compiled (they do not exist before Shader Model 4).
- A vertex texture read is compiled to `texldl`; the bytecode translator to WGSL
  does not take it yet.
- Instruction counts are higher than fxc's: there is no common-subexpression
  search beyond identical instructions, no scheduling, and an integer cast is the
  full sequence. The slot weights used for the limits of ps_2_0 are approximate.
- Where the Direct3D 9 compilers differ from the Shader Model 4 ones, this one does as they
  do: a global that is not `const` may be written (the shader has its own copy); a vector
  condition of `?:` chooses per component; the variable of a `for` head belongs to the block
  around the loop; `mul` cuts the longer side of a product; `faceforward` is `n` only for a
  negative dot product.
- Errors: the codes and texts that are certain are listed in `hlsl-check.js`'s
  tests; the rest are best-known. The location of an error in a source passed in
  memory is printed as `memory(line,col)`.

## Assembly

`D3DXAssembleShader` and `D3DXDisassembleShader` are `shader-asm.js`, one table of
instruction forms read in both directions; the program's macros and includes go through
the preprocessor first. `shader-asm.test.js` holds the token layouts by hand, a round
trip over random programs of thirteen versions, and a gate against the reference
assembler of the machine fixture. Not known without a real D3DX: the wording of its
errors, the rounding of a float literal, the order of `_sat` and `_pp` in a listing, and
which versions accept which modifiers. Not checked: the structure of a program
(unbalanced `if`, texture ops after arithmetic in ps_1_x).

## Effects

`D3DXCreateEffect` and its kin read an effect file with the same front end
(`effect-model.js`): the preprocessor with the program's macros and includes, the
parser and the checker over every declaration. A function's body is checked by
the compile of the entry point a pass names, so a function no pass compiles does
not refuse the effect. Each `compile vs_2_0 f(...)` is a compile of one entry point
over the same source and the same included files, its arguments bound to the
`uniform` parameters of `f` (or, where it declares none, to those without a
semantic), which then fold into the code instead of taking registers.

`effect.js` builds ID3DXEffect, ID3DXEffectPool and ID3DXEffectCompiler over that
description. A pass's states go to the device (or the program's state manager) in
the order written; each shader is followed by its constants (the parameters of the
same names, laid out by the shader's constant table with the routine D3DX's setters
use) and the sampler states of the samplers it reads. `effect.test.js` holds the
contract (vtable order and widths for d3dx9_24/25, 26 and 27 on; Wine's conformance
expectations for descriptions, names, conversions and pools) and runs a pass's pixel
shader on the reference machine with the registers the effect set.

Not done:

- a compiled fx_2_0 effect is not read (E_NOTIMPL), and the effect compiler's
  CompileEffect hands back this layer's own container of the source, which
  D3DXCreateEffect takes back;
- a state value that is an expression of parameters (fxc's preshader) is left out
  with a warning;
- a pass whose shader does not compile, or is written in an `asm { }` block, makes
  its technique invalid rather than refusing the effect.
