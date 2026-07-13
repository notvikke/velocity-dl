!macro NSIS_HOOK_PREINSTALL
  ; Chrome-family browsers can keep the native messaging host open while the
  ; desktop app is upgraded. Stop that helper before NSIS replaces its binary.
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM vdl_native_host.exe'
  Pop $0
!macroend
