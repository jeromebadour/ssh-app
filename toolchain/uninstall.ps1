#Requires -Version 5.1
# Removes the install this file sits in. It never touches your own files: your boxes, your keys and your
# settings stay where they are, and this script prints where that is.
#
#   uninstall.ps1          removes the program, the Start menu entry and the entry in Apps and features
#   uninstall.ps1 -Check   prints what it would remove; changes nothing
#
# A folder cannot be deleted while a script inside it is running, so this script copies itself to the
# temporary folder and runs that copy, pointed back at this folder with -Folder. The copy does the work and
# waits for it, so what you see is what happened: no second window, nothing left to finish later.

[CmdletBinding()]
param(
  [switch] $Check,
  [string] $Folder = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$me = $MyInvocation.MyCommand.Path
$here = if ($Folder -ne '') { $Folder } else { Split-Path -Parent $me }
$fromCopy = $Folder -ne ''

function Say($line) { Write-Host $line }

function Am-Admin {
  $person = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $person.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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

  if ($Check) {
    Say ('the folder:                  ' + $(if (Test-Path -LiteralPath $here) { $here } else { 'not there' }))
    Say ('the Start menu entry:        ' + $(if (Test-Path -LiteralPath $shortcut) { $shortcut } else { 'not there' }))
    Say ('the Apps and features entry: ' + $(if (Test-Path -LiteralPath $regKey) { $regKey } else { 'not there' }))
    Say ('left alone, your own files:  ' + $yours)
    if ($running.Count -gt 0) { Say ('' + $running.Count + ' copies of ' + $program + ' are running; removing would stop and ask you to close them.') }
    Say 'Checked only. Nothing was removed.'
    exit 0
  }

  if ($running.Count -gt 0) {
    throw ('' + $running.Count + ' copies of ' + $program + ' are running. Nothing was removed. Close them and run this again.')
  }
  if (-not (Am-Admin)) {
    throw ('This window is not an administrator window, and ' + $here + ' needs one. Nothing was removed. The command, in a PowerShell started with "Run as administrator": powershell -ExecutionPolicy Bypass -File "' + $me + '"')
  }

  # Still standing inside the folder that is to go: hand the work to a copy of this file in the temporary
  # folder, and wait for it. Its words are this script's words.
  if (-not $fromCopy) {
    $copy = Join-Path ${env:TEMP} ('uninstall-' + [Guid]::NewGuid().ToString('N') + '.ps1')
    Copy-Item -LiteralPath $me -Destination $copy -Force
    try {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $copy -Folder $here
      $code = $LASTEXITCODE
    } finally {
      Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue
    }
    exit $code
  }

  $left = 0
  if (Test-Path -LiteralPath $regKey) {
    Remove-Item -LiteralPath $regKey -Recurse -Force
    if (Test-Path -LiteralPath $regKey) { Say ('could not remove the entry in Apps and features: ' + $regKey); $left++ }
    else { Say 'removed the entry in Apps and features.' }
  } else { Say 'the entry in Apps and features was already gone.' }

  if (Test-Path -LiteralPath $shortcut) {
    Remove-Item -LiteralPath $shortcut -Force
    if (Test-Path -LiteralPath $shortcut) { Say ('could not remove the Start menu entry: ' + $shortcut); $left++ }
    else { Say 'removed the Start menu entry.' }
  } else { Say 'the Start menu entry was already gone.' }

  Remove-Item -LiteralPath $here -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $here) {
    # Say which files are still there, so what is left is never a guess.
    $still = @(Get-ChildItem -LiteralPath $here -Recurse -File -ErrorAction SilentlyContinue)
    Say ('could not remove the folder: ' + $here + ' (' + $still.Count + ' files still in it)')
    foreach ($f in $still | Select-Object -First 5) { Say ('  still there: ' + $f.FullName) }
    $left++
  } else {
    Say ('removed the folder: ' + $here)
  }

  Say ''
  if ($left -gt 0) { Say ('' + $left + ' things could not be removed, named above.') }
  Say ('Left alone, as always: your own files at ' + $yours)
  exit $(if ($left -gt 0) { 1 } else { 0 })
} catch {
  Say ''
  Say ('Stopped: ' + $_.Exception.Message)
  exit 1
}
