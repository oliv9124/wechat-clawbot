"""官方技能共用的小工具：机器人目录、这个机器人自己的凭证、下载目录、只有自己能读的临时 cookie 文件、转文字排队。"""
import contextlib
import fcntl
import os
import signal
import sys
import tempfile
import time
from pathlib import Path

STORE = Path(__file__).resolve().parents[1]
LOCK_PATH = os.environ.get('CLAWBOT_TRANSCRIBE_LOCK', '/dev/shm/clawbot-transcribe.lock')


def _stop(signum, frame):
    raise SystemExit(128 + signum)


# 被叫停（超时、智能体或服务停掉时发 SIGTERM）也照样走 finally：临时 cookie 文件、临时音频都删掉。
# Python 默认收到 SIGTERM 直接退出，不走 finally，会在 /tmp 里留下东西
try:
    if signal.getsignal(signal.SIGTERM) == signal.SIG_DFL:
        signal.signal(signal.SIGTERM, _stop)
except ValueError:  # 不是在主线程里导入的：设不了，照旧
    pass


def bot_dir():
    """机器人目录：智能体执行命令时的工作目录就是它（测试时可以用 CLAWBOT_BOT_DIR 指定）"""
    return Path(os.environ.get('CLAWBOT_BOT_DIR') or os.getcwd()).resolve()


def credential(skill):
    """这个机器人自己存的凭证（data/skills/<技能>/cookie.txt，只有它自己能读）；没有就是空字符串"""
    try:
        return (bot_dir() / 'data' / 'skills' / skill / 'cookie.txt').read_text(encoding='utf-8').strip()
    except OSError:
        return ''


def cookie_dict(cookie):
    """"名字=值; 名字=值" → {名字: 值}"""
    out = {}
    for item in (cookie or '').split(';'):
        if '=' in item:
            k, v = item.strip().split('=', 1)
            if k.strip():
                out[k.strip()] = v.strip()
    return out


def downloads_dir(platform, output_dir=None):
    """下载目录 <机器人目录>/data/downloads/<平台>/。output_dir 写机器人目录、data/downloads 或平台目录本身都行"""
    if output_dir:
        norm = os.path.normpath(output_dir)
        if 'downloads' not in norm:
            candidate = os.path.join(norm, 'data', 'downloads')
            if os.path.isdir(candidate):
                norm = candidate
        elif os.path.basename(norm) == 'downloads':
            candidate = os.path.join(os.path.dirname(norm), 'data', 'downloads')
            if os.path.isdir(candidate):
                norm = candidate
    else:
        norm = str(bot_dir() / 'data' / 'downloads')
    out = norm if os.path.basename(norm).lower() == platform else os.path.join(norm, platform)
    os.makedirs(out, exist_ok=True)
    return out


@contextlib.contextmanager
def private_cookie_file(cookie, domain):
    """给 yt-dlp 用的 Netscape 格式 cookie 文件：只有自己能读（0600），用完就删。不用 --add-header 传 cookie"""
    fd, path = tempfile.mkstemp(prefix='clawbot-cookie-', suffix='.txt')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write('# Netscape HTTP Cookie File\n')
            for k, v in cookie_dict(cookie).items():
                f.write(f'{domain}\tTRUE\t/\tFALSE\t2147483647\t{k}\t{v}\n')
        yield path
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _open_lock():
    # 世界可写的 /dev/shm 里，系统不让对别人建的文件用 O_CREAT：先打开已有的，没有才新建
    try:
        return os.open(LOCK_PATH, os.O_RDONLY)
    except FileNotFoundError:
        pass
    try:
        fd = os.open(LOCK_PATH, os.O_RDONLY | os.O_CREAT | os.O_EXCL, 0o644)
        try:
            os.fchmod(fd, 0o644)
        except OSError:
            pass
        return fd
    except FileExistsError:
        return os.open(LOCK_PATH, os.O_RDONLY)


@contextlib.contextmanager
def transcribe_slot(wait_sec=1800):
    """全服务器同一时间只跑一个转写（2 核 3G），其他的排队；所有机器人（包括沙箱里的）共用 /dev/shm 里的一把锁。
    给出排队等了多少秒；等太久抛 TimeoutError"""
    fd = _open_lock()
    t0 = time.time()
    told = False
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if not told:
                    sys.stderr.write('[排队] 另一个转写正在跑，等它跑完…\n')
                    told = True
                if time.time() - t0 > wait_sec:
                    raise TimeoutError(f'转写排队超过 {wait_sec // 60} 分钟，稍后再试')
                time.sleep(2)
        yield round(time.time() - t0, 1)
    finally:
        os.close(fd)
