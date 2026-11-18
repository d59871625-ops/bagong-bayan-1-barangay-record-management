@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
if not defined LARAGON_ROOT set "LARAGON_ROOT=C:\laragon"
set "PHP_EXE="

for /f "delims=" %%D in ('dir /b /ad /o-n "%LARAGON_ROOT%\bin\php\php-*" 2^>nul') do if not defined PHP_EXE if exist "%LARAGON_ROOT%\bin\php\%%D\php.exe" set "PHP_EXE=%LARAGON_ROOT%\bin\php\%%D\php.exe"

if not defined PHP_EXE (
    for /f "delims=" %%P in ('where php 2^>nul') do if not defined PHP_EXE set "PHP_EXE=%%P"
)

if not defined PHP_EXE (
    echo PHP CLI was not found. Start Laragon or set LARAGON_ROOT to its installation folder.
    pause
    exit /b 1
)

start "Barangay PHP API" "%PHP_EXE%" -S 127.0.0.1:8000 -t "%PROJECT_ROOT%backend"
start "Barangay portal" /D "%PROJECT_ROOT%" cmd.exe /k npm.cmd run dev -- --host 127.0.0.1

echo Started the local API and frontend. Keep Laragon MySQL running.
