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

efficientvit-seg-b1-ade20k.onnx
    EfficientViT-Seg B1 trained on ADE20K (150 scene classes) by MIT HAN Lab —
    https://github.com/mit-han-lab/efficientvit — Apache License 2.0.
    Exported to ONNX for this app from the authors' weights
    (https://huggingface.co/han-cai/efficientvit-seg, efficientvit_seg_b1_ade20k.pt): fixed 512×512 input
    "pixel_values", output "logits" (1×150×64×64), opset 17; the export matches the PyTorch model to 1e-4.
    Used for the Sky and People masks and for keyword suggestions. It replaces SegFormer-B0, whose NVIDIA
    licence did not allow commercial use; on test photos the two agree (sky IoU 0.94, people 0.93) and this
    one is about twice as fast.
    The ADE20K photos the model learned from have their own terms of use (research); that concerns the
    training data, not this file's licence.

face_detection_yunet_2023mar.onnx
    YuNet face detector by Shiqi Yu et al., from the OpenCV Zoo —
    https://huggingface.co/opencv/face_detection_yunet — MIT licence. Finds faces and five points on each.

face_recognition_sface_2021dec.onnx
    SFace face recognition model by Yaoyao Zhong et al., from the OpenCV Zoo —
    https://huggingface.co/opencv/face_recognition_sface — Apache License 2.0.
    Turns a face into 128 numbers that are close together for the same person.

The models run in their own thread (js/aiworker.js). The scene model also
provides keyword suggestions in the Library (PJ.AIMask.describe).
