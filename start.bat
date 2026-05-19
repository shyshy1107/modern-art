@echo off
chcp 65001 >nul
title 现代艺术 Modern Art - 服务器

echo.
echo   ╔══════════════════════════════════════╗
echo   ║     🎨 现代艺术 Modern Art Online    ║
echo   ║          服务器启动中...             ║
echo   ╚══════════════════════════════════════╝
echo.

cd /d "%~dp0"

echo [1/3] 检查依赖...
if not exist "node_modules" (
    echo 正在安装依赖，请稍候...
    call npm install
    echo 依赖安装完成！
)

echo [2/3] 启动服务器...
start "" "http://localhost:3000"

echo [3/3] 正在运行...
echo.
echo   ✅ 服务器已启动！
echo   📡 地址: http://localhost:3000
echo   🛑 关闭此窗口即可停止服务器
echo   ─────────────────────────────────
echo.

node server.js
pause
