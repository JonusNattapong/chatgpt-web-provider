@echo off
chcp 65001 >nul
title ChatGPT Web Provider Server
cd /d "D:\Projects\Github\chatgpt-web-provider"
echo =========================================================
echo   ChatGPT Web Provider - กำลังเปิดใช้งาน Local API
echo   Endpoint: http://127.0.0.1:17842/v1
echo =========================================================
echo.
bun run src/provider-cli.ts serve
pause
