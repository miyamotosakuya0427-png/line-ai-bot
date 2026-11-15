# ONE JARVIS Apps Script

This directory contains the Apps Script source used by the JARVIS service to access the company spreadsheet.

## Security setup before deploying

1. Copy `apps-script/Code.gs` into the existing `ONE-JARVIS-SHEETS` Apps Script project.
2. In Apps Script **Project Settings → Script Properties**, keep the existing `SPREADSHEET_ID` and `JARVIS_SHEETS_TOKEN` values. Do not paste their values into GitHub, issues, or chat.
3. Before enabling the initial-admin endpoint, an authorized spreadsheet owner must inspect the pending `EMP003` row in `13 LINE連携` and independently confirm that it belongs to the intended administrator.
4. Only after that manual verification, add the Script Property `JARVIS_INITIAL_ADMIN_LINE_USER_ID` with the exact LINE user ID from that verified row. Keep this identifier private. Do not derive it from a request body or allow a user to self-register it.
5. Confirm that the initial-admin property is present, then use the existing JARVIS endpoint to complete the one-time bootstrap. The bootstrap is rejected if the property is missing, malformed, or does not exactly match the LINE identity verified by the JARVIS server.
6. Restrict spreadsheet and Apps Script project access to trusted administrators. The audit sheet is append-only through this code, but Google Sheets editors can still manually alter it; restrict editor permissions and use Google Drive version history/organizational controls where available.

## Audit behavior

The script creates `14 管理者操作履歴` when the first admin action is recorded. It appends separate `開始`, `成功`, and, where possible, `失敗` events for initial-admin bootstrap and LINE-link approval/rejection. Existing audit rows are not updated or deleted by the script.

## Important deployment boundary

Committing this source to GitHub does **not** update the live Apps Script deployment or the Render service. Deploy those separately only after reviewing the exact changes and approving the deployment. Never use the production `main` branch for this work.
