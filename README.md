# Fanal

Prédicteur IA **indépendant** du prix Bitcoin à **5 secondes**. Interface française. Ce n’est **pas** un bot de trading, ni un conseil financier — un jouet de recherche.

Le live lit **Coinbase Exchange** public REST, produit **BTC-USD** (ticker, carnet niveau 2, trades). Aucune clé API. Le classifieur LightGBM 5s a été entraîné hors-ligne sur des archives 1s **Binance Vision** (features relatives de microstructure, split temporel, sans fuite). Coinbase n’offre pas d’historique 1s : les bougies live 1s sont reconstruites à partir des trades + ticker.

Repo : [github.com/Jayvy2002/fanal](https://github.com/Jayvy2002/fanal)

## Lire le graphique

Le panneau principal est un graphique 1s (environ 4–5 minutes), pas un mot HAUSSIER isolé.

| | |
|---|---|
| **Curseur blanc** | *Maintenant* |
| **Trait or pointillé** | Trajectoire **prévue** pour les 5 prochaines secondes (et cible de prix). Échelle = mouvement attendu calibré sur la validation, pas un scénario inventé. |
| **Trait or pâle** | Tête 15s optionnelle (plus faible). |
| **Vert** | La direction prévue a **matché** le réel une fois les 5s écoulées. |
| **Rouge** | Direction **ratée**. |
| **Les ~20 derniers appels** | Restent en traînée sur le graphique : le réel s’imprime par-dessus la prévision. |

Bande **pourquoi** : rendement 5s, taker buy, OBI du carnet, etc.

## Test out-of-sample

Split temporel (pas de shuffle) sur **45 jours** de klines 1s Binance Vision (2026-07-10 → 2026-08-23), horizon 5s, égalités exclues. Live = Coinbase BTC-USD.

| | 5s (live) | 15s (trait pâle) |
|---|---|---|
| **τ** | 0,58 | 0,58 |
| **Précision gated TEST** | **70,3 %** | 64,3 % |
| n | 299 106 | 165 514 |
| Couverture | 74,9 % | 47,5 % |
| Naive (dernier rendement 1s) | 51,1 % | 52,2 % |
| \|move\| moyen | 1,03 bps | 2,18 bps |
| Espérance après 1 bp | −0,78 bps | −0,56 bps |

VAL 5s était plus haute (81 %) que le TEST (70 %) : régime, comme souvent en microstructure. L’edge directionnel vs naive ~51 % est réel ; après 1 bp de friction l’espérance 5s reste négative parce que les moves sont minuscules. On ne maquille pas de résultats ATM.

Poids live : `models/fanal_sec_lgbm.txt` + dump JSON pour le scoreur Node. On ne remplace les poids que si le TEST gated égale ou bat le baseline (~67 %) ou si l’espérance est clairement meilleure à couverture comparable.

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

Ré-entraîner (optionnel, Python 3 + lightgbm/pandas/numpy) — archives Vision seulement :

```bash
python3 train/train_fanal.py 45
```

Les zips / CSV Vision restent dans `data/` (gitignoré), ainsi que les `.pkl`.

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
- `GET /api/live` — signal (`close`, `p_up`, `gated`, `horizon_s`, `expected_move_bps`, `target_px`) + spark ~300 points `{t,p}` + `forecasts[]` (path, hit, target) + paper + carnet + bande pourquoi
