# Fanal

Prédicteur IA **indépendant** du prix Bitcoin à **5 secondes**. Interface française. Ce n’est **pas** un bot de trading, ni un conseil financier — un jouet de recherche.

Le live lit **Coinbase Exchange** public REST, produit **BTC-USD** (ticker, carnet niveau 2, trades). Aucune clé API. Les bougies 1s live sont reconstruites à partir des trades (taker buy = maker `sell`). Le scoreur n’utilise que la **dernière barre 1s complète** (la seconde en cours est affichée sur le graphique, pas dans les features).

Les poids live restent Binance Vision 45 j : `log_vol` et `cvd_*` live Coinbase sont ramenés à l’échelle Binance (~10×) ; ret / tbr / imb / z-scores restent bruts. Sans ça les arbres voient des vecteurs hors distribution.

**Feu** seulement si (1) P(↑) sort de la bande τ **et** (2) le |move| 5s **attendu** ≥ **1 bp**. Objectif : meilleure espérance après 1 bp de coût, pas un headline de gated-accuracy.

Repo : [github.com/Jayvy2002/fanal](https://github.com/Jayvy2002/fanal)

## Lire le graphique

Le panneau principal est un graphique 1s (environ 4–5 minutes), pas un mot HAUSSIER isolé.

| | |
|---|---|
| **Curseur blanc** | *Maintenant* |
| **Trait or pointillé** | Trajectoire **prévue** pour les 5 prochaines secondes (et cible de prix). Échelle = |move| attendu calibré sur la validation. |
| **Trait or pâle** | Tête 15s optionnelle (plus faible). |
| **Vert** | La direction prévue a **matché** le réel une fois les 5s écoulées. |
| **Rouge** | Direction **ratée**. |
| **NEUTRE** | P dans la bande τ, **ou** |move| prévu sous 1 bp. |

Bande **pourquoi** : rendement 5s, taker buy, OBI du carnet, etc.

## Test out-of-sample

Split **temporel** (pas de shuffle). Horizon 5s, égalités exclues. Live = Coinbase BTC-USD.

| | main (Binance Vision 45 j, τ=0,58 seul) | Coinbase 14 j + gate 1 bp |
|---|---|---|
| Archive | klines 1s BTCUSDT Vision | trades publics BTC-USD → barres 1s |
| **τ** | 0,58 | 0,58 |
| **min \|move\|** | — | **1,00 bp** |
| **Précision gated TEST** | **70,3 %** | **60,1 %** |
| n | 299 106 | 24 195 |
| Couverture | 74,9 % | **17,8 %** |
| Naive (dernier rendement 1s) | 51,1 % | 52,8 % |
| \|move\| moyen | 1,03 bps | 1,12 bps |
| Espérance après 1 bp | **−0,78 bps** | **−0,80 bps** |
| Espérance après 2 bp | −1,78 bps | −1,80 bps |

Le réentraînement Coinbase **n’a pas** remplacé les poids live : E après 1 bp est un peu **plus négative** (−0,80 vs −0,78) et la gated-acc est inférieure, même si la couverture reste utilisable (18 %). Sur Coinbase, le gate 1 bp améliore tout de même E1 vs τ seul (−0,80 vs −0,82) en filtrant les petits moves.

**Poids live** = arbres Binance Vision 45 j + **gate 1 bp à l’inférence**. Dumps Coinbase dans `models/fanal_sec_lgbm_coinbase.json` (expérience, pas le scoreur Netlify).

Un edge directionnel vs naive ~51–53 % est réel ; après 1 bp de friction l’espérance 5s reste **négative**. Ce n’est pas un edge ATM — on ne maquille pas les chiffres.

## Paper 24 h (pas de live)

Objectif : laisser https://fanal.netlify.app ouvert **24 heures** et voir si le carnet virtuel est profitable. Un jour vert voudrait dire qu’on peut **discuter** d’un live Coinbase Advanced Trade spot BTC-USD — pas avant.

| | |
|---|---|
| Capital virtuel | **1 000 $ US** |
| Clip | **75 $ US** (~0,001 BTC) par signal |
| Positions | **une à la fois**, flatten à l’horizon **5 s** |
| Entrée | feu live **et** `|move|` ≥ `PAPER_MIN_MOVE_BPS` (défaut **1,0** ; constante relevable pour coller à l’aller-retour de frais) |
| Preneur (défaut) | fill immédiat bid/ask, frais **taker des deux côtés** |
| Faiseur / post-only | achat au **bid**, vente à l’**ask** ; fill seulement si le marché **trade à travers** (low < bid / high > ask), pas un touch ni last/mid. Barre 1s commencée avant l’ordre ignorée. Sinon **annulé** à l’horizon du signal. Sortie faiseur, sinon flatten preneur. |
| Frais | palier retail Coinbase Advanced Trade **0–10 000 $ US / 30 j** : preneur **60 bp**, faiseur **40 bp** ([barème public](https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees)). Aller-retour preneur = **120 bp**. |
| Short | notionnel virtuel — le spot BTC-USD n’a pas d’inventaire à découvert. |
| Horloge | chaque `GET /api/live` (l’UI poll **1 s**) **et** la function planifiée `paper-tick` (**1 min**, cron Netlify). L’onglet au premier plan donne la résolution 5 s ; sans lui le flatten avance quand même à la minute — un 24 h paper ne dépend plus d’un onglet ouvert. |
| Persistance | store Blobs `fanal-paper` / clé `ledger` (`consistency: strong`). En local : `/tmp/fanal-paper-ledger.json`. |

Le paper preneur 5 s **devrait perdre** : 120 bp de friction vs ~1 bp de move. L’UI n’en cache rien (cash, equity, PnL réalisé, frais, taux de hits, n, position, mode).

`POST /api/paper` `{ "mode": "taker" | "maker" }` change le mode. `GET /api/paper` relit le carnet sans avancer l’horloge. `GET /api/paper-tick` (et la function planifiée homonyme, cron 1 min) avance un pas comme `/api/live`.

**Non branché** : pas de clés API, pas d’ordres Advanced Trade, pas de retraits.

## Lancer en local

```bash
cd frontend
npm i
npm run dev
```

Le serveur Vite (`http://localhost:5173`) proxifie `/api/*` vers la même logique que les Netlify Functions (ticker, carnet, live, health).

Pour coller à la prod :

```bash
npm i -g netlify-cli
# à la racine du repo
npx netlify dev
```

Ré-entraîner (Python 3 + lightgbm/pandas/numpy) — trades Coinbase publics seulement :

```bash
pip install -r train/requirements.txt
python3 train/train_fanal.py 14
```

Les dumps bruts / barres 1s restent dans `data/` (gitignoré). Le script pagine `/products/BTC-USD/trades`, respecte les rate limits, et reconstruit des barres 1s (ici **14,0 jours**, 1,06 M secondes tradées). Horizon 5s conservé (pas de bascule 5 minutes). Les poids live ne sont remplacés que si le TEST a une meilleure E après 1 bp **ou** une gated-acc ≥ main avec une couverture encore utilisable.

## Déployer sur Netlify

1. [Importer le repo GitHub](https://app.netlify.com/start) `Jayvy2002/fanal`.
2. Les réglages sont dans le `netlify.toml` à la racine — pas besoin de secrets.

| Réglage | Valeur |
|---|---|
| Base directory | `frontend` |
| Build command | `npm run build` |
| Publish directory | `dist` |
| Functions directory | `netlify/functions` |

Le SPA fallback `/* → /index.html` est **après** `/api/* → /.netlify/functions/:splat`, pour ne pas avaler l’API.

Chaque invocation interroge Coinbase Exchange (`api.exchange.coinbase.com`, BTC-USD), reconstruit les barres 1s, calcule les features, et score le LightGBM en TypeScript (arbres JSON, booster en cache module). Aucun secret. Aucun appel Binance depuis le navigateur ni depuis les functions live.

Le paper 5s est **persisté** via Netlify Blobs : un cold start ne wipe plus le livre. Le trading live **n’est pas** branché.

## API

- `GET /api/health` — `paper` = `"blobs"` | `"file"` (plus `"memory"`)
- `GET /api/ticker` — ticker Coinbase BTC-USD (+ stats 24h)
- `GET /api/book` — profondeur niveau 2, mid, OBI 10
- `GET /api/live` — signal + spark + `forecasts[]` + **paper persisté** + carnet + bande pourquoi. Avance le paper d’un pas (features = barre 1s complète).
- `GET /api/paper` — snapshot du carnet (sans pas de simulation)
- `POST /api/paper` — `{ "mode": "taker" | "maker" }`
- `GET /api/paper-tick` — même pas paper que `/live` (cron 1 min en prod)
