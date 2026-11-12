@echo off
rem Frissites es inditas egy lepesben: dupla kattintassal is futtathato.
rem Ctrl+C-re kerdes nelkul leall: a szkript nul bemenettel fut ujra, igy a
rem "Terminate batch job (Y/N)?" kerdesre nem var valaszt.
if not "%~1"=="--belso" (
  call "%~f0" --belso <nul
  exit /b
)
cd /d "%~dp0"
call npm run update
if errorlevel 1 goto hiba
rem A szervert kozvetlenul a node inditja (nem az npm): Ctrl+C-re negativ a
rem kilepesi kod, igy csak valodi hibanal all meg az ablak.
node --import tsx --env-file-if-exists=.env server\src\main.ts
if errorlevel 1 goto hiba
exit /b
:hiba
pause <con
