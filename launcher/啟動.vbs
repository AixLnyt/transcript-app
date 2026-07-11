' 啟動.vbs
' 雙擊即可執行 npm start，不會跳出黑底命令提示字元視窗

Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")
scriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
objShell.CurrentDirectory = scriptDir
objShell.Run "cmd /c npm start", 0, False
