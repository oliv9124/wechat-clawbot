#!/usr/bin/env python3
"""
video_transcriber.py - 通用短视频解析、转录与核心要点提取工具
支持输入短视频链接或本地视频文件，自动提取完整字幕逐字稿并生成核心摘要。
"""

import os
import sys
import json
import time
import re
import argparse
import subprocess
from pathlib import Path

# 本地依赖库
try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None

def extract_audio(video_path, output_audio_path):
    """通过 ffmpeg 极速提取 16kHz 单声道音频"""
    cmd = [
        'ffmpeg', '-y', '-i', str(video_path),
        '-vn', '-ar', '16000', '-ac', '1',
        '-c:a', 'pcm_s16le', str(output_audio_path)
    ]
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return res.returncode == 0 and os.path.exists(output_audio_path)

def transcribe_audio_file(audio_path, model_size='base'):
    """使用本地缓存的 faster-whisper 模型进行语音转文字"""
    if not WhisperModel:
        raise RuntimeError("faster_whisper 未安装，请先 pip install faster-whisper")

    # 优先加载本地已有模型缓存
    model = WhisperModel(
        model_size,
        device='cpu',
        compute_type='int8',
        cpu_threads=2,
        local_files_only=True
    )

    segments, info = model.transcribe(
        str(audio_path),
        language='zh',
        beam_size=1,
        initial_prompt="以下是普通话中文口述内容，请使用简体中文及规范标点符号。"
    )

    full_text_list = []
    segment_data = []

    for s in segments:
        text = s.text.strip()
        if text:
            full_text_list.append(text)
            segment_data.append({
                'start': round(s.start, 2),
                'end': round(s.end, 2),
                'text': text
            })

    full_text = "".join(full_text_list)
    return {
        'language': info.language,
        'duration': round(info.duration, 2),
        'text': full_text,
        'segments': segment_data
    }

def summarize_text(text):
    """对提取出的文案进行要点提炼与智能排版"""
    if not text or len(text.strip()) == 0:
        return "该视频未识别到明显语音对话或人声台词。"

    # 按标点分句
    sentences = [s.strip() for s in re.split(r'[。！？\n]+', text) if len(s.strip()) > 6]
    if not sentences:
        return text

    if len(sentences) <= 3:
        return "\n".join([f"• {s}" for s in sentences])

    # 选取关键核心句生成结构化速览
    bullets = []
    step = max(1, len(sentences) // 4)
    for idx in range(0, min(len(sentences), 4 * step), step):
        if idx < len(sentences):
            bullets.append(f"• {sentences[idx]}")
    return "\n".join(bullets[:4])

def process_video(video_path, output_dir=None):
    """处理本地视频并提取文字"""
    if not os.path.exists(video_path):
        return {'success': False, 'error': f"文件不存在: {video_path}"}

    temp_audio = f"/tmp/transcribe_{int(time.time()*1000)}.wav"
    try:
        t0 = time.time()
        ok = extract_audio(video_path, temp_audio)
        if not ok:
            return {'success': False, 'error': "音频提取失败，请检查视频源文件"}

        res = transcribe_audio_file(temp_audio)
        summary = summarize_text(res['text'])

        return {
            'success': True,
            'video_path': str(video_path),
            'text': res['text'],
            'summary': summary,
            'duration_sec': res['duration'],
            'process_time_sec': round(time.time() - t0, 2),
            'segments': res['segments']
        }
    finally:
        if os.path.exists(temp_audio):
            try:
                os.remove(temp_audio)
            except Exception:
                pass

def resolve_category_dir(base_dir, platform):
    if not base_dir:
        base_dir = "/tmp"
    norm = os.path.normpath(base_dir)
    # 自动定位到 bot 的 data/downloads 物理目录
    if 'downloads' not in norm:
        candidate = os.path.join(norm, 'data', 'downloads')
        if os.path.exists(candidate):
            norm = candidate
    elif os.path.basename(norm) == 'downloads':
        parent = os.path.dirname(norm)
        candidate = os.path.join(parent, 'data', 'downloads')
        if os.path.exists(candidate):
            norm = candidate

    if os.path.basename(norm).lower() == platform.lower():
        cat_dir = norm
    else:
        cat_dir = os.path.join(norm, platform)
    os.makedirs(cat_dir, exist_ok=True)
    return cat_dir


def main():
    parser = argparse.ArgumentParser(description="短视频文案与台词提取工具")
    parser.add_argument("input", help="视频文件绝对路径或短视频 URL")
    parser.add_argument("--output-dir", help="若输入为 URL，指定视频下载的目标保存目录")
    parser.add_argument("--json", action="store_true", default=True, help="以 JSON 格式输出结果")

    parser.add_argument("--download-video", action="store_true", default=False, help="是否强制下载完整视频文件（默认B站不下载，抖音自动下载）")
    args = parser.parse_args()

    input_val = args.input.strip()

    # 如果是本地文件直接转录
    if os.path.exists(input_val):
        result = process_video(input_val, args.output_dir)
    elif re.search(r'(bilibili\.com|b23\.tv|BV[a-zA-Z0-9]{10})', input_val, re.IGNORECASE):
        # B站专属通道：优先提取字幕或纯音频，默认不下视频大文件
        bili_script = Path(__file__).resolve().parent / "bilibili_extractor.py"
        if not bili_script.exists():
            bili_script = Path("/root/agy/scripts/bilibili_extractor.py")

        out_dir = resolve_category_dir(args.output_dir, "bilibili")
        cmd = [sys.executable, str(bili_script), input_val, "--output-dir", out_dir]
        if args.download_video:
            cmd.append("--download-video")

        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.stdout.strip():
            print(proc.stdout.strip())
            sys.exit(proc.returncode)
        else:
            result = {'success': False, 'error': f"B站解析异常: {proc.stderr}"}
    else:
        # 自动探测并适配 playwright_download.py 脚本路径
        candidates = [
            Path(__file__).resolve().parent / "playwright_download.py",
            Path(__file__).resolve().parent.parent / "skills" / "douyin-downloader" / "scripts" / "playwright_download.py",
            Path(__file__).resolve().parent.parent / "wechat-clawbot-shareable" / "skills" / "douyin-downloader" / "scripts" / "playwright_download.py",
            Path("/root/agy/skills/douyin-downloader/scripts/playwright_download.py"),
            Path("/root/agy/wechat-clawbot-shareable/skills/douyin-downloader/scripts/playwright_download.py"),
        ]
        dl_script = next((c for c in candidates if c.exists()), None)
        if not dl_script:
            print(json.dumps({'success': False, 'error': '未找到 playwright_download.py 下载脚本'}, ensure_ascii=False))
            sys.exit(1)

        out_dir = resolve_category_dir(args.output_dir, "douyin")
        cmd = [sys.executable, str(dl_script), input_val, str(out_dir)]
        dl_proc = subprocess.run(cmd, capture_output=True, text=True)

        # 查找下载的 mp4
        downloaded_file = None
        for line in dl_proc.stdout.splitlines():
            if "下载完成:" in line:
                m = re.search(r'下载完成:\s*(\S+\.mp4)', line)
                if m:
                    downloaded_file = m.group(1).strip()
                    break

        if not downloaded_file or not os.path.exists(downloaded_file):
            result = {
                'success': False,
                'error': f"视频下载解析失败: {dl_proc.stderr or dl_proc.stdout}"
            }
        else:
            result = process_video(downloaded_file, out_dir)

    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
