#!/usr/bin/env python3
"""转文字（官方技能 transcribe）：用本地 faster-whisper（CPU int8）把音频或视频转成逐字稿和要点。
全服务器同一时间只跑一个转写，其他的排队（见 _shared/clawbot_skill.py）。
用法：transcribe.py <音频或视频文件> [--model base]
输出 JSON：{success, video_path, text, summary, segments, duration_sec, process_time_sec, waited_sec}
别的技能可以直接 import：from transcribe import transcribe_media, summarize_text
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / '_shared'))
from clawbot_skill import transcribe_slot  # noqa: E402

try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None


def extract_audio(src, dst):
    """ffmpeg 抽出 16kHz 单声道音频"""
    res = subprocess.run(['ffmpeg', '-y', '-i', str(src), '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', str(dst)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return res.returncode == 0 and os.path.getsize(dst) > 0


def transcribe_audio_file(audio_path, model_size='base'):
    """用本地缓存的 faster-whisper 模型转文字（不联网下载模型）"""
    if not WhisperModel:
        raise RuntimeError('faster_whisper 没装，需要管理员 pip install faster-whisper')
    model = WhisperModel(model_size, device='cpu', compute_type='int8', cpu_threads=2, local_files_only=True)
    segments, info = model.transcribe(str(audio_path), language='zh', beam_size=1,
                                      initial_prompt='以下是普通话中文口述内容，请使用简体中文及规范标点符号。')
    texts, segs = [], []
    for s in segments:
        t = s.text.strip()
        if t:
            texts.append(t)
            segs.append({'start': round(s.start, 2), 'end': round(s.end, 2), 'text': t})
    return {'language': info.language, 'duration': round(info.duration, 2), 'text': ''.join(texts), 'segments': segs}


def summarize_text(text):
    """从逐字稿里挑几句关键句，排成要点"""
    if not text or not text.strip():
        return '这段内容没有识别到明显的人声台词。'
    sentences = [s.strip() for s in re.split(r'[。！？\n]+', text) if len(s.strip()) > 6]
    if not sentences:
        return text
    if len(sentences) <= 3:
        return '\n'.join(f'• {s}' for s in sentences)
    step = max(1, len(sentences) // 4)
    return '\n'.join(f'• {sentences[i]}' for i in range(0, min(len(sentences), 4 * step), step))[:2000]


def transcribe_media(path, model_size='base'):
    """音频或视频文件 → 文字。排到空位才开始；临时文件用完就删"""
    if not os.path.exists(path):
        return {'success': False, 'error': f'文件不存在: {path}'}
    t0 = time.time()
    fd, wav = tempfile.mkstemp(prefix='clawbot-transcribe-', suffix='.wav')
    os.close(fd)
    try:
        with transcribe_slot() as waited:
            if not extract_audio(path, wav):
                return {'success': False, 'error': '音频提取失败，请检查文件'}
            res = transcribe_audio_file(wav, model_size)
        return {'success': True, 'text': res['text'], 'summary': summarize_text(res['text']), 'segments': res['segments'],
                'duration_sec': res['duration'], 'process_time_sec': round(time.time() - t0, 2), 'waited_sec': waited}
    except TimeoutError as e:
        return {'success': False, 'error': str(e)}
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser(description='把音频或视频转成文字（本地 Whisper，全服务器排队）')
    ap.add_argument('input', help='音频或视频文件的路径')
    ap.add_argument('--model', default='base', help='Whisper 模型（默认 base，已缓存在服务器上）')
    args = ap.parse_args()
    res = transcribe_media(args.input, args.model)
    if res.get('success'):
        res = {'success': True, 'video_path': args.input, **{k: v for k, v in res.items() if k != 'success'}}
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
