; Forsion NSIS 自定义卸载:卸载时询问是否一并清除用户数据。
; customUnInstall 宏由 electron-builder 在卸载流程中调用(默认 oneClick 安装也生效)。
; 注意:~/.forsion、~/Forsion 等由 App 的 JS 在用户目录创建,NSIS 原生不知道,需在此显式删除。
; ~/.tangu、~/Tangu 是 junction(删真身后悬空但无害),不 RMDir /r 以规避穿透 junction 的坑。

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "同时删除 Forsion 的数据与工作区(账号/设置/Agent 数据/会话)?$\r$\n位置:$PROFILE\.forsion 与 $PROFILE\Forsion。此操作不可恢复。" IDNO skipTangu
    RMDir /r "$PROFILE\.forsion"
    RMDir /r "$PROFILE\Forsion"
  skipTangu:
  MessageBox MB_YESNO|MB_ICONQUESTION "同时删除 Forsion 的桌面设置(窗口/壳层配置)?" IDNO skipDesktop
    RMDir /r "$APPDATA\Forsion"
  skipDesktop:
!macroend
