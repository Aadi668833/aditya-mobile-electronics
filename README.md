# Aditya Mobile & Electronics: setup guide (all free)

Files: `index.html` (public catalog), `admin.html` (private panel), `schema.sql` (database + security), `config.js` (your keys).

## 1. Database (Supabase, free)
1. Create an account at supabase.com, then **New project** (choose a strong database password and save it).
2. Open **SQL Editor > New query**, paste all of `schema.sql`, press **Run**. It must finish with "Success".
3. **Authentication > Providers > Email**: turn **OFF "Allow new users to sign up"** (this prevents public admin registration).
4. **Project Settings > API**: copy the *Project URL* and the *anon public* key into `config.js`. Never use or share the `service_role` key.

## 2. First admin account
1. **Authentication > Users > Add user > Create new user**: enter your email and a long password; tick "Auto confirm".
2. In SQL Editor run (use your email):
   `insert into admins(user_id) select id from auth.users where email='you@example.com';`
   Only accounts listed in `admins` can see or change business data. Add another staff member the same way.

## 3. Test before you trust it (do all of these)
- Open `index.html` locally: products list appears after you add one.
- Log in at `admin.html` with a wrong password (must fail), then correctly.
- Add a product, record a purchase (stock goes up), make a sale (stock goes down), try selling more than stock (must be refused), open the bill, print/save as PDF.
- Privacy check: in a private/incognito window open
  `YOUR_SUPABASE_URL/rest/v1/products?select=*` with header `apikey: <anon key>` (e.g. via a REST client).
  It must return `[]` or an error, never products. `public_products` should show only name, price, photo, specs, in_stock.
- Create a second Supabase user that is NOT in `admins`: logging in at admin.html must say no admin access.

## 4. Put it online (GitHub Pages, free)
1. Create a GitHub account and a new **public** repository; upload the 4 files (index.html, admin.html, config.js; keep schema.sql out if you prefer).
2. **Settings > Pages > Deploy from a branch > main / root**. Your site appears at `https://<username>.github.io/<repo>/`.
3. Admin panel: `.../admin.html` (bookmark it on your laptop and phone; it is not linked from the public site).
   Note: the admin page itself is visible to anyone who guesses the URL, but without an admin login it shows nothing, because the database refuses everything.
4. Supabase free projects pause after about a week with no activity; open the project and press Restore if that happens. Back up occasionally with the CSV report.

## Daily use
Products > Add product (photo, prices, opening stock) → Purchases when new stock arrives → New sale for each customer → bill opens, press Print / Save as PDF. Wrong stock count? Products > Stock (a reason is required and logged).

## Known limits
One product per purchase entry; reports filter by period (not yet by product/category); charts are simple bars; no customer ledger beyond "Add payment"; the activity log is stored (table `activity_log`) but has no screen yet.
