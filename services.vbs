' services.vbs - run services.mjs with a hidden, console-detached window.
' The scheduled task targets:  wscript.exe "<this file>"
' 直接用 node.exe 跑會被綁在某個主控台上，主控台一關就收到
' 0xC000013A（STATUS_CONTROL_C_EXIT）被殺掉，隧道也跟著斷。
' 走 wscript 啟動可以完全脫離主控台。
Option Explicit
Dim sh, fso, dir, node
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then node = "C:\Program Files\nodejs\node.exe"
sh.CurrentDirectory = dir
sh.Run """" & node & """ """ & dir & "\services.mjs""", 0, False
