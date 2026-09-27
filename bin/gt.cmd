@echo off
setlocal
set "ROOT=%~dp0.."
set "MODE=%~1"
if "%MODE%"=="" set "MODE=start"
if "%PORT%"=="" set "PORT=8787"

set "PM=npm"
where pnpm >nul 2>nul && set "PM=pnpm"

if /i "%MODE%"=="help" goto :help
if /i "%MODE%"=="build" goto :build
if /i "%MODE%"=="dev" goto :dev
if /i "%MODE%"=="skills" goto :skills
if /i "%MODE%"=="mcp" goto :mcp

goto :start

:help
echo.
echo   gt              build if needed, start server, open browser  [port %PORT%]
echo   gt dev          run vite + server, open http://localhost:5173
echo   gt build        rebuild the web bundle
echo   gt skills ...   install agent skills into the configured workspace
echo                   (gt skills help for the full list)
echo   gt mcp ...      manage MCP servers (gt mcp help for the full list)
echo   gt help         this text
echo.
echo   set PORT=8788 ^&^& gt    to use another port
echo.
exit /b 0

:start
cd /d "%ROOT%" || goto :badroot
call :ensure
if errorlevel 1 exit /b 1

if not exist "%ROOT%\web\dist\index.html" goto :firstbuild

call :portbusy %PORT%
if not errorlevel 1 (
  echo [gt] port %PORT% is already serving - opening the browser to it
  start http://127.0.0.1:%PORT%
  exit /b 0
)

echo [gt] starting server on http://127.0.0.1:%PORT%
set "OPEN_BROWSER=1"
cd /d "%ROOT%\server"
call %PM% run start
exit /b %ERRORLEVEL%

:firstbuild
echo [gt] no web bundle yet - building once
cd /d "%ROOT%\web"
call %PM% run build
if errorlevel 1 (
  echo [gt] build failed
  exit /b 1
)
goto :start

:build
cd /d "%ROOT%" || goto :badroot
call :ensure
if errorlevel 1 exit /b 1
echo [gt] building web bundle
cd /d "%ROOT%\web"
call %PM% run build
exit /b %ERRORLEVEL%

:dev
cd /d "%ROOT%" || goto :badroot
call :ensure
if errorlevel 1 exit /b 1
echo [gt] dev mode - web on http://localhost:5173
start "" /min cmd /c "timeout /t 6 /nobreak >nul && start http://localhost:5173"
call %PM% run dev
exit /b %ERRORLEVEL%

:skills
call :collect %*
node "%ROOT%\bin\skills.mjs" %ARGS%
exit /b %ERRORLEVEL%

:mcp
call :collect %*
node "%ROOT%\bin\mcp.mjs" %ARGS%
exit /b %ERRORLEVEL%

rem Rebuild the argument list from the first argument on. Called with %*, so the %1 it shifts is
rem the subroutine's own - shifting the caller's arguments from inside a call is not possible.
:collect
shift
set "ARGS="
:collectloop
if "%~1"=="" exit /b 0
set "ARGS=%ARGS% "%~1""
shift
goto :collectloop

:ensure
if exist "%ROOT%\node_modules" exit /b 0
echo [gt] installing dependencies with %PM% ...
call %PM% install
exit /b %ERRORLEVEL%

:portbusy
netstat -an | findstr /c:LISTENING | findstr /c:":%~1 " >nul 2>nul
exit /b %ERRORLEVEL%

:badroot
echo [gt] cannot enter "%ROOT%"
exit /b 1
