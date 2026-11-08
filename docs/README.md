# Bottlify documentation

Bottlify runs unchanged Windows programs, 32-bit and 64-bit, in a browser tab: cork translates the
program's x86 or x86-64 code to WebAssembly, and a Win32 and DirectX layer written in JavaScript answers its calls on WebGPU,
WebAudio and OPFS. What it is for is in the [README](../README.md); these pages are how to use it
and how it works.

<!-- This list is the site's navigation (tools/docs/site.mjs): a page is reachable when it is
listed here. -->

## Using it

- [Getting started](core/README.md)
- [API](core/api.md)
- [Configuration](core/configuration.md)
- [Limits](core/limits/README.md)
  - [Processes](core/limits/processes.md)
  - [Graphics](core/limits/graphics.md)
  - [The installer](core/limits/installer.md)
- [Installing programs](installer/README.md)
  - [How the installer works](installer/how-it-works.md)
  - [The bottle server](installer/server.md)
- [Networking](networking/README.md)
- [Games and programs](games.md)

## How it works

- [Inside Bottlify](architecture/README.md)
- [Hello world, step by step](architecture/hello-world.md)
- [Threads](architecture/threads.md)
- [Startup](architecture/startup.md)
- [cork in the engine](architecture/cork.md)
- [Win32 in JavaScript](architecture/win32.md)
- [Graphics](architecture/graphics.md)
- [Sound](architecture/sound.md)
- [Networking](architecture/networking.md)
- [Storage](architecture/storage.md)

## cork

- [What cork is](cork/README.md)
- [How cork works](cork/how-it-works.md)
- [How fast cork is](cork/speed.md)
- [Running cork](cork/running.md)
- [Settings](cork/settings.md)
- [Source and tests](cork/source.md)
