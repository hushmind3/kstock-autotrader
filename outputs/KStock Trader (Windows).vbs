Option Explicit
Dim shell, fso, scriptDirectory, projectRoot, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDirectory)
If shell.Run("cmd /d /c node -e ""process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)""", 0, True) <> 0 Then
  MsgBox "Node.js 22 이상을 먼저 설치해 주세요.", vbCritical, "KStock Trader 실행 실패"
  WScript.Quit 1
End If
command = "node """ & projectRoot & "\scripts\desktop-launcher.mjs"""
shell.Run command, 0, False
