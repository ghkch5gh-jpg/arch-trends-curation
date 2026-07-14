' Launch run-weekly.ps1 with NO visible window (SW_HIDE = 0).
' Task Scheduler runs:  wscript.exe "...\scripts\run-hidden.vbs"
Dim fso, scriptDir, root, ps1, cmd, exitCode
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(scriptDir)
ps1 = root & "\scripts\run-weekly.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """"
exitCode = CreateObject("WScript.Shell").Run(cmd, 0, True)
WScript.Quit exitCode
