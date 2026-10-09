!addplugindir "$PLUGINSDIR\..\plugins"

!macro customBody
  ; 安装页面
  !insertmacro MUI_INSTALLOPTIONS_READ $R0 "installer.ini" "Fields" "Text1"
  !insertmacro MUI_INSTALLOPTIONS_READ $R1 "installer.ini" "Fields" "Text2"
  
  ; 显示安装信息
  SetOutPath "$APPDATA\NovaTrade"
  
  ; 创建桌面快捷方式图标
  CreateShortcut "$DESKTOP\NovaTrade.lnk" "$INSTDIR\NovaTrade.exe"
  
  ; 创建开始菜单快捷方式
  CreateDirectory "$SMPROGRAMS\NovaTrade"
  CreateShortcut "$SMPROGRAMS\NovaTrade\NovaTrade.lnk" "$INSTDIR\NovaTrade.exe"
  CreateShortcut "$SMPROGRAMS\NovaTrade\卸载.lnk" "$INSTDIR\Uninstall.exe"
!macroend
