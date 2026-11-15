Machine-learning files used by the "Subject", "Sky" and "People" masks (src/js/aimask.js).
Everything runs on this computer; nothing is uploaded.

ort.wasm.min.mjs, ort-wasm-simd-threaded.mjs, ort-wasm-simd-threaded.wasm
    ONNX Runtime Web 1.31.1 (WebAssembly build) — https://github.com/microsoft/onnxruntime
    MIT licence, see onnxruntime-LICENSE.txt.

u2netp.onnx
    U²-Net (small) salient-object model by Xuebin Qin et al. — https://github.com/xuebinqin/U-2-Net
    Apache License 2.0. ONNX export from the rembg project (https://github.com/danielgatis/rembg).
    Used for the Subject mask.

segformer-b0-ade.onnx
    SegFormer-B0 fine-tuned on ADE20K (150 scene classes) by NVIDIA — https://github.com/NVlabs/SegFormer
    ONNX export from https://huggingface.co/Xenova/segformer-b0-finetuned-ade-512-512
    NVIDIA Source Code License for SegFormer: research and evaluation use only, NOT for commercial use
    (https://github.com/NVlabs/SegFormer/blob/master/LICENSE). Used for the Sky and People masks.
    If this app is ever distributed commercially, leave this file out (the Sky and People masks then
    report that their model is missing) or replace it with a model under a licence that allows it.

The models run in their own thread (js/aiworker.js). The scene model also
provides keyword suggestions in the Library (PJ.AIMask.describe).
