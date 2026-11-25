# Roomcast

Roomcast broadcasts text and images to three room screens. All four predefined admins can manage any room.

## Start on Windows

Double-click Start Roomcast.cmd to start the server and open the room overview. Keep its window open while you use the site. You can also run the following in PowerShell from this folder. Python 3.12 or newer is recommended. Roomcast uses only Python's standard library.

    python server.py

Open http://127.0.0.1:8000/ for the room overview or http://127.0.0.1:8000/admin for the admin panel. Use an assigned ID and password. Once signed in, the browser keeps the admin session for seven days unless you sign out.

## Use a room

1. Open /rooms/1, /rooms/2, or /rooms/3 in the corresponding screen's browser and choose **Full screen** to hide the browser chrome where supported.
2. In the admin panel, select the same room. Type your note and use **Add images** to pick photos. Desktop users can also drop files on the upload button. Each admin has a separate autosaved draft in each room.
3. Check the **TV preview** to see the 16:9 layout and whether the draft will scroll. On a phone, **TV preview** and **Publish** are in the bottom action bar. Select **Publish** to replace the screen's entire note. The last-updated label comes from the server's publish time. Draft edits and room status changes leave that time alone.
4. To clear the screen, publish an empty draft and confirm. To reuse an older broadcast, open **Publish history** and choose **Restore**.
5. If another admin publishes to the same room first, review the new live message, choose **Keep my draft**, then publish if you still want to replace it.

The **Available** and **In use** setting is manual. Viewers keep the most recent broadcast on screen during a temporary connection loss and pick up the latest broadcast when the connection returns. A room that needs to show a very long note can scroll.

## Reach the screens from a second device

For a trusted local network, you can bind the server to all network adapters:

    python server.py --host 0.0.0.0

Open the app on the second device using the host computer's local network address and port 8000. Keep the host running and use the private-network firewall profile if Windows asks. Local network connections use HTTP by default.

## Deploy to Vercel

1. Import this GitHub repository in [Vercel](https://vercel.com/new). Use the repository root and let Vercel detect Flask.
2. From the Vercel project's **Storage** tab, create or connect a **Neon Postgres** database. Check that **Production** has a pooled connection string in **DATABASE_URL**. **POSTGRES_URL** is also accepted.
3. In **Settings → Environment Variables**, add **ROOMCAST_ADMIN_PASSWORDS** as a sensitive **Production** variable. Enter a single JSON object mapping the four admin IDs to their passwords. For example, replace the example IDs and passwords with your own:

       {"admin-id-1":"REPLACE_WITH_UNIQUE_PASSWORD_1","admin-id-2":"REPLACE_WITH_UNIQUE_PASSWORD_2","admin-id-3":"REPLACE_WITH_UNIQUE_PASSWORD_3","admin-id-4":"REPLACE_WITH_UNIQUE_PASSWORD_4"}

4. Redeploy to Production. Then open the Vercel URL for the room overview, /admin for the editor, or /rooms/1, /rooms/2, and /rooms/3 for the displays.

Roomcast creates the tables and seeds the admin accounts on first use of a new hosted database. Set the passwords before the first successful setup. A new cloud database starts with blank rooms. The project's local SQLite database stays on the Windows computer. Keep passwords and database URLs out of the repository.

The hosted screens check for updates about every 10 seconds. The editor can resize larger JPEG, PNG, and WebP photos before sending them. GIFs must be at most 4 MB to preserve their animation. Anyone who can reach a viewer URL can read its broadcast.

If the rooms show a connection error after deploying, open /api/rooms on the Vercel URL to check the setup message. Then confirm the database and password variables are set for Production and redeploy.


## Local data

The data folder contains the SQLite database, including the seeded admin accounts, saved drafts, images, and broadcast history. Passwords are stored as salted hashes. Keep this folder private and back it up using SQLite's backup command or after stopping Roomcast. Avoid adding data to source control.

BOARD_DATABASE can point to a different SQLite path. To provision a fresh database, pass a JSON object of user IDs and passwords to standard input of python server.py --accounts-from-stdin. Supply the object from a secure prompt or secret store; keep plaintext passwords out of command history and files. A fresh GitHub checkout needs this step before you can sign in locally.
