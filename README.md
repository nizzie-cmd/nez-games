# Nez Games

The Nez Games website (`public/index.html`, served at `/`) and its first game, Bribe-Tac-Toe (`public/bribe-tac-toe/`, served at `/bribe-tac-toe/`). One Render service runs both.

## Bribe-Tac-Toe

Two-player tic tac toe over the internet. On your turn you can pay $1 through Stripe Checkout to erase one of your opponent's marks (once per turn), then place your own.

One player clicks **Start a game** and sends the link; the first other person to open it plays O. Moves update live for both players.

## Run locally (Stripe test mode)

1. `npm install`
2. `cp .env.example .env` and set `STRIPE_SECRET_KEY` to your **test** secret key (Stripe Dashboard → Developers → API keys).
3. `npm start`, then open http://localhost:4242
4. To play yourself, open the invite link in a private window. Pay with test card `4242 4242 4242 4242`, any future expiry, any CVC.

## Put it online with Render

1. Push this folder to a GitHub repository.
2. On render.com, choose **New → Blueprint**, pick the repository, and Render reads `render.yaml`.
3. When asked, paste your Stripe secret key into `STRIPE_SECRET_KEY`, and the $1 price ID from your Stripe product catalog (`price_...`) into `STRIPE_PRICE_ID`. Leave `STRIPE_WEBHOOK_SECRET` empty for now.
4. After it deploys, open the `https://….onrender.com` address and start a game.

Optional webhook (counts a payment even if the player closes the tab before Stripe sends them back): in Stripe, add an endpoint `https://<your-app>.onrender.com/webhook` for `checkout.session.completed`, then put its signing secret into `STRIPE_WEBHOOK_SECRET` on Render.

## Limits to know

- Games are kept in memory. A restart or redeploy ends games in progress. Render's free plan also sleeps after about 15 minutes with no visitors, and the first visit after that takes up to a minute.
- Paid erases are stored in `data.json`, which Render's free plan wipes on restart. Erases are normally used seconds after paying, so this rarely matters.
- Players are recognized by a browser cookie. Switching browsers mid-game makes you a spectator.
