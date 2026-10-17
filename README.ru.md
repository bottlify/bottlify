# Bottlify

[English](README.md)

## Что это

Bottlify это набор JavaScript-модулей для запуска программ и игр для Windows x86 в браузере.
Страница подключает модули и запускает с их помощью обычный `.exe`: программа работает прямо во
вкладке, без Windows, плагинов и установки. Сама программа не знает, что она в браузере: она видит
Windows, диск `C:`, реестр, окна, DirectX и звук.

Поддерживаются 32-битные программы, DirectDraw, Direct3D 7–10, OpenGL 1.1 с расширениями, Vulkan,
DirectSound, DirectMusic, видео через DirectShow и сеть через Winsock.

## Зачем

Браузер есть на любом устройстве, от телефона до компьютера. Bottlify превращает его в платформу
для программ и игр, которые уже написаны: игра лежит «в бутылке» и открывается по ссылке.

Раньше браузер пытались сделать платформой плагины: Flash, Java-апплеты, Unity Web Player. Под
каждый приходилось писать программы отдельно, и когда браузеры отказались от плагинов, эти игры
перестали запускаться. Bottlify опирается только на стандарты, которые есть в любом современном
браузере (WebAssembly, WebGPU, Web Audio, OPFS), а программы для него переписывать не нужно.

## Из чего состоит

- **[core](modules/core/README.md)** (`@bottlify/core`): окружение Windows, написанное с нуля на
  JavaScript. `kernel32`, `user32`, `gdi32`, DirectX, OpenGL, DirectSound, Winsock и остальные
  системные библиотеки работают поверх WebGPU, WebAudio и OPFS. Страница запускает его одним
  вызовом `createApp()`.
- **[cork](modules/cork/README.ru.md)** (`@bottlify/cork`): транслятор x86 → WebAssembly. Он
  переводит машинный код программы в wasm, а браузер компилирует его под процессор устройства,
  поэтому одна и та же сборка работает и на x86, и на ARM.
- **[networking](modules/networking/README.md)** (`@bottlify/networking`, по желанию): TCP и UDP
  для вкладки через один WebSocket, сервер-ретранслятор и его клиент. Без него программе доступен
  только loopback внутри вкладки.
- **[installer](modules/installer/README.md)** (`@bottlify/installer`, по желанию): собирает
  бутылку из установщика игры, который без изменений запускается внутри движка.

Как всё устроено целиком (потоки, запуск, трансляция, Win32, графика, звук, сеть, хранилища),
описано в [архитектуре](docs/architecture.ru.md). Каждый модуль подробно описан в своём README по
ссылкам выше. Для тех, кто встраивает `@bottlify/core`: [API, настройки и
ограничения](docs/core/README.md) (на английском). Планы лежат в [`roadmap/`](roadmap/README.md).

## Сборка и тесты

```sh
npm ci
npm run fetch:video-decoder && npm run fetch:corpus   # the pinned decoder and cork's x86 corpus
npm run typecheck && npm run lint && npm test && npm run check:boundaries
npm run test:integration && npm run build
npm run cdp:probe   # boots the engine in a real headless Chrome
```

Модули лежат в [`modules/`](modules/), инструменты разработки (стенд с настоящим браузером, аудит импортов,
бенчмарки) в [`tools/`](tools/). Лаунчер и интерфейс бутылок живут в отдельном репозитории,
[`bottlify-ui`](https://github.com/bottlify/bottlify-ui).

Bottlify распространяется по лицензии MPL-2.0. Чужие компоненты и код перечислены в
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
