#!/usr/bin/env python3
import asyncio
import os
import re
import sys
import urllib.parse
import urllib.request
import yaml
from playwright.async_api import async_playwright

async def download_douyin_video(url, output_dir=None):
    if not output_dir:
        output_dir = os.environ.get('DOUYIN_OUTPUT_DIR', '/tmp/downloads/douyin')
    else:
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
        if os.path.basename(norm).lower() != 'douyin':
            output_dir = os.path.join(norm, 'douyin')
        else:
            output_dir = norm
    os.makedirs(output_dir, exist_ok=True)

    # 1. 解析短链
    if 'v.douyin.com' in url:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                url = resp.geturl()
        except urllib.error.HTTPError as e:
            url = e.headers.get('Location', url)
    print('目标链接:', url)

    m = re.search(r'video/(\d+)', url)
    if not m:
        print('未能在链接中提取出视频ID:', url)
        return None
    video_id = m.group(1)
    target_page = f'https://www.douyin.com/video/{video_id}?previous_page=web_code_link'

    # 2. 读取配置与 Cookie
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    config_path = os.environ.get('DOUYIN_CONFIG_PATH', os.path.join(base_dir, 'douyin-downloader-main', 'config.yml'))
    cookies_dict = {}
    if os.path.exists(config_path):
        try:
            with open(config_path) as f:
                cfg = yaml.safe_load(f) or {}
            cookies_dict = cfg.get('cookies', {})
        except Exception:
            pass

    detail_event = asyncio.Event()
    detail_data = {}

    # 3. 通过无头 Chromium 模拟真实页面上下文
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            viewport={'width': 1280, 'height': 800}
        )
        cookies_list = [
            {'name': k, 'value': str(v), 'domain': '.douyin.com', 'path': '/'}
            for k, v in cookies_dict.items()
        ]
        await context.add_cookies(cookies_list)
        page = await context.new_page()

        async def on_response(response):
            if '/aweme/v1/web/aweme/detail/' in response.url and response.status == 200:
                try:
                    data = await response.json()
                    detail_data['data'] = data
                    detail_event.set()
                except Exception:
                    pass

        page.on('response', on_response)

        try:
            await page.goto(target_page, wait_until='domcontentloaded', timeout=40000)
            await asyncio.wait_for(detail_event.wait(), timeout=35.0)
        except Exception as e:
            print('等待页面事件提示:', e)
        finally:
            await browser.close()

    if not detail_data.get('data'):
        print('未能截获视频详情数据')
        return None

    aweme_detail = detail_data['data'].get('aweme_detail', {})
    desc = aweme_detail.get('desc', video_id)
    safe_desc = re.sub(r'[\\/*?:\"<>|# ]+', '_', desc)[:50].strip('_')
    out_filename = f'{video_id}_{safe_desc}.mp4'
    out_filepath = os.path.join(output_dir, out_filename)

    video = aweme_detail.get('video', {})
    play_addr = video.get('play_addr', {}) or video.get('play_addr_h264', {})
    url_list = play_addr.get('url_list', [])
    if not url_list:
        print('未找到视频播放直链')
        return None

    download_url = url_list[0]
    print('正在下载无水印原画视频:', download_url[:70])

    dl_req = urllib.request.Request(download_url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Referer': 'https://www.douyin.com/'
    })
    with urllib.request.urlopen(dl_req, timeout=40) as resp, open(out_filepath, 'wb') as f:
        f.write(resp.read())

    size_mb = os.path.getsize(out_filepath) / (1024 * 1024)
    print(f'下载完成: {out_filepath} ({size_mb:.2f} MB)')

    return out_filepath

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python3 playwright_download.py <douyin_url> [output_dir]')
        sys.exit(1)
    url = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    res = asyncio.run(download_douyin_video(url, out))
    if not res:
        sys.exit(1)
