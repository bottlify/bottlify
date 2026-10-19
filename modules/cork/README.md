# `@bottlify/cork`

[По-русски](README.ru.md)

Cork is the x86 processor of [Bottlify](https://github.com/bottlify/bottlify): it translates 32-bit
x86 machine code into WebAssembly and runs it, in a browser or in Node. It knows nothing about
Windows; a system call, a port write or a fault stops it and hands control back to the caller.

`@bottlify/core` already carries its own copy of cork. This package is for running x86 code without
the Windows layer.

## Install

```sh
npm install @bottlify/cork
```

## Use

```js
import { createMachine } from '@bottlify/cork';

const machine = createMachine({ ramSize: 16 << 20 });
// mov ecx, 1000; L: mov eax, ecx; int 0x80; add edi, eax; dec ecx; jnz L; hlt
machine.load(0x1000, [0xb9, 0xe8, 3, 0, 0, 0x89, 0xc8, 0xcd, 0x80, 0x01, 0xc7, 0x49, 0x75, 0xf7,
    0xf4]);
machine.setReg('eip', 0x1000);
machine.setReg('esp', (16 << 20) - 16);

for (;;)
{
    const stop = await machine.run();
    if (stop.reason === 'interrupt' && stop.vector === 0x80)
    {
        machine.setReg('eax', machine.reg('eax') * 2);   // answer the system call, go on
        continue;
    }
    console.log(stop.reason, machine.reg('edi'));        // halt 1001000
    break;
}
await machine.dispose();
```

From a terminal: `npx cork run program.elf --linux` runs a 32-bit ELF and prints why it stopped,
the registers and how many instructions ran.

## Documentation

- [What cork runs, how it works, how fast it is](https://github.com/bottlify/bottlify/blob/main/docs/cork/README.md)
- [Settings](https://github.com/bottlify/bottlify/blob/main/modules/cork/SETTINGS.md)

MPL-2.0.
