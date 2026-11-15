' start.vbs - start launch.mjs with no console window (nothing in the taskbar).
' Double-click this file, or make a shortcut pointing at:  wscript.exe "<this file>"
' launch.vbs is the same thing (old name, kept for existing shortcuts).
Option Explicit
Dim sh, fso, dir, node
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then node = "C:\Program Files\nodejs\node.exe"
sh.CurrentDirectory = dir
sh.Run """" & node & """ """ & dir & "\launch.mjs""", 0, False
