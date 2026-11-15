Machine-learning files used by the "Subject", "Sky" and "People" masks (src/js/aimask.js)
and by face grouping (src/js/faces.js).
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

efficientvit-seg-b1-ade20k.onnx   (preferred scene model; used instead of SegFormer when present)
    EfficientViT-Seg B1 trained on ADE20K by MIT HAN Lab — https://github.com/mit-han-lab/efficientvit
    Apache License 2.0. Not distributed as ONNX by its authors: export it from their weights
    (https://huggingface.co/han-cai/efficientvit-seg, efficientvit_seg_b1_ade20k.pt) at 512×512, opset 17,
    input "pixel_values", output "logits", and put the file here. Once it is here, segformer-b0-ade.onnx
    can be deleted. Same 150 classes in the same order, so nothing else changes.

face_detection_yunet_2023mar.onnx
    YuNet face detector by Shiqi Yu et al., from the OpenCV Zoo —
    https://huggingface.co/opencv/face_detection_yunet — MIT licence. Finds faces and five points on each.

face_recognition_sface_2021dec.onnx
    SFace face recognition model by Yaoyao Zhong et al., from the OpenCV Zoo —
    https://huggingface.co/opencv/face_recognition_sface — Apache License 2.0.
    Turns a face into 128 numbers that are close together for the same person.

The models run in their own thread (js/aiworker.js). The scene model also
provides keyword suggestions in the Library (PJ.AIMask.describe).
