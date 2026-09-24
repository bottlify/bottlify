# Third-party notices — Bottlify

This lists components not authored in this repository that are distributed with the product.
Full license texts are kept alongside the corresponding component.

## v86 — x86 PC emulator / x86-to-wasm JIT (optional component)

- Source: fork https://github.com/bottlify/v86 (upstream: https://github.com/copy/v86)
- Location in this repository: `modules/core/vendor/v86`
- License: BSD-2-Clause
- This component is optional. The default engine, `cork`, is this project's own
  translator and loads nothing of v86; the emulator is selected per launch and its
  artifacts are fetched on demand. A package built without `vendor/prebuilt/` carries
  none of v86 and runs the library's demos under `cork`; a launch that selects
  `emulator` or `hybrid` is refused with a message saying the layer is absent.

```
Copyright (c) 2012, The v86 contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## v86 nasm instruction corpus — test data for the translator

- Source: the fork above, `tests/nasm/` (hand-written cases and `create_tests.js`'s generated
  ones), assembled and recorded on real hardware by the fork's CI and published as
  `nasm-corpus.json.gz` beside each release
- Location in this repository: fetched into `modules/cork/vendor/` by `npm run fetch:corpus`
  from the release pinned in `modules/cork/corpus-lock.json`; not committed, not distributed
- License: BSD-2-Clause (the same text as above)
- What is used: the assembled images and the recorded register and memory state, as inputs and
  expected outputs of `@bottlify/cork`'s corpus and differential tests. The comparison rules
  (which flags and status bits are compared, the seven-digit float tolerance, which state a
  case that died is compared on) follow the fork's own `tests/nasm/run.js` so that a case
  passes here for the reason it passes there; that runner's code is not copied.

## FFmpeg — video and audio decoding

- Source: upstream https://github.com/FFmpeg/FFmpeg at release tag `n6.1`, commit
  `d4ff0020b40b524a490cf62eccbd3a318f4c0e58`, unmodified
- Build definition: `modules/core/scripts/Dockerfile.video-decoder`,
  `modules/core/scripts/video-decoder/build-decoder.sh` and `build-video-decoder.mjs` in this
  repository; the workflow `.github/workflows/vendor.yml` runs it and publishes the result as a
  release of this repository
- Distributed artifact: `video-decoder.wasm`, a WebAssembly build of the FFmpeg libraries linked
  with `modules/core/scripts/video-decoder/decoder.c` (original work under the MPL), fetched into
  `modules/core/vendor/prebuilt/` by `npm run fetch:video-decoder` from the release pinned in
  `modules/core/video-decoder-lock.json`. It is a build artifact and is not committed to this
  repository.
- License: LGPL-2.1-or-later

The build passes neither `--enable-gpl` nor `--enable-nonfree`, so no GPL-licensed and no
non-redistributable component is compiled in; the result is FFmpeg under the LGPL, distributed
alongside this MPL-2.0 product as a separately licensed component rather than merged into it.
Adding either flag would relicense the artifact, and `build-decoder.sh` says so where the flags
are.

The corresponding source obligation is met by upstream itself: FFmpeg's code is compiled as
released, and the image pins the tag by commit so that a tag that moved fails the build rather
than compiling something else. The commit is repeated inside `video-decoder.manifest.json`,
published beside the `.wasm`: the exact tree that was compiled is public and named, and
rebuilding it needs only Docker.

FFmpeg's full license text is in that tree (`COPYING.LGPLv2.1`).

## Wine conformance expectations — used as a specification

Wine and the Win32 specifications are used only as a source of knowledge about API behavior;
no code from them is carried into this repository.

The graphics layer states this more precisely, because it leans on that knowledge hardest.
Wine's conformance tests for DirectDraw, Direct3D and OpenGL (`dlls/*/tests`, LGPL-2.1-or-later)
establish what these APIs do: which argument combinations fail and with which result code, what
state a freshly created device holds, which calls are legal in which order. Those behaviours are
facts about a Microsoft product, established by measurement, and belong to nobody.

What is derived from them here: the boundary-case sets and the validity tables — which lock
rectangles are malformed, which pool and usage combinations are accepted, which capability bits a
surface may be created with. The selection of cases to cover is Wine's editorial work over
twenty-five years, and this entry records that debt.

What is not taken: no code, no test structure, no helper, no assertion text, no ordering. Every
test in this repository is written independently, against this project's own conventions.
