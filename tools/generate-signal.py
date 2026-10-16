"""Generate DEADLINE's original, one-second alert using only Python's standard library.

No recordings, samples, or third-party sounds are used. The generated asset is MIT
licensed with the module. Run from any directory: python tools/generate-signal.py
"""
import hashlib
import math
from pathlib import Path
import struct
import wave

SAMPLE_RATE = 44100
DURATION = 1.0
# Start, duration, fundamental frequency. Short ascending pulses, then a soft tail.
PULSES = ((0.02, 0.18, 660.0), (0.25, 0.18, 880.0), (0.48, 0.48, 1100.0))
OUTPUT = Path(__file__).resolve().parents[1] / "assets" / "expiry.wav"


def sample_at(time):
    value = 0.0
    for start, duration, frequency in PULSES:
        local = time - start
        if not 0 <= local < duration:
            continue
        # Raised-cosine attack and release keep sample boundaries free of clicks.
        attack = min(1.0, local / 0.015)
        release = min(1.0, (duration - local) / 0.09)
        envelope = (0.5 - 0.5 * math.cos(math.pi * attack))
        envelope *= 0.5 - 0.5 * math.cos(math.pi * release)
        phase = 2 * math.pi * frequency * local
        value += 0.42 * envelope * (0.85 * math.sin(phase) + 0.15 * math.sin(2 * phase))
    return round(value * 32767)


def main():
    samples = [sample_at(index / SAMPLE_RATE) for index in range(round(SAMPLE_RATE * DURATION))]
    peak = max(abs(sample) for sample in samples)
    assert 0 < peak < 32767, "Signal must be audible and must not clip."
    assert samples[0] == samples[-1] == 0, "Signal must start and end at silence."
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUTPUT), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    print(f"expiry.wav: {DURATION:.2f}s, mono PCM16/{SAMPLE_RATE}Hz, peak {peak}/32767, sha256 {digest}")


if __name__ == "__main__":
    main()
