# Third-party notices

D2 Diagram Viewer & D2 Preview includes the following files from the npm package @terrastruct/d2 version 0.1.33 (D2.js, the WebAssembly build of D2 v0.7.0). They are copied unmodified from the package's dist/node-cjs folder and kept as separate files:

- lib/d2/d2.wasm: the D2 compiler, layout and renderer. Mozilla Public License 2.0 (MPL-2.0), Copyright 2022 Terrastruct, Inc. The license text is in lib/d2/LICENSE.txt (LICENSE.txt of the D2 repository at tag v0.7.0). The source code is available at https://github.com/terrastruct/d2 (folder d2js for the WebAssembly build). The WebAssembly file also contains the parts D2 builds into it, among them the Go standard library (BSD-3-Clause), the dagre layout (MIT) and the Source Sans Pro and Source Code Pro fonts (SIL Open Font License 1.1), as distributed in that package.
- lib/d2/wasm_exec.js: the Go WebAssembly runtime support file. BSD-3-Clause License, Copyright 2009 The Go Authors (the file says 2018). The license text is in lib/d2/LICENSE-wasm_exec.txt.

The ELK layout file of the same package (elk.js, Eclipse Public License 2.0) is not included.

The preview, the exporters (PNG reading, PDF writing), the batch export, the file and import handling and the TextMate grammar are written for this extension.

The D2 example files from the D2 repository (MPL-2.0) and the D2 documentation (BSD-3-Clause) used to test the extension were kept as local test data and are not part of the package.
