#!/bin/bash
# 沙箱运行（推荐，需要 root）：每个机器人一个低权限系统账号，由 systemd 托管、在沙箱里运行。
# 一个机器人即使被诱导执行了危险命令，也只能动它自己的目录：看不到 /root、/home、其他机器人，改不了程序和系统。
#
# 用 root 运行（在程序目录里）：
#   bash deploy/sandbox/install_sandbox.sh plan [机器人...]      只检查、列出每一步要做什么，什么都不改（默认）
#   bash deploy/sandbox/install_sandbox.sh prepare               一次性准备，可以重复跑
#   bash deploy/sandbox/install_sandbox.sh switch <机器人>...     等它空闲，从 PM2 切到沙箱
#   bash deploy/sandbox/install_sandbox.sh check <机器人>...      在运行中的沙箱里验证，什么都不改
#   bash deploy/sandbox/install_sandbox.sh rollback <机器人>...   退回原来的跑法（PM2，原来的账号）
#   bash deploy/sandbox/install_sandbox.sh sync-login [机器人...] agy 登录失效、在源账号重新登录后，把新登录同步给沙箱里的机器人
#
# 本机设置写在 /etc/clawbot/sandbox.conf（可选，shell 变量格式），比如：
#   HIDE="-/var/lib/docker -/www -/srv/other-project"   # 这台服务器上别的项目：沙箱里完全看不到（- 开头表示不存在就跳过）
#   MEM=1G  CPU=100%  TASKS=300                          # 每个机器人（3 个服务加它调用的智能体、脚本）合计的上限
#   AGY_FROM=/root                                       # 从哪个家目录复制 agy 程序和登录（默认：现在跑 PM2 的账号）
#   TARGET=/opt/wechat-clawbot                           # 程序在 /root 或 /home 下面时，搬到哪里（旧路径留软链接）
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "要用 root 运行"; exit 1; }

CONF=/etc/clawbot/sandbox.conf
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
TARGET=${TARGET:-/opt/wechat-clawbot}
HOMEBASE=${HOMEBASE:-/var/lib/clawbot/home}    # 机器人账号的家目录（agy 的登录、对话记录）；放在 /home 外面，老版本 systemd 也能整个藏起 /home
CACHE=${CACHE:-/var/cache/clawbot}             # 技能共用的只读缓存：抖音下载用的浏览器、转文字用的模型
BACKUP=${BACKUP:-/var/backups/clawbot-sandbox}
HIDE=${HIDE:--/var/lib/docker}
MEM=${MEM:-1G}; CPU=${CPU:-100%}; TASKS=${TASKS:-300}
ROLES="routine forwarder scheduler"
NODE=$(command -v node)
MODE=${1:-plan}; shift || true

SELF_REPO=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd -P)
# 程序在 /root、/home 下面，或者路径上有一层别的账号进不去：沙箱账号用不了，要搬到 $TARGET
needs_move() {
  case "$SELF_REPO" in /root | /root/* | /home/*) return 0 ;; esac
  local p=$SELF_REPO
  while [ "$p" != / ]; do
    [ $((0$(stat -c %a "$p") & 1)) -eq 1 ] || return 0
    p=$(dirname "$p")
  done
  return 1
}
if needs_move; then REPO=$TARGET; else REPO=$SELF_REPO; fi
here() { [ -d "$REPO/bots" ] && echo "$REPO" || echo "$SELF_REPO"; }
all_bots() { (cd "$(here)/bots" && for d in */; do [ -f "$d/config.json" ] && printf '%s ' "${d%/}"; done); }
BOTS=${*:-$(all_bots)}
user_of() { echo "clawbot-$1"; }
port_of() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('port',''))" "$(here)/bots/$1/config.json" 2>/dev/null; }
now() { TZ=Asia/Shanghai date '+%F %T'; }
switched() { systemctl is-enabled --quiet "clawbot-routine@$1" 2>/dev/null; }

# PM2：机器人原来由哪个账号的 PM2 跑（README 建议普通账号）；agy 的登录也从这个账号复制
pm2_user() { local p; p=$(pgrep -f '^PM2 v' | head -1); [ -n "$p" ] && ps -o user= -p "$p" | tr -d ' '; }
pm2_as() {
  local u; u=$(pm2_user)
  [ -n "$u" ] || return 0
  if [ "$u" = root ]; then pm2 "$@"; else runuser -u "$u" -- bash -lc "pm2 $*"; fi
}
home_of() { getent passwd "$1" | cut -d: -f6; }
AGY_FROM=${AGY_FROM:-$( (u=$(pm2_user); [ -n "$u" ] && home_of "$u") || echo /root)}
AGY_CFG=$AGY_FROM/.gemini/antigravity-cli
agy_bin() {
  local f
  for f in "$AGY_FROM/.local/bin/agy-real" "$AGY_FROM/.local/bin/agy" "$(readlink -f "$(command -v agy 2>/dev/null)" 2>/dev/null)"; do
    [ -n "$f" ] && [ -x "$f" ] && ! head -c2 "$f" | grep -q '#!' && echo "$f" && return
  done
}

# 计划模式只列出来；其他模式真做，失败就停
step() {
  local what=$1 detail=$2; shift 2
  echo "    · $what"
  if [ "$MODE" = plan ]; then
    [ -n "$detail" ] && echo "        $detail"
    return 0
  fi
  "$@" || { echo "    ✗ 失败：$what"; exit 1; }
}

# ---------- systemd：老版本不认的设置不写，内存上限按 cgroup 版本写 ----------
SDV=$(systemctl --version | awk 'NR==1{print $2}')
CG=$([ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] && echo v2 || echo v1)
MARK='# 由 install_sandbox.sh 生成'
extra_hardening() {
  [ "$SDV" -ge 242 ] && printf 'ProtectHostname=yes\nRestrictSUIDSGID=yes\n'
  [ "$SDV" -ge 244 ] && printf 'ProtectKernelLogs=yes\n'
  [ "$SDV" -ge 245 ] && printf 'ProtectClock=yes\n'
  [ "$SDV" -ge 247 ] && printf 'ProtectProc=invisible\n'
  return 0
}
limits_text() {
  echo "$MARK：这个机器人 3 个服务加上它调用的智能体、脚本，合计的资源上限"
  echo "[Slice]"
  if [ "$CG" = v2 ]; then echo "MemoryHigh=$MEM"; echo "MemoryMax=$MEM"; else echo "MemoryLimit=$MEM"; fi
  echo "CPUQuota=$CPU"
  echo "TasksMax=$TASKS"
}
script_of() { case $1 in routine) echo routine_server.js ;; forwarder) echo wechat_forwarder.js ;; scheduler) echo scheduler.js ;; esac; }
desc_of() { case $1 in routine) echo '消息处理（从收件箱取消息、调用 agy、回复微信）' ;; forwarder) echo '收微信消息（写进收件箱）' ;; scheduler) echo '定时任务、提醒、凌晨记忆整理' ;; esac; }
unit_text() {
  cat <<EOF
$MARK：机器人 %i 的$(desc_of "$1")，在低权限账号 clawbot-%i 和沙箱里运行
[Unit]
Description=ClawBot %i - $1
After=network-online.target
Wants=network-online.target

[Service]
Slice=clawbot-%i.slice
Type=simple
User=clawbot-%i
Group=clawbot-%i
WorkingDirectory=$REPO/bots/%i
ExecStart=$NODE $REPO/core/$(script_of "$1")
SyslogIdentifier=clawbot-%i-$1
Environment=NODE_ENV=production LANG=en_US.UTF-8
Environment=HOME=$HOMEBASE/%i
Environment=PATH=$HOMEBASE/%i/.gemini/antigravity-cli/bin:$HOMEBASE/%i/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HF_HOME=$CACHE/huggingface HF_HUB_OFFLINE=1 PLAYWRIGHT_BROWSERS_PATH=$CACHE/ms-playwright
Restart=always
RestartSec=3
TimeoutStopSec=15

# 沙箱：整个系统只读，只有本机器人的目录和它的家目录可写；/root、/home 和下面列的路径看不到；
# 其他机器人的目录和家目录都是 700，读不到；/tmp 独立；不能提权
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$REPO/bots/%i $HOMEBASE/%i
InaccessiblePaths=$HIDE
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes
UMask=0027
$(extra_hardening)
[Install]
WantedBy=multi-user.target
EOF
}

# ---------- 等机器人空闲：没有智能体在跑、收件箱没有正在处理的消息、不在凌晨整理 ----------
busy_reason() {
  local bot=$1 d p c agents=0
  d=$(readlink -f "$(here)/bots/$bot")
  for p in $(pgrep -f 'agy' 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    c=$(readlink -f "/proc/$p/cwd" 2>/dev/null) || continue
    case "$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)" in *agy*) ;; *) continue ;; esac
    case "$c" in "$d" | "$d"/*) agents=$((agents + 1)) ;; esac
  done
  [ "$agents" -gt 0 ] && { echo "有 $agents 个智能体在跑"; return; }
  local n; n=$(ls "$d/data/inbox/processing" 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] && { echo "收件箱里有 $n 条正在处理"; return; }
  python3 -c "import json,sys
try: print('凌晨整理在跑' if json.load(open(sys.argv[1])).get('running') else '')
except Exception: print('')" "$d/data/state/memory_consolidation.json"
}
wait_idle() {
  local bot=$1 i r
  for i in $(seq 1 120); do
    r=$(busy_reason "$bot")
    [ -z "$r" ] && return 0
    [ $((i % 6)) -eq 1 ] && echo "    （$bot $r，等它空下来）"
    sleep 10
  done
  echo "    ✗ $bot 等了 20 分钟还不空闲，这次不切"
  return 1
}

# =====================================================================
# 一次性准备
do_backup() {
  install -d -m 700 "$BACKUP"
  [ -f "$(home_of "$(pm2_user)" 2>/dev/null)/.pm2/dump.pm2" ] && cp -p "$(home_of "$(pm2_user)")/.pm2/dump.pm2" "$BACKUP/dump.pm2.$(date +%Y%m%d%H%M%S)"
  find "$(here)/bots" -printf '%m %u %g %p\n' > "$BACKUP/perms.$(date +%Y%m%d%H%M%S).txt"
}
do_move() {
  [ -e "$TARGET" ] && { echo "    $TARGET 已经存在，不搬"; return 1; }
  mv "$SELF_REPO" "$TARGET" && ln -s "$TARGET" "$SELF_REPO" && echo "$SELF_REPO" > "$BACKUP/moved-from"
}
do_lock_repo() {
  chown root:root "$REPO" "$REPO/bots" && chmod 755 "$REPO" "$REPO/bots"
  local d
  for d in core skills-store scripts deploy; do [ -e "$REPO/$d" ] && chmod -R go-w,a+rX "$REPO/$d"; done
  for d in "$REPO"/bots/*/; do [ -f "$d/config.json" ] && chmod 700 "$d" && chmod 600 "$d/config.json"; done
  return 0
}
do_cache() {
  install -d -m 755 "$CACHE"
  local c
  for c in ms-playwright huggingface; do
    [ -d "$CACHE/$c" ] && continue
    [ -d "$AGY_FROM/.cache/$c" ] && cp -a "$AGY_FROM/.cache/$c" "$CACHE/"
  done
  chown -R root:root "$CACHE" && chmod -R go-w,a+rX "$CACHE"
}
do_units() {
  local role f
  for role in $ROLES; do
    f=/etc/systemd/system/clawbot-$role@.service
    if [ -f "$f" ] && ! grep -q "^$MARK" "$f"; then
      echo "    ✗ $f 是别的方式装的，不覆盖"
      return 1
    fi
  done
  for role in $ROLES; do unit_text "$role" > "/etc/systemd/system/clawbot-$role@.service"; done
  install -d -m 755 /var/lib/clawbot "$HOMEBASE"
  systemctl daemon-reload
}
plan_prepare() {
  echo
  echo "== 一次性准备（prepare）"
  step "备份：PM2 进程清单、机器人目录的权限" "存到 $BACKUP" do_backup
  if needs_move && [ ! -d "$TARGET/bots" ]; then
    step "程序搬到 $TARGET，旧路径留软链接（还没切的机器人照常跑）" "mv $SELF_REPO $TARGET && ln -s $TARGET $SELF_REPO" do_move
  fi
  step "程序目录归 root、所有人只读；每个机器人的目录先锁成 700、微信凭证 600" "" do_lock_repo
  step "共享缓存：浏览器和语音模型复制到 $CACHE，只读" "从 $AGY_FROM/.cache 复制，已有的不重复复制" do_cache
  step "写 3 个服务模板到 /etc/systemd/system/（别的方式装的不覆盖）" "clawbot-{routine,forwarder,scheduler}@.service" do_units
}

# 切换一个机器人
do_account() {
  local U=$1 H=$2
  install -d -m 755 /var/lib/clawbot "$HOMEBASE"
  id "$U" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$H" --create-home --shell /sbin/nologin "$U" || return 1
  chmod 700 "$H"
}
do_agy() {
  local U=$1 H=$2 bin; bin=$(agy_bin)
  [ -n "$bin" ] || { echo "    ✗ 在 $AGY_FROM 下面没找到 agy 程序"; return 1; }
  [ -f "$AGY_CFG/antigravity-oauth-token" ] || { echo "    ✗ $AGY_FROM 的 agy 还没登录：先用那个账号运行一次 agy 完成登录"; return 1; }
  install -d -o "$U" -g "$U" -m 700 "$H/.local" "$H/.local/bin" "$H/.gemini" "$H/.gemini/antigravity-cli"
  install -o "$U" -g "$U" -m 755 "$bin" "$H/.local/bin/agy-real"
  printf '#!/bin/bash\nexec "$HOME/.local/bin/agy-real" "$@"\n' > "$H/.local/bin/agy"
  chown "$U:$U" "$H/.local/bin/agy" && chmod 755 "$H/.local/bin/agy"
  local f
  for f in settings.json antigravity-oauth-token; do
    [ -f "$AGY_CFG/$f" ] && install -o "$U" -g "$U" -m 600 "$AGY_CFG/$f" "$H/.gemini/antigravity-cli/$f"
  done
  return 0
}
do_pm2_off() {
  local bot=$1 r
  for r in $ROLES; do pm2_as delete "$bot-$r" >/dev/null 2>&1; done
  pm2_as save >/dev/null 2>&1
  return 0
}
do_fix_paths() {
  local bot=$1 D=$2 l t old
  # 技能链接：指向别处的同名官方技能，改指到 $REPO/skills-store
  for l in $(find "$D/.agents/skills" -maxdepth 1 -type l 2>/dev/null); do
    t=$(readlink "$l")
    case "$t" in "$REPO/skills-store/"*) continue ;; esac
    [ -d "$REPO/skills-store/$(basename "$t")" ] && ln -sfn "$REPO/skills-store/$(basename "$t")" "$l"
  done
  # 程序搬过家：记忆文件里写着旧路径的，前缀改成新位置（先备份原文件，只改路径）
  old=$(cat "$BACKUP/moved-from" 2>/dev/null)
  if [ -n "$old" ]; then
    local f bk="$BACKUP/memory-paths-$bot"
    for f in $(grep -rlF "$old/" "$D/MEMORY.md" "$D/data/memory" 2>/dev/null); do
      mkdir -p "$bk" && cp -p --parents "$f" "$bk/" && sed -i "s|$old/|$REPO/|g" "$f"
    done
  fi
  return 0
}
do_own() {
  local U=$1 D=$2
  stat -c %U "$D" > "$BACKUP/owner-$(basename "$D")"
  chown -hR "$U:$U" "$D" && chmod 700 "$D" && chmod 600 "$D/config.json"
}
do_slice() {
  local bot=$1
  install -d "/etc/systemd/system/clawbot-$bot.slice.d"
  limits_text > "/etc/systemd/system/clawbot-$bot.slice.d/10-limits.conf"
  systemctl daemon-reload
}
do_start() {
  local bot=$1
  systemctl enable --now "clawbot-routine@$bot" "clawbot-forwarder@$bot" "clawbot-scheduler@$bot" 2>&1 | grep -v '^Created symlink' || true
  sleep 5
  local r ok=1
  for r in $ROLES; do systemctl is-active --quiet "clawbot-$r@$bot" || ok=0; done
  echo "    3 个服务：$([ $ok = 1 ] && echo 都在跑 || echo '✗ 有没起来的')；健康检查 $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$(port_of "$bot")/health")"
  [ $ok = 1 ]
}
plan_switch() {
  echo
  echo "== 每个机器人切换（switch），一个一个来"
  local bot
  for bot in $BOTS; do
    local U H D; U=$(user_of "$bot"); H=$HOMEBASE/$bot; D=$REPO/bots/$bot
    if switched "$bot"; then echo "  [$bot] 已经在沙箱里了，跳过"; continue; fi
    echo "  [$bot] 账号 $U，家目录 $H"
    step "等它空闲：没有智能体在跑、收件箱没有正在处理的消息、不在凌晨整理（最多等 20 分钟）" "" wait_idle "$bot"
    step "建账号（不能登录，只用来跑服务）" "" do_account "$U" "$H"
    step "复制 agy 程序、设置、登录文件（只复制不打开）；以后这个账号自己更新 agy" "从 $AGY_FROM 复制" do_agy "$U" "$H"
    step "从 PM2 里删掉它的 3 个进程" "PM2 账号：$(pm2_user || echo 没有在跑)" do_pm2_off "$bot"
    step "技能链接改指到 $REPO/skills-store；程序搬过家的，记忆文件里的旧路径前缀改成新位置" "" do_fix_paths "$bot" "$D"
    step "目录改归它自己（700），别的机器人读不到；微信凭证 600" "原来的归属记下来，退回时还原" do_own "$U" "$D"
    step "资源上限：CPU $CPU、内存 $MEM" "" do_slice "$bot"
    step "启动 3 个沙箱服务，开机自启" "" do_start "$bot"
  done
}

# 在运行中的沙箱里，用机器人自己的账号验证（什么都不改；SKILL_TESTS=1 时再跑抖音下载、转文字自检）
do_check() {
  local bot=$1 U uid gid pid D H port r
  U=$(user_of "$bot"); D=$REPO/bots/$bot; H=$HOMEBASE/$bot; port=$(port_of "$bot")
  echo "  [$bot]"
  switched "$bot" || { echo "    还没切到沙箱"; return; }
  uid=$(id -u "$U"); gid=$(id -g "$U")
  for r in $ROLES; do
    pid=$(systemctl show -p MainPID --value "clawbot-$r@$bot")
    echo "    $r：$(systemctl is-active "clawbot-$r@$bot")，进程账号 $(ps -o user= -p "$pid" 2>/dev/null)"
  done
  echo "    健康检查：$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/health")"
  pid=$(systemctl show -p MainPID --value "clawbot-routine@$bot")
  local others hidden p
  others=$(for b in $(all_bots); do [ "$b" != "$bot" ] && printf '%s ' "$REPO/bots/$b/config.json"; done)
  hidden=$(for p in $HIDE; do p=${p#-}; [ -e "$p" ] && printf '%s ' "$p"; done)
  nsenter -t "$pid" -m -- setpriv --reuid="$uid" --regid="$gid" --init-groups --no-new-privs -- \
    env -i HOME="$H" PATH="$H/.gemini/antigravity-cli/bin:$H/.local/bin:/usr/local/bin:/usr/bin:/bin" LANG=en_US.UTF-8 \
    HF_HOME="$CACHE/huggingface" HF_HUB_OFFLINE=1 PLAYWRIGHT_BROWSERS_PATH="$CACHE/ms-playwright" \
    OTHERS="$others" HIDDEN="$hidden" D="$D" H="$H" REPO="$REPO" PROBE_MODEL="${AGY_PROBE_MODEL:-}" SKILL_TESTS="${SKILL_TESTS:-}" \
    bash -c '
      ok() { echo "    ✓ $1"; }; bad() { echo "    ✗ $1"; }
      no() { if eval "$2" >/dev/null 2>&1; then bad "$1（居然可以）"; else ok "$1"; fi; }
      yes() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1（不行）"; fi; }
      no "看不到 /root" "ls /root"
      no "看不到 /home" "ls /home/* || ls -A /home | grep -q ."
      for p in $HIDDEN; do no "看不到 $p" "ls $p"; done
      for f in $OTHERS; do no "读不到其他机器人的微信凭证（$(basename $(dirname $f))）" "cat $f"; done
      no "读不到 /etc/shadow" "cat /etc/shadow"
      no "不能 sudo 提权" "sudo -n true"
      no "改不了程序代码" "touch $REPO/core/.sbx-test"
      no "写不了 /etc" "touch /etc/.sbx-test"
      yes "能写自己的目录" "touch $D/data/.sbx-test && rm -f $D/data/.sbx-test"
      yes "能写自己的家目录" "touch $H/.sbx-test && rm -f $H/.sbx-test"
      out=$(cd "$D" && timeout 180 agy -p "只回复两个字：好的" ${PROBE_MODEL:+--model $PROBE_MODEL} 2>/dev/null | tail -1)
      case "$out" in *好的*) ok "agy 用这个账号能用（回复：$out）" ;; *) bad "agy 试跑没拿到回复：${out:0:80}" ;; esac
      [ "$SKILL_TESTS" = 1 ] || exit 0
      mark="$D/data/.sbx-marker"; touch "$mark"
      if [ -e "$D/.agents/skills/douyin" ]; then
        r=$(cd "$D" && timeout 300 bash "$REPO/skills-store/douyin/test.sh" "$D" 2>&1 | tail -1)
        case "$r" in ok*) ok "抖音技能自检：$r" ;; *) bad "抖音技能自检：${r:0:120}（同一份 cookie 短时间多次下载会被抖音临时挡住，隔一分钟再试）" ;; esac
        mp4=$(find "$D/data" -newer "$mark" -type f -name "*.mp4" 2>/dev/null | head -1)
        if [ -n "$mp4" ] && [ -e "$D/.agents/skills/transcribe" ]; then
          t=$(timeout 600 bash "$REPO/skills-store/transcribe/test.sh" "$mp4" 2>&1 | tail -1)
          case "$t" in ok*) ok "转文字技能自检：$t" ;; *) bad "转文字技能自检：${t:0:120}" ;; esac
        fi
      fi
      n=$(find "$D/data" -newer "$mark" -type f -path "*download*" 2>/dev/null | wc -l)
      find "$D/data" -newer "$mark" -type f -path "*download*" -delete 2>/dev/null; rm -f "$mark"
      echo "    · 清掉自检下载的 $n 个文件（只删这次新下的）"
    '
}

do_sync_login() {
  local bot=$1 U H f
  U=$(user_of "$bot"); H=$HOMEBASE/$bot
  switched "$bot" || { echo "  [$bot] 不在沙箱里，跳过"; return; }
  [ -f "$AGY_CFG/antigravity-oauth-token" ] || { echo "  ✗ $AGY_FROM 的 agy 还没登录"; return 1; }
  for f in settings.json antigravity-oauth-token; do
    [ -f "$AGY_CFG/$f" ] && install -o "$U" -g "$U" -m 600 "$AGY_CFG/$f" "$H/.gemini/antigravity-cli/$f"
  done
  echo "  [$bot] 已同步 agy 登录（从 $AGY_FROM）"
}

do_rollback() {
  local bot=$1 D owner
  D=$(here)/bots/$bot
  owner=$(cat "$BACKUP/owner-$bot" 2>/dev/null); owner=${owner:-root}
  echo "  [$bot] 退回 PM2，目录还给 $owner"
  systemctl disable --now "clawbot-routine@$bot" "clawbot-forwarder@$bot" "clawbot-scheduler@$bot" 2>&1 | grep -v '^Removed' || true
  chown -hR "$owner:$(id -gn "$owner")" "$D" && chmod 755 "$D"
  if [ "$owner" = root ]; then (cd "$D" && bash start.sh >/dev/null 2>&1); else runuser -u "$owner" -- bash -lc "cd '$D' && bash start.sh" >/dev/null 2>&1; fi
  sleep 5
  echo "    健康检查：$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$(port_of "$bot")/health")"
}

plan_checks() {
  echo "== 前提检查（$(now)）"
  local extra; extra=$(extra_hardening | tr '\n' ' ' | sed 's/=yes//g; s/=invisible//')
  echo "  systemd $SDV，cgroup $CG → 内存上限写成 $([ "$CG" = v2 ] && echo MemoryHigh/MemoryMax || echo MemoryLimit)；新版才有的加固项：${extra:-这个版本都不支持，不写}"
  echo "  node：${NODE:-✗没找到}"
  echo "  程序目录：$SELF_REPO$(needs_move && echo "（在 /root、/home 下或别的账号进不去 → 搬到 $TARGET，旧路径留软链接）" || echo "（沙箱账号进得去，不用搬）")"
  echo "  agy：从 $AGY_FROM 复制；程序 $([ -n "$(agy_bin)" ] && echo "$(agy_bin)" || echo ✗没找到)；登录 $([ -f "$AGY_CFG/antigravity-oauth-token" ] && echo 有 || echo ✗没有，先登录)"
  echo "  技能缓存：$(for c in ms-playwright huggingface; do printf '%s %s；' "$c" "$( [ -d "$CACHE/$c" ] && echo 已有 || ( [ -d "$AGY_FROM/.cache/$c" ] && du -sh "$AGY_FROM/.cache/$c" | cut -f1 ) || echo 没有，用到的技能装好后再放进 "$CACHE")"; done)"
  echo "  PM2：$(pm2_user >/dev/null && echo "在 $(pm2_user) 账号下跑" || echo 没在跑)；本机设置：$([ -f "$CONF" ] && echo "$CONF" || echo 没有，用默认值)"
  echo "  沙箱里还要藏起来的路径：$(for p in $HIDE; do q=${p#-}; [ -e "$q" ] && printf '%s ' "$q"; done)"
  echo "  磁盘剩余：$(df -h / | awk 'NR==2{print $4}')"
  echo
  echo "== 机器人"
  local bot
  for bot in $BOTS; do
    if switched "$bot"; then echo "  [$bot] 已经在沙箱里（账号 $(user_of "$bot")）"; continue; fi
    echo "  [$bot] 端口 $(port_of "$bot")，目录 $(du -sh "$(here)/bots/$bot" | cut -f1)，$(r=$(busy_reason "$bot"); echo "${r:-空闲}")"
  done
}

case "$MODE" in
  plan)
    plan_checks; plan_prepare; plan_switch
    echo
    echo "== 生成的服务模板（消息处理那个；另外两个只有启动的程序不同）"
    unit_text routine | sed 's/^/  │ /'
    echo
    echo "（计划模式，什么都没改）" ;;
  prepare) echo "== prepare $(now)"; plan_prepare; echo "== 完成 $(now)" ;;
  switch)
    [ -f /etc/systemd/system/clawbot-routine@.service ] || { echo "先跑 prepare"; exit 1; }
    echo "== switch $(now)"; plan_switch; echo "== 完成 $(now)" ;;
  check) echo "== check $(now)"; for b in $BOTS; do do_check "$b"; done ;;
  rollback) echo "== rollback $(now)"; for b in $BOTS; do do_rollback "$b"; done ;;
  sync-login) echo "== sync-login $(now)"; for b in $BOTS; do do_sync_login "$b"; done ;;
  unit) unit_text "${1:-routine}" ;;   # 只打印要写的服务模板（routine / forwarder / scheduler），不写
  *) sed -n '2,/^set -uo/p' "$0" | sed '$d'; exit 2 ;;
esac
