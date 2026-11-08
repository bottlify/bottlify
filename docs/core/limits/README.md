# Limits

What is missing, and where the engine answers differently from Windows. A call that answers
differently raises a `divergence` event naming the API, a warning in the journal; one whose work
did not happen at all -- a draw or a frame lost, an object the GPU refused -- raises a `loss`
event, an error. Neither stops the program.

## Programs

- 32-bit x86 programs: a PE32 image for i386. A 64-bit (PE32+) image runs on one executor, with
  its pages below 4 GiB, as far as console programs on msvcrt or vcruntime140 go, structured and
  C++ exceptions, floating-point arguments and results, and a window program's classes,
  windows, messages, hooks and painting, and Direct3D 9, OpenGL and DirectSound included, every
  call into them a trap: dialogs, MDI, DirectDraw and the other Direct3D versions are not there yet at
  64 bits (`roadmap/x64.md`). A message's WPARAM and LPARAM keep 32 bits there. A run whose
  first program is 64-bit is on a 64-bit Windows, where a 32-bit child runs under WOW64 without
  the file system's and the registry's redirection.
  A structured exception there passes no `_set_se_translator` translator. The exports that are
  i386 code alone (`_chkesp`, the __fastcall `Rtl*` calls) are not in a 64-bit process's modules,
  `RtlActivateActivationContextUnsafeFast` among them. A 16-bit (NE) image is
  refused when it is loaded.
- Only user mode. There is no kernel underneath; the engine's layers answer every system call.
- Below `0x10000` a write or running code faults, as an access violation, as on Windows; a read
  there finds zeros where Windows would fault too (`roadmap/decisions.md` A79).
- The processor a program finds is a Nehalem (SSE4.2, POPCNT): AVX, AVX2, FMA, BMI, AES-NI and
  AVX-512 are not announced and fault as on that processor. `tools/isa-audit.mjs` tells which a
  title's code uses.
- A .NET program runs under Mono: `mscoree.dll`'s `_CorExeMain` loads the bottle's runtime from
  `C:\Windows\Mono` (Mono's own Windows build: `bin\libmono-2.0-x86.dll`, `lib\mono\4.5`,
  `etc\mono`), which the bottle has to hold; without it the program does not run and the loss is
  said. A native program hosts the same runtime through the shim (`CLRCreateInstance`,
  `ICLRMetaHost`, `ICLRRuntimeInfo`, `ICorRuntimeHost`, `ICLRRuntimeHost`, `GetCORVersion` and
  kin), which reports runtimes 2.0.50727 and 4.0.30319 and hands application domains out through
  Mono's COM interop; logical thread state, mapped files, domain enumeration, evidence and
  unloading are refused (`E_NOTIMPL`), and a runtime-loaded callback's thread mark changes
  nothing. Only 32-bit console programs are tested so far; WinForms, WPF, XNA and mixed C++/CLI
  assemblies are not.
- The global assembly cache (`fusion.dll`) is the Windows folders `C:\WINDOWS\assembly` and
  `C:\WINDOWS\Microsoft.NET\assembly`: a strongly named assembly installed lands there, and a
  query or an enumeration reads what is there; Mono's own cache under `C:\Windows\Mono` is not
  part of it. There is no download cache, no native image cache and no install references: an
  enumeration of either cache is empty, a reference passed in is not kept (and said), and
  installing from streams (`IAssemblyCacheItem`), the scavenger, `CopyPDBs` and
  `CreateApplicationContext` are refused (`E_NOTIMPL`) and said.
- With less RAM than 2 GiB the system's shared page (`0x7FFE0000`) is there all the same, kept in
  RAM's last 128 KiB, and the heap ends below it.
- An import nothing implements returns 0 when its argument size is known (a decorated name, a cdecl
  library, a library the program brought). Otherwise the program stops with `unimplemented import`
  and the function's name.
- The guest's zone is measured, not enforced: a program that holds more than 1 GiB of its RAM marks
  the zones' table `over` and goes on.
- The tab's memory is held to 1.5 GiB in three zones ([configuration.md](../configuration.md#memory-zones)).
  Not every pool of the engine's own heaps is measured yet: the zones' table names those that are
  not, and the bytes they hold are counted nowhere.

## Sound

- Without `SharedArrayBuffer` (the `compatible` mode) sound is mixed on the engine's thread and
  posted to the worklet. A DirectSound buffer is then read out on the guest's clock rather than by
  the device, and what piles up while the device runs short stays queued: the sound can lag the
  picture by up to the ring's depth, a third of a second.
- 64 voices play at once.
- DirectSound 3D keeps every parameter but does not position the sound: a 3D buffer plays as with
  3D processing off.
- No capture: recording answers `DSERR_NODRIVER`.
- Media Foundation describes media and decodes none (`roadmap/decisions.md` A238): `mfplat`'s
  attributes, media types, memory buffers, samples and events are there, and `propsys`'s
  PROPVARIANT conversions, but no source, decoder, transform or work queue. A source reader
  (`MFCreateSourceReaderFromURL`, `MFCreateSourceReaderFromByteStream`) is refused and the loss
  is said with the file's name: XNA's songs and videos through FNA (WMA, WMV) and FAudio's xWMA do
  not play. Registering a transform is refused with `E_ACCESSDENIED`.

## Input

- Only keyboard, mouse and gamepads reach the program. The page's focus, visibility and lifecycle
  never do.

## Network

- No raw TCP or UDP. Sockets go through the relay over WebSocket; without `network` only the
  loopback adapter exists.
- The relay links tabs in one room and reaches outside hosts only from its server's allow list.
- A single TCP `send` over 64 KiB fails: the relay's frames carry at most 64 KiB and are not split.
- crypt32 builds a certificate chain from the certificates it was given and the ROOT store
  (`win32.trustedRoots`); it fetches nothing, so a missing intermediate is a partial chain and
  revocation, when asked, is unknown and offline (`CRYPT_E_REVOCATION_OFFLINE` under the SSL
  policy). Only RSA signatures are verified: a certificate signed with an ECDSA key fails as
  not signature valid.

## Files

- The bundle is read-only. What the program writes goes into the session, kept per `id`.
- A file mapping is a copy: a view reads the file when it is made and writes it back when it is
  closed, so two views of one file do not see each other's writes.

## Images (WIC)

The Windows Imaging Component (`windowscodecs.dll`, `CLSID_WICImagingFactory`) decodes, converts
and scales bitmaps for the program, .NET's WPF among them.

- Decoders: BMP, PNG, ICO, GIF, JPEG and TIFF, each frame in the pixel format Windows' decoder
  gives, except TIFF: its first image only, always as 32bppBGRA. DDS and JPEG XR are refused
  (`WINCODEC_ERR_COMPONENTNOTFOUND`). A decoder reads its whole stream and decodes every frame
  when it is initialized.
- No encoders, no metadata (query readers and writers, metadata blocks, fast metadata encoders),
  no colour transforms and no embedded ICC profiles: refused, and said once as a divergence.
- The scaler's linear, cubic and Fant modes all average the source area under each pixel;
  nearest neighbour is the pixel under its centre. Indexed formats scale by nearest neighbour.
- Conversion covers the integer, float and half formats and CMYK (without colour management);
  fixed-point, 32bppRGBE and n-channel formats are not converted.
- The internal interfaces native WPF used on Windows (`IMILBitmap`, `IMILBitmapSource` and
  kin) are not there.
