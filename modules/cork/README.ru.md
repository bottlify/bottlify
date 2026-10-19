# `@bottlify/cork`

[English](README.md)

Cork - это процессор x86 в [Bottlify](https://github.com/bottlify/bottlify): он переводит 32-битный
машинный код x86 в WebAssembly и выполняет его в браузере или в Node. Про Windows он ничего не
знает: системный вызов, запись в порт или исключение останавливают его и возвращают управление
тому, кто его запустил.

В `@bottlify/core` уже есть своя копия cork. Этот пакет нужен, чтобы выполнять код x86 без слоя
Windows.

## Установка

```sh
npm install @bottlify/cork
```

## Пример

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

Из терминала: `npx cork run program.elf --linux` запускает 32-битный ELF и печатает, почему он
остановился, регистры и сколько инструкций выполнено.

## Документация

- [Что cork умеет, как устроен и насколько быстр](https://github.com/bottlify/bottlify/blob/main/docs/cork/README.ru.md)
- [Настройки](https://github.com/bottlify/bottlify/blob/main/modules/cork/SETTINGS.ru.md)

MPL-2.0.
