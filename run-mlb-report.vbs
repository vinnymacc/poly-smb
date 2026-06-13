' Silent launcher for the daily MLB pre-game report (Windows Task Scheduler).
' Runs src/mlb-report.ts with a hidden window (0 = hidden, False = don't wait)
' so no black console flashes. Output goes to mlb-report.log.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "C:\Program Files\nodejs\node.exe"
tsxCli  = projDir & "\node_modules\tsx\dist\cli.mjs"
reportTs = projDir & "\src\mlb-report.ts"
logFile = projDir & "\mlb-report.log"
command = "cmd /c """"" & nodeExe & """ """ & tsxCli & """ """ & reportTs & """ >> """ & logFile & """ 2>&1"""
sh.CurrentDirectory = projDir
sh.Run command, 0, False
