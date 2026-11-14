' launch.vbs - run launch.mjs with a hidden window (no console on the desktop).
' The shortcut targets:  wscript.exe "<this file>"
Option Explicit
Dim sh, fso, dir, node
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then node = "C:\Program Files\nodejs\node.exe"
sh.CurrentDirectory = dir
sh.Run """" & node & """ """ & dir & "\launch.mjs""", 0, False
