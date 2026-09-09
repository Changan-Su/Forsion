; 安装进度由独立 NSIS 进程显示,应用退出/旧 exe 被移走时仍然可见。
!macro customInit
  ; 兼容旧客户端 quitAndInstall(true, true) 传来的 --updated /S。
  ; 普通 /S 部署仍尊重静默意图,不影响卸载器。
  ${if} ${isUpdated}
    SetSilent normal
  ${endif}
!macroend

!macro customInstallMode
  ; 更新沿用原来的安装范围,跳过交互;per-machine 分支仍由 builder 负责提权。
  ${if} ${isUpdated}
    ${if} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

LangString forsionInstalling 1033 "Installing ${PRODUCT_NAME}"
LangString forsionInstalling 2052 "正在安装 ${PRODUCT_NAME}"
LangString forsionInstallWait 1033 "This may take several minutes. Shortcuts are temporarily unavailable. Updates restart the app automatically."
LangString forsionInstallWait 2052 "可能需要几分钟，期间快捷方式暂不可用。请等待安装完成，更新后将自动启动。"

!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_TEXT "$(forsionInstalling)"
  !define MUI_PAGE_HEADER_SUBTEXT "$(forsionInstallWait)"
!macroend

!macro customInstall
  ; 此钩子在文件、注册表、快捷方式全部恢复后执行。更新不再停在「完成」页。
  ${if} ${isUpdated}
  ${andIf} ${isForceRun}
    HideWindow
    Call StartApp
    !insertmacro quitSuccess
  ${endif}
!macroend

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
