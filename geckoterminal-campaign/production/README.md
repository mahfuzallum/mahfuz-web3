# Production sources

Pipeline: `fetch_data.sh` → build `web/data.js` → `tts.py` (Kokoro voiceover) → `timeline.py` → `music.py` → `mix.py` → `render.js` (4K frames) → ffmpeg.

Not committed (download separately): the Kokoro model files (`kokoro-v1.0.onnx`, `voices-v1.0.bin` from the kokoro-onnx GitHub releases), the web fonts (Google Fonts: Space Grotesk, Inter, JetBrains Mono → `web/fonts/`), and the official app icon and screenshots (GeckoTerminal Google Play listing → `web/icon.png`, `web/shot_1..4.png`).

Render (4 workers): `node render.js web frames 30 <startFrame> <endFrame> 2`. Encode:
`ffmpeg -framerate 30 -i frames/f_%05d.jpg -i mix.wav -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -c:a aac -b:a 320k -shortest out.mp4`
