#Requires -Version 5.1
# Installs the app for this machine from the folder this file sits in.
#
#   install.ps1              installs to C:\Program Files\<name>
#   install.ps1 -Check       checks the files and prints what it would do; changes nothing
#   install.ps1 -Replace     replaces an install that is already there
#   install.ps1 -To <path>   installs somewhere else
#
# Every file is checked against app.manifest before anything is written, and again where it landed.
# Nothing is half-installed: if a step fails, the steps before it are undone and each undo is printed.

[CmdletBinding()]
param(
  [string] $To,
  [switch] $Replace,
  [switch] $Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$undo = New-Object System.Collections.ArrayList

function Say($line) { Write-Host $line }

function Stop-With($line) { throw $line }

function Add-Undo($what, $action) { [void]$undo.Add(@{ what = $what; action = $action }) }

function Undo-All {
  for ($i = $undo.Count - 1; $i -ge 0; $i--) {
    $step = $undo[$i]
    try {
      & $step.action
      Say ("undone: " + $step.what)
    } catch {
      Say ("could not undo: " + $step.what + " (" + $_.Exception.Message + ")")
    }
  }
}

function Sha256($path) {
  (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
}

# What Windows says about Smart App Control. An unsigned program is blocked while it is on.
function Smart-App-Control {
  $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
  $value = $null
  try {
    $value = (Get-ItemProperty -Path $key -Name VerifiedAndReputablePolicyState -ErrorAction Stop).VerifiedAndReputablePolicyState
  } catch {
    return 'Smart App Control: not on this machine (the setting is absent).'
  }
  switch ($value) {
    0 { return 'Smart App Control: off.' }
    1 { return 'Smart App Control: ON. It blocks programs that are not signed, and this one is not signed. Turn it off in Windows Security, App and browser control, before the program will start.' }
    2 { return 'Smart App Control: evaluation. It does not block yet, and it can turn itself on later.' }
    default { return ('Smart App Control: the setting reads ' + $value + ', which this script does not know.') }
  }
}

function Am-Admin {
  $me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

try {
  # 1. What is in this folder.
  $plan = Join-Path $here 'install.json'
  $manifestPath = Join-Path $here 'app.manifest'
  $appDir = Join-Path $here 'app'
  foreach ($need in @($plan, $manifestPath)) {
    if (-not (Test-Path -LiteralPath $need)) { Stop-With ("This folder has no " + (Split-Path -Leaf $need) + ". Unpack the whole zip and run this file from inside it.") }
  }
  if (-not (Test-Path -LiteralPath $appDir)) { Stop-With 'This folder has no app folder. Unpack the whole zip and run this file from inside it.' }

  $what = Get-Content -LiteralPath $plan -Raw | ConvertFrom-Json
  $name = $what.name
  $program = $what.program
  $version = $what.version
  if (-not $To) { $To = Join-Path ${env:ProgramFiles} $what.folder }
  $shortcut = Join-Path ${env:ProgramData} ('Microsoft\Windows\Start Menu\Programs\' + $name + '.lnk')
  $regKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + $what.folder

  Say ($name + ' ' + $version)
  Say ('from: ' + $here)
  Say ('to:   ' + $To)
  Say ''

  # 2. Every file, against the manifest, before anything is written.
  $wanted = @{}
  foreach ($line in Get-Content -LiteralPath $manifestPath) {
    if (-not $line.Trim()) { continue }
    $cut = $line.IndexOf('  ')
    if ($cut -lt 1) { Stop-With ('app.manifest has a line this script cannot read: ' + $line) }
    $wanted[$line.Substring($cut + 2)] = $line.Substring(0, $cut).ToLowerInvariant()
  }
  if ($wanted.Count -eq 0) { Stop-With 'app.manifest is empty.' }

  $found = @{}
  foreach ($file in Get-ChildItem -LiteralPath $appDir -Recurse -File) {
    $rel = $file.FullName.Substring($appDir.Length + 1).Replace('\', '/')
    $found[$rel] = Sha256 $file.FullName
  }
  $bad = New-Object System.Collections.ArrayList
  foreach ($rel in $wanted.Keys) {
    if (-not $found.ContainsKey($rel)) { [void]$bad.Add('missing: ' + $rel) }
    elseif ($found[$rel] -ne $wanted[$rel]) { [void]$bad.Add('changed: ' + $rel) }
  }
  foreach ($rel in $found.Keys) {
    if (-not $wanted.ContainsKey($rel)) { [void]$bad.Add('not in the manifest: ' + $rel) }
  }
  if ($bad.Count -gt 0) {
    foreach ($line in $bad) { Say $line }
    Stop-With ('' + $bad.Count + ' of these files are not what the manifest says. Nothing was installed. Download the zip again.')
  }
  Say ('checked ' + $wanted.Count + ' files against app.manifest: all of them match.')
  Say (Smart-App-Control)
  Say ''

  $already = Test-Path -LiteralPath $To
  $running = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($program)) -ErrorAction SilentlyContinue)

  # 3. -Check stops here, having written nothing.
  if ($Check) {
    if ($already) { Say ('Already installed at ' + $To + '. -Replace would replace it.') }
    else { Say ('Would install to ' + $To + ', with a Start menu entry and an entry in Apps and features.') }
    if ($running.Count -gt 0) { Say ('' + $running.Count + ' copies of ' + $program + ' are running; installing would stop and ask you to close them.') }
    Say 'Checked only. Nothing was written.'
    exit 0
  }

  if (-not (Am-Admin)) {
    Stop-With ('This window is not an administrator window, and ' + $To + ' needs one. Nothing was written. The command, in a PowerShell started with "Run as administrator": powershell -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  }
  if ($already -and -not $Replace) {
    $old = 'unknown'
    $oldPlan = Join-Path $To 'install.json'
    if (Test-Path -LiteralPath $oldPlan) { $old = (Get-Content -LiteralPath $oldPlan -Raw | ConvertFrom-Json).version }
    Stop-With ($name + ' ' + $old + ' is already installed at ' + $To + '. Nothing was written. -Replace replaces it.')
  }
  if ($running.Count -gt 0) {
    Stop-With ('' + $running.Count + ' copies of ' + $program + ' are running. Nothing was written. Close them and run this again.')
  }

  # 4. Copy into a folder of its own, check it where it landed, then swap it in.
  $incoming = $To + '.incoming'
  $previous = $To + '.previous'
  if (Test-Path -LiteralPath $incoming) { Remove-Item -LiteralPath $incoming -Recurse -Force }
  if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }

  New-Item -ItemType Directory -Path $incoming -Force | Out-Null
  Add-Undo ('the half-copied folder ' + $incoming) { Remove-Item -LiteralPath $incoming -Recurse -Force -ErrorAction SilentlyContinue }
  # -Path, not -LiteralPath: the wildcard is meant as a wildcard (with -LiteralPath it would look for a file named *).
  Copy-Item -Path (Join-Path $appDir '*') -Destination $incoming -Recurse -Force
  Copy-Item -LiteralPath $plan -Destination (Join-Path $incoming 'install.json') -Force
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $incoming 'app.manifest') -Force
  $uninstaller = Join-Path $here 'uninstall.ps1'
  if (-not (Test-Path -LiteralPath $uninstaller)) { Stop-With 'This folder has no uninstall.ps1. Nothing is installed without the way to remove it.' }
  Copy-Item -LiteralPath $uninstaller -Destination (Join-Path $incoming 'uninstall.ps1') -Force

  $landedBad = 0
  foreach ($rel in $wanted.Keys) {
    $landed = Join-Path $incoming ($rel.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $landed)) { Say ('did not arrive: ' + $rel); $landedBad++; continue }
    if ((Sha256 $landed) -ne $wanted[$rel]) { Say ('arrived changed: ' + $rel); $landedBad++ }
  }
  if ($landedBad -gt 0) { Stop-With ('' + $landedBad + ' files did not arrive as they left.') }
  Say ('copied ' + $wanted.Count + ' files and checked every one of them where it landed.')

  if ($already) {
    Move-Item -LiteralPath $To -Destination $previous
    Add-Undo ('the install that was there (put back from ' + $previous + ')') { Move-Item -LiteralPath $previous -Destination $To -Force }
  }
  Move-Item -LiteralPath $incoming -Destination $To
  Add-Undo ('the new folder ' + $To) { Remove-Item -LiteralPath $To -Recurse -Force -ErrorAction SilentlyContinue }

  # 5. The Start menu entry.
  $exe = Join-Path $To $program
  if (-not (Test-Path -LiteralPath $exe)) { Stop-With ($program + ' is not in the installed folder.') }
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcut)
  $link.TargetPath = $exe
  $link.WorkingDirectory = $To
  $link.Description = $name
  $link.Save()
  if (-not (Test-Path -LiteralPath $shortcut)) { Stop-With 'The Start menu entry was not written.' }
  Add-Undo ('the Start menu entry') { Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue }
  Say 'wrote the Start menu entry.'

  # 6. The entry in Apps and features, which is also how Windows finds the uninstaller.
  $size = [int]((Get-ChildItem -LiteralPath $To -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1024)
  New-Item -Path $regKey -Force | Out-Null
  Add-Undo ('the entry in Apps and features') { Remove-Item -LiteralPath $regKey -Recurse -Force -ErrorAction SilentlyContinue }
  New-ItemProperty -Path $regKey -Name DisplayName -Value $name -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $regKey -Name DisplayVersion -Value $version -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $regKey -Name Publisher -Value $what.publisher -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $regKey -Name InstallLocation -Value $To -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $regKey -Name DisplayIcon -Value $exe -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $regKey -Name UninstallString -Value ('powershell -ExecutionPolicy Bypass -File "' + (Join-Path $To 'uninstall.ps1') + '"') -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $regKey -Name EstimatedSize -Value $size -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $regKey -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $regKey -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
  Say 'wrote the entry in Apps and features.'

  if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }

  Say ''
  Say ('Installed: ' + $name + ' ' + $version)
  Say ('  program:    ' + $exe)
  Say ('  Start menu: ' + $name)
  Say ('  to remove:  powershell -ExecutionPolicy Bypass -File "' + (Join-Path $To 'uninstall.ps1') + '"')
  exit 0
} catch {
  Say ''
  Say ('Stopped: ' + $_.Exception.Message)
  if ($undo.Count -gt 0) { Undo-All }
  exit 1
}
