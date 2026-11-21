# Local admin and database setup

Admin sign-in is authenticated by the PHP backend against an active account in the `users` table. Only accounts with the `admin` or `official` role can open the dashboard or perform protected actions such as resident-code recovery delivery. Use the backend account password at sign-in; Gmail App Passwords are only for outbound email. Keep the API behind a trusted environment and do not put backend credentials in Vite variables or frontend code.

Shared operational records, resident document requests and drafts, payment drafts, registration requests and decisions, resident records/history, archives, issued-document history, document fees, certificate availability and uploaded DOCX templates, community updates, official schedules/profiles/photos, GCash recipients, and admin display preferences are synchronized to the `bb1_app_state` table in the configured MySQL database. Writes are sent as a single transaction and queued in order; the dashboard shows whether a change reached the database. Uploaded custom certificate templates include their detected field labels and proof requirements, and are limited to 5 MB total shared storage. Login accounts created through the account endpoints use the relational `users`, `residents`, and registration tables, with passwords stored as hashes. Approving a generic registration request in the admin workflow stores the resident record in app-state; it does not create login credentials.

The database API and MySQL must both be running for cross-session and cross-device persistence. When they are unavailable, the app keeps using the current browser's localStorage and shows a warning; those local-only changes are not shared automatically. If the database reconnects during an open session, choose whether to reload the shared database copy or explicitly save this browser's copy before resuming synchronization.

The certificate PDF converter allows the production frontend origin and localhost development origins by default, and still requires an authenticated admin or official token. Keep the CORS origins exact if changing them. The shared app-state API requires an authenticated admin or official token and contains resident and admin records; it is not a public data API. Do not expose it or other backend endpoints to the public internet until all resident operations use authenticated, role-limited endpoints. A public frontend can be hosted separately, but that does not make the resident/admin workflows safe or available online.

## Public frontend hosting

The production frontend defaults to the same-origin `https://<site>/backend` API path instead of trying to contact `127.0.0.1` on each visitor’s device. To use that default, build with `npm run build`, upload the **contents** of `dist` to the host’s web root, and upload the PHP `backend` directory alongside it so `backend/api.php` resolves at `/backend/api.php`. Do not upload `backend/.env`; configure database and mail settings through the host’s private PHP environment/configuration.

This only fixes the frontend’s API address. The current shared app-state API accepts admin/official tokens and is not sufficient by itself for public resident data access. Do not publish resident records or enable resident workflows against a publicly exposed shared-state endpoint; role-scoped resident APIs and a protected production database are required first.

For the InfinityFree deployment, the PHP backend uses the account's non-secret MySQL host, database name, and username as production defaults when those variables are absent. Set `BRGY_DB_PASSWORD` in the host's private PHP environment; never put the password in frontend files or public source control. Local requests retain the Laragon defaults.

### Optional automatic deployment

`.github/workflows/deploy-infinityfree.yml` builds the frontend and uploads the committed frontend/backend files to `/htdocs` whenever matching changes are pushed to `master`. To enable it, add the hosting FTP server, FTP username, and FTP password as GitHub Actions repository secrets named `FTP_SERVER`, `FTP_USERNAME`, and `FTP_PASSWORD`. Use FTP details from the hosting panel, not the dashboard or MySQL password. The workflow uses explicit FTPS and deliberately excludes `.env`, logs, SQL files, and local helper scripts; it does not migrate or overwrite database records. Keep the existing server-side `/htdocs/backend/.env` and protected `.htaccess` in place. Changes deploy only after they are committed and pushed; they do not sync directly from the editor. If the hosting FTP service does not support FTPS, do not switch to plaintext FTP for unattended deployment; use the hosting panel or another encrypted deployment method instead.

GitHub Free supports Actions and repository secrets; Premium is not required. Only a repository owner or administrator can manage these secrets. If the repository Settings or Actions secrets page is unavailable or returns 404, ask the repository owner/admin to add them. Never send the FTP values in chat or commit them to the repository.

## Laragon database connection

1. Start MySQL in Laragon and confirm the existing `vite_brygmanagmentsystem` database is available. The PHP connection defaults to Laragon's local `root` account with an empty password, matching the existing project configuration.
2. From the project root, run `start-local-system.cmd`. It finds PHP in Laragon, starts the backend at `http://127.0.0.1:8000`, and opens the Vite frontend at `http://127.0.0.1:5173`. Vite is configured to fail instead of silently switching ports, because browser local storage is isolated by port.
3. If you prefer separate terminals, start the backend with `.\backend\start-local-api.ps1` and the frontend with `npm run dev -- --host 127.0.0.1`.
4. If the database uses different connection details, set `BRGY_DB_HOST`, `BRGY_DB_NAME`, `BRGY_DB_USER`, and `BRGY_DB_PASSWORD` in the PHP server's environment before starting it. Do not put database credentials in Vite's `.env`; `VITE_` variables are exposed to the browser.
5. To use different API URLs or a different Vite origin, set `VITE_BACKEND_API_URL`, `VITE_API_URL`, and `BRGY_ALLOWED_ORIGINS` as appropriate, then restart the affected servers.

The app initializes missing database records from browser storage, and merges identified resident-submission records from both sources at startup so local-only submissions are not discarded just because the database contains an older snapshot. Keep a separate MySQL backup: the app-state table is not a substitute for backups. Keep this local-only demo behind a trusted local environment; the data API is not a public deployment authentication layer. Registration uploads currently retain file names, not uploaded file contents.

## Initial resident accounts

The five resident records shown in the admin resident list are synchronized to the relational `users` and `residents` tables without email addresses. Apply the email-nullability migration once if it has not already been applied, then run the CLI seeder from the project root. The seeder file contains the five resident names and codes and is safe to rerun:

```powershell
Get-Content .\backend\migrations\20261113_resident_email_optional.sql | & 'C:\laragon\bin\mysql\mysql-8.4.3-winx64\bin\mysql.exe' -u root vite_brygmanagmentsystem
& 'C:\laragon\bin\php\php-8.3.36-Win32-vs16-x64\php.exe' .\backend\seed-initial-residents.php
```

The seeder is transactional and safe to rerun: it updates the names and addresses for these resident codes and synchronizes their app-state records. Resident login requires the registered first name, last name, and resident code. These accounts do not have email addresses or email delivery enabled.

## Resident code recovery delivery

Recovery requests collect an email address only. Clicking **Verify request** opens the saved recipient and send action. After the admin verifies the resident, the backend emails the current resident login code to the address saved in that resident's relational account. This is the account's existing code, not an OTP or newly generated code; it is not reset. The request becomes verified only after Gmail accepts the email. A missing or invalid saved email stops delivery.

Declining a recovery request sends a short apology notice to the email address submitted with the request. The notice does not include the resident code or additional resident instructions. Decline notices require an authorized backend admin session and configured Gmail SMTP.

The PHP backend requires Composer dependencies. From the project root, install them with:

```powershell
& 'C:\laragon\bin\php\php-8.3.36-Win32-vs16-x64\php.exe' -d extension=zip 'C:\laragon\bin\composer\composer.phar' install --working-dir .\backend
```

## Admin invitation delivery

Admin invitations can be emailed to any valid email address, including another Gmail address. Configure `BRGY_GMAIL_USERNAME` and `BRGY_GMAIL_APP_PASSWORD` in `backend/.env` for delivery. `BRGY_ADMIN_INVITATION_URL` is optional: if omitted, the invitation email uses the backend address that received the request. That address may only be reachable from this computer or network, so recipients outside it need a reachable HTTPS backend URL configured before they can accept. The app-state API is restricted to local development and must not be exposed publicly as-is.

For local development, add your values to `backend/.env` (copy `backend/.env.example` if the file is missing). `backend/.env` is ignored by Git and read only by PHP. Alternatively, set these variables in the PHP API process environment; process environment values take precedence:

- `BRGY_GMAIL_USERNAME`: Gmail address used as the sender.
- `BRGY_GMAIL_APP_PASSWORD`: Gmail App Password (not the Gmail account password).
- `BRGY_GMAIL_FROM_NAME`: optional displayed sender name.

Keep all delivery credentials on the PHP backend. Do not put them in the Vite `.env`, frontend code, or source control. The Gmail account needs an App Password and permission to send mail. A delivery/configuration failure is reported in the admin dialog and leaves the existing resident code unchanged. The seeded initial resident accounts have no email address by default; update their resident records with the correct saved email before using delivery.

During a document request, residents can open the official PhilSys Check website in a new tab and upload an image of its successful result for barangay staff review. The app does not scan or transmit PhilSys QR data, and the uploaded image is not an automatic authenticity check.

The admin dashboard includes a non-destructive archive for moved-out residents and declined registration applications, verification and ready-for-release document queues, DOCX template preview and availability controls, an issued-document logbook, and CSV-exportable request reports in History. In Certificate templates, admins upload a DOCX and provide only its proof requirements. The system automatically detects underlines and blank text boxes as fillable fields, infers their labels from the document, and exposes Word checkbox questions and their nearby options for residents to select. Matching blanks automatically share one answer, checkbox groups allow multiple selections, and signature lines are excluded. The uploaded body layout and content are preserved while the standard barangay header is applied. Each released document is recorded separately with its control number, release date, purpose, OR number, recipient, and issuing officer.

## Certificate PDF downloads

Certificate PDFs are converted from the filled DOCX template by LibreOffice so the document's page size, margins, and pagination come from the Word file rather than the browser preview.

1. Install LibreOffice on the machine running PHP.
2. Run the local PHP API using the Laragon steps above; `backend/certificate-to-pdf.php` is then available at `http://127.0.0.1:8000/certificate-to-pdf.php`.
3. Ensure PHP allows `proc_open` and accepts uploads larger than 15 MB (set `upload_max_filesize` and `post_max_size` to at least `16M`).
4. If LibreOffice is not on PHP's `PATH`, configure `LIBREOFFICE_PATH` to its `soffice` executable. The PDF endpoint always allows `https://airi.infinityfreeapp.com` and allows local Vite origins by default. If the frontend uses a different origin, set `CERTIFICATE_PDF_ALLOWED_ORIGIN` to its exact origin or a comma-separated list; configured values replace local defaults while retaining the production origin.
5. If the PDF endpoint has a different URL, set `VITE_CERTIFICATE_PDF_URL` in `.env` and restart Vite.

The PDF action fills only values present in the resident's confirmed request. Missing values are left blank. The original DOCX files in `src/certificate-templates` are never modified. Keep the endpoint's admin/official authentication enabled and its CORS allowlist limited to the exact frontend origins.

The template editor renders the selected DOCX paper size in its page preview. Changing paper size updates the page dimensions without rewriting the template body or margins, and document-title paragraphs are centered in the editor.
