#!/usr/bin/env python3
"""Scoopz reel prep: check videos for common upload-failure causes and
re-encode them into a safe, upload-ready vertical MP4 with a caption file.

Usage:
    python3 scoopz/prep.py                    # process everything in scoopz/inbox/
    python3 scoopz/prep.py my_video.mov       # process one file
    python3 scoopz/prep.py -o out_dir a.mp4 b.mov

Output (default scoopz/ready/):
    <name>.mp4         upload-ready video
    <name>.txt         caption + hashtags (copy-paste into Scoopz)
    report.md          what was wrong with each input and what was fixed
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".3gp"}
DEFAULT_CONFIG = {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "max_seconds": 180,
    "trim_to_max": False,
    "max_mb": 100,
    "crf": 20,
    "hashtags": ["#scoopz", "#reels", "#viral"],
    "default_caption": "",
}


def load_config(path):
    cfg = dict(DEFAULT_CONFIG)
    if path and Path(path).exists():
        cfg.update(json.loads(Path(path).read_text(encoding="utf-8")))
    return cfg


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        return None
    return json.loads(out.stdout)


def parse_fps(rate):
    try:
        num, den = rate.split("/")
        return float(num) / float(den) if float(den) else 0.0
    except (ValueError, AttributeError):
        return 0.0


def rotation_of(v):
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            return abs(int(sd["rotation"])) % 360
    rot = (v.get("tags") or {}).get("rotate")
    return abs(int(rot)) % 360 if rot else 0


def analyze(path, info, cfg):
    """Return (facts, problems). Problems are human-readable upload risks."""
    problems = []
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = info.get("format", {})
    if v is None:
        return {}, ["No video stream found — file is broken or not a video."]

    w, h = int(v.get("width", 0)), int(v.get("height", 0))
    if rotation_of(v) in (90, 270):
        w, h = h, w
    fps = parse_fps(v.get("avg_frame_rate") or v.get("r_frame_rate"))
    dur = float(fmt.get("duration") or v.get("duration") or 0)
    size_mb = Path(path).stat().st_size / 1_048_576
    transfer = v.get("color_transfer", "")
    hdr = transfer in ("smpte2084", "arib-std-b67")
    facts = {
        "codec": v.get("codec_name"), "width": w, "height": h,
        "fps": round(fps, 2), "duration_s": round(dur, 1),
        "size_mb": round(size_mb, 1), "pix_fmt": v.get("pix_fmt"),
        "audio": a.get("codec_name") if a else None, "hdr": hdr,
        "container": fmt.get("format_name"),
    }

    if v.get("codec_name") != "h264":
        problems.append(f"Video codec is {v.get('codec_name')} (HEVC/VP9/etc.) — many apps only accept H.264.")
    if hdr:
        problems.append("HDR video (iPhone/Android HDR) — often fails or looks washed out after upload.")
    if v.get("pix_fmt") not in ("yuv420p", "yuvj420p"):
        problems.append(f"Pixel format {v.get('pix_fmt')} (10-bit or unusual) — needs 8-bit yuv420p.")
    if fps > 31:
        problems.append(f"{fps:.0f} fps — high frame rate; 30 fps is the safe choice.")
    if w and h and abs((w / h) - (9 / 16)) > 0.02:
        problems.append(f"Aspect ratio {w}x{h} is not vertical 9:16 — may be rejected or cropped.")
    if max(w, h) > 1920:
        problems.append(f"Resolution {w}x{h} is above 1080p (4K) — large and often rejected.")
    if a is None:
        problems.append("No audio track — some apps fail on silent files.")
    elif a.get("codec_name") != "aac":
        problems.append(f"Audio codec is {a.get('codec_name')} — AAC is the safe choice.")
    if "mp4" not in (fmt.get("format_name") or "") and Path(path).suffix.lower() != ".mp4":
        problems.append(f"Container is {Path(path).suffix} — MP4 is the safe choice.")
    if dur > cfg["max_seconds"]:
        problems.append(f"Duration {dur:.0f}s is longer than {cfg['max_seconds']}s.")
    if size_mb > cfg["max_mb"]:
        problems.append(f"File is {size_mb:.0f} MB — over {cfg['max_mb']} MB.")
    if dur < 3:
        problems.append(f"Very short ({dur:.1f}s) — some apps reject clips under ~3s.")
    return facts, problems


def build_filter(facts, cfg):
    W, H, fps = cfg["width"], cfg["height"], cfg["fps"]
    pre = []
    if facts.get("hdr"):
        pre.append("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                   "tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv")
    pre.append(f"fps={fps}")
    head = ",".join(pre)
    ratio = facts["width"] / facts["height"] if facts.get("height") else 0
    if abs(ratio - W / H) <= 0.02:
        return (f"[0:v]{head},scale={W}:{H}:force_original_aspect_ratio=increase,"
                f"crop={W}:{H},setsar=1,format=yuv420p[v]")
    # Not 9:16: fit the video and fill the rest with a blurred copy.
    return (f"[0:v]{head},split[a][b];"
            f"[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
            f"gblur=sigma=40,eq=brightness=-0.08[bg];"
            f"[b]scale={W}:{H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]")


def encode(src, dst, facts, cfg, crf):
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src)]
    has_audio = facts.get("audio") is not None
    if not has_audio:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    cmd += ["-filter_complex", build_filter(facts, cfg), "-map", "[v]",
            "-map", "0:a:0" if has_audio else "1:a:0"]
    if cfg["trim_to_max"] and facts["duration_s"] > cfg["max_seconds"]:
        cmd += ["-t", str(cfg["max_seconds"])]
    elif not has_audio:
        cmd += ["-shortest"]
    cmd += [
        "-c:v", "libx264", "-profile:v", "high", "-level", "4.1",
        "-preset", "medium", "-crf", str(crf),
        "-maxrate", "8M", "-bufsize", "16M", "-g", str(cfg["fps"] * 2),
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-map_metadata", "-1", "-movflags", "+faststart", str(dst),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-800:])


def caption_for(src, cfg):
    side = src.with_suffix(".txt")
    text = side.read_text(encoding="utf-8").strip() if side.exists() else cfg["default_caption"]
    tags = [t for t in cfg["hashtags"] if t.lower() not in text.lower()]
    return (text + ("\n\n" if text else "") + " ".join(tags)).strip() + "\n"


def process(src, out_dir, cfg):
    info = probe(src)
    if info is None:
        return {"file": src.name, "ok": False, "error": "ffprobe could not read the file (corrupt or not a video)."}
    facts, problems = analyze(src, info, cfg)
    if not facts:
        return {"file": src.name, "ok": False, "error": problems[0]}
    dst = out_dir / (src.stem + ".mp4")
    crf = cfg["crf"]
    for _ in range(3):
        encode(src, dst, facts, cfg, crf)
        if dst.stat().st_size / 1_048_576 <= cfg["max_mb"]:
            break
        crf += 4
    (out_dir / (src.stem + ".txt")).write_text(caption_for(src, cfg), encoding="utf-8")
    out_facts, out_problems = analyze(dst, probe(dst), cfg)
    return {"file": src.name, "ok": True, "before": facts, "problems": problems,
            "after": out_facts, "remaining": out_problems, "output": dst.name}


def write_report(results, out_dir):
    lines = ["# Scoopz prep report", ""]
    for r in results:
        lines.append(f"## {r['file']}")
        if not r["ok"]:
            lines += [f"- FAILED: {r['error']}", ""]
            continue
        b, a = r["before"], r["after"]
        lines.append(f"- Before: {b['codec']} {b['width']}x{b['height']} {b['fps']}fps, "
                     f"{b['duration_s']}s, {b['size_mb']} MB, audio={b['audio']}, HDR={b['hdr']}")
        lines.append(f"- After:  {a['codec']} {a['width']}x{a['height']} {a['fps']}fps, "
                     f"{a['duration_s']}s, {a['size_mb']} MB, audio={a['audio']}")
        if r["problems"]:
            lines.append("- Fixed:")
            lines += [f"  - {p}" for p in r["problems"]]
        else:
            lines.append("- No technical problems found in the original.")
        if r["remaining"]:
            lines.append("- Still needs attention:")
            lines += [f"  - {p}" for p in r["remaining"]]
        lines.append(f"- Ready: `{r['output']}` + caption `{Path(r['output']).stem}.txt`")
        lines.append("")
    lines += [
        "## Check by hand before posting (a script can't detect these)",
        "- No copyrighted music, movie/TV clips, or other people's videos.",
        "- No TikTok/CapCut/Instagram watermark or logo.",
        "- Nothing that breaks Scoopz Community Guidelines (nudity, violence, hate, bullying, self-harm, minors).",
        "- Don't post many videos back-to-back; space them out.",
    ]
    (out_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="*", help="video files or folders (default: scoopz/inbox)")
    ap.add_argument("-o", "--out", default=str(HERE / "ready"), help="output folder")
    ap.add_argument("-c", "--config", default=str(HERE / "config.json"))
    args = ap.parse_args()

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        sys.exit("ffmpeg/ffprobe not found. Install ffmpeg first.")
    cfg = load_config(args.config)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    files = []
    for item in [Path(p) for p in (args.inputs or [HERE / "inbox"])]:
        if item.is_dir():
            files += sorted(p for p in item.iterdir() if p.suffix.lower() in VIDEO_EXTS)
        elif item.is_file():
            files.append(item)
    if not files:
        sys.exit("No videos found. Put videos in scoopz/inbox/ or pass file paths.")

    results = []
    for f in files:
        print(f"Processing {f.name} ...", flush=True)
        try:
            results.append(process(f, out_dir, cfg))
        except RuntimeError as e:
            results.append({"file": f.name, "ok": False, "error": f"ffmpeg failed: {e}"})
    print(write_report(results, out_dir))
    sys.exit(0 if all(r["ok"] for r in results) else 1)


if __name__ == "__main__":
    main()
