# GMBC-PTO-Tracker
A web app for Glen Meadows baptist church to use for paid time off tracking

## Stucture:
- `Code/` - Central folder.
- `Sheets/` - Folder listing all table headers and tabs in the conencted google sheet.
- `README.md` - ReadMe doc.

## Key Files:
- `Code/Code.gs` - google scripts base code.
- `Code/Intex.HTML`- HTML for front end PTO tracking.
- `Code/Appsscript.json` - access and privilges.
- `Sheets/SheetsStructure` - Layout of the google sheet.

## Deployment Notes
- Deploy the web app to execute as the script owner and share access to your Google Workspace domain.
- The PTO app identifies the current user from their Workspace email, so users must open the app with the correct Google account.
- The UI now includes a `Use Different Google Account` action to send users to Google's account chooser and return them to the PTO app.
- The manifest intentionally keeps only the scopes needed by the current code so the first-run consent screen stays as small as possible.
