# Fanal

Prédicteur IA **indépendant** du prix Bitcoin sur **bougies 1 minute**, décision à **15 minutes**. Interface française. Ce n’est **pas** un bot de trading, ni un conseil financier — un jouet de recherche.

Le live lit **Coinbase Exchange** public REST, produit **BTC-USD** (`GET /products/BTC-USD/candles?granularity=60`, plus ticker / carnet / trades). Aucune clé API. Le scoreur n’utilise que la **dernière barre 1m complète** (la minute en cours est affichée, pas dans les features).

Les têtes LightGBM (petits arbres, pas un réseau type CAT) sortent P(close_h > now) et un |move| calibré pour {1, 3, 5, 10, **15**, 30} minutes. Le chemin or interpolé part de *maintenant* vers 15 m (30 m pâle). **Pas** de branding KAT/Krafer, **pas** de poids copiés.

**Feu** seulement si (1) P(↑ 15 m) ≥ 0,58 ou ≤ 0,42 **et** (2) le |move| 15 m **attendu** ≥ **120 bp** (aller-retour faiseur). Confiance = cette probabilité. Hit/miss graphique = direction du mid 15 m plus tard (sans frais). Le PnL $ paper soustrait les frais.

Repo : [github.com/Jayvy2002/fanal](https://github.com/Jayvy2002/fanal)

## Lire le graphique

Le panneau principal est un graphique **1 minute** (~3 h), pas un mot HAUSSIER isolé.

| | |
|---|---|
| **Curseur blanc** | *Maintenant* |
| **Trait or** | Trajectoire **prévue** 15 minutes (nœuds 1 / 3 / 5 / 10 / 15 m interpolés) |
| **Trait or pâle** | Tête 30 m optionnelle |
| **Vert** | La direction prévue a **matché** le réel une fois les 15 m écoulées (direction seule) |
| **Rouge** | Direction **ratée** |
| **NEUTRE** | P dans la bande τ, **ou** |move| prévu sous 120 bp (RT faiseur) |

Bande **pourquoi** : rendements 1m, range, vol, gaps (hauts/bas 1 m non comblés), heure, OBI carnet, taker-buy si les trades récents le permettent.

## Entraînement

Split **temporel** 70 / 15 / 15 (pas de shuffle). Archive : bougies publiques Coinbase Exchange BTC-USD, `granularity=60`.

```bash
pip install -r train/requirements.txt
python3 train/train_fanal.py --days 90 --granularity 60 --horizon 15
```

| | |
|---|---|
| Fenêtre | **2026-05-26 → 2026-08-24** (**90,00 j**, n = **129 601** barres 1 m densifiées) |
| Requêtes | pagination REST (~300 bougies / appel), rate-limit respecté |
| Têtes | 1, 3, 5, 10, **15**, 30 minutes |
| τ | 0,58 |
| Gate | **120 bp** = RT faiseur (défaut) |

Les dumps 5 s (`models/fanal_sec_*`) restent des **artefacts**. Ils ne sont **pas** le scoreur live.

## Test out-of-sample (tête 15 m)

Horizon 15 m, égalités exclues. Live = Coinbase BTC-USD 1 m.

| | TEST 15 m |
|---|---|
| Archive | candles Coinbase 90 j |
| **τ** | 0,58 |
| **min \|move\|** | **120 bp** (RT faiseur) |
| **Précision gated TEST** | **n/a** (n = 0) |
| n gated | **0** |
| **Couverture** | **0,00 %** |
| Naive (dernier rendement 1 m) | 49,3 % |
| **\|move\| 15 m moyen (tout le TEST)** | **13,0 bp** |
| **E après RT faiseur (120 bp)** | **n/a** (aucun feu) — si on forçait chaque barre : ~13 − 120 ≈ **−107 bp** |
| **E après RT preneur (240 bp)** | **n/a** — forcé : ~13 − 240 ≈ **−227 bp** |

Même **sans** le gate 120 bp, τ = 0,58 ne sort presque jamais : le petit LightGBM reste dans la bande (P proche de 0,5). Le |move| 15 m BTC (~13 bp) est **largement sous** 120 bp. **C’est acceptable.** Succès = paper 1 m honnête et fee-aware, pas un jour vert.

## Frais (une seule source : `netlify/functions/lib/paperFees.ts`)

Le barème officiel Advanced Trade est **login-gated**. On n’invente pas ces chiffres.

**Défaut paper / gate** — Advanced Trade intro, **non vérifié** (sources tierces 2026, palier < 1 k$ US / 30 j : TokenEcho, Exchange Review Lab) :

| | bp |
|---|---|
| Preneur (taker) | **120** |
| Faiseur (maker) | **60** |
| Aller-retour faiseur | **120** |
| Aller-retour preneur | **240** |

Pages Coinbase : [Advanced Trade](https://help.coinbase.com/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees) · [Exchange](https://help.coinbase.com/en/exchange/trading-and-funding/exchange-fees).

**Alternate nommée, pas le défaut** : Exchange **60 / 40** bp.

L’UI affiche produit, bp, RT et le caveat.

## Paper 24 h (pas de live)

Objectif : laisser https://fanal.netlify.app ouvert **24 heures** et voir le carnet virtuel. Un jour vert voudrait dire qu’on peut **discuter** d’un live — pas avant. Avec un gate 120 bp et ~13 bp de move 15 m, le carnet restera **presque vide**. C’est le résultat attendu.

| | |
|---|---|
| Capital virtuel | **1 000 $ US** |
| Clip | **75 $ US** par signal |
| Positions | **une à la fois**, flatten **15 min après le placement** |
| Défaut | **faiseur / post-only** |
| Entrée | feu live 15 m **et** \|move\| ≥ 120 bp. Un signal 1 s / 5 s **n’ouvre pas** le paper. |
| Fill faiseur | trade-through sur les **barres 1 m suivantes** (low < bid / high > ask). La minute **en cours au placement** est ignorée. Non fill à +15 m → **annulé**. Sortie faiseur d’abord, sinon flatten preneur. |
| Schéma ledger | **v = 2** (l’ancien carnet 5 s n’est pas continué) |
| Persistance | Blobs `fanal-paper` / clé `ledger`. **Pas** de fallback `/tmp` en prod si le store Blobs existe. |
| Cron | `paper-tick` **1 min** (taille de barre) |

**Non branché** : pas de clés API, pas d’ordres Advanced Trade, pas de Polymarket, pas de retraits.

`POST /api/paper` `{ "mode": "taker" | "maker" }` change le mode. `GET /api/paper` relit le carnet sans avancer l’horloge. `GET /api/paper-tick` avance un pas comme `/api/live`.

## Lancer en local

```bash
cd frontend
npm i
npm run dev
```

Le serveur Vite (`http://localhost:5173`) proxifie `/api/*` vers la même logique que les Netlify Functions.

```bash
npm i -g netlify-cli
npx netlify dev
```

Tests de logique :

```bash
npx tsx netlify/functions/lib/pipeline.test.ts
```

## Déployer sur Netlify

1. [Importer le repo GitHub](https://app.netlify.com/start) `Jayvy2002/fanal`.
2. Les réglages sont dans le `netlify.toml` à la racine — pas besoin de secrets.

| Réglage | Valeur |
|---|---|
| Base directory | `frontend` |
| Build command | `npm run build` |
| Publish directory | `dist` |
| Functions directory | `netlify/functions` |

Chaque invocation interroge Coinbase Exchange (`api.exchange.coinbase.com`, BTC-USD), lit les bougies 1 m, calcule les features, et score le LightGBM en TypeScript (arbres JSON). Aucun secret. Aucun appel Binance depuis `/api/*`.

## API

- `GET /api/health` — `paper` = `"blobs"` \| `"file"` ; `bar_s=60`, `horizon_s=900`
- `GET /api/ticker` — ticker Coinbase BTC-USD (+ stats 24h)
- `GET /api/book` — profondeur niveau 2, mid, OBI 10
- `GET /api/live` — signal 15 m + spark 1 m + chemin or + **paper persisté** + carnet. Features = barre 1 m complète.
- `GET /api/paper` — snapshot du carnet (sans pas de simulation)
- `POST /api/paper` — `{ "mode": "taker" | "maker" }`
- `GET /api/paper-tick` — même pas paper que `/live` (cron 1 min en prod)
