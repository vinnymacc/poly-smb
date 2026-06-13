' Silent launcher for Windows Task Scheduler.
' Runs the poll with a hidden window (0 = hidden, False = don't wait) so no
' black console flashes every interval. Output goes to poll.log.
' Note: avoid VBScript reserved words like "log" as variable names.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "C:\Program Files\nodejs\node.exe"
tsxCli  = projDir & "\node_modules\tsx\dist\cli.mjs"
pollTs  = projDir & "\src\poll.ts"
logFile = projDir & "\poll.log"
' cmd /c so we can redirect output to the log file; window style 0 = hidden.
command = "cmd /c """"" & nodeExe & """ """ & tsxCli & """ """ & pollTs & """ >> """ & logFile & """ 2>&1"""
sh.CurrentDirectory = projDir
sh.Run command, 0, False
