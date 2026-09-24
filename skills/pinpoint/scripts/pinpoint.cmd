@echo off
rem Pinpoint launcher for Windows. Override the runtime with PINPOINT_NODE.
setlocal
set "PP_NODE=%PINPOINT_NODE%"
if not defined PP_NODE (
  where node >nul 2>nul && set "PP_NODE=node"
)
if not defined PP_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "PP_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined PP_NODE if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "PP_NODE=%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined PP_NODE (
  echo {"ok":false,"error":"node_not_found","message":"Pinpoint needs Node.js 18+ (https://nodejs.org). Or set PINPOINT_NODE."}
  exit /b 127
)
"%PP_NODE%" "%~dp0pinpoint.mjs" %*
