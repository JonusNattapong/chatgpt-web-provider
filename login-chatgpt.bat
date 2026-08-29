@echo off
chcp 65001 >nul
title ChatGPT Web Provider Login
cd /d "D:\Projects\Github\chatgpt-web-provider"
echo =========================================================
echo   ChatGPT Web Provider - เข้าสู่ระบบอัตโนมัติ
echo =========================================================
echo.
echo กำลังเปิดหน้าต่าง Chrome...
echo 1. ให้คุณล็อกอินบัญชี ChatGPT ตามปกติ
echo 2. เมื่อเห็นหน้าแชทและช่องพิมพ์ข้อความแล้ว ให้ "ปิดหน้าต่าง Chrome" (กด X)
echo.
bun run src/provider-cli.ts login
echo.
echo =========================================================
echo เรียบร้อย! บันทึก Session สำเร็จแล้ว
echo =========================================================
pause
