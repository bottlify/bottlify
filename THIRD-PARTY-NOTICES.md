# Third-party notices — Bottlify

This lists components not authored in this repository that are distributed with the product.
Full license texts are kept alongside the corresponding component.

## v86 — x86 PC emulator / x86-to-wasm JIT

- Source: fork https://github.com/mrwayer/v86 (upstream: https://github.com/copy/v86)
- Location in this repository: `modules/core/vendor/v86`
- License: BSD-2-Clause

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