@echo off
chcp 65001 >nul
setlocal
set "DIR=%~dp0doctor.mjs"

:menu
echo.
echo ============================================
echo   DSH 会话体检 / 修复
echo ============================================
echo   1. 总览（推荐先看这个）
echo   2. 判定某个会话为什么看不到（host 视角，最权威）
echo   3. 只体检
echo   4. 修数据层（非法 turn/end reason）
echo   5. 数据层 + 注册表层（会话消失了选这个）
echo   6. 检查首帧不变量（列表里没有 / 打不开）
echo   7. 修「历史加载失败 reading 'code'」（畸形 turn/end）
echo   8. 打客户端防护补丁（治本，会白屏选这个）
echo   9. 查崩溃日志
echo  10. 还原客户端
echo  11. reason:null 防复发三补丁（升级后必打）
echo   0. 退出
echo.
set /p "c=请选择: "

if "%c%"=="1" goto s
if "%c%"=="2" goto verify
if "%c%"=="3" goto scan
if "%c%"=="4" goto fix
if "%c%"=="5" goto all
if "%c%"=="6" goto frames
if "%c%"=="7" goto endcheck
if "%c%"=="8" goto patch
if "%c%"=="9" goto logs
if "%c%"=="10" goto restore
if "%c%"=="11" goto reasonguard
if "%c%"=="0" exit /b 0
goto menu

:s
node "%DIR%" status
goto pause
:verify
echo.
set /p "id=输入会话 id 前几位（直接回车=只看异常）: "
if "%id%"=="" node "%DIR%" verify
if not "%id%"=="" node "%DIR%" verify %id%
goto pause
:scan
node "%DIR%" scan
goto pause
:fix
node "%DIR%" fix
goto pause
:all
node "%DIR%" all
goto pause
:frames
node "%DIR%" frames
goto pause
:endcheck
echo.
echo 注意：修数据前请先完全退出 DeepSeek Harness（含托盘）。
node "%DIR%" endcheck --apply
goto pause
:patch
echo.
echo 注意：打补丁前请先完全退出 DeepSeek Harness。
node "%DIR%" patch --apply
goto pause
:logs
node "%DIR%" logs
goto pause
:restore
node "%DIR%" restore-asar
goto pause
:reasonguard
echo.
echo 注意：打补丁前请先完全退出 DeepSeek Harness。
node "%DIR%" reasonguard --apply
goto pause

:pause
echo.
pause
goto menu
