#!/bin/zsh
# 同じフォルダの体験画面をlocalhostだけで公開し、Chromeで開く。
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  print 'Python 3が見つかりません。Codexで「デモを開いて」と伝えてください。'
  read -k 1
  exit 1
fi
preview_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
python3 -m http.server "$preview_port" --bind 127.0.0.1 --directory "$PWD" >/dev/null 2>&1 &
preview_pid=$!
trap 'kill "$preview_pid" 2>/dev/null' EXIT INT TERM
sleep 0.4
open -a 'Google Chrome' "http://127.0.0.1:$preview_port/preview/index.html"
print '体験画面を開きました。このウィンドウを閉じるとデモを終了します。'
wait "$preview_pid"
