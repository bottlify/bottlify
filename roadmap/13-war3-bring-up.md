# 13 — Bringing up Warcraft III

> A working plan for one title, written from measurement rather than from reading the source. Every
> claim below that begins "it stops at" or "it calls" came out of `tools/launch-probe.mjs`; anything
> that did not is marked as a guess.
>
> This is not a per-game plan in the sense rule 4 forbids. Nothing here licenses branching on a
> game's name. It is an *ordering*: which generic layers to finish first, answered by what one real
> program actually asks for. The master plan's §4a already says the targets are entitled to answer
> that question.

## Where it stands

`node tools/launch-probe.mjs warcraft-iii-frozen-throne` today:

| | |
|---|---|
| images loaded | 26 |
| imports nothing claimed | 1 (`wininet!InternetCanonicalizeUrlA`) |
| asked for by name at run time and not found | 3 |
| guest instructions | ~1 031 000 |
| COM interfaces published | 0 |
| stops at | Storm's own error report, `.\SFile.cpp(832)` |

So the bundle path is finished work: a real installation mounts, every image maps, imports bind,
and a million guest instructions run. What is left is a chain of blockers, and the value of the
probe is that it names the next link rather than requiring it to be guessed.

## W1 — reach the archives

Storm reports a failure in `SFile.cpp` before opening a single archive: `CreateFileA` was called
exactly twice in the whole run, both times for the error report it was writing. The archives are all
present in the bundle. Before that point it read the registry eight times and took
`GetModuleFileNameA` four times, which is the shape of a program working out where it is installed.

1. **Argument strings in the call trace.** The trace prints pointers. A call to `RegOpenKeyExA` or
   `LoadLibraryA` is only useful if the name it was given is visible, and reading each one out of the
   image by hand is not a workflow. The bridge already records a detail ring; it should resolve the
   string arguments of the calls that take them.
2. **The ordered call history.** The bridge keeps four thousand call names but publishes only the
   counts. The sequence leading to a failure is the diagnostic; the histogram is the summary.
3. **Root-cause the SFile failure** with those two in hand.
4. **The four functions nothing claims.** `InternetCanonicalizeUrlA`, `IsProcessorFeaturePresent`,
   `_set_error_mode`, `FindActCtxSectionStringW`. Small, and unrelated to the above — but a program
   that resolves a name and gets zero usually calls the pointer anyway.

**Done when** the probe shows an archive opened and read.

## W2 — reach the first drawing call

Unknown territory: nothing has observed what this program does after the archives open. Two things
can be made ready in advance, and both are worth doing before they are needed because both are
expensive to debug from inside a failing game.

1. **The COM calling convention, settled by evidence.** The bridge marshals COM methods as thiscall
   with `this` in ECX. On Win32, COM interface methods are `__stdcall` and the interface pointer is
   the first argument *on the stack* — that is what makes the C `lpVtbl` bindings binary-compatible
   with the C++ call. If the bridge is wrong, every COM call in the engine reads its arguments
   shifted by one and pops four bytes too few, and DirectDraw, Direct3D, DirectSound, DirectInput and
   ole32 are all broken identically. **Status: suspected, not verified.** No program has reached a
   COM call yet, so nothing has failed to reveal it. Settle it against the real binaries in the
   bundle, not against recall.
2. **The Direct3D 8 device surface.** The seam reaches an implementation for about thirty of the
   ninety slots. Missing is what a real program touches in its first seconds:
   `GetAvailableTextureMem`, `GetCreationParameters`, `SetGammaRamp`, `SetCursorProperties`,
   `ShowCursor`, `CopyRects`, `UpdateTexture`, `CreateRenderTarget`, `CreateDepthStencilSurface`,
   `CreateCubeTexture`, `CreateVolumeTexture`, the state blocks, the lights, `GetTransform`,
   `GetStreamSource`, `GetIndices`, `ValidateDevice`, the shader entry points.

**Done when** the probe shows `comInterfaces` above zero and a draw call arriving.

## W3 — the first frame on a real GPU

Every one of the thirty-eight thousand lines in `graphics/` is verified against our own model and
nothing else: no pixel has ever reached a real device. That is entry A11 of the decisions register
and it is the largest unmeasured risk in the project.

The cheapest way to convert it into a measurement is not the game. It is a hand-written guest
program of thirty instructions that creates a device, clears it, draws one triangle and presents,
run in a real browser against a real WebGPU device, with the resulting pixels read back and compared
numerically. When that works, the whole stack from a guest `CALL` to a lit pixel is proven, and any
later failure in a game is about the game's usage rather than about the path existing.

**Done when** a screenshot of the canvas has the expected colours at named coordinates, compared as
numbers rather than looked at.

## W4 — from a frame to a game

Only reachable after the above, and listed so the order is not re-litigated later:

- **Input routing.** DirectInput and the window queue exist; nothing connects a browser event to
  them.
- **Audio output.** DirectSound models buffers and cursors correctly and opens no output device.
- **Windowing.** A real surface, sized and positioned, with the cooperative-level and mode-set
  behaviour DirectDraw promises.
- **Pacing under load**, using the pacer that now exists, against the §21 thresholds.

## What is deliberately not in this plan

Direct3D 9's seam (this title does not use it), OpenGL's exports (a fallback path), Direct3D 10, the
alternative C runtimes, and the video and networking packages. Each is real work and none of it is
between here and a running Warcraft III.
