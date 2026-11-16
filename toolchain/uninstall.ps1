#Requires -Version 5.1
# Removes the install this file sits in. It never touches your own files: your boxes, your keys and your
# settings stay where they are, and this script prints where that is.
#
#   uninstall.ps1          removes the program, the Start menu entry and the entry in Apps and features
#   uninstall.ps1 -Check   prints what it would remove; changes nothing

[CmdletBinding()]
param(
  [switch] $Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Say($line) { Write-Host $line }

function Am-Admin {
  $me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

try {
  $plan = Join-Path $here 'install.json'
  if (-not (Test-Path -LiteralPath $plan)) { throw ('This folder has no install.json, so it is not an install this script made: ' + $here) }
  $what = Get-Content -LiteralPath $plan -Raw | ConvertFrom-Json
  $name = $what.name
  $program = $what.program
  $shortcut = Join-Path ${env:ProgramData} ('Microsoft\Windows\Start Menu\Programs\' + $name + '.lnk')
  $regKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + $what.folder
  $yours = Join-Path ${env:APPDATA} $what.folder

  Say ($name + ' ' + $what.version + ' at ' + $here)

  $running = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($program)) -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0 -and -not $Check) {
    throw ('' + $running.Count + ' copies of ' + $program + ' are running. Nothing was removed. Close them and run this again.')
  }

  $plannedFolder = Test-Path -LiteralPath $here
  $plannedShortcut = Test-Path -LiteralPath $shortcut
  $plannedKey = Test-Path -LiteralPath $regKey

  if ($Check) {
    Say ('the folder:                 ' + $(if ($plannedFolder) { $here } else { 'not there' }))
    Say ('the Start menu entry:       ' + $(if ($plannedShortcut) { $shortcut } else { 'not there' }))
    Say ('the Apps and features entry:' + $(if ($plannedKey) { ' ' + $regKey } else { ' not there' }))
    Say ('left alone, your own files: ' + $yours)
    if ($running.Count -gt 0) { Say ('' + $running.Count + ' copies of ' + $program + ' are running; removing would stop and ask you to close them.') }
    Say 'Checked only. Nothing was removed.'
    exit 0
  }

  $left = 0
  if (-not (Am-Admin)) {
    throw ('This window is not an administrator window, and ' + $here + ' needs one. Nothing was removed. The command, in a PowerShell started with "Run as administrator": powershell -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  }

  if ($plannedKey) {
    Remove-Item -LiteralPath $regKey -Recurse -Force
    if (Test-Path -LiteralPath $regKey) { Say ('could not remove the Apps and features entry: ' + $regKey); $left++ }
    else { Say 'removed the entry in Apps and features.' }
  } else { Say 'the entry in Apps and features was already gone.' }

  if ($plannedShortcut) {
    Remove-Item -LiteralPath $shortcut -Force
    if (Test-Path -LiteralPath $shortcut) { Say ('could not remove the Start menu entry: ' + $shortcut); $left++ }
    else { Say 'removed the Start menu entry.' }
  } else { Say 'the Start menu entry was already gone.' }

  # The folder this script is in: it deletes itself, so the delete is handed to a second PowerShell that
  # waits for this one to end. The second one prints what it did to a file next to the folder.
  $report = $here + '.removed.txt'
  $second = @(
    '$ErrorActionPreference = ' + "'" + 'Continue' + "'",
    'Start-Sleep -Seconds 2',
    'Remove-Item -LiteralPath ' + "'" + $here + "'" + ' -Recurse -Force -ErrorAction SilentlyContinue',
    'if (Test-Path -LiteralPath ' + "'" + $here + "'" + ') {',
    '  Set-Content -LiteralPath ' + "'" + $report + "'" + ' -Value ' + "'" + 'The folder is still there: ' + $here + "'",
    '} else {',
    '  Set-Content -LiteralPath ' + "'" + $report + "'" + ' -Value ' + "'" + 'Removed: ' + $here + "'",
    '}'
  ) -join "`n"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($second))
  Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', $encoded) | Out-Null
  Say ('removing the folder in a second window: ' + $here)
  Say ('it writes what it did to: ' + $report)

  Say ''
  if ($left -gt 0) { Say ('' + $left + ' things could not be removed, named above.') }
  Say ('Left alone, as always: your own files at ' + $yours)
  exit $(if ($left -gt 0) { 1 } else { 0 })
} catch {
  Say ''
  Say ('Stopped: ' + $_.Exception.Message)
  exit 1
}
