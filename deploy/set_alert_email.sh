#!/bin/bash
# 配置告警邮件：按提示填写发信邮箱和授权码，写进告警配置（权限 600），然后可以发一封测试邮件。
# 告警配置的位置：root 执行时是 /etc/clawbot/alert.json（只有 root 能读）；普通账号执行时是项目目录下的 alert.json。
# 也可以用环境变量 CLAWBOT_ALERT_CONFIG 指定。用法：bash deploy/set_alert_email.sh
# 授权码输入时不显示，只写进上面这个文件，不会出现在命令行、日志或 git 里。重新运行就是修改。
set -euo pipefail
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$PROJECT/core"
if [ -n "${CLAWBOT_ALERT_CONFIG:-}" ]; then
  CONFIG=$CLAWBOT_ALERT_CONFIG
elif [ "$(id -u)" = 0 ]; then
  CONFIG=/etc/clawbot/alert.json
else
  CONFIG="$PROJECT/alert.json"
fi
NODE=/opt/node22/bin/node
[ -x "$NODE" ] || NODE=node

case "$CONFIG" in /etc/*) [ "$(id -u)" = 0 ] || { echo "$CONFIG 要用 root 才能写"; exit 1; } ;; esac
command -v python3 >/dev/null || { echo "缺少 python3，先安装：apt install python3"; exit 1; }

echo "发信用哪个邮箱？"
echo "  1) QQ 邮箱   smtp.qq.com:465     （网页版 QQ 邮箱 设置 → 账号 → 开启 SMTP 服务，生成授权码）"
echo "  2) 163 邮箱  smtp.163.com:465    （网页版 163 邮箱 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务，生成授权码）"
echo "  3) Gmail     smtp.gmail.com:465  （Google 账号开启两步验证后，生成应用专用密码）"
echo "  4) 其他"
read -rp "选 1-4：" choice
case "$choice" in
  1) host=smtp.qq.com;    port=465; mode=ssl ;;
  2) host=smtp.163.com;   port=465; mode=ssl ;;
  3) host=smtp.gmail.com; port=465; mode=ssl ;;
  4) read -rp "SMTP 服务器地址：" host
     read -rp "端口 [465]：" port; port=${port:-465}
     read -rp "加密方式 ssl / starttls [ssl]：" mode; mode=${mode:-ssl} ;;
  *) echo "没有这个选项"; exit 1 ;;
esac
read -rp "发信邮箱地址：" user
read -rsp "授权码 / 应用专用密码（输入时不显示）：" password; echo
# 授权码和应用专用密码本身没有空格，复制时带上的空格去掉
[ "$choice" = 4 ] || password=${password// /}
read -rp "告警发到哪个邮箱（多个用逗号隔开；直接回车 = 发给 $user）：" to
to=${to:-$user}
if [ -z "$host" ] || [ -z "$user" ] || [ -z "$password" ]; then
  echo "服务器、邮箱地址和授权码都不能为空"; exit 1
fi
case "$mode" in ssl|starttls) ;; *) echo "加密方式只能是 ssl 或 starttls"; exit 1 ;; esac

[ -d "$(dirname "$CONFIG")" ] || install -d -m 700 "$(dirname "$CONFIG")"
SMTP_HOST="$host" SMTP_PORT="$port" SMTP_MODE="$mode" SMTP_USER="$user" SMTP_PASS="$password" SMTP_TO="$to" CONFIG="$CONFIG" \
python3 -I - <<'PY'
import json, os
path = os.environ['CONFIG']
try:
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
cfg['email'] = {
    'host': os.environ['SMTP_HOST'], 'port': int(os.environ['SMTP_PORT']), 'mode': os.environ['SMTP_MODE'],
    'user': os.environ['SMTP_USER'], 'password': os.environ['SMTP_PASS'], 'to': os.environ['SMTP_TO'],
}
tmp = path + '.tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PY
password=
echo "已写入 $CONFIG（权限 600）。监控服务每轮都会重新读取，不用重启。"
if grep -q '"owner_bot"' "$CONFIG"; then
  echo "告警会经 owner_bot 的微信发给主人，同时发到上面的邮箱。"
else
  echo "每个机器人出问题时经它自己的微信通知它的用户，同时发到上面的邮箱。"
fi

read -rp "现在发一封测试邮件吗？[Y/n] " yn
case "${yn:-Y}" in
  n|N) echo "好的。以后想测试可以执行：$NODE $CORE/monitor.js --test email" ;;
  *) if "$NODE" "$CORE/monitor.js" --test email; then
       echo "测试邮件已发出，去收件箱确认一下（没看到的话也看看垃圾箱）。"
     else
       echo "测试邮件没发出去，原因见上面一行；改好后重新运行本脚本即可。"
     fi ;;
esac
