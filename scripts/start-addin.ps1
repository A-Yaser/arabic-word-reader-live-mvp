$ErrorActionPreference='Stop';$R=Split-Path -Parent $PSScriptRoot;Set-Location (Join-Path $R 'addin');if(!(Test-Path '.\node_modules')){npm install};npx office-addin-dev-certs install;npm run dev
