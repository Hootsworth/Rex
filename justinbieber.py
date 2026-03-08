import wave
import numpy as np

# Parameters for the WAV file
sample_rate = 44100  # Sample rate in Hz
duration = 1.0  # Duration in seconds
frequency = 440.0  # Frequency of the sound in Hz (A4 note)

# Generate samples
t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
audio_data = 0.5 * np.sin(2 * np.pi * frequency * t)
audio_data = (audio_data * 32767).astype(np.int16)  # Convert to 16-bit PCM format

# Write to WAV file
with wave.open('hello_world.wav', 'wb') as wav_file:
    wav_file.setnchannels(1)  # Mono
    wav_file.setsampwidth(2)  # 2 bytes for 16-bit audio
    wav_file.setframerate(sample_rate)
    wav_file.writeframes(audio_data.tobytes())