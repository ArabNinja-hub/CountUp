<#
.SYNOPSIS
    Reproducible LIVE PostgreSQL validation for CountUp (Phase A / M2 auth).

.DESCRIPTION
    Starts (or uses) an ISOLATED, DISPOSABLE PostgreSQL 18 server, then runs the
    real-server test suite `npm run test:db:live` against it. This suite NEVER falls
    back to PGlite: if TEST_DATABASE_URL is missing or points at a non-loopback host,
    it fails loudly. No production database is ever contacted.

    Requires: Node 22, npm, and EITHER Docker OR a local PostgreSQL 18 install
    (psql / pg_ctl on PATH).

.EXAMPLE
    # Docker path (recommended on Windows)
    powershell -ExecutionPolicy Bypass -File .\scripts\live-postgres-validation.ps1 -UseDocker

.EXAMPLE
    # Local PostgreSQL 18 install, e.g. listening on port 55432 with trust auth
    powershell -ExecutionPolicy Bypass -File .\scripts\live-postgres-validation.ps1 `
      -AdminUrl 'postgresql://postgres@127.0.0.1:55432/postgres'
#>
[CmdletBinding()]
param(
    [string] $AdminUrl = 'postgresql://postgres@127.0.0.1:55432/postgres',
    [switch] $UseDocker,
    [string] $PostgresImage = 'postgres:18',
    [string] $ContainerName = 'countup-pg-validation',
    [int] $Port = 55432,
    [string] $CliDatabase = 'countup_cli_validation'
)

$ErrorActionPreference = 'Stop'
$startedContainer = $false
$pushedLocation = $false

function Invoke-Npm {
    param([string[]] $Arguments)
    & npm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed with exit $LASTEXITCODE" }
}

try {
    # ------------------------------------------------------------------ 1. server
    if ($UseDocker) {
        Write-Host "== Starting disposable PostgreSQL 18 container '$ContainerName' on port $Port =="
        & docker rm -f $ContainerName 2>$null | Out-Null
        & docker run -d --rm --name $ContainerName `
            -e POSTGRES_HOST_AUTH_METHOD=trust `
            -e POSTGRES_DB=postgres `
            -p "$($Port):5432" $PostgresImage | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'docker run failed' }
        $startedContainer = $true
        $AdminUrl = "postgresql://postgres@127.0.0.1:$Port/postgres"
        for ($i = 0; $i -lt 60; $i++) {
            & docker exec $ContainerName pg_isready -U postgres -d postgres 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { break }
            Start-Sleep -Seconds 1
        }
        & docker exec $ContainerName pg_isready -U postgres -d postgres
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not become ready in 60s' }
    }
    else {
        if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
            throw 'psql not found. Install PostgreSQL 18, or re-run with -UseDocker.'
        }
        Write-Host "== Using local PostgreSQL at $AdminUrl =="
    }

    # ------------------------------------------------------------------ 2. install
    Push-Location (Join-Path $PSScriptRoot '..')
    $pushedLocation = $true
    Write-Host '== npm ci =='
    Invoke-Npm @('ci', '--no-audit', '--no-fund')

    # ------------------------------------------------------------------ 3. URL guard
    $uri = [System.Uri] $AdminUrl
    $loopback = @('127.0.0.1', 'localhost', '::1', '[::1]')
    if ($loopback -notcontains $uri.Host) {
        throw "Refusing non-loopback host '$($uri.Host)'. Use an isolated local/disposable server."
    }

    # ------------------------------------------------------------------ 4. live suite
    $env:TEST_DATABASE_URL = $AdminUrl
    $env:NODE_ENV = 'test'
    Write-Host '== Live PostgreSQL validation suite (no PGlite fallback) =='
    Invoke-Npm @('run', 'test:db:live')

    # ------------------------------------------------------------------ 5. CLI path
    Write-Host '== Migration CLI against the same real server =='
    if ($UseDocker) {
        & docker exec $ContainerName psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS $CliDatabase WITH (FORCE)" | Out-Null
        & docker exec $ContainerName psql -U postgres -d postgres -c "CREATE DATABASE $CliDatabase" | Out-Null
    }
    else {
        & psql $AdminUrl -c "DROP DATABASE IF EXISTS $CliDatabase WITH (FORCE)" | Out-Null
        & psql $AdminUrl -c "CREATE DATABASE $CliDatabase" | Out-Null
    }
    $cliUriBuilder = [System.UriBuilder]::new($AdminUrl)
    $cliUriBuilder.Path = "/$CliDatabase"
    $env:DATABASE_URL = $cliUriBuilder.Uri.ToString()
    $env:NODE_ENV = 'development'
    Invoke-Npm @('run', 'db:status')
    Invoke-Npm @('run', 'db:migrate')
    Invoke-Npm @('run', 'db:migrate')
    Invoke-Npm @('run', 'db:status')
    Invoke-Npm @('run', 'db:migrate:down')
    Invoke-Npm @('run', 'db:migrate')
    Write-Host '== ALL LIVE POSTGRESQL VALIDATION STEPS PASSED =='
}
finally {
    if ($UseDocker -and $startedContainer) {
        Write-Host "== Removing disposable container '$ContainerName' =="
        & docker rm -f $ContainerName 2>$null | Out-Null
    }
    Remove-Item Env:\TEST_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\NODE_ENV -ErrorAction SilentlyContinue
    if ($pushedLocation) { Pop-Location -ErrorAction SilentlyContinue }
}
