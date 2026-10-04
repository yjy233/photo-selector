#!/bin/zsh
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22 或更新版本。'
  read -r '?按回车关闭…'
  exit 1
fi
if [ ! -d node_modules ]; then
  npm install || exit 1
fi
echo '启动后请在浏览器打开 http://localhost:3000'
npm start
