CONFLICT REPAIR FILES
=====================
Replace these files in the project root, preserving paths:
  api/index.ts
  server/db.ts
  server/routes.ts
  vite.config.ts
  package.json
  package-lock.json (if included)

Then run in PowerShell:
  Get-ChildItem -Recurse -File -Include *.ts,*.tsx,*.js,*.jsx,*.json,*.mjs,*.cjs |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } |
  Select-String -Pattern '^<<<<<<<|^=======|^>>>>>>>'

The command must return nothing.
Then:
  npm install
  npm run lint
  npm run build
