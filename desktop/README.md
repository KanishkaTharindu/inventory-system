# Office Stock Desktop Setup Guide

This guide covers the Windows desktop version of Office Stock: setting up the shared Supabase project, creating administrator accounts, building the installer, installing it on PCs, and fixing common setup errors.

## 1. How the desktop version works

- Office Stock runs its interface and business rules on each Windows PC in an Electron application.
- Each PC connects directly to the same Supabase project over HTTPS. Supabase provides the shared PostgreSQL database and user authentication.
- There is no Office Stock server to install, host, or start. PCs need an internet connection to read and save shared data. The app does not queue changes while offline.
- Database row level security (RLS) and PostgreSQL transactions enforce access and protect multi-step stock and cash operations. The desktop UI alone is not the security boundary.
- The old Django application is a separate version. Its `.env` settings and `DB_ENGINE=sqlite` setting do not configure this desktop app. The desktop app asks for a Supabase project URL and publishable key.

The Supabase project starts empty. The desktop installer does not import `db.sqlite3` or existing Django records. Existing data needs a separate, reviewed import if you later decide to use it.

## 2. Get the Supabase connection values

In the Supabase Dashboard, open your project’s **Connect** dialog, or go to **Project Settings → API Keys**. Copy:

1. **Project URL**, in the form `https://your-project-ref.supabase.co`.
2. **Publishable key**, beginning with `sb_publishable_`.

Supabase’s [API key guide](https://supabase.com/docs/guides/getting-started/api-keys) describes where to find these values. Office Stock accepts the publishable key because it runs on users’ PCs. It rejects secret/service-role keys. Never put a secret key, service-role key, database password, or user password in the desktop app, SQL files, or source code.

> The `DB_ENGINE`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, and `DB_PORT` values in the root `.env.example` belong to the Django version. They are not Supabase connection settings for Office Stock Desktop. SQLite is a local file database; it does not connect to Supabase.

## 3. Set up the Supabase database once

Do this once per Supabase project, not once per PC.

1. In Supabase, select the correct project and open **SQL Editor**.
2. Open each file below from `supabase/migrations/` and run it in the listed order. Run one file at a time so any error points to one migration.

   1. `202610210001_desktop_schema.sql`
   2. `202610210002_auth_rls.sql`
   3. `202610210003_atomic_inventory.sql`
   4. `202610210004_branch_workflows.sql`
   5. `202610210005_petty_cash.sql`
   6. `202610210006_permissions_and_bootstrap.sql`
   7. `202610210007_validation_and_grants.sql`
   8. `202610210008_audit_and_settings.sql`
   9. `202610210009_restored_workflows.sql`
   10. `202610210010_function_privileges.sql`

3. If Supabase shows **Potential issue detected** about tables and RLS, choose **Run and enable RLS**. The schema migration enables RLS, and the following migration installs the policies used by signed-in users.
4. Confirm each query completes successfully before moving to the next file. Do not rerun a migration that completed successfully. If a query reports an error, keep the full error text and fix that migration before continuing.

These migrations create the tables, initial roles, authentication profile trigger, access policies, audit rules, and transactional inventory and petty cash operations.

## 4. Create the first Super Admin

The Auth account (email and password) and the application role are separate things. Creating an Auth account sets its login credentials. The SQL bootstrap grants that account Super Admin access; **it does not create or reset a password**.

### Recommended: create the account in Supabase Dashboard

This avoids depending on a confirmation email when you are setting up the first administrator.

1. Open **Authentication → Users → Add user → Create new user**.
2. Enter an email address you control and choose a strong password of at least 12 characters. If shown, enable **Auto Confirm User**.
3. Open `supabase/bootstrap_first_admin.sql`. Replace the email value in `admin_email` with the exact email used for the Auth account. Do not put the password in this SQL file.
4. Run the SQL file once in the same project’s **SQL Editor**. It creates/activates the Main Office profile for that account.
5. Open Office Stock, enter the project URL and publishable key, then sign in with that email and password.

The Dashboard account creation method is an administrative action. Do not put a Supabase secret or service-role key into the desktop app to create users.

### Alternative: create the account from Office Stock

On the Office Stock sign-in page, choose **Create account** and set a password of at least 12 characters. If email confirmations are enabled, confirm the email first. Then run the bootstrap SQL as described above.

For app sign-up, Supabase must allow new user registration. In Supabase Authentication provider settings, check the Email provider and the **Allow new users to sign up** setting. If confirmation emails are required, the account must be confirmed before the bootstrap will accept it.

## 5. Add another Super Admin

Use this when an active Super Admin already exists, or when you need a new account with a password you know.

1. In **Authentication → Users → Add user → Create new user**, create an account with a **different email address** that you control and choose its password. Enable **Auto Confirm User** if shown. Supabase will not create a duplicate Auth account for an email already in use.
2. Open `supabase/promote_additional_super_admin.sql` and replace `new-admin@example.com` with the new account’s exact email.
3. Run that SQL file in the project’s **SQL Editor**. It promotes the selected confirmed Auth account and leaves the existing Super Admin active.
4. Sign in to Office Stock using the new account’s email and password.

Do not rerun `bootstrap_first_admin.sql` to add another administrator. It deliberately stops when a Super Admin is already active. The additional-admin SQL does not create a login account or password; create the Auth account first.

## 6. Configure Office Stock on each PC

1. Start **Office Stock**.
2. On the **Connect to Supabase** screen, enter the project URL and `sb_publishable_...` key from section 2.
3. Select **Validate and save**. This checks that the Auth endpoint can be reached and accepts the key. It does not check that database migrations have been run.
4. Sign in with an Auth account that has an active application profile.

Repeat these steps on every PC, using the same project URL and publishable key. Each Windows user profile stores its own connection and session using Windows-protected local storage. Do not copy another person’s session token to a different PC.

## 7. Build the Windows installer

Only the developer/build PC needs Node.js 24 or later. People installing the finished app do not need Node, Python, Django, or a terminal.

From PowerShell, run:

```powershell
Set-Location desktop
npm.cmd ci
npm.cmd run dist:win
```

The installer is created at:

```text
desktop/dist/OfficeStock-Setup-1.0.0-x64.exe
```

The installer supports per-user installation, a selectable install location, and Start Menu/Desktop shortcuts. It registers the `officestock://` link handler used for authentication callbacks. The installer is currently unsigned, so Windows SmartScreen may show an unknown publisher warning. Distribute it only through a trusted channel; a code-signing certificate can identify the publisher.

To give the system to another user, share the generated installer. They install it, then enter the same Supabase project URL and publishable key on first launch and sign in with their own Auth account. Never distribute a service-role or secret key.

## 8. Set up password reset links and email delivery

In Supabase, open **Authentication → URL Configuration** and add this exact URL under the allowed redirect URLs:

```text
officestock://auth/callback
```

Office Stock requests this redirect for password recovery and email confirmation. The **Site URL** is a fallback used when the request does not provide an allowed redirect. If you use custom Auth email templates, use Supabase’s `RedirectTo` value so the link returns to the app. See [Supabase redirect URL setup](https://supabase.com/docs/guides/auth/redirect-urls).

### Connect your existing mail server

You do not need to buy Supabase email sending. If your mail provider offers an SMTP server that accepts connections from the internet, Supabase Auth can use it. Ask your email/hosting provider for these values:

- SMTP host, such as `mail.your-domain.com`.
- SMTP port and encryption method. Use the exact values from your provider; common ports are 587 (STARTTLS) and 465 (implicit TLS).
- SMTP username and password. This may be a full mailbox address and an app-specific password.
- Sender email address that the mailbox is permitted to send as, such as `no-reply@your-domain.com`.
- Sender name, such as `Office Stock`.

Then, in Supabase Dashboard, open **Authentication settings → SMTP** (custom SMTP), enable it, enter those values, and save. Supabase’s [custom SMTP instructions](https://supabase.com/docs/guides/auth/auth-smtp) show the corresponding settings. Keep the SMTP password private; enter it only in the Supabase Dashboard, not in Office Stock, SQL, `.env`, or Git.

The mail server must be reachable from Supabase over the internet. A server available only as `localhost`, a private office IP, or a VPN-only address will not work directly. In that case ask your provider for a public SMTP relay that permits authenticated sending. Make sure the sender address is authorized by your provider. Configure SPF, DKIM, and DMARC for your sending domain as your provider recommends to help messages reach inboxes.

Supabase’s default email sender is for testing: it is best-effort, limited to two messages per hour, and restricts delivery to authorized project team addresses. Custom SMTP removes those default-recipient restrictions, but Supabase and your mail provider still apply rate limits and sending quotas. Supabase currently applies a low initial limit to custom SMTP projects; its [SMTP guide](https://supabase.com/docs/guides/auth/auth-smtp) explains rate limits and deliverability.

After saving the settings, test by requesting one password reset for a real account and check the mailbox’s inbox and spam folder. You can also check the project’s Auth logs if delivery fails.

When the desktop installer is installed, opening a valid `officestock://auth/callback` link should launch Office Stock and show the password form. A reset email does not reveal the old password; the user chooses a new one after opening a valid recovery link.

## 9. Add ordinary users and assign access

- Office Stock accounts are for signing in to Office Stock. The app’s **Super Admin** role is an application role; it does not grant Supabase Dashboard, SQL Editor, or project-owner access. Do not add ordinary users as members of your Supabase organization/project or share your Dashboard login with them.
- Users sign in to the app with the Auth email and password created for them. They do not need a separate Supabase Dashboard account. The app uses the public publishable key, while Supabase RLS enforces what each signed-in user can do.
- A new Auth account gets an inactive `pending` profile by default. It cannot read or change application data until an administrator assigns a role, branch, and active state.
- A signed-in Super Admin can use **Users → Create user** to create an account and assign access. The temporary password must be at least 12 characters. Share it with that user privately so they can sign in and change it.
- In-app account creation requires Supabase sign-ups to be enabled. If sign-ups are disabled, create the Auth account in Supabase Dashboard first, then manage its access from the application.
- Keep at least one active Super Admin. RLS policies and database functions enforce user and branch permissions even if someone modifies the desktop files.

## 10. Common errors and what to do

| Error or symptom | What it means | What to do |
| --- | --- | --- |
| **The Supabase URL must be an HTTPS project origin** | The URL is malformed, uses HTTP, or includes a path. | Use the project URL exactly as copied from Supabase, such as `https://project-ref.supabase.co`. Do not append `/auth`, `/rest/v1`, or a trailing route. |
| **Use the Supabase publishable key** | The key is missing, is an old key format, or is a secret/service-role key. | Copy the `sb_publishable_...` key from the correct project. Never paste a secret key into the app. |
| **Supabase rejected the publishable key** | The key and URL are from different projects, or the key was copied incorrectly. | Copy both values again from the same project. |
| **Could not reach Supabase** or a timeout | Internet, DNS, firewall, proxy, or Supabase availability problem. | Check that the PC is online, retry, and verify the project URL. The app cannot save to the shared database while offline. |
| **No Auth user found for ...** during bootstrap | The email in the SQL file does not match an Auth account in this project. | In the same Supabase project, open Authentication → Users and confirm the account exists. Use its exact email in the SQL file. A read-only check is: `select id, email, email_confirmed_at from auth.users order by created_at desc;` |
| **The email ... is not confirmed** | Supabase Auth has the account, but it is not confirmed. | Confirm it from the email link, or create it in the Dashboard with Auto Confirm enabled if that option is available. Then run the bootstrap/promotion script again. |
| **No Supabase Auth account found** even though you see a user | The SQL query is being run against a different Supabase project, or the email does not match exactly. | Compare the project selected in the Dashboard with the URL entered in Office Stock. Copy the email shown under Authentication → Users exactly. |
| **Supabase did not return a user. Check that sign-ups are enabled.** | Public sign-up may be disabled, or that email already has an account. | Enable **Allow new users to sign up** for the Email provider, or create a new account from the Supabase Dashboard. Do not try to sign up again with an email already registered. |
| **A Super Admin is already active. This bootstrap is one-time only.** | The first administrator has already been activated. | Use `supabase/promote_additional_super_admin.sql` for a second account. Do not remove the existing administrator just to rerun the first bootstrap. |
| **No active Main Office branch exists** during promotion | The first-admin bootstrap has not created the Main Office yet, or it is inactive. | Run the first-admin bootstrap successfully first, then rerun the additional-admin promotion script. |
| **Access is not active** after sign-in | The Auth login worked, but the profile is pending/inactive or has no role/branch. | Sign in with an active Super Admin and assign the user a role, branch, and active state under **Users**. For the first/second Super Admin, use the appropriate SQL bootstrap script. |
| **No application profile exists** or missing profile/settings table | Migrations were skipped, run in the wrong project, or did not finish. | Apply all ten migration files in order to the same project used by the app. Check SQL Editor results for the first failed query. |
| **Permission denied**, HTTP 401/403, or an empty section | The session expired, the profile is inactive, or RLS/role permissions deny that operation. | Sign out and back in. Confirm the profile is active and assigned the intended role/branch. If this is a new project, ensure all migrations completed. Do not “fix” this by using a secret key in the app. |
| **Potential issue detected: tables without RLS** in SQL Editor | Supabase’s SQL warning is asking about row level security. | For the supplied migrations, choose **Run and enable RLS**. They explicitly enable RLS and later install the application policies. |
| **No reset email arrives** | The default sender may be rate-limited, restrict the recipient, or fail delivery. | Check Spam and the project’s Auth logs. The default sender is limited to two messages per hour and may only send to authorized team emails. Configure custom SMTP, or create another account directly in Supabase Dashboard if you need immediate access. |
| Reset link opens `localhost:3000` and says **otp_expired** | The link is expired/used, or Supabase is redirecting to a local development URL instead of the desktop app. `localhost` only works on the PC while a local web server is running. | Request one new link after correcting settings. Confirm `officestock://auth/callback` is allowed, install the desktop app, and open the newest link on that PC. Do not keep reopening an old link. |
| **No password was created by the bootstrap** | The bootstrap only assigns the app role; it never sets Auth credentials. | Use the password chosen when creating the Auth account. If it is unknown, reset it by email, or create a new Auth account with a password and promote it with the additional-admin script. |
| A second account cannot reuse the first account’s email | Supabase Auth requires a unique email identity. | Use a different email address you control for the new account. |
| Windows says **Unknown publisher** | This installer is not signed with a publisher certificate. | Verify the installer came from your trusted project owner/build PC before continuing. A code-signing certificate removes the unknown-publisher identity warning. |

If a SQL script fails, copy the complete error and identify the migration/script name. Do not paste passwords, secret keys, SMTP passwords, or session tokens into support messages.

## 11. First-use checks across PCs

After installation, use two PCs with different Auth users and confirm:

1. Both have the same project URL and publishable key.
2. A record saved on PC A appears on PC B after refresh.
3. A user cannot access a branch or action outside their assigned permissions.
4. Two simultaneous stock issues cannot make stock negative; the final balance is consistent on both PCs.
5. Petty cash spending cannot exceed the shared balance when two requests happen at the same time.
6. With the internet disconnected, the app shows a connection problem and does not claim an unsaved change succeeded.

These checks require your Supabase project and two PCs. A successful connection check on the setup screen alone does not verify migrations, sign-in, RLS, or concurrent operations.

## 12. Security and data handling

- The publishable key identifies the application; it is not a user password or a privileged key. Supabase Auth identifies the signed-in user, and RLS enforces that user’s database access. See [Supabase API key security](https://supabase.com/docs/guides/getting-started/api-keys).
- Never ship a Supabase secret/service-role key in the installer. Those keys bypass RLS.
- Passwords are handled by Supabase Auth. Do not store passwords, password hashes, or SMTP credentials in app settings or SQL scripts.
- Office Stock encrypts the local project settings and session using Windows-protected storage. Each Windows account needs its own sign-in.
- The app calls Supabase directly. It does not include a local backend, cloud application backend, or offline write queue.
- Business transactions that must be atomic run inside guarded PostgreSQL functions. Supabase applies permissions and RLS to those operations, so changing the desktop files must not grant extra database rights.

## 13. Updating, uninstalling, and project files

- To release an updated installer, build it on the developer PC and share the new `desktop/dist/OfficeStock-Setup-...-x64.exe`. Bump `version` in `desktop/package.json` before a release if you want a new version number in the installer name.
- Uninstalling Office Stock does not delete the Supabase project or its shared data. The installer is configured to retain the Windows user’s local app data. Sign out before handing a shared Windows account or PC to another person; use a separate Windows account for each person when possible.
- Apply database migrations only when a project update supplies new migration instructions. Do not rerun the original ten migrations as a routine way to update the app.

Useful files:

| File/folder | Purpose |
| --- | --- |
| `desktop/main.js` | Local Electron main process, secure storage, connection validation, and authentication deep links. |
| `desktop/preload.js` | Limited bridge between the local UI and Windows/Electron features. |
| `desktop/ui/` | Application screens and styles. |
| `supabase/migrations/` | Database schema, RLS rules, roles, and transactional operations. |
| `supabase/bootstrap_first_admin.sql` | One-time activation of the first Super Admin Auth account. |
| `supabase/promote_additional_super_admin.sql` | Promotion of a separately created, confirmed Auth account to an additional Super Admin. |
| `.env.example` | Settings for the separate Django version; not used by the desktop application. |

For the separate Django version, see the Django setup instructions in the repository’s root [README](../README.md). Those instructions require Python and a Django runtime; they do not describe how to install the Windows desktop app.
