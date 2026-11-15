JPEG XL encoder (libjxl compiled to WebAssembly), from the npm package
@jsquash/jxl 1.3.0 (repackaged from Google's Squoosh). Apache License 2.0,
see LICENSE.txt. libjxl itself is BSD 3-Clause.
Only the single-threaded encoder is included; it runs in js/jxlworker.js.

jxl_oxide_wasm.js, jxl_oxide_wasm_bg.wasm
    jxl-oxide 0.12.6 (npm package jxl-oxide-wasm), a JPEG XL decoder written in Rust —
    https://github.com/tirr-c/jxl-oxide — MIT or Apache License 2.0 (both texts are here).
    Used to read DNG files whose picture is stored as JPEG XL (js/jxlrawworker.js), at full bit depth.
