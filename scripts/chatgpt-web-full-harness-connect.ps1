$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tunnelId = Read-Host "Paste Tunnel ID (tunnel_...)"
$secureKey = Read-Host "Paste runtime API key (Tunnels Read + Use)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $env:CODEX_CHATGPT_WEB_TUNNEL_ID = $tunnelId
  $env:CODEX_CHATGPT_WEB_RUNTIME_KEY = $plainKey
  & node (Join-Path $scriptDir "chatgpt-web-full-harness-connect.mjs")
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:CODEX_CHATGPT_WEB_TUNNEL_ID -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_CHATGPT_WEB_RUNTIME_KEY -ErrorAction SilentlyContinue
  $plainKey = $null
}
