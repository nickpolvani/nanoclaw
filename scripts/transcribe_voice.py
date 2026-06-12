#!/usr/bin/env python3
"""
Voice transcription using Qwen3-ASR (local, Hugging Face).
Usage: python3 transcribe_voice.py <audio_file_path>
Prints the transcription to stdout, nothing else.
"""
import sys
import os

def main():
    if len(sys.argv) < 2:
        print("[Voice message]", end="")
        sys.exit(0)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print("[Voice message]", end="")
        sys.exit(0)

    try:
        import torch
        from qwen_asr import Qwen3ASRModel

        # Pick best available device
        if torch.backends.mps.is_available():
            device = "mps"
            dtype = torch.float32  # MPS doesn't support bfloat16 well
        elif torch.cuda.is_available():
            device = "cuda:0"
            dtype = torch.bfloat16
        else:
            device = "cpu"
            dtype = torch.float32

        model = Qwen3ASRModel.from_pretrained(
            "Qwen/Qwen3-ASR-0.6B",
            dtype=dtype,
            device_map=device,
            max_new_tokens=256,
        )

        results = model.transcribe(audio=audio_path, language=None)
        text = results[0].text.strip() if results and results[0].text else ""

        if text:
            print(text, end="")
        else:
            print("[Voice message]", end="")

    except ImportError:
        # qwen-asr not installed
        print("[Voice message: install qwen-asr to enable transcription]", end="")
        sys.exit(0)
    except Exception as e:
        sys.stderr.write(f"Transcription error: {e}\n")
        print("[Voice message]", end="")
        sys.exit(0)

if __name__ == "__main__":
    main()
