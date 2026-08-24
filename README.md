# Fanal

Prédicteur IA **indépendant** du prix Bitcoin à **5 secondes** (BTCUSDT). Interface française. Ce n’est **pas** un bot de trading, ni un conseil financier.

Le modèle LightGBM lit les bougies 1s publiques Binance, calcule des features de microstructure sans fuite, et n’émet un signal **HAUSSIER** / **BAISSIER** que si \(P(\uparrow)\) sort de la bande \(\tau\). Sinon : **NEUTRE**.

Repo : [github.com/Jayvy2002/fanal](https://github.com/Jayvy2002/fanal)

## Test out-of-sample

Split temporel (pas de shuffle) sur 21 jours de klines 1s Binance Vision (2026-08-03 → 2026-08-23), horizon 5s, égalités exclues :

| | |
|---|---|
| **τ** | 0,58 |
| **Précision gated** | **67,3 %** |
| n | 143 121 |
| Couverture | 78,3 % |
| Naive (dernier rendement 1s) | 51,8 % |

Poids : `models/fanal_sec_lgbm.txt` + dump JSON pour le scoreur Node.

## Lancer en local

```bash
cd frontend
npm i
npm run dev
```

Le serveur Vite (`http://localhost:5173`) proxifie déjà `/api/*` vers la même logique que les Netlify Functions (ticker, carnet, live, health).

Pour coller à la prod :

```bash
npm i -g netlify-cli
# à la racine du repo
npx netlify dev
```

Ré-entraîner (optionnel, Python 3 + lightgbm/pandas/numpy) :

```bash
python3 train/train_fanal.py 21
```

Les zips Vision restent dans `data/` (gitignoré).

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

Chaque invocation de fonction interroge l’API publique Binance (`data-api.binance.vision`, repli `api.binance.com`), calcule les features, et score le LightGBM en TypeScript (arbres JSON, booster en cache module). Aucun secret.

Le paper trading 5s est **en mémoire par instance** : un cold start Netlify remet le taux de hits à zéro.

## API

- `GET /api/health`
- `GET /api/ticker` — ticker 24h BTCUSDT
- `GET /api/book` — profondeur, mid, OBI 10
- `GET /api/live` — signal + spark + paper + carnet
