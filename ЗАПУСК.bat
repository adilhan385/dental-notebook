@echo off
chcp 65001 >nul
title Цифровой блокнот стоматолога
cd /d "%~dp0"

echo =================================================================
echo   Цифровой блокнот стоматолога — Запуск
echo =================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ОШИБКА] Не найден Node.js!
    echo Пожалуйста, скачайте и установите Node.js ^(версия 22 или новее^) с сайта:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [1/2] Первый запуск: установка необходимых компонентов ^(npm install^)...
    call npm install
    if %errorlevel% neq 0 (
        echo [ОШИБКА] Не удалось установить зависимости.
        pause
        exit /b 1
    )
    echo.
)

echo Запускаем сервер на http://localhost:3001 ...
echo Браузер откроется автоматически через 3 секунды.
echo Не закрывайте это окно во время работы с блокнотом.
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3001"
call npm run dev
pause
