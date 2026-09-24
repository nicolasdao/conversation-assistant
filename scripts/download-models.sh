#!/bin/sh
# Downloads the local VAD and speaker-embedding models into models/, skipping files that already exist.
set -e
mkdir -p models
fetch() {
  if [ -s "models/$1" ]; then
    echo "models/$1 already present"
  else
    echo "downloading models/$1"
    curl -fL --retry 3 -o "models/$1.part" "$2"
    mv "models/$1.part" "models/$1"
  fi
}
fetch silero_vad.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
fetch wespeaker_en_voxceleb_resnet34_LM.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx
