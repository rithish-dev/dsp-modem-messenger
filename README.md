# Modem

A texting app that behaves like a 1990s dial-up modem instead of an instant messenger.

Built while revising for a DSP exam — wanted to actually see the concepts (FFT, FSK encoding, signal noise) instead of just doing them on paper.

## How it works
- Messages are encoded as audio using FSK (frequency-shift keying) — the same idea old modems used, where each bit is one of two tones (1200Hz / 2200Hz)
- Sent at 300 baud (deliberately slow)
- A live spectrogram shows the real FFT of the outgoing audio while it transmits
- Channel quality is randomized per message — poor conditions can corrupt characters, and there's a small chance the "carrier" is lost and the message never arrives

## Stack
React + Web Audio API, no backend.

## Note
This is a prototype/demo, not a production messaging app — no real network connection between users.
