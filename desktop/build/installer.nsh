; Forsion NSIS 自定义卸载:卸载时询问是否一并清除用户数据。
; customUnInstall 宏由 electron-builder 在卸载流程中调用(默认 oneClick 安装也生效)。
; 注意:~/.forsion、~/Forsion 等由 App 的 JS 在用户目录创建,NSIS 原生不知道,需在此显式删除。
; ~/.tangu、~/Tangu 是 junction(删真身后悬空但无害),不 RMDir /r 以规避穿透 junction 的坑。

; ⚠️ 更新(而非真卸载)时,安装器会带 `--updated` 静默跑一遍旧卸载器 —— 此时**一个字都不许问**:
; 用户点的是「更新」,数据当然留着(实报:更新途中弹「是否保留数据」)。${isUpdated} 由 electron-builder
; 在卸载器里提供(见 app-builder-lib/templates/nsis/uninstaller.nsh 同段用法),NSIS 的静默模式并不会
; 自动吞掉 MessageBox,所以必须显式绕开。
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "同时删除 Forsion 的数据与工作区(账号/设置/Agent 数据/会话)?$\r$\n位置:$PROFILE\.forsion 与 $PROFILE\Forsion。此操作不可恢复。" IDNO skipTangu
      RMDir /r "$PROFILE\.forsion"
      RMDir /r "$PROFILE\Forsion"
    skipTangu:
    MessageBox MB_YESNO|MB_ICONQUESTION "同时删除 Forsion 的桌面设置(窗口/壳层配置)?" IDNO skipDesktop
      RMDir /r "$APPDATA\Forsion"
    skipDesktop:
  ${endif}
!macroend
