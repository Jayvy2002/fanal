# Fanal

Prédicteur IA **indépendant** du prix Bitcoin à **5 secondes**. Interface française. Ce n’est **pas** un bot de trading, ni un conseil financier — un jouet de recherche.

Le live lit **Coinbase Exchange** public REST, produit **BTC-USD** (ticker, carnet niveau 2, trades). Aucune clé API. Les bougies 1s live sont reconstruites à partir des trades (taker buy = maker `sell`).

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

Le paper trading 5s est **en mémoire par instance** : un cold start Netlify remet le taux de hits à zéro.

## API

- `GET /api/health`
- `GET /api/ticker` — ticker Coinbase BTC-USD (+ stats 24h)
- `GET /api/book` — profondeur niveau 2, mid, OBI 10
- `GET /api/live` — signal (`close`, `p_up`, `gated`, `horizon_s`, `expected_move_bps`, `min_move_bps`, `target_px`) + spark ~300 points `{t,p}` + `forecasts[]` (path, hit, target) + paper + carnet + bande pourquoi
