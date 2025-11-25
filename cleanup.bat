@echo off
echo ====================================
echo  Cleaning up old Node.js files...
echo ====================================
echo.

REM Check if node_modules exists
if exist node_modules (
    echo Deleting node_modules folder...
    rmdir /s /q node_modules
    echo ✓ node_modules deleted!
) else (
    echo ℹ node_modules folder not found (already clean)
)

echo.

REM Check if package-lock.json exists
if exist package-lock.json (
    echo Deleting package-lock.json...
    del /f /q package-lock.json
    echo ✓ package-lock.json deleted!
) else (
    echo ℹ package-lock.json not found (already clean)
)

echo.
echo ====================================
echo  Cleanup complete!
echo ====================================
echo.
echo Next steps:
echo 1. Run: npm install
echo 2. Run: npm start
echo.
pause