#!/usr/bin/env python3
"""
bilibili_extractor.py - B站视频字幕极速提取与纯音频转录工具
特点：
1. 默认轻量模式：仅提取官方/AI字幕或仅下载纯音频转录文案，不下载庞大视频文件；
2. 只有明确传入 --download-video 时，才下载完整 mp4 视频；
3. 支持读取 ../config/bilibili_config.json 中的 Cookie 解决机房 IP 412 风控问题。
"""

import os
import sys
import json
import time
import re
import argparse
import subprocess
import urllib.request
import urllib.parse
from pathlib import Path

# 尝试加载同一目录下的通用视频转录模块
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
CONFIG_DIR = SKILL_DIR / "config"
CONFIG_FILE = CONFIG_DIR / "bilibili_config.json"

try:
    from video_transcriber import transcribe_audio_file, summarize_text
except ImportError:
    # 动态导入
    sys.path.append(str(SCRIPT_DIR))
    from video_transcriber import transcribe_audio_file, summarize_text


def load_bilibili_cookie():
    """读取并合成可用的 B站 Cookie 字符串"""
    cookie_str = os.environ.get("BILIBILI_COOKIE", "").strip()
    if cookie_str:
        return cookie_str

    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)

            if cfg.get("cookie", "").strip():
                return cfg["cookie"].strip()

            parts = []
            if cfg.get("sessdata", "").strip():
                parts.append(f"SESSDATA={cfg['sessdata'].strip()}")
            if cfg.get("bili_jct", "").strip():
                parts.append(f"bili_jct={cfg['bili_jct'].strip()}")
            if cfg.get("buvid3", "").strip():
                parts.append(f"buvid3={cfg['buvid3'].strip()}")

            if parts:
                return "; ".join(parts)
        except Exception as e:
            sys.stderr.write(f"[警告] 读取 bilibili_config.json 异常: {e}\n")

    return ""


def extract_bvid_or_url(input_str):
    """解析 B站链接或短链（b23.tv），提取标准 BV 号与目标 URL"""
    input_str = input_str.strip()

    # 提取文本中的 url (清理两端的中英文括号及特殊字符)
    m_url = re.search(r'https?://[^\s<>\[\]【】\(\)（）]+', input_str)
    url = m_url.group(0) if m_url else input_str

    # 若为 b23.tv 短链，先请求获取 302 重定向后的真实地址
    if "b23.tv" in url:
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                url = resp.geturl()
        except urllib.error.HTTPError as e:
            url = e.headers.get("Location", url)
        except Exception:
            pass

    # 提取 BV 号
    m_bv = re.search(r'(BV[a-zA-Z0-9]{10})', url, re.IGNORECASE)
    bvid = m_bv.group(1) if m_bv else None

    # 如果输入直接是 BV 号
    if not bvid and re.match(r'^BV[a-zA-Z0-9]{10}$', input_str, re.IGNORECASE):
        bvid = input_str

    # 若提取到 BV 号，始终以标准无参数 URL 为准，杜绝脏参数干扰
    if bvid:
        url = f"https://www.bilibili.com/video/{bvid}"

    return bvid, url


def get_video_info_and_subtitles(bvid, cookie=""):
    """
    通过 B站官方 API 获取视频详情与官方/AI字幕
    """
    api_url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Referer": f"https://www.bilibili.com/video/{bvid}",
    }
    if cookie:
        headers["Cookie"] = cookie

    req = urllib.request.Request(api_url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") == 0 and "data" in data:
                res_data = data["data"]
                return {"success": True, "data": res_data}
            else:
                return {"success": False, "error": f"API返回错误: code={data.get('code')}, msg={data.get('message')}"}
    except urllib.error.HTTPError as e:
        return {"success": False, "error": f"HTTP {e.code}: {e.reason}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def parse_subtitle_json(subtitle_url):
    """下载并解析 B站字幕 JSON 格式"""
    if subtitle_url.startswith("//"):
        subtitle_url = "https:" + subtitle_url

    req = urllib.request.Request(
        subtitle_url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        sub_data = json.loads(resp.read().decode("utf-8"))

    body = sub_data.get("body", [])
    full_text_list = []
    segments = []

    for item in body:
        text = item.get("content", "").strip()
        if text:
            full_text_list.append(text)
            segments.append({
                "start": round(item.get("from", 0.0), 2),
                "end": round(item.get("to", 0.0), 2),
                "text": text
            })

    full_text = "，".join(full_text_list)
    return full_text, segments


def download_audio_and_transcribe(video_url, cookie="", timeout_sec=240):
    """
    若无字幕，使用 yt-dlp 仅下载音频流并通过 Whisper 转录
    使用 8 线程并发下载 (-N 8) 与原生 m4a 流，杜绝转码耗时与超时卡顿
    """
    temp_audio = f"/tmp/bili_audio_{int(time.time()*1000)}.m4a"
    cmd = [
        "yt-dlp",
        "--no-warnings",
        "-N", "8",
        "-f", "ba[ext=m4a]/ba",
        "-o", temp_audio,
        "--add-header", "Referer: https://www.bilibili.com/",
    ]
    if cookie:
        cmd.extend(["--add-header", f"Cookie: {cookie}"])

    cmd.append(video_url)

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
        if not os.path.exists(temp_audio):
            return {"success": False, "error": f"音频下载失败: {proc.stderr or proc.stdout}"}

        trans_res = transcribe_audio_file(temp_audio)
        return {
            "success": True,
            "text": trans_res["text"],
            "segments": trans_res["segments"],
            "duration": trans_res["duration"]
        }
    finally:
        if os.path.exists(temp_audio):
            try:
                os.remove(temp_audio)
            except Exception:
                pass


def download_bilibili_video(video_url, output_dir, cookie="", timeout_sec=300):
    """
    仅在用户明确指令时调用：使用 yt-dlp 下载完整视频 MP4 (多线程加速)
    """
    if output_dir:
        norm = os.path.normpath(output_dir)
        if 'downloads' not in norm:
            candidate = os.path.join(norm, 'data', 'downloads')
            if os.path.exists(candidate):
                norm = candidate
        elif os.path.basename(norm) == 'downloads':
            parent = os.path.dirname(norm)
            candidate = os.path.join(parent, 'data', 'downloads')
            if os.path.exists(candidate):
                norm = candidate
        if os.path.basename(norm).lower() != 'bilibili':
            output_dir = os.path.join(norm, 'bilibili')
        else:
            output_dir = norm
    else:
        output_dir = "/tmp/downloads/bilibili"
    os.makedirs(output_dir, exist_ok=True)
    out_template = os.path.join(output_dir, "%(id)s_%(title).50s.%(ext)s")
    cmd = [
        "yt-dlp",
        "--no-warnings",
        "-N", "8",
        "-f", "bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "--postprocessor-args", "ffmpeg:-movflags +faststart",
        "-o", out_template,
        "--add-header", "Referer: https://www.bilibili.com/",
    ]
    if cookie:
        cmd.extend(["--add-header", f"Cookie: {cookie}"])
    cmd.append(video_url)

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
    
    # 查找下载的 mp4
    downloaded_file = None
    for line in proc.stdout.splitlines():
        if "[Merger] Merging formats into" in line:
            m = re.search(r'Merging formats into "([^"]+\.mp4)"', line)
            if m:
                downloaded_file = m.group(1)
                break
        elif "[download] Destination:" in line:
            m = re.search(r'Destination:\s*(\S+\.mp4)', line)
            if m:
                downloaded_file = m.group(1)
                break

    if not downloaded_file or not os.path.exists(downloaded_file):
        return {"success": False, "error": f"视频下载失败: {proc.stderr or proc.stdout}"}

    # 规范化文件名：去除空格与特殊标点，确保微信端与提取正则 100% 完美匹配
    dir_name = os.path.dirname(downloaded_file)
    base_name = os.path.basename(downloaded_file)
    clean_name = re.sub(r'[\s\(\)\[\]（）《》！？，、：；]+', '_', base_name)
    if clean_name != base_name:
        clean_path = os.path.join(dir_name, clean_name)
        try:
            os.rename(downloaded_file, clean_path)
            downloaded_file = clean_path
        except Exception:
            pass

    return {"success": True, "video_path": downloaded_file}


def process_bilibili(input_str, output_dir="/tmp", download_video=False):
    """
    B站视频处理主函数
    """
    t0 = time.time()
    bvid, full_url = extract_bvid_or_url(input_str)
    if not bvid:
        return {"success": False, "error": f"未能解析出有效的 B站 BV号或链接: {input_str}"}

    cookie = load_bilibili_cookie()

    # 1. 尝试直接获取视频详情与官方字幕 (0 MB 视频下载，极速秒出)
    info_res = get_video_info_and_subtitles(bvid, cookie)
    title = bvid
    video_duration = 0
    subtitles = []

    if info_res["success"]:
        v_data = info_res["data"]
        title = v_data.get("title", bvid)
        video_duration = v_data.get("duration", 0)
        subtitles = v_data.get("subtitle", {}).get("list", [])

    full_text = ""
    segments = []
    from_subtitle = False

    # 若存在官方字幕，直接秒级解析字幕
    if subtitles:
        try:
            # 优先匹配中文或第一条字幕
            target_sub = next((s for s in subtitles if "zh" in s.get("lan", "") or "ai" in s.get("lan", "")), subtitles[0])
            sub_url = target_sub.get("subtitle_url", "")
            if sub_url:
                parsed_text, parsed_segs = parse_subtitle_json(sub_url)
                # 检查字幕是否仅包含音乐标签或字数过少（很多 B站 视频 AI 字幕只有前奏音乐符）
                meaningful_chars = re.sub(r'[♪\s\d:，。！？【】]+', '', parsed_text)
                if len(meaningful_chars) >= 30:
                    full_text = parsed_text
                    segments = parsed_segs
                    from_subtitle = True
                else:
                    sys.stderr.write("[提示] 官方字幕仅包含音乐标签或有效字数过少，自动切换至纯音频转录通道...\n")
        except Exception as e:
            sys.stderr.write(f"[提示] 解析官方字幕异常，切换至音频转录通道: {e}\n")

    # 若无官方字幕，走纯音频下载 + 本地 Whisper 转录
    if not full_text:
        audio_res = download_audio_and_transcribe(full_url, cookie)
        if not audio_res["success"]:
            # 若失败，返回友好错误提示（如果是风控 412 则清晰指导）
            err_msg = audio_res["error"]
            if "412" in err_msg or "Precondition Failed" in err_msg or not cookie:
                return {
                    "success": False,
                    "platform": "bilibili",
                    "bvid": bvid,
                    "title": title,
                    "error": "B站触发了云服务器机房 IP 风控(HTTP 412)。请在 config/bilibili_config.json 中配置一次 B站 Cookie 即可畅享解析！"
                }
            return {"success": False, "error": f"音频转录失败: {err_msg}"}

        full_text = audio_res["text"]
        segments = audio_res["segments"]
        if not video_duration:
            video_duration = audio_res.get("duration", 0)

    # 2. 结构化总结提炼
    summary = summarize_text(full_text)

    # 3. 检查是否需要下载完整 MP4 视频
    video_path = None
    if download_video:
        dl_res = download_bilibili_video(full_url, output_dir, cookie)
        if dl_res["success"]:
            video_path = dl_res["video_path"]

    return {
        "success": True,
        "platform": "bilibili",
        "bvid": bvid,
        "title": title,
        "video_path": video_path,
        "from_subtitle": from_subtitle,
        "text": full_text,
        "summary": summary,
        "duration_sec": video_duration,
        "process_time_sec": round(time.time() - t0, 2),
        "segments": segments
    }


def main():
    parser = argparse.ArgumentParser(description="B站视频文案提取与核心要点总结工具")
    parser.add_argument("input", help="B站视频分享文本、链接（b23.tv 或 bilibili.com）或 BV号")
    parser.add_argument("--output-dir", default="/tmp", help="若指定下载视频，视频保存目标目录")
    parser.add_argument("--download-video", action="store_true", default=False, help="是否下载完整视频 MP4（默认不下载，仅提取文案）")
    parser.add_argument("--json", action="store_true", default=True, help="以 JSON 格式输出结果")

    args = parser.parse_args()
    res = process_bilibili(args.input, args.output_dir, args.download_video)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
