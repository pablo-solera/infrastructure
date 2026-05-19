param(
    [string]$ComposeDir = $PSScriptRoot,
    [string]$BackupRoot = "$PSScriptRoot\backups",
    [string]$GiteaContainer = "gitea",
    [string]$PostgresContainer = "postgres-db",
    [string]$GiteaImage = "docker.gitea.com/gitea:1.26"
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
}

function Assert-Docker {
    try {
        docker version | Out-Null
    }
    catch {
        throw "Docker no está disponible o no responde."
    }
}

function Assert-ContainerRunning($name) {
    $status = docker inspect -f "{{.State.Running}}" $name 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "No existe el contenedor '$name'."
    }
    if ($status.Trim() -ne "true") {
        throw "El contenedor '$name' no está arrancado."
    }
}

Assert-Docker

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$backupDir = Join-Path $BackupRoot $timestamp
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$dataDir = Join-Path $ComposeDir "data"

if (-not (Test-Path $dataDir)) {
    throw "No existe la carpeta '$dataDir'."
}

Write-Step "Comprobando contenedores"
Assert-ContainerRunning $GiteaContainer
Assert-ContainerRunning $PostgresContainer

$giteaBackupFile = "gitea-dump-$timestamp.zip"
$pgDumpFile      = "postgres-$timestamp.sql"
$pgGlobalsFile   = "postgres-globals-$timestamp.sql"

try {
    Write-Step "Parando Gitea para un backup consistente"
    docker stop $GiteaContainer | Out-Null

    Write-Step "Generando backup de Gitea con gitea dump"

    # Obtiene UID/GID del usuario git desde la propia imagen/contendor de Gitea
    # Se arranca temporalmente el contenedor real para consultar el usuario.
    docker start $GiteaContainer | Out-Null

    $uid = docker exec $GiteaContainer sh -lc 'id -u git'
    $gid = docker exec $GiteaContainer sh -lc 'id -g git'

    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo obtener el UID/GID del usuario git dentro del contenedor Gitea."
    }

    $uid = $uid.Trim()
    $gid = $gid.Trim()

    docker stop $GiteaContainer | Out-Null

    docker run --rm `
        --user "${uid}:${gid}" `
        -v "${dataDir}:/data" `
        -v "${backupDir}:/backup" `
        $GiteaImage `
        /usr/local/bin/gitea dump `
        -c /data/gitea/conf/app.ini `
        -f "/backup/$giteaBackupFile"

    if ($LASTEXITCODE -ne 0) {
        throw "Falló gitea dump."
    }

    Write-Step "Arrancando Gitea de nuevo"
    docker start $GiteaContainer | Out-Null

    Write-Step "Generando backup nativo de PostgreSQL (pg_dump)"
    docker exec $PostgresContainer sh -lc "export PGPASSWORD=`"$POSTGRES_PASSWORD`"; pg_dump -U `"$POSTGRES_USER`" -d `"$POSTGRES_DB`" -f /tmp/$pgDumpFile"
    if ($LASTEXITCODE -ne 0) {
        throw "Falló pg_dump."
    }

    docker cp "${PostgresContainer}:/tmp/$pgDumpFile" (Join-Path $backupDir $pgDumpFile) | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo copiar el pg_dump al host."
    }

    Write-Step "Generando backup de roles/globales de PostgreSQL"
    docker exec $PostgresContainer sh -lc "export PGPASSWORD=`"$POSTGRES_PASSWORD`"; pg_dumpall -U `"$POSTGRES_USER`" --globals-only -f /tmp/$pgGlobalsFile"
    if ($LASTEXITCODE -eq 0) {
        docker cp "${PostgresContainer}:/tmp/$pgGlobalsFile" (Join-Path $backupDir $pgGlobalsFile) | Out-Null
        docker exec $PostgresContainer sh -lc "rm -f /tmp/$pgGlobalsFile" | Out-Null
    } else {
        Write-Warning "No se pudo generar el dump de roles/globales. El backup principal de la base sí se ha hecho."
    }

    docker exec $PostgresContainer sh -lc "rm -f /tmp/$pgDumpFile" | Out-Null

    Write-Step "Backup completado"
    Write-Host "Carpeta: $backupDir" -ForegroundColor Green
    Write-Host " - $giteaBackupFile"
    Write-Host " - $pgDumpFile"
    if (Test-Path (Join-Path $backupDir $pgGlobalsFile)) {
        Write-Host " - $pgGlobalsFile"
    }
}
catch {
    Write-Error $_
    throw
}
finally {
    $running = docker inspect -f "{{.State.Running}}" $GiteaContainer 2>$null
    if ($LASTEXITCODE -eq 0 -and $running.Trim() -ne "true") {
        Write-Step "Rearrancando Gitea en finally"
        docker start $GiteaContainer | Out-Null
    }
}