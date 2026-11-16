# Auto-fill setup (about 15 minutes, all free)

New and changed files:

| File | What to do |
|---|---|
| `migration-autofill.sql` | Run once in Supabase (step 1) |
| `supabase/functions/product-lookup/index.ts` | Deploy as an Edge Function (step 2) |
| `admin.html`, `index.html` | Replace the old ones on GitHub (step 4) |

`config.js`, `schema.sql` and `logo.png` do not change.

**Do the steps in this order.** If you upload the new `admin.html` before step 1, saving products will fail until the database update is done.

## 1. Update the database
1. Supabase > Table Editor > `products` > Export CSV (a backup, just in case).
2. SQL Editor > New query > paste all of `migration-autofill.sql` > Run. It must say "Success".
   - It only adds optional columns (discount price, colours, photo credit), a duplicate-name guard, and makes billing use the discount price when one is set.
   - If it prints a notice that duplicate names already exist, rename those products and run the file again.

## 2. Get a free AI key (Google AI Studio)
1. Open https://aistudio.google.com/apikey, sign in with a Google account, create an API key and copy it.
2. This key stays on Supabase's server. It is never put in `admin.html` or `config.js` or GitHub.

## 3. Deploy the lookup function (no command line needed)
1. Supabase > **Edge Functions** > **Deploy a new function** > **Via Editor**.
2. Name it exactly `product-lookup`. Delete the sample code, paste the full contents of `index.ts`, and Deploy.
3. Leave "Verify JWT" switched **on**.
4. Edge Functions > **Secrets** > add:
   - `GEMINI_API_KEY` = the key from step 2 (required)
   - `ALLOWED_ORIGIN` = `https://YOURNAME.github.io` (optional, recommended: only your site may call it)
   - `GEMINI_MODEL` (optional). Default is `gemini-3.5-flash`. If searches fail with "AI service did not answer", pick a current Flash model name from AI Studio and put it here.

## 4. Upload the website files
Replace `admin.html` and `index.html` in your GitHub repository (Add file > Upload files). Wait a minute for GitHub Pages to update, then hard-refresh (Ctrl+F5).

## 5. Try it
1. Log in at `admin.html` > Products > **Auto-fill from product name**.
2. Type `Samsung Galaxy M35 5G` > Find product.
3. Check the details, tick a photo (optional), press **Use this information**.
4. Enter your selling price, purchase price (and discount price, stock if any), choose Show on website, press **Save product**.
5. Search the same name again: it should warn that it already exists.
6. Log out and open the function URL, or call it without logging in: it must refuse (401/403).

## Good to know
- **Check everything.** Details come from AI reading web pages. The screen shows a confidence level and source links, but specs and colours can still be wrong for similar models. Edit freely before saving.
- **Photos:** only openly licensed sources are searched (Wikimedia Commons, Openverse). New phones often have none. Then upload your own photo, or use a manufacturer photo you have permission to use. Photos needing credit show a small "Photo:" line on the product card on your website.
- **Nothing is auto-saved or auto-priced.** Selling price, purchase price and stock start empty/0 every time.
- **Discount price:** shown on the website as a struck-through price, and **billing now uses it** (the bill and sale record the discounted price). Leave it blank for no discount. It cannot be higher than the selling price.
- **Duplicates:** the same name (ignoring capitals, spaces and symbols) is blocked, and the same model number asks you to confirm. Give variants distinct names, for example `Galaxy M35 5G (8GB/128GB)`.
- **Free limits:** Google's free tier has daily request limits (see AI Studio). The function also limits each admin to 40 searches per 10 minutes. If the limit is reached, fill the form by hand as before.
- **Privacy:** only the product name you type is sent to the AI and photo sources.
