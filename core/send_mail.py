#!/usr/bin/env python3
"""
发一封告警邮件，供 monitor.js 调用。只用 Python 自带的 smtplib，不需要装别的包。
从标准输入读一个 JSON：host、port、mode、user、password、from、to、subject、body。
授权码只经标准输入传进来，不出现在命令行和日志里；出错时只把错误原因写到标准错误，然后以 1 退出。
mode：ssl（默认，端口一般是 465）/ starttls（端口一般是 587）/ plain（不加密，只用于本机测试）
"""
import json
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid, parseaddr


def main():
    cfg = json.load(sys.stdin)
    mode = cfg.get('mode') or 'ssl'
    port = int(cfg.get('port') or {'ssl': 465, 'starttls': 587}.get(mode, 25))
    sender = parseaddr(cfg.get('from') or cfg['user'])[1]
    to = cfg['to'] if isinstance(cfg['to'], list) else [a.strip() for a in str(cfg['to']).split(',') if a.strip()]

    msg = EmailMessage()
    msg['Subject'] = cfg['subject']
    msg['From'] = formataddr(('ClawBot 告警', sender))
    msg['To'] = ', '.join(to)
    msg['Date'] = formatdate(localtime=True)
    msg['Message-ID'] = make_msgid(domain=sender.split('@')[-1] or 'localhost')
    msg.set_content(cfg['body'])

    if mode == 'ssl':
        server = smtplib.SMTP_SSL(cfg['host'], port, timeout=20, context=ssl.create_default_context())
    else:
        server = smtplib.SMTP(cfg['host'], port, timeout=20)
    with server:
        if mode == 'starttls':
            server.starttls(context=ssl.create_default_context())
        if cfg.get('user') and cfg.get('password'):
            server.login(cfg['user'], cfg['password'])
        server.send_message(msg, from_addr=sender, to_addrs=to)


if __name__ == '__main__':
    try:
        main()
    except Exception as err:  # 只输出错误类型和服务器给的原因，不带配置内容
        print(f'{type(err).__name__}: {err}', file=sys.stderr)
        sys.exit(1)
