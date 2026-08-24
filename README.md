# Fanal

Prédicteur IA **indépendant** du prix Bitcoin à **5 secondes**. Interface française. Ce n’est **pas** un bot de trading, ni un conseil financier — un jouet de recherche.

Le live lit **Coinbase Exchange** public REST, produit **BTC-USD** (ticker, carnet niveau 2, trades). Aucune clé API. Les bougies 1s live sont reconstruites à partir des trades (taker buy = maker `sell`). Le classifieur LightGBM 5s est entraîné hors-ligne sur la **même** reconstruction (pagination publique de `/products/BTC-USD/trades`). Coinbase n’offre pas d’archive 1s type Binance Vision.

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

Split **temporel** (pas de shuffle). Horizon 5s, égalités exclues. Live = Coinbase BTC-USD. Le gate combine τ et `min_move_bps`.

Les chiffres **main précédente** (Binance Vision 45 j, τ=0,58 seul, live Coinbase) :

| | main (Binance 1s, τ seul) |
|---|---|
| **τ** | 0,58 |
| **min \|move\|** | — |
| **Précision gated TEST** | **70,3 %** |
| n | 299 106 |
| Couverture | 74,9 % |
| Naive (dernier rendement 1s) | 51,1 % |
| \|move\| moyen | 1,03 bps |
| Espérance après 1 bp | **−0,78 bps** |
| Espérance après 2 bp | −1,78 bps |

Les chiffres **cette branche** (entraînement Coinbase 1s + gate 1 bp) sont dans `models/fanal_sec_meta.json` (`test`, `previous_main`, `swap_reason`). Un edge directionnel vs naive ~51 % peut être réel tout en restant **négatif après 1 bp** — on ne maquille pas d’ATM.

Poids live : `models/fanal_sec_lgbm.txt` + dump JSON pour le scoreur Node. On ne remplace les poids que si le TEST a une **meilleure E après 1 bp** (moins négative / positive) **ou** une gated-acc ≥ main avec une couverture encore utilisable (~1–5 % des secondes, de préférence plus).

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

Les dumps bruts / barres 1s restent dans `data/` (gitignoré), ainsi que les `.pkl`. Le script pagine `/products/BTC-USD/trades`, respecte les rate limits, et reconstruit des barres 1s. Horizon 5s conservé (pas de bascule 5 minutes).

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
