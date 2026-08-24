# Fanal

Prédicteur IA **indépendant** du prix Bitcoin. Interface française. Ce n’est **pas** un bot de trading, ni un conseil financier — un jouet de recherche.

Le **graphique** reste un feu **5 secondes**. Le **paper 24 h** (défaut) est **faiseur ~60 s**, gate = aller-retour de frais faiseur — pas un meilleur LightGBM 5 s.

Le live lit **Coinbase Exchange** public REST, produit **BTC-USD** (ticker, carnet niveau 2, trades). Aucune clé API. Jayvy trade sur [Coinbase Advanced Trade](https://www.coinbase.com/advanced-trade/spot/BTC-USD), pas Exchange. Les bougies 1s live sont reconstruites à partir des trades (taker buy = maker `sell`). Le scoreur n’utilise que la **dernière barre 1s complète** (la seconde en cours est affichée sur le graphique, pas dans les features).

Les poids live 5s restent Binance Vision 45 j : `log_vol` et `cvd_*` live Coinbase sont ramenés à l’échelle Binance (~10×) ; ret / tbr / imb / z-scores restent bruts.

**Feu 5s (affichage)** seulement si (1) P(↑) sort de la bande τ **et** (2) le |move| 5s **attendu** ≥ **1 bp**. **Le paper n’entre pas sur ce feu.**

Repo : [github.com/Jayvy2002/fanal](https://github.com/Jayvy2002/fanal)

## Lire le graphique

Le panneau principal est un graphique 1s (environ 4–5 minutes), pas un mot HAUSSIER isolé.

| | |
|---|---|
| **Curseur blanc** | *Maintenant* |
| **Trait or pointillé** | Trajectoire **prévue** pour les 5 prochaines secondes (affichage). |
| **Trait or pâle** | Tête 15s optionnelle (plus faible). |
| **Vert / rouge** | Direction 5s matchée / ratée une fois les 5s écoulées. |
| **NEUTRE 5s** | P dans la bande τ, **ou** |move| prévu sous 1 bp. |

**Affichage 5s ≠ paper 60s.** Bande **pourquoi** : rendement 5s, taker buy, OBI du carnet, etc.

## Test out-of-sample (tête 5s, affichage)

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

Le réentraînement Coinbase **n’a pas** remplacé les poids live 5s. Un edge directionnel vs naive ~51–53 % est réel ; après 1 bp de friction l’espérance 5s reste **négative**.

## Frais (module unique)

Les deux nombres du paper se changent dans `netlify/functions/lib/paperFees.ts` : `TAKER_FEE_BPS` et `MAKER_FEE_BPS`. L’UI les lit via l’API.

**Défaut paper = Coinbase Advanced Trade, palier d’entrée volume 30 j < 1 000 $ US.**

| | Preneur | Faiseur | Aller-retour |
|---|---|---|---|
| **Advanced Trade intro (hypothèse)** | **120 bp** | **60 bp** | **240 / 120 bp** |
| Exchange public 0–10 k$ US (non utilisé) | 60 bp | 40 bp | 120 / 80 bp |

Ce **ne sont pas** des chiffres publiés par Coinbase. Le [barème officiel Advanced Trade](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees) est derrière connexion (« sign in to see the complete fee structure »). 120 / 60 bp = hypothèse tierce 2026 ([TokenEcho](https://tokenecho.com), Exchange Review Lab — ils divergent sur les paliers suivants), **non vérifiée** vs table officielle.

Le [barème public Coinbase Exchange](https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees) 0–10 k$ US = 60 / 40 bp est conservé comme **alternative nommée**, pas le défaut : Jayvy trade sur Advanced Trade, pas Exchange.

## Paper 24 h (pas de live)

Objectif : laisser https://fanal.netlify.app ouvert **24 heures** et voir si le carnet virtuel est profitable. Un jour vert voudrait dire qu’on peut **discuter** d’un live Advanced Trade spot BTC-USD — pas avant.

| | |
|---|---|
| Capital virtuel | **1 000 $ US** |
| Clip | **75 $ US** par signal |
| Défaut | **faiseur / post-only, horizon 60 s** |
| Positions | **une à la fois**, flatten à **placement + 60 s** (pas +60 s après le fill) |
| Entrée | signal **60 s** (pas le feu 5s) : direction HAUSSIER/BAISSIER **et** `|move|` prévu ≥ **RT faiseur (120 bp)**. NEUTRE ou |move| sous les frais → pas de take. |
| Faiseur | achat au **bid**, vente à l’**ask** ; fill seulement si le marché **trade à travers** (low < bid / high > ask), pas un touch ni last/mid. Barre 1s commencée avant l’ordre ignorée. Sinon **annulé** à +60 s. Sortie faiseur d’abord ; si non fill à l’horizon, flatten preneur (frais preneur sur cette jambe). |
| Preneur 60s | fill immédiat bid/ask, frais preneur des deux côtés (opt-in). |
| Preneur 5s | **opt-in de comparaison** (`horizonSec: 5`), gate 1 bp — **doit perdre** vs frais Advanced Trade (240 bp RT preneur vs ~1 bp de move). |
| PnL $ | brut − frais entrée − frais sortie. Equity marquée bid/ask moins le frais de sortie restant. Fill faiseur = prix posté. |
| Short | notionnel virtuel. |
| Horloge | `GET /api/live` (poll UI 1 s) **et** `paper-tick` (cron **1 min**). L’onglet fermé : le flatten 60 s avance quand même à la minute. |
| Persistance | Blobs `fanal-paper` / `ledger`. Schéma **v2** (horizon + mode). Un carnet 5s v1 n’est **pas** continué en 60s faiseur (reset 1 000 $). Un cold start **ne wipe pas** un carnet v2 60s valide. Changer mode/horizon via POST recrée un carnet (pas de mix). |

Le |move| 60s BTC est souvent **~10 bp** vs **120 bp** de friction faiseur. La couverture sera minuscule ; l’espérance après frais est probablement **négative**. Succès = paper honnête fee-aware, pas un jour vert.

`POST /api/paper` `{ "mode": "taker" | "maker", "horizonSec": 60 }` (60 = défaut). `horizonSec: 5` = comparaison preneur 5s. `GET /api/paper` relit sans avancer. `GET /api/paper-tick` avance un pas comme `/api/live`.

**Non branché** : pas de clés API, pas d’ordres Advanced Trade, pas de retraits.

## Tête 60s

Le paper scoré un horizon 60s : P(close_60s > now) et |move| calibré en bp (le gate a besoin de la magnitude). Features : structure **15s–2 min** (`ret_15/30/60/120`, vol, CVD, imb), pas seulement le mean-reversion 3–5s.

- S’il y a un LightGBM 60s dans `netlify/functions/_models/fanal_sec_lgbm_60.json` (arbres non vides), il est utilisé.
- Sinon **fallback** (dumps `data/` gitignorés, pas d’entraînement CI) : direction = mélange scoreur 5s existant + momentum 15s–2 min ; |move| = vol réalisée 60s × facteur de confiance. Ce n’est **pas** un LightGBM 60s. Relancer :

```bash
pip install -r train/requirements.txt
python3 train/train_fanal.py --horizon 60
```

quand des barres 1s Coinbase (`data/coinbase/bars_1s.csv.gz`) ou Binance Vision (`data/binance/`) sont présentes. Split temporel, pas de shuffle. Le script imprime TEST : gated-acc, couverture, |move| moyen, E après RT faiseur (120 bp) et RT preneur (240 bp). Les poids live 5s ne sont pas remplacés.

### TEST 60s (Binance Vision 7 j, 14–20 août 2026)

Petit LightGBM (59 arbres, 15 feuilles). Split temporel 70 / 15 / 15. |move| inconditionnel ≈ **2,7 bp**. Gate paper = **120 bp**.

| | Gate 120 bp (paper) | Gate 10 bp (réf., pas le paper) | τ=0,58 seul |
|---|---|---|---|
| n | **0** | 3 | 15 455 |
| Couverture | **0 %** | 0,004 % | 19,3 % |
| Acc gated | — | 66,7 % | 55,2 % |
| Naive (ret_60) | 50,1 % | 50,1 % | 50,1 % |
| \|move\| moyen | — | 4,80 bp | 4,94 bp |
| E après RT faiseur (120 bp) | — | **−123,8 bp** | **−119,1 bp** |
| E après RT preneur (240 bp) | — | −243,8 bp | −239,1 bp |

**Aucun signal ne passe le gate frais sur ce TEST.** Dès qu’on prend (même τ seul), E après 120 bp est ~ −119 bp. Couverture minuscule, E négative : on ne maquille pas. (Échantillon calme : 2,7 bp d’amplitude 60s, en dessous du ~10 bp souvent cité — le diagnostic frais vs move ne change pas.)

## Lancer en local

```bash
cd frontend
npm i
npm run dev
```

Le serveur Vite (`http://localhost:5173`) proxifie `/api/*` vers la même logique que les Netlify Functions.

```bash
node --experimental-strip-types --no-warnings netlify/functions/lib/pipeline.test.ts
```

Ré-entraîner la tête 5s (Python 3 + lightgbm/pandas/numpy) :

```bash
pip install -r train/requirements.txt
python3 train/train_fanal.py 14
```

Les dumps restent dans `data/` (gitignoré). Les poids live 5s ne sont remplacés que si le TEST a une meilleure E après 1 bp **ou** une gated-acc ≥ main avec une couverture encore utilisable.

## Déployer sur Netlify

1. [Importer le repo GitHub](https://app.netlify.com/start) `Jayvy2002/fanal`.
2. Les réglages sont dans le `netlify.toml` à la racine — pas besoin de secrets.

| Réglage | Valeur |
|---|---|
| Base directory | `frontend` |
| Build command | `npm run build` |
| Publish directory | `dist` |
| Functions directory | `netlify/functions` |

Le SPA fallback `/* → /index.html` est **après** `/api/* → /.netlify/functions/:splat`.

Chaque invocation interroge Coinbase Exchange (`api.exchange.coinbase.com`, BTC-USD), reconstruit les barres 1s, calcule les features, et score le LightGBM en TypeScript. Aucun secret. Aucun appel Binance depuis le navigateur ni depuis les functions live.

Le paper est **persisté** via Netlify Blobs. Le trading live **n’est pas** branché.

## API

- `GET /api/health` — `paper` = `"blobs"` | `"file"`
- `GET /api/ticker` — ticker Coinbase BTC-USD (+ stats 24h)
- `GET /api/book` — profondeur niveau 2, mid, OBI 10
- `GET /api/live` — signal 5s + `paper_signal` 60s + spark + `forecasts[]` + **paper persisté**. Avance le paper (features = barre 1s complète).
- `GET /api/paper` — snapshot du carnet (sans pas de simulation)
- `POST /api/paper` — `{ "mode": "taker" | "maker", "horizonSec": 60 }` (60 défaut ; 5 = comparaison)
- `GET /api/paper-tick` — même pas paper que `/live` (cron 1 min en prod)
