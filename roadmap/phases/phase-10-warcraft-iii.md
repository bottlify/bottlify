# Phase 10 — Bringing up Warcraft III

> A working plan for one title, written from measurement rather than from reading the source. Every
> claim below that begins "it stops at" or "it calls" came out of `tools/launch-probe.mjs`; anything
> that did not is marked as a guess.
>
> This is not a per-game plan in the sense rule 4 forbids. Nothing here licenses branching on a
> game's name. It is an *ordering*: which generic layers to finish first, answered by what one real
> program actually asks for. The master plan's §4a already says the targets are entitled to answer
> that question.

## Where it stands

**W1, W2 and W3 are closed. The game runs in a browser on a real GPU and draws its main menu.**
`node tools/cdp_test/game.mjs warcraft-iii-frozen-throne` is where that is measured now; the Node
probe below is still the right instrument for everything that happens before a device is asked for,
and only for that.

What closed each of them, because the order was not the one this plan guessed:

- **W2's first item settled the other way round.** The COM calling convention was suspected wrong
  and was: a method's arguments start where the bridge says they start, and fixing it moved every
  COM call in the engine at once — which is exactly the blast radius the entry predicted.
- **W2's second item** is largely done: the Direct3D 8 device answers eighty-two of its ninety-four
  slots.
- **W3 went the cheap route it named** — a hand-written guest program drawing one triangle on a real
  device, checked as numbers — and then the game followed it onto the same path.
- **W4 has started.** Keyboard, mouse and gamepad reach the guest, and sound leaves the engine.
  Windowing and pacing under load against the §21 thresholds are not done, and no number has been
  recorded for either.

The section below is the last state of the Node probe and is kept because the instruments it
describes are the ones to reach for next time.

`node tools/launch-probe.mjs warcraft-iii-frozen-throne`:

| | |
|---|---|
| images loaded | 30 |
| imports nothing claimed | 1 (`wininet!InternetCanonicalizeUrlA`) |
| guest instructions | ~37 668 000 |
| stops at | `Direct3DCreate8`, because a Node process has no GPU |

W1 is closed. The four archives open, their hash and block tables are read byte-exact into guest
memory, the game reads its files out of them, loads `Game.dll`, calls `GameMain`, reads its
configuration out of the registry, and asks for a Direct3D 8 device. What stopped it before was
never the archives: it was `DllMain`'s third argument (see `../registers/decisions-and-optimisations.md`
A15), which made the archive library overwrite its own hash table with one built from a different
seed. Two other generic defects were found on the way and are recorded there as A16 and A17.

The next measurement has to happen in a browser, because the wall is a GPU rather than a missing
function. The Node probe cannot go further on its own.

## What found it, and what to reach for next time

Worth writing down, because the same three questions come up every time and none of them could be
answered before:

- **What did the program call, from the beginning?** `--log <file>` writes every host call with its
  arguments and the text they point at. The ring in a failure report holds the end of a run, and a
  program that gives up decided so tens of thousands of calls earlier.
- **What did one of the game's own libraries do?** `--watch Storm.dll` or
  `--watch MSVCR80.dll!toupper` puts a stub in front of that import which records the call and then
  forwards into the real function, and a second stub catches the return. Nothing else can see a call
  between two guest modules, and that is where a game's decisions are made.
- **What is in that global right now?** `--peek 0x37e9610:16` with `--grep` reads guest memory at
  the moment a chosen call acts on it. A table that has been overwritten is invisible from every
  other angle.

The static half lives in `.tools/` (see its README): a capstone disassembler that speaks the same
addresses the probe prints, and a cached Ghidra service for decompilation and string cross-
references. The last defect was found by decompiling a `DllMain` there and then peeking, here, at
the table it built.

## W1 — reach the archives — closed

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

## W2 — reach the first drawing call — closed

Unknown territory: nothing has observed what this program does after the archives open. Two things
can be made ready in advance, and both are worth doing before they are needed because both are
expensive to debug from inside a failing game.

1. **The COM calling convention, settled by evidence.** The bridge marshals COM methods as thiscall
   with `this` in ECX. On Win32, COM interface methods are `__stdcall` and the interface pointer is
   the first argument *on the stack* — that is what makes the C `lpVtbl` bindings binary-compatible
   with the C++ call. If the bridge is wrong, every COM call in the engine reads its arguments
   shifted by one and pops four bytes too few, and DirectDraw, Direct3D, DirectSound, DirectInput and
   ole32 are all broken identically. **Status: settled — the suspicion was correct**, and the fix
   moved every COM call in the engine at once. The paragraph is kept as written because the reasoning
   is the reusable part: when one convention is wrong, everything above it is wrong identically, and
   that is what makes it cheap to find and expensive to leave.
2. **The Direct3D 8 device surface.** The seam reaches an implementation for about thirty of the
   ninety slots. Missing is what a real program touches in its first seconds:
   `GetAvailableTextureMem`, `GetCreationParameters`, `SetGammaRamp`, `SetCursorProperties`,
   `ShowCursor`, `CopyRects`, `UpdateTexture`, `CreateRenderTarget`, `CreateDepthStencilSurface`,
   `CreateCubeTexture`, `CreateVolumeTexture`, the state blocks, the lights, `GetTransform`,
   `GetStreamSource`, `GetIndices`, `ValidateDevice`, the shader entry points.

**Done when** the probe shows `comInterfaces` above zero and a draw call arriving.

## W3 — the first frame on a real GPU — closed

Written when every one of the thirty-eight thousand lines in `graphics/` was verified against our own
model and nothing else, with no pixel having reached a real device — entry A11 of the decisions
register, and at the time the largest unmeasured risk in the project. It is no longer unmeasured.

The cheapest way to convert it into a measurement is not the game. It is a hand-written guest
program of thirty instructions that creates a device, clears it, draws one triangle and presents,
run in a real browser against a real WebGPU device, with the resulting pixels read back and compared
numerically. When that works, the whole stack from a guest `CALL` to a lit pixel is proven, and any
later failure in a game is about the game's usage rather than about the path existing.

**Done when** a screenshot of the canvas has the expected colours at named coordinates, compared as
numbers rather than looked at.

## W4 — from a frame to a game — in progress

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
