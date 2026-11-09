#!/usr/bin/env python3
"""抖音（官方技能 douyin）：下载无水印原画视频，默认接着转出逐字稿和要点。
用法：douyin.py <抖音链接或分享文本> [--output-dir <机器人目录>/data/downloads] [--no-transcribe]
凭证（可选）：这个机器人自己的 data/skills/douyin/cookie.txt（用户在微信里发「设置凭证 抖音 <cookie>」）。没有也能下大部分视频。
输出 JSON：{success, platform, video_path, size_mb, text, summary, segments, duration_sec, process_time_sec}
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2] / '_shared'))
sys.path.insert(0, str(HERE.parents[2] / 'transcribe' / 'scripts'))
from clawbot_skill import cookie_dict, credential, downloads_dir  # noqa: E402

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'


def resolve_video_id(text):
    """分享文本、短链、网页链接 → 视频 ID"""
    m = re.search(r'https?://[^\s<>\[\]【】()（）]+', text)
    url = m.group(0) if m else text.strip()
    if 'v.douyin.com' in url:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=10) as resp:
                url = resp.geturl()
        except urllib.error.HTTPError as e:
            url = e.headers.get('Location', url)
    m = re.search(r'video/(\d+)', url) or re.search(r'modal_id=(\d+)', url)
    return m.group(1) if m else None


async def fetch_detail(video_id, cookies):
    """用无头 Chromium 打开视频页，截下页面自己请求的视频详情"""
    from playwright.async_api import async_playwright
    event = asyncio.Event()
    detail = {}
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(user_agent=UA, viewport={'width': 1280, 'height': 800})
        if cookies:
            await context.add_cookies([{'name': k, 'value': v, 'domain': '.douyin.com', 'path': '/'} for k, v in cookies.items()])
        page = await context.new_page()

        async def on_response(response):
            if '/aweme/v1/web/aweme/detail/' in response.url and response.status == 200:
                try:
                    detail['data'] = await response.json()
                    event.set()
                except Exception:
                    pass

        page.on('response', on_response)
        try:
            await page.goto(f'https://www.douyin.com/video/{video_id}?previous_page=web_code_link', wait_until='domcontentloaded', timeout=40000)
            await asyncio.wait_for(event.wait(), timeout=35.0)
        except Exception as e:
            sys.stderr.write(f'[提示] 等待视频详情: {e}\n')
        finally:
            await browser.close()
    return (detail.get('data') or {}).get('aweme_detail') or {}


def download(text, output_dir=None):
    video_id = resolve_video_id(text)
    if not video_id:
        return {'success': False, 'error': '没能从链接里认出抖音视频 ID'}
    aweme = asyncio.run(fetch_detail(video_id, cookie_dict(credential('douyin'))))
    if not aweme:
        hint = '' if credential('douyin') else '（这个机器人还没有抖音凭证，可以让用户在微信里发「设置凭证 抖音 <cookie>」再试）'
        return {'success': False, 'error': f'没拿到视频详情{hint}'}
    video = aweme.get('video') or {}
    urls = ((video.get('play_addr') or {}) or (video.get('play_addr_h264') or {})).get('url_list') or []
    if not urls:
        return {'success': False, 'error': '没找到视频直链'}
    safe = re.sub(r'[\\/*?:"<>|# \r\n\t]+', '_', aweme.get('desc') or video_id)[:50].strip('_')
    out = os.path.join(downloads_dir('douyin', output_dir), f'{video_id}_{safe}.mp4')
    req = urllib.request.Request(urls[0], headers={'User-Agent': UA, 'Referer': 'https://www.douyin.com/'})
    with urllib.request.urlopen(req, timeout=60) as resp, open(out, 'wb') as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    return {'success': True, 'video_path': out, 'size_mb': round(os.path.getsize(out) / 1048576, 2)}


def main():
    ap = argparse.ArgumentParser(description='抖音：下载无水印视频，默认转出逐字稿和要点')
    ap.add_argument('input', help='抖音链接或分享文本')
    ap.add_argument('--output-dir', help='下载到哪里（默认这个机器人的 data/downloads/douyin/）')
    ap.add_argument('--no-transcribe', action='store_true', help='只下载，不转文字')
    args = ap.parse_args()
    t0 = time.time()
    try:
        res = download(args.input, args.output_dir)
    except Exception as e:
        res = {'success': False, 'error': f'下载出错: {e}'}
    res['platform'] = 'douyin'
    if res.get('success') and not args.no_transcribe:
        from transcribe import transcribe_media
        tr = transcribe_media(res['video_path'])
        if tr.get('success'):
            res.update({k: tr[k] for k in ('text', 'summary', 'segments', 'duration_sec', 'waited_sec')})
        else:
            res['transcribe_error'] = tr.get('error')
    res['process_time_sec'] = round(time.time() - t0, 2)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
