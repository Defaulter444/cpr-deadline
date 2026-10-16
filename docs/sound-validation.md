# DEADLINE 1.1.0 audio validation

2026-10-16, Foundry VTT 12.331 / Cyberpunk RED Core v0.92.4, isolated deadline-test world only.

63 automated tests passed. Signal tests cover one playback per observed run, pause/reset silence, no replay when loading an already expired timer, resume, revival by adding time, private GM-only timers, disabled/zero volume, local AudioHelper playback, failed or pending loads, safe normalization and form validation without partial writes.

Live GM and Player sessions: the sound checkbox defaults on; the configuration disclosure opens; the native Foundry audio browser selects assets/expiry.wav; the path and 35% volume survive save and rerender. Preview was invoked for the default and selected-file settings without browser errors. A 30-second visible countdown appeared on both clients and reached expired/hidden on both; no audio-loading errors appeared. Actual speaker output amplitude is not measured by this browser automation.

The signal is original synthesized audio, mono PCM16 44.1 kHz, duration 1 second, peak 12341 of 32767. tools/generate-signal.py reproduces the bundled WAV byte for byte. Packaging includes the sound and runtime scripts; test and build tools are excluded. Each client uses Foundry's interface channel and personal interface volume, without rebroadcasting sound over the socket. The normal browser audio-unlock requirement applies.

No production campaign or primary Foundry data directory was modified.
