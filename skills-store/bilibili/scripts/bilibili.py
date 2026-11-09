#!/usr/bin/env python3
"""B站（官方技能 bilibili）：读字幕，没有字幕才下载音频转文字；用户明确要视频时才下载 MP4。
用法：bilibili.py <B站链接、b23.tv 短链、分享文本或 BV 号> [--output-dir <机器人目录>/data/downloads] [--download-video]
凭证：这个机器人自己的 data/skills/bilibili/cookie.txt（用户在微信里发「设置凭证 B站 <cookie>」）。
     很多视频不登录拿不到 AI 字幕和音频；凭证也可以临时用环境变量 BILIBILI_COOKIE 给。
输出 JSON：{success, platform, bvid, title, video_path, from_subtitle, text, summary, duration_sec, process_time_sec, segments}
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2] / '_shared'))
sys.path.insert(0, str(HERE.parents[2] / 'transcribe' / 'scripts'))
from clawbot_skill import credential, downloads_dir, private_cookie_file  # noqa: E402

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
NEED_LOGIN = 'B站这条视频要登录才拿得到字幕和音频：请让用户在微信里发「设置凭证 B站 <cookie>」，存好以后再试。'


def load_cookie():
    return os.environ.get('BILIBILI_COOKIE', '').strip() or credential('bilibili')


def extract_bvid_or_url(text):
    """B站链接、b23.tv 短链、分享文本或 BV 号 → (BV号, 标准链接)"""
    text = text.strip()
    m = re.search(r'https?://[^\s<>\[\]【】()（）]+', text)
    url = m.group(0) if m else text
    if 'b23.tv' in url:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=8) as resp:
                url = resp.geturl()
        except urllib.error.HTTPError as e:
            url = e.headers.get('Location', url)
        except Exception:
            pass
    m = re.search(r'(BV[a-zA-Z0-9]{10})', url) or re.search(r'(BV[a-zA-Z0-9]{10})', text)
    bvid = m.group(1) if m else None
    return bvid, (f'https://www.bilibili.com/video/{bvid}' if bvid else url)


def api_get(url, bvid, cookie):
    headers = {'User-Agent': UA, 'Referer': f'https://www.bilibili.com/video/{bvid}'}
    if cookie:
        headers['Cookie'] = cookie
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=12) as resp:
        return json.loads(resp.read().decode('utf-8'))


WBI_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
           13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
_wbi_mixin = None


def wbi_query(params, bvid, cookie):
    """B站 WBI 签名：nav 接口给两段 key，按固定顺序打乱取前 32 位，和排好序的参数（加时间戳）一起算 md5"""
    global _wbi_mixin
    if not _wbi_mixin:
        img = (api_get('https://api.bilibili.com/x/web-interface/nav', bvid, cookie).get('data') or {}).get('wbi_img') or {}
        keys = ''.join(img[k].rsplit('/', 1)[-1].split('.')[0] for k in ('img_url', 'sub_url'))
        _wbi_mixin = ''.join(keys[i] for i in WBI_TAB if i < len(keys))[:32]
    p = dict(params, wts=round(time.time()))
    p = {k: ''.join(ch for ch in str(v) if ch not in "!'()*") for k, v in sorted(p.items())}
    q = urllib.parse.urlencode(p)
    return q + '&w_rid=' + hashlib.md5((q + _wbi_mixin).encode()).hexdigest()


def own_subtitles(subs, aid, cid, strict):
    """只留这个视频自己的字幕：AI 字幕的地址里带着 aid 和 cid（连在一起），对不上就是别的视频的。
    strict 时连 UP 主上传的字幕也要对得上（不签名的接口才这样，那个接口会随机给别的视频的字幕）"""
    mark = f'{aid}{cid}'
    return [s for s in subs if s.get('subtitle_url') and
            (mark in s['subtitle_url'].split('?')[0] or (not strict and not s.get('lan', '').startswith('ai-')))]


def player_subtitles(bvid, aid, cid, cookie):
    """字幕列表（带下载地址；AI 字幕要登录）。用带 WBI 签名的 player/wbi/v2，结果稳定；
    不签名的 player/v2 经常随机给别的视频的 AI 字幕或者不给，只在签名接口用不了时退回去，多问几次、严格核对"""
    try:
        d = api_get('https://api.bilibili.com/x/player/wbi/v2?' + wbi_query({'aid': aid, 'cid': cid, 'bvid': bvid}, bvid, cookie),
                    bvid, cookie)
        if d.get('code') == 0:
            return own_subtitles(((d.get('data') or {}).get('subtitle') or {}).get('subtitles') or [], aid, cid, strict=False)
        sys.stderr.write(f"[提示] 签名字幕接口返回 code={d.get('code')} {d.get('message')}，改用不签名的接口\n")
    except Exception as e:
        sys.stderr.write(f'[提示] 签名字幕接口出错，改用不签名的接口: {e}\n')
    for i in range(5):
        try:
            d = api_get(f'https://api.bilibili.com/x/player/v2?aid={aid}&cid={cid}&bvid={bvid}', bvid, cookie)
            subs = own_subtitles(((d.get('data') or {}).get('subtitle') or {}).get('subtitles') or [], aid, cid, strict=True)
            if subs:
                return subs
        except Exception as e:
            sys.stderr.write(f'[提示] 取字幕列表失败: {e}\n')
        time.sleep(0.3)
    return []


def video_info(bvid, cookie):
    """视频详情（标题、时长、aid、cid）和这个视频自己的字幕。view 接口给的字幕没有下载地址，要从播放器接口拿；
    拿不到对得上的字幕就当没有（改成下载音频转文字，慢一些但不会张冠李戴）"""
    try:
        data = api_get(f'https://api.bilibili.com/x/web-interface/view?bvid={bvid}', bvid, cookie)
    except urllib.error.HTTPError as e:
        return {'success': False, 'error': f'HTTP {e.code}: {e.reason}'}
    except Exception as e:
        return {'success': False, 'error': str(e)}
    if data.get('code') != 0 or 'data' not in data:
        return {'success': False, 'error': f"接口返回 code={data.get('code')} {data.get('message')}"}
    info = data['data']
    aid, cid = info.get('aid'), info.get('cid')
    subtitles = player_subtitles(bvid, aid, cid, cookie) if aid and cid else []
    return {'success': True, 'title': info.get('title') or bvid, 'duration': info.get('duration') or 0, 'aid': aid, 'cid': cid,
            'subtitles': subtitles}


def read_subtitle(subtitle_url):
    if subtitle_url.startswith('//'):
        subtitle_url = 'https:' + subtitle_url
    with urllib.request.urlopen(urllib.request.Request(subtitle_url, headers={'User-Agent': UA}), timeout=12) as resp:
        body = json.loads(resp.read().decode('utf-8')).get('body') or []
    segments = [{'start': round(i.get('from', 0.0), 2), 'end': round(i.get('to', 0.0), 2), 'text': i.get('content', '').strip()}
                for i in body if i.get('content', '').strip()]
    return '，'.join(s['text'] for s in segments), segments


def run_ytdlp(args, cookie, timeout):
    with private_cookie_file(cookie, '.bilibili.com') as cookie_path:
        cmd = ['yt-dlp', '--no-warnings', '-N', '8', '--add-header', 'Referer: https://www.bilibili.com/']
        if cookie:
            cmd += ['--cookies', cookie_path]
        return subprocess.run(cmd + args, capture_output=True, text=True, timeout=timeout)


def download_audio(url, bvid, cid, cookie, workdir, timeout=300):
    """只下载音频到 workdir：先用 yt-dlp；不行再用 B站 的播放地址接口直接拿音频流（主地址不行换备用地址）。返回文件路径"""
    errors = []
    try:
        proc = run_ytdlp(['-f', 'ba[ext=m4a]/ba', '-o', os.path.join(workdir, 'audio.%(ext)s'), url], cookie, timeout)
        got = [f for f in os.listdir(workdir) if f.startswith('audio.') and not f.endswith('.part')]
        if got and os.path.getsize(os.path.join(workdir, got[0])) > 1024:
            return os.path.join(workdir, got[0])
        errors.append(f"yt-dlp: {((proc.stderr or proc.stdout).strip().splitlines() or ['没有输出'])[-1]}")
    except Exception as e:
        errors.append(f'yt-dlp: {e}')
    if cid:
        try:
            play = api_get(f'https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&fnval=16', bvid, cookie)
            audios = ((play.get('data') or {}).get('dash') or {}).get('audio') or []
            if not audios:
                errors.append(f"播放地址接口: code={play.get('code')} 没有音频流")
            for stream in audios[:1]:
                for src in [stream.get('baseUrl')] + (stream.get('backupUrl') or []):
                    if not src:
                        continue
                    out = os.path.join(workdir, 'audio_dash.m4s')
                    try:
                        req = urllib.request.Request(src, headers={'User-Agent': UA, 'Referer': 'https://www.bilibili.com/'})
                        with urllib.request.urlopen(req, timeout=60) as resp, open(out, 'wb') as f:
                            shutil.copyfileobj(resp, f, 1 << 20)
                        if os.path.getsize(out) > 1024:
                            return out
                    except Exception as e:
                        errors.append(f'音频流 {src.split("/")[2]}: {e}')
        except Exception as e:
            errors.append(f'播放地址接口: {e}')
    raise RuntimeError('；'.join(str(e)[:160] for e in errors) or '音频下载失败')


def download_video(url, output_dir, cookie, timeout=600):
    """用户明确要视频时才调用：下载完整 MP4（H.264 + AAC，微信里能直接播）"""
    out_dir = downloads_dir('bilibili', output_dir)
    proc = run_ytdlp(['-f', 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                      '--merge-output-format', 'mp4', '--postprocessor-args', 'ffmpeg:-movflags +faststart',
                      '--print', 'after_move:filepath', '-o', os.path.join(out_dir, '%(id)s_%(title).50s.%(ext)s'), url], cookie, timeout)
    paths = [l.strip() for l in proc.stdout.splitlines() if l.strip().endswith('.mp4')]
    path = paths[-1] if paths else None
    if not path or not os.path.exists(path):
        return {'success': False, 'error': f"视频下载失败: {(proc.stderr or proc.stdout).strip()[-300:]}"}
    # 文件名去掉空格和标点，微信那边认路径更稳
    clean = os.path.join(os.path.dirname(path), re.sub(r'[\s()\[\]（）《》！？，、：；]+', '_', os.path.basename(path)))
    if clean != path:
        try:
            os.rename(path, clean)
            path = clean
        except OSError:
            pass
    return {'success': True, 'video_path': path}


def process(text, output_dir=None, want_video=False):
    t0 = time.time()
    bvid, url = extract_bvid_or_url(text)
    if not bvid:
        return {'success': False, 'error': f'没能从里面认出 B站视频（BV号）: {text[:80]}'}
    cookie = load_cookie()
    info = video_info(bvid, cookie)
    base = {'platform': 'bilibili', 'bvid': bvid, 'title': info.get('title', bvid)}
    full_text, segments, from_subtitle = '', [], False
    duration = info.get('duration') or 0
    subs = info.get('subtitles') or []
    if subs:
        pick = next((s for s in subs if 'zh' in s.get('lan', '')), subs[0])
        try:
            full_text, segments = read_subtitle(pick['subtitle_url'])
            # 有的字幕只有音乐符号或寥寥几个字；字幕比视频还长说明是别的视频的：都当成没有字幕
            if len(re.sub(r'[♪\s\d:，。！？【】]+', '', full_text)) < 30:
                full_text, segments = '', []
            elif duration and segments and segments[-1]['end'] > duration + 30:
                sys.stderr.write('[提示] 字幕比视频还长，不是这个视频的，改成下载音频转文字\n')
                full_text, segments = '', []
            else:
                from_subtitle = True
        except Exception as e:
            sys.stderr.write(f'[提示] 读字幕失败，改成下载音频转文字: {e}\n')
    if not full_text:
        workdir = tempfile.mkdtemp(prefix='clawbot-bili-')
        try:
            audio = download_audio(url, bvid, info.get('cid'), cookie, workdir)
            from transcribe import transcribe_media
            tr = transcribe_media(audio)
            if not tr.get('success'):
                return {'success': False, **base, 'error': f"转文字失败: {tr.get('error')}"}
            full_text, segments, duration = tr['text'], tr['segments'], duration or tr.get('duration_sec', 0)
        except Exception as e:
            err = str(e)
            if not cookie or '412' in err or '-352' in err or 'Precondition' in err:
                return {'success': False, **base, 'error': NEED_LOGIN if not cookie else f'B站拒绝了请求（风控）：{err[:200]}'}
            return {'success': False, **base, 'error': f'音频下载失败: {err[:300]}'}
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
    from transcribe import summarize_text
    video_path = None
    if want_video:
        dl = download_video(url, output_dir, cookie)
        video_path = dl.get('video_path')
        if not dl['success']:
            base['video_error'] = dl['error']
    return {'success': True, **base, 'video_path': video_path, 'from_subtitle': from_subtitle, 'text': full_text,
            'summary': summarize_text(full_text), 'duration_sec': duration, 'process_time_sec': round(time.time() - t0, 2),
            'segments': segments}


def main():
    ap = argparse.ArgumentParser(description='B站：读字幕或转文字，按需下载视频')
    ap.add_argument('input', help='B站链接、b23.tv 短链、分享文本或 BV 号')
    ap.add_argument('--output-dir', help='下载视频时放哪里（默认这个机器人的 data/downloads/bilibili/）')
    ap.add_argument('--download-video', action='store_true', help='同时下载完整 MP4（用户明确要视频时才加）')
    args = ap.parse_args()
    try:
        res = process(args.input, args.output_dir, args.download_video)
    except Exception as e:
        res = {'success': False, 'platform': 'bilibili', 'error': f'出错: {e}'}
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
